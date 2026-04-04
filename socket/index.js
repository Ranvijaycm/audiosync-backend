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
 *   trackEndedProcessed: Boolean,  // FIX: prevent duplicate track-ended processing
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
      trackEndedProcessed: false,
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

// FIX 1 — SYNC LAG ROOT CAUSE:
// The old setInterval-based countdown drifted by ~100ms/tick AND the 500ms startTime
// buffer was too tight. MediaPlayer.prepare() on Android takes 1-3s on first call,
// so devices that weren't already prepared would lag by exactly that amount (6-7s).
// Solution: use precise setTimeout chain + 2500ms lead time so all devices have
// enough time to call prepare() and be ready BEFORE the scheduled start timestamp.
function startCountdown(io, roomCode, trackId) {
  const state = getRoomState(roomCode);
  if (state.countdownActive) return;
  state.countdownActive = true;
  state.trackEndedProcessed = false;

  let count = 3;
  function tick() {
    io.to(roomCode).emit('sync-countdown', { secondsLeft: count });
    count--;
    if (count >= 0) {
      setTimeout(tick, 1000);
    } else {
      state.countdownActive = false;
      // 2500ms lead — enough for MediaPlayer.prepare() + network jitter
      const startTime = Date.now() + 2500;
      io.to(roomCode).emit('start-playback', { trackId, startTime });
      console.log(`▶️  start-playback sent for room ${roomCode}, trackId=${trackId}, startTime=${startTime}`);
    }
  }
  setTimeout(tick, 0);
}

// FIX 2 — GUEST USERS: guest IDs are negative (set by Android client)
function isGuestUserId(userId) {
  return typeof userId === 'number' && userId < 0;
}

