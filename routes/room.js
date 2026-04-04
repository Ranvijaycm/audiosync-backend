const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../config/db');
const authMiddleware = require('../middleware/auth');
const upload = require('../middleware/upload');

// Helper: generate a unique 6-char alphanumeric room code
async function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code, exists;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const [rows] = await db.query('SELECT id FROM rooms WHERE code = ?', [code]);
    exists = rows.length > 0;
  } while (exists);
  return code;
}

async function getListenerCount(roomId) {
  const [rows] = await db.query('SELECT COUNT(*) as count FROM room_users WHERE room_id = ?', [roomId]);
  return rows[0].count;
}

// POST /room/create — logged-in users only
router.post('/create', authMiddleware, async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ success: false, message: 'userId is required' });
  }

  try {
    const code = await generateRoomCode();

    const [result] = await db.query(
      'INSERT INTO rooms (code, created_by, is_active) VALUES (?, ?, TRUE)',
      [code, userId]
    );

    const roomId = result.insertId;
    await db.query('INSERT INTO room_users (room_id, user_id) VALUES (?, ?)', [roomId, userId]);

    const listenerCount = await getListenerCount(roomId);

    return res.status(201).json({
      success: true,
      roomCode: code,
      isHost: true,
      listenerCount,
      message: 'Room created successfully',
    });
  } catch (err) {
    console.error('Create room error:', err);
    return res.status(500).json({ success: false, message: 'Server error creating room' });
  }
});

// POST /room/join — logged-in users only
router.post('/join', authMiddleware, async (req, res) => {
  const { roomCode, userId } = req.body;

  if (!roomCode || !userId) {
    return res.status(400).json({ success: false, message: 'roomCode and userId are required' });
  }

  try {
    const [rooms] = await db.query(
      'SELECT * FROM rooms WHERE code = ? AND is_active = TRUE',
      [roomCode.toUpperCase()]
    );

    if (rooms.length === 0) {
      return res.status(404).json({ success: false, message: 'Room not found or inactive' });
    }

    const room = rooms[0];

    await db.query(
      'INSERT IGNORE INTO room_users (room_id, user_id) VALUES (?, ?)',
      [room.id, userId]
    );

    const listenerCount = await getListenerCount(room.id);
    const isHost = room.created_by === parseInt(userId);

    return res.json({
      success: true,
      roomCode: room.code,
      isHost,
      listenerCount,
      message: 'Joined room successfully',
    });
  } catch (err) {
    console.error('Join room error:', err);
    return res.status(500).json({ success: false, message: 'Server error joining room' });
  }
});

// FIX: POST /room/guest-join — guests don't have a JWT so they can't hit /join.
// This endpoint only validates that the room exists — no DB record is written for guests.
// All guest presence is tracked in-memory via socket state on the server.
router.post('/guest-join', async (req, res) => {
  const { roomCode } = req.body;

  if (!roomCode) {
    return res.status(400).json({ success: false, message: 'roomCode is required' });
  }

  try {
    const [rooms] = await db.query(
      'SELECT id, code, created_by FROM rooms WHERE code = ? AND is_active = TRUE',
      [roomCode.toUpperCase()]
    );

    if (rooms.length === 0) {
      return res.status(404).json({ success: false, message: 'Room not found or inactive' });
    }

    const room = rooms[0];

    return res.json({
      success: true,
      roomCode: room.code,
      isHost: false,
      message: 'Guest joined room',
    });
  } catch (err) {
    console.error('Guest join error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /room/:code
router.get('/:code', authMiddleware, async (req, res) => {
  const { code } = req.params;

  try {
    const [rooms] = await db.query(
      'SELECT * FROM rooms WHERE code = ? AND is_active = TRUE',
      [code.toUpperCase()]
    );

    if (rooms.length === 0) {
      return res.status(404).json({ success: false, message: 'Room not found' });
    }

    const room = rooms[0];
    const listenerCount = await getListenerCount(room.id);

    const [queueRows] = await db.query(
      `SELECT id, track_name as name, artist, added_by as addedBy, 
              file_path as url, order_index, is_played
       FROM queue WHERE room_id = ? ORDER BY order_index ASC`,
      [room.id]
    );

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const queue = queueRows.map(track => ({
      ...track,
      url: `${baseUrl}/${track.url}`,
      duration: 0,
    }));

    return res.json({
      success: true,
      roomCode: room.code,
      listenerCount,
      queue,
    });
  } catch (err) {
    console.error('Get room error:', err);
    return res.status(500).json({ success: false, message: 'Server error fetching room' });
  }
});

// POST /room/queue/add — logged-in users only (guests cannot upload)
router.post('/queue/add', authMiddleware, upload.single('audio'), async (req, res) => {
  const { roomCode, trackName, artist, addedBy } = req.body;

  if (!roomCode || !trackName || !artist || !addedBy) {
    return res.status(400).json({
      success: false,
      message: 'roomCode, trackName, artist, and addedBy are required',
    });
  }

  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Audio file is required' });
  }

  try {
    const [rooms] = await db.query(
      'SELECT * FROM rooms WHERE code = ? AND is_active = TRUE',
      [roomCode.toUpperCase()]
    );

    if (rooms.length === 0) {
      return res.status(404).json({ success: false, message: 'Room not found' });
    }

    const room = rooms[0];

    const [orderRows] = await db.query(
      'SELECT COALESCE(MAX(order_index), -1) + 1 AS next_index FROM queue WHERE room_id = ?',
      [room.id]
    );
    const orderIndex = orderRows[0].next_index;

    const filePath = `uploads/${req.file.filename}`;

    const [result] = await db.query(
      `INSERT INTO queue (room_id, file_path, track_name, artist, added_by, order_index, is_played)
       VALUES (?, ?, ?, ?, ?, ?, FALSE)`,
      [room.id, filePath, trackName, artist, addedBy, orderIndex]
    );

    const trackId = result.insertId;
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const fileUrl = `${baseUrl}/${filePath}`;

    return res.status(201).json({
      success: true,
      trackId,
      fileUrl,
      message: 'Track added to queue',
    });
  } catch (err) {
    console.error('Queue add error:', err);
    return res.status(500).json({ success: false, message: 'Server error adding track' });
  }
});

module.exports = router;
