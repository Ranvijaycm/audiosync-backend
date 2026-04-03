const db = require('../config/db');

/**
 * In-memory room state (resets on server restart).
 * roomState[roomCode] = {
 *   hostSocketId: String,
 *   hostUserId: Int,
 *   members: Map<socketId, { userId, username }>,
 *   readyDevices: Set<socketId>,
 *   currentTrackId: Int | null,
 *   countdownActive: Boolean,
 * }
 */
const roomState = {};

function getRoomState(roomCode) {
  if (!roomState[roomCode]) {
    roomState[roomCode] = {
      hostSocketId: null,
      hostUserId: null,
      members: new Map(),
      readyDevices: new Set(),
      currentTrackId: null,
      countdownActive: false,
    };
  }
  return roomState[roomCode];
}

function getListenerCount(roomCode) {
  const state = roomState[roomCode];
  return state ? state.members.size : 0;
}

async function getNextTrack(roomCode) {
  const [rooms] = await db.query('SELECT id FROM rooms WHERE code = ?', [roomCode]);
  if (!rooms.length) return null;
  const roomId = rooms[0].id;
  const [tracks] = await db.query(
    'SELECT * FROM queue WHERE room_id = ? AND is_played = FALSE ORDER BY order_index ASC LIMIT 1',
    [roomId]
  );
  return tracks[0] || null;
}

async function getFullQueue(roomCode, baseUrl) {
  const [rooms] = await db.query('SELECT id FROM rooms WHERE code = ?', [roomCode]);
  if (!rooms.length) return [];
  const [tracks] = await db.query(
    'SELECT id, track_name as name, artist, added_by as addedBy, file_path as url, order_index, is_played FROM queue WHERE room_id = ? ORDER BY order_index ASC',
    [rooms[0].id]
  );
  return tracks.map(t => ({ ...t, url: `${baseUrl}/${t.url}`, duration: 0 }));
}

function startCountdown(io, roomCode, trackId) {
  const state = getRoomState(roomCode);
  if (state.countdownActive) return;
  state.countdownActive = true;

  let count = 3;
  const interval = setInterval(() => {
    io.to(roomCode).emit('sync-countdown', { secondsLeft: count });
    count--;
    if (count < 0) {
      clearInterval(interval);
      state.countdownActive = false;

      // Emit start-playback with a precise future timestamp (500ms from now)
      const startTime = Date.now() + 500;
      io.to(roomCode).emit('start-playback', { trackId, startTime });
    }
  }, 1000);
}