module.exports = function initSocket(io) {
  io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.id}`);

    // ── join-room ─────────────────────────────────────────────────────────
    socket.on('join-room', async ({ roomCode, userId, username }) => {
      // FIX: userId can be negative for guests — only block missing/null values
      if (!roomCode || userId === undefined || userId === null || !username) {
        socket.emit('room-joined', { success: false, message: 'roomCode, userId, and username are required' });
        return;
      }

      const code = roomCode.toUpperCase();
      const userIdInt = parseInt(userId);

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
        state.members.set(socket.id, { userId: userIdInt, username });

        // Guests cannot be host
        if (!isGuestUserId(userIdInt) && room.created_by === userIdInt) {
          state.hostSocketId = socket.id;
          state.hostUserId = userIdInt;
        }

        socket.data.roomCode = code;
        socket.data.userId = userIdInt;
        socket.data.username = username;
        socket.data.isGuest = isGuestUserId(userIdInt);

        const listenerCount = getListenerCount(code);
        socket.emit('room-joined', { success: true, listenerCount });
        socket.to(code).emit('listener-joined', { listenerCount, username });

        console.log(`👤 ${username} (userId=${userIdInt}, guest=${isGuestUserId(userIdInt)}) joined room ${code} (${listenerCount} total)`);
      } catch (err) {
        console.error('join-room error:', err);
        socket.emit('room-joined', { success: false, message: 'Server error' });
      }
    });

    // ── leave-room ────────────────────────────────────────────────────────
    socket.on('leave-room', ({ roomCode, userId }) => {
      handleLeave(io, socket, roomCode?.toUpperCase(), parseInt(userId));
    });

    // ── track-uploaded ────────────────────────────────────────────────────
    socket.on('track-uploaded', ({ roomCode, trackId, fileUrl, trackName, artist, addedBy }) => {
    const code = roomCode?.toUpperCase();
    if (!code) return;

    const state = getRoomState(code);

    // Only set as current track if nothing is playing
    if (!state.currentTrackId) {
        state.currentTrackId = trackId;
        state.readyDevices.clear();
        state.countdownActive = false;
        state.trackEndedProcessed = false;
        // Broadcast to trigger download + ready flow
        io.to(code).emit('track-available', { trackId, fileUrl, trackName, artist, addedBy });
    } else {
        // Something already playing — just add to queue UI, don't interrupt
        io.to(code).emit('track-queued', { trackId, fileUrl, trackName, artist, addedBy });
    }

    console.log(`🎵 Track uploaded in room ${code}: ${trackName} (id=${trackId})`);
});

    // ── get-queue ─────────────────────────────────────────────────────────
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
    socket.on('device-ready', ({ roomCode, userId }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      const state = getRoomState(code);

      // FIX 4: Guard against ghost sockets. If a socket isn't in members yet,
      // it could have been from a stale reconnect — ignore it.
      if (!state.members.has(socket.id)) {
        console.warn(`⚠️  device-ready from unregistered socket ${socket.id} in room ${code}, ignoring`);
        return;
      }

      state.readyDevices.add(socket.id);

      const totalMembers = state.members.size;
      const readyCount = state.readyDevices.size;

      console.log(`✅ Device ready in ${code}: ${readyCount}/${totalMembers} (socketId=${socket.id})`);

      if (readyCount >= totalMembers && totalMembers > 0 && !state.countdownActive) {
        console.log(`🚀 All devices ready in room ${code}, starting countdown`);
        startCountdown(io, code, state.currentTrackId);
      }
    });

    // ── track-ended ───────────────────────────────────────────────────────
    // FIX 5: All devices emit track-ended — deduplicate so we only advance queue once.
    socket.on('track-ended', async ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      const state = getRoomState(code);

      // Only process once per track
      if (state.trackEndedProcessed) return;
      state.trackEndedProcessed = true;

      try {
        if (state.currentTrackId) {
          await db.query('UPDATE queue SET is_played = TRUE WHERE id = ?', [state.currentTrackId]);
        }

        const nextTrack = await getNextTrack(code);

        if (nextTrack) {
          state.currentTrackId = nextTrack.id;
          state.readyDevices.clear();
          state.countdownActive = false;
          state.trackEndedProcessed = false;

          const baseUrl = `${process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3000)}`;
          const fileUrl = `${baseUrl}/${nextTrack.file_path}`;

          io.to(code).emit('track-available', {
            trackId: nextTrack.id,
            fileUrl,
            trackName: nextTrack.track_name,
            artist: nextTrack.artist,
            addedBy: nextTrack.added_by,
          });

          const queue = await getFullQueue(code, baseUrl);
          io.to(code).emit('queue-updated', { queue });
        } else {
          state.currentTrackId = null;
          io.to(code).emit('queue-empty', {});
        }
      } catch (err) {
        console.error('track-ended error:', err);
        // Reset flag so a retry can work
        state.trackEndedProcessed = false;
      }
    });

    // ── seek / pause / resume — host-only ─────────────────────────────────
    // FIX 6: Validate that only the host can broadcast playback control events.
    socket.on('seek-track', ({ roomCode, position }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      const state = getRoomState(code);
      if (state.hostSocketId && state.hostSocketId !== socket.id) return;
      socket.to(code).emit('playback-seeked', { position });
    });

    socket.on('pause-track', ({ roomCode, position }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      const state = getRoomState(code);
      if (state.hostSocketId && state.hostSocketId !== socket.id) return;
      socket.to(code).emit('playback-paused', { position });
    });

    socket.on('resume-track', ({ roomCode, position }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      const state = getRoomState(code);
      if (state.hostSocketId && state.hostSocketId !== socket.id) return;
      socket.to(code).emit('playback-resumed', { position });
    });

    // ── disconnect ────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const { roomCode, userId } = socket.data;
      if (roomCode) handleLeave(io, socket, roomCode, userId);
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
    const listenerCount = getListenerCount(roomCode);
    io.to(roomCode).emit('listener-left', { listenerCount, username });

    if (
      state.members.size > 0 &&
      state.readyDevices.size >= state.members.size &&
      !state.countdownActive &&
      state.currentTrackId
    ) {
      startCountdown(io, roomCode, state.currentTrackId);
    }

    // FIX 7: Skip DB delete for guest users — they're not stored in room_users
    const userIdInt = parseInt(userId);
    if (!isNaN(userIdInt) && userIdInt > 0) {
      try {
        const [rooms] = await db.query('SELECT id FROM rooms WHERE code = ?', [roomCode]);
        if (rooms.length) {
          await db.query('DELETE FROM room_users WHERE room_id = ? AND user_id = ?', [rooms[0].id, userIdInt]);
        }
      } catch (err) {
        console.error('Error removing room_user:', err);
      }
    }

    console.log(`🚶 ${username} left room ${roomCode} (${listenerCount} remaining)`);
  }
}
