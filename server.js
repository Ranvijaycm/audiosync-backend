require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/room');
const initSocket = require('./socket/index');

const app = express();
const server = http.createServer(app);

// ── Socket.IO setup ──────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: '*',        // In production, restrict to your app's domain
    methods: ['GET', 'POST'],
  },
});

// ── Middleware ───────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded audio files statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Routes ───────────────────────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/room', roomRoutes);

// Health check
app.get('/', (req, res) => {
  res.json({ success: true, message: 'AudioSync server is running 🎵' });
});

// ── Socket.IO events ──────────────────────────────────────────────────────
initSocket(io);

// ── Start server ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎵 AudioSync server running on port ${PORT}`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Android emulator: http://10.0.2.2:${PORT}\n`);
});