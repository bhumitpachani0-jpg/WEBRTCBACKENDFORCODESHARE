// server.js - Main Express + Socket.IO Server
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
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/codeshare')
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Room Schema with TTL (auto-delete after 24 hours)
const roomSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true, index: true },
  code: { type: String, default: '// Welcome to CodeShare.online!\n// Start typing your code here...\n\nconsole.log("Hello, World!");' },
  notepad: { type: String, default: '# Notes\n\nStart writing your notes here...' },
  language: { type: String, default: 'javascript' },
  createdAt: { type: Date, default: Date.now, expires: 86400 } // TTL: 24 hours
});

const Room = mongoose.model('Room', roomSchema);

// Track users in each room (max 2 per room)
const roomUsers = new Map(); // roomId -> Set of socket IDs

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);
  let currentRoom = null;

  // Join room with 2-user limit
  socket.on('join-room', async (roomId) => {
    // Check if room is full
    if (roomUsers.has(roomId) && roomUsers.get(roomId).size >= 2) {
      socket.emit('room-full');
      console.log('🚫 Room full:', roomId);
      return;
    }

    currentRoom = roomId;
    socket.join(roomId);

    // Track users
    if (!roomUsers.has(roomId)) {
      roomUsers.set(roomId, new Set());
    }
    roomUsers.get(roomId).add(socket.id);

    // Send user their ID
    socket.emit('user-id', socket.id);

    // Get or create room data
    let room = await Room.findOne({ roomId });
    if (!room) {
      room = await Room.create({ roomId });
    }

    // Send current room state
    socket.emit('sync', {
      code: room.code,
      notepad: room.notepad,
      language: room.language
    });

    // Notify all users about user count
    const userList = Array.from(roomUsers.get(roomId));
    io.to(roomId).emit('users-update', userList);
    console.log(`👥 Users in room ${roomId}: ${userList.length}`);
  });

  // Real-time code sync
  socket.on('code-update', async (data) => {
    if (!currentRoom) return;
    
    await Room.findOneAndUpdate(
      { roomId: currentRoom },
      { code: data },
      { upsert: true }
    );
    
    socket.to(currentRoom).emit('code-update', data);
  });

  // Real-time notepad sync
  socket.on('notepad-update', async (data) => {
    if (!currentRoom) return;
    
    await Room.findOneAndUpdate(
      { roomId: currentRoom },
      { notepad: data },
      { upsert: true }
    );
    
    socket.to(currentRoom).emit('notepad-update', data);
  });

  // Language change sync
  socket.on('language-update', async (data) => {
    if (!currentRoom) return;
    
    await Room.findOneAndUpdate(
      { roomId: currentRoom },
      { language: data },
      { upsert: true }
    );
    
    socket.to(currentRoom).emit('language-update', data);
  });

  // ========== WebRTC Video Call Signaling ==========
  
  // User initiates a call
  socket.on('call-request', () => {
    if (!currentRoom) return;
    console.log('📞 Call request in room:', currentRoom);
    socket.to(currentRoom).emit('call-request', socket.id);
  });

  // User accepts the call
  socket.on('call-accepted', () => {
    if (!currentRoom) return;
    console.log('✅ Call accepted in room:', currentRoom);
    socket.to(currentRoom).emit('call-accepted');
  });

  // User rejects the call
  socket.on('call-rejected', () => {
    if (!currentRoom) return;
    console.log('❌ Call rejected in room:', currentRoom);
    socket.to(currentRoom).emit('call-rejected');
  });

  // User ends the call
  socket.on('call-ended', () => {
    if (!currentRoom) return;
    console.log('📴 Call ended in room:', currentRoom);
    socket.to(currentRoom).emit('call-ended');
  });

  // WebRTC SDP Offer
  socket.on('offer', (offer) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('offer', offer);
  });

  // WebRTC SDP Answer
  socket.on('answer', (answer) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('answer', answer);
  });

  // WebRTC ICE Candidate
  socket.on('ice-candidate', (candidate) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('ice-candidate', candidate);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('🔌 User disconnected:', socket.id);
    
    if (currentRoom && roomUsers.has(currentRoom)) {
      roomUsers.get(currentRoom).delete(socket.id);
      
      // Notify remaining user about call end
      socket.to(currentRoom).emit('call-ended');
      
      if (roomUsers.get(currentRoom).size === 0) {
        roomUsers.delete(currentRoom);
      } else {
        io.to(currentRoom).emit('users-update', Array.from(roomUsers.get(currentRoom)));
      }
    }
  });
});

// Cleanup cron job - runs every hour
cron.schedule('0 * * * *', async () => {
  console.log('🧹 Running cleanup job...');
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await Room.deleteMany({ createdAt: { $lt: cutoff } });
  console.log(`🗑️ Deleted ${result.deletedCount} old rooms`);
});

// REST API Endpoints
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    rooms: roomUsers.size,
    connections: io.engine.clientsCount
  });
});

app.get('/api/room/:roomId', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    const userCount = roomUsers.get(req.params.roomId)?.size || 0;
    res.json({ ...room.toObject(), userCount, maxUsers: 2 });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket ready for connections`);
});