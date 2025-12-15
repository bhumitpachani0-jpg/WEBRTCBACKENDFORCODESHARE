// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const corsOptions = {
  origin: "https://www.codeshare.online",
  methods: ["GET", "POST"],
  credentials: true
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/codeshare')
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Room Schema
const roomSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true, index: true },
  files: [{
    id: { type: String, required: true },
    name: { type: String, required: true },
    content: { type: String, default: '' },
    language: { type: String, default: 'javascript' }
  }],
  notes: [{
    id: { type: String, required: true },
    name: { type: String, required: true },
    content: { type: String, default: '' }
  }],
  createdAt: { type: Date, default: Date.now, expires: 86400 } // 24-hour TTL
});

const Room = mongoose.model('Room', roomSchema);
const roomUsers = new Map(); // roomId -> Set<socket.id>

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);
  let currentRoom = null;

  socket.on('join-room', async (roomId) => {
    // Room full check
    if (roomUsers.has(roomId) && roomUsers.get(roomId).size >= 2) {
      socket.emit('room-full');
      return;
    }

    currentRoom = roomId;
    socket.join(roomId);

    if (!roomUsers.has(roomId)) roomUsers.set(roomId, new Set());
    roomUsers.get(roomId).add(socket.id);

    socket.emit('user-id', socket.id);

    // Load or create room
    let room = await Room.findOne({ roomId });
    if (!room) {
      room = await Room.create({
        roomId,
        files: [{
          id: 'default',
          name: 'main.js',
          content: '// Welcome to CodeShare.online!\n// Start typing your code here...\n\nconsole.log("Hello, World!");',
          language: 'javascript'
        }],
        notes: [{
          id: 'default',
          name: 'Notes',
          content: '# Notes\n\nStart writing your notes here...'
        }]
      });
    }

    // Send fresh data from DB
    socket.emit('sync', {
      files: room.files,
      notes: room.notes
    });

    // Update user count
    const userList = Array.from(roomUsers.get(roomId));
    io.to(roomId).emit('users-update', userList);
  });

  // Helper: broadcast latest room state to all in room
  const broadcastLatestState = async () => {
    if (!currentRoom) return;
    const room = await Room.findOne({ roomId: currentRoom });
    if (room) {
      io.to(currentRoom).emit('sync', {
        files: room.files,
        notes: room.notes
      });
    }
  };

  // File Events
  socket.on('file-create', async (file) => {
    if (!currentRoom) return;
    await Room.updateOne({ roomId: currentRoom }, { $push: { files: file } });
    await broadcastLatestState();
  });

  socket.on('file-update', async (data) => {
    if (!currentRoom) return;
    const setFields = {};
    if (data.content !== undefined) setFields['files.$.content'] = data.content;
    if (data.language !== undefined) setFields['files.$.language'] = data.language;

    await Room.updateOne(
      { roomId: currentRoom, 'files.id': data.fileId },
      { $set: setFields }
    );
    await broadcastLatestState();
  });

  socket.on('file-rename', async (data) => {
    if (!currentRoom) return;
    await Room.updateOne(
      { roomId: currentRoom, 'files.id': data.fileId },
      { $set: { 'files.$.name': data.name } }
    );
    await broadcastLatestState();
  });

  socket.on('file-delete', async (fileId) => {
    if (!currentRoom) return;
    await Room.updateOne(
      { roomId: currentRoom },
      { $pull: { files: { id: fileId } } }
    );
    await broadcastLatestState();
  });

  // Note Events
  socket.on('note-create', async (note) => {
    if (!currentRoom) return;
    await Room.updateOne({ roomId: currentRoom }, { $push: { notes: note } });
    await broadcastLatestState();
  });

  socket.on('note-update', async (data) => {
    if (!currentRoom) return;
    await Room.updateOne(
      { roomId: currentRoom, 'notes.id': data.noteId },
      { $set: { 'notes.$.content': data.content } }
    );
    await broadcastLatestState();
  });

  socket.on('note-rename', async (data) => {
    if (!currentRoom) return;
    await Room.updateOne(
      { roomId: currentRoom, 'notes.id': data.noteId },
      { $set: { 'notes.$.name': data.name } }
    );
    await broadcastLatestState();
  });

  socket.on('note-delete', async (noteId) => {
    if (!currentRoom) return;
    await Room.updateOne(
      { roomId: currentRoom },
      { $pull: { notes: { id: noteId } } }
    );
    await broadcastLatestState();
  });

  // Chat & other events
  socket.on('chat-message', (data) => {
    if (currentRoom) socket.to(currentRoom).emit('chat-message', data);
  });

  // WebRTC signaling (unchanged)
  socket.on('call-request', () => { if (currentRoom) socket.to(currentRoom).emit('call-request', socket.id); });
  socket.on('call-accepted', () => { if (currentRoom) socket.to(currentRoom).emit('call-accepted'); });
  socket.on('call-rejected', () => { if (currentRoom) socket.to(currentRoom).emit('call-rejected'); });
  socket.on('call-ended', () => { if (currentRoom) socket.to(currentRoom).emit('call-ended'); });
  socket.on('offer', (offer) => { if (currentRoom) socket.to(currentRoom).emit('offer', offer); });
  socket.on('answer', (answer) => { if (currentRoom) socket.to(currentRoom).emit('answer', answer); });
  socket.on('ice-candidate', (candidate) => { if (currentRoom) socket.to(currentRoom).emit('ice-candidate', candidate); });

  // Media toggles
  socket.on('video-toggle', (data) => { if (currentRoom) socket.to(currentRoom).emit('video-toggle', data); });
  socket.on('audio-toggle', (data) => { if (currentRoom) socket.to(currentRoom).emit('audio-toggle', data); });
  socket.on('screen-share-toggle', (data) => { if (currentRoom) socket.to(currentRoom).emit('screen-share-toggle', data); });

  socket.on('disconnect', () => {
    console.log('🔌 User disconnected:', socket.id);
    if (currentRoom && roomUsers.has(currentRoom)) {
      roomUsers.get(currentRoom).delete(socket.id);
      socket.to(currentRoom).emit('call-ended');
      if (roomUsers.get(currentRoom).size === 0) {
        roomUsers.delete(currentRoom);
      } else {
        io.to(currentRoom).emit('users-update', Array.from(roomUsers.get(currentRoom)));
      }
    }
  });
});

// Cleanup old rooms
cron.schedule('0 * * * *', async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await Room.deleteMany({ createdAt: { $lt: cutoff } });
  console.log(`🗑️ Deleted ${result.deletedCount} expired rooms`);
});

// API endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', rooms: roomUsers.size, connections: io.engine.clientsCount });
});

app.get('/api/room/:roomId', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json({ ...room.toObject(), userCount: roomUsers.get(req.params.roomId)?.size || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