module.exports = function initSocket(io) {
  io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.id}`);

    // ── join-room ─────────────────────────────────────────────────────────
    socket.on('join-room', async ({ roomCode, userId, username }) => {
      if (!roomCode || !userId || !username) return;

      const code = roomCode.toUpperCase();

      try {
        const [rooms] = await db.query(
          'SELECT * FROM rooms WHERE code = ? AND is_active = TRUE',
          [code]
        );
        if (!rooms.length) {
          socket.emit('room-joined', { success: false, message: 'Room not found' });
          return;
        }

        const room = rooms[0];
        socket.join(code);

        const state = getRoomState(code);
        state.members.set(socket.id, { userId: parseInt(userId), username });

        // Determine host
        if (room.created_by === parseInt(userId)) {
          state.hostSocketId = socket.id;
          state.hostUserId = parseInt(userId);
        }

        // Store roomCode on socket for cleanup
        socket.data.roomCode = code;
        socket.data.userId = parseInt(userId);
        socket.data.username = username;

        const listenerCount = getListenerCount(code);

        socket.emit('room-joined', { success: true, listenerCount });

        // Notify others
        socket.to(code).emit('listener-joined', { listenerCount, username });

        console.log(`👤 ${username} joined room ${code} (${listenerCount} total)`);
      } catch (err) {
        console.error('join-room error:', err);
      }
    });

    // ── leave-room ────────────────────────────────────────────────────────
    socket.on('leave-room', ({ roomCode, userId }) => {
      handleLeave(io, socket, roomCode?.toUpperCase(), parseInt(userId));
    });

    // ── track-uploaded ────────────────────────────────────────────────────
    // Host tells server a new track was added; server broadcasts to all listeners
    socket.on('track-uploaded', ({ roomCode, trackId, fileUrl, trackName, artist, addedBy }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      const state = getRoomState(code);
      state.currentTrackId = trackId;
      state.readyDevices.clear();
      state.countdownActive = false;

      io.to(code).emit('track-available', { trackId, fileUrl, trackName, artist, addedBy });
      console.log(`🎵 Track available in room ${code}: ${trackName}`);
    });

    // ── get-queue ─────────────────────────────────────────────────────────
    // Listener requests existing queue when joining a room that already has tracks
    socket.on('get-queue', async ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      try {
        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

        const [rooms] = await db.query('SELECT id FROM rooms WHERE code = ?', [code]);
        if (!rooms.length) return;

        const [tracks] = await db.query(
          'SELECT id as trackId, track_name as trackName, artist, added_by as addedBy, file_path as fileUrl FROM queue WHERE room_id = ? AND is_played = FALSE ORDER BY order_index ASC',
          [rooms[0].id]
        );

        const formattedTracks = tracks.map(t => ({
          ...t,
          fileUrl: `${baseUrl}/${t.fileUrl}`,
        }));

        socket.emit('queue-state', { tracks: formattedTracks });
        console.log(`📋 Sent queue to ${socket.id} for room ${code}: ${formattedTracks.length} track(s)`);
      } catch (err) {
        console.error('get-queue error:', err);
      }
    });

    // ── device-ready ──────────────────────────────────────────────────────
    // Listener signals it has finished downloading the track
    socket.on('device-ready', ({ roomCode, userId }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      const state = getRoomState(code);
      state.readyDevices.add(socket.id);

      const totalMembers = state.members.size;
      const readyCount = state.readyDevices.size;

      console.log(`✅ Device ready in ${code}: ${readyCount}/${totalMembers}`);

      if (readyCount >= totalMembers && totalMembers > 0 && !state.countdownActive) {
        console.log(`🚀 All devices ready in room ${code}, starting countdown`);
        startCountdown(io, code, state.currentTrackId);
      }
    });

    // ── track-ended ───────────────────────────────────────────────────────
    socket.on('track-ended', async ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      try {
        // Mark current track as played
        const state = getRoomState(code);
        if (state.currentTrackId) {
          await db.query('UPDATE queue SET is_played = TRUE WHERE id = ?', [state.currentTrackId]);
        }

        // Get next track
        const nextTrack = await getNextTrack(code);

        if (nextTrack) {
          state.currentTrackId = nextTrack.id;
          state.readyDevices.clear();
          state.countdownActive = false;

          const baseUrl = `${process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3000)}`;
          const fileUrl = `${baseUrl}/${nextTrack.file_path}`;

          io.to(code).emit('track-available', {
            trackId: nextTrack.id,
            fileUrl,
            trackName: nextTrack.track_name,
            artist: nextTrack.artist,
            addedBy: nextTrack.added_by,
          });

          // Emit updated queue
          const queue = await getFullQueue(code, baseUrl);
          io.to(code).emit('queue-updated', { queue });
        }
      } catch (err) {
        console.error('track-ended error:', err);
      }
    });

    // ── seek-track ────────────────────────────────────────────────────────
    socket.on('seek-track', ({ roomCode, position }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      socket.to(code).emit('playback-seeked', { position });
    });

    // ── pause-track ───────────────────────────────────────────────────────
    socket.on('pause-track', ({ roomCode, position }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      socket.to(code).emit('playback-paused', { position });
    });

    // ── resume-track ──────────────────────────────────────────────────────
    socket.on('resume-track', ({ roomCode, position }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      socket.to(code).emit('playback-resumed', { position });
    });

    // ── disconnect ────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const { roomCode, userId } = socket.data;
      if (roomCode) {
        handleLeave(io, socket, roomCode, userId);
      }
      console.log(`🔌 Socket disconnected: ${socket.id}`);
    });
  });
};

// ── Shared leave handler ───────────────────────────────────────────────────
async function handleLeave(io, socket, roomCode, userId) {
  if (!roomCode) return;

  const state = roomState[roomCode];
  if (!state) return;

  const member = state.members.get(socket.id);
  const username = member?.username || 'Unknown';

  state.members.delete(socket.id);
  state.readyDevices.delete(socket.id);
  socket.leave(roomCode);

  const isHost = state.hostSocketId === socket.id;

  if (isHost) {
    // Host left — close the room
    state.hostSocketId = null;
    try {
      await db.query('UPDATE rooms SET is_active = FALSE WHERE code = ?', [roomCode]);
      await db.query(
        'DELETE ru FROM room_users ru JOIN rooms r ON ru.room_id = r.id WHERE r.code = ?',
        [roomCode]
      );
    } catch (err) {
      console.error('Error closing room:', err);
    }

    io.to(roomCode).emit('host-left', { message: 'The host has left. Room is now closed.' });
    delete roomState[roomCode];
    console.log(`🚪 Host left, room ${roomCode} closed`);
  } else {
    // Regular listener left
    const listenerCount = getListenerCount(roomCode);
    io.to(roomCode).emit('listener-left', { listenerCount, username });

    // If all remaining devices are ready now (edge case: someone left while others were ready)
    if (
      state.readyDevices.size >= state.members.size &&
      state.members.size > 0 &&
      !state.countdownActive &&
      state.currentTrackId
    ) {
      startCountdown(io, roomCode, state.currentTrackId);
    }

    // Remove from DB
    try {
      const [rooms] = await db.query('SELECT id FROM rooms WHERE code = ?', [roomCode]);
      if (rooms.length) {
        await db.query('DELETE FROM room_users WHERE room_id = ? AND user_id = ?', [rooms[0].id, userId]);
      }
    } catch (err) {
      console.error('Error removing room_user:', err);
    }

    console.log(`🚶 ${username} left room ${roomCode} (${listenerCount} remaining)`);
  }
}