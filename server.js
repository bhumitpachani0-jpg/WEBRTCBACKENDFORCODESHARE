// server.js - Enhanced with Multi-File & Multi-Note Persistence
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

// Middleware
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/codeshare')
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Enhanced Room Schema with Files and Notes arrays
const roomSchema = new mongoose.Schema({
  roomId: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  files: [{
    id: String,
    name: String,
    content: String,
    language: String
  }],
  notes: [{
    id: String,
    name: String,
    content: String
  }],
  activeFileId: String,
  activeNoteId: String,
  createdAt: { 
    type: Date, 
    default: Date.now
  },
  lastActivity: {
    type: Date,
    default: Date.now,
    expires: 86400 // TTL: 24 hours from last activity (auto-delete)
  }
});

// Update lastActivity on any change
roomSchema.pre('save', function(next) {
  this.lastActivity = new Date();
  next();
});

const Room = mongoose.model('Room', roomSchema);

// Track users in each room (max 2 per room)
const roomUsers = new Map();

io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);
  let currentRoom = null;

  // Join room with 2-user limit
  socket.on('join-room', async (roomId) => {
    try {
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

      // Get or create room data with default files and notes
      let room = await Room.findOne({ roomId });
      
      if (!room) {
        // Create new room with default file and note
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
          }],
          activeFileId: 'default',
          activeNoteId: 'default'
        });
        console.log('✨ Created new room:', roomId);
      } else {
        // Update last activity
        room.lastActivity = new Date();
        await room.save();
        console.log('📂 Loaded existing room:', roomId);
      }

      // Send current room state to the joining user
      socket.emit('sync', {
        files: room.files || [],
        notes: room.notes || [],
        activeFileId: room.activeFileId || 'default',
        activeNoteId: room.activeNoteId || 'default'
      });

      // Notify all users about user count
      const userList = Array.from(roomUsers.get(roomId));
      io.to(roomId).emit('users-update', userList);
      console.log(`👥 Users in room ${roomId}: ${userList.length}`);
    } catch (error) {
      console.error('❌ Error joining room:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // ========== FILE OPERATIONS ==========
  
  socket.on('file-create', async (file) => {
    if (!currentRoom) return;
    
    try {
      await Room.findOneAndUpdate(
        { roomId: currentRoom },
        { 
          $push: { files: file },
          $set: { activeFileId: file.id, lastActivity: new Date() }
        }
      );
      
      console.log('📁 File created:', file.name);
      socket.to(currentRoom).emit('file-create', file);
    } catch (error) {
      console.error('❌ Error creating file:', error);
    }
  });

  socket.on('file-update', async (data) => {
    if (!currentRoom) return;
    
    try {
      const update = {
        'files.$.content': data.content,
        lastActivity: new Date()
      };
      
      if (data.language) {
        update['files.$.language'] = data.language;
      }
      
      await Room.findOneAndUpdate(
        { roomId: currentRoom, 'files.id': data.fileId },
        { $set: update }
      );
      
      socket.to(currentRoom).emit('file-update', data);
    } catch (error) {
      console.error('❌ Error updating file:', error);
    }
  });

  socket.on('file-rename', async (data) => {
    if (!currentRoom) return;
    
    try {
      await Room.findOneAndUpdate(
        { roomId: currentRoom, 'files.id': data.fileId },
        { 
          $set: { 
            'files.$.name': data.name,
            lastActivity: new Date()
          }
        }
      );
      
      console.log('✏️ File renamed:', data.name);
      socket.to(currentRoom).emit('file-rename', data);
    } catch (error) {
      console.error('❌ Error renaming file:', error);
    }
  });

  socket.on('file-delete', async (fileId) => {
    if (!currentRoom) return;
    
    try {
      const room = await Room.findOne({ roomId: currentRoom });
      
      // Don't allow deleting the last file
      if (room.files.length <= 1) {
        socket.emit('error', { message: 'Cannot delete the last file' });
        return;
      }
      
      await Room.findOneAndUpdate(
        { roomId: currentRoom },
        { 
          $pull: { files: { id: fileId } },
          $set: { lastActivity: new Date() }
        }
      );
      
      console.log('🗑️ File deleted:', fileId);
      socket.to(currentRoom).emit('file-delete', fileId);
    } catch (error) {
      console.error('❌ Error deleting file:', error);
    }
  });

  // ========== NOTE OPERATIONS ==========
  
  socket.on('note-create', async (note) => {
    if (!currentRoom) return;
    
    try {
      await Room.findOneAndUpdate(
        { roomId: currentRoom },
        { 
          $push: { notes: note },
          $set: { activeNoteId: note.id, lastActivity: new Date() }
        }
      );
      
      console.log('📓 Note created:', note.name);
      socket.to(currentRoom).emit('note-create', note);
    } catch (error) {
      console.error('❌ Error creating note:', error);
    }
  });

  socket.on('note-update', async (data) => {
    if (!currentRoom) return;
    
    try {
      await Room.findOneAndUpdate(
        { roomId: currentRoom, 'notes.id': data.noteId },
        { 
          $set: { 
            'notes.$.content': data.content,
            lastActivity: new Date()
          }
        }
      );
      
      socket.to(currentRoom).emit('note-update', data);
    } catch (error) {
      console.error('❌ Error updating note:', error);
    }
  });

  socket.on('note-rename', async (data) => {
    if (!currentRoom) return;
    
    try {
      await Room.findOneAndUpdate(
        { roomId: currentRoom, 'notes.id': data.noteId },
        { 
          $set: { 
            'notes.$.name': data.name,
            lastActivity: new Date()
          }
        }
      );
      
      console.log('✏️ Note renamed:', data.name);
      socket.to(currentRoom).emit('note-rename', data);
    } catch (error) {
      console.error('❌ Error renaming note:', error);
    }
  });

  socket.on('note-delete', async (noteId) => {
    if (!currentRoom) return;
    
    try {
      const room = await Room.findOne({ roomId: currentRoom });
      
      // Don't allow deleting the last note
      if (room.notes.length <= 1) {
        socket.emit('error', { message: 'Cannot delete the last note' });
        return;
      }
      
      await Room.findOneAndUpdate(
        { roomId: currentRoom },
        { 
          $pull: { notes: { id: noteId } },
          $set: { lastActivity: new Date() }
        }
      );
      
      console.log('🗑️ Note deleted:', noteId);
      socket.to(currentRoom).emit('note-delete', noteId);
    } catch (error) {
      console.error('❌ Error deleting note:', error);
    }
  });

  // ========== CHAT ==========
  
  socket.on('chat-message', (data) => {
    if (!currentRoom) return;
    console.log('💬 Chat message in room:', currentRoom);
    socket.to(currentRoom).emit('chat-message', data);
  });

  socket.on('typing-start', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('typing-start');
  });

  socket.on('typing-stop', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('typing-stop');
  });

  // ========== VIDEO CALL SIGNALING ==========
  
  socket.on('video-toggle', (data) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('video-toggle', data);
  });

  socket.on('audio-toggle', (data) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('audio-toggle', data);
  });

  socket.on('screen-share-toggle', (data) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('screen-share-toggle', data);
  });

  socket.on('call-request', () => {
    if (!currentRoom) return;
    console.log('📞 Call request in room:', currentRoom);
    socket.to(currentRoom).emit('call-request', socket.id);
  });

  socket.on('call-accepted', () => {
    if (!currentRoom) return;
    console.log('✅ Call accepted in room:', currentRoom);
    socket.to(currentRoom).emit('call-accepted');
  });

  socket.on('call-rejected', () => {
    if (!currentRoom) return;
    console.log('❌ Call rejected in room:', currentRoom);
    socket.to(currentRoom).emit('call-rejected');
  });

  socket.on('call-ended', () => {
    if (!currentRoom) return;
    console.log('📴 Call ended in room:', currentRoom);
    socket.to(currentRoom).emit('call-ended');
  });

  socket.on('offer', (offer) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('offer', offer);
  });

  socket.on('answer', (answer) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('answer', answer);
  });

  socket.on('ice-candidate', (candidate) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('ice-candidate', candidate);
  });

  // ========== DISCONNECT ==========
  
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

// Cleanup cron job - runs every hour
cron.schedule('0 * * * *', async () => {
  console.log('🧹 Running cleanup job...');
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await Room.deleteMany({ lastActivity: { $lt: cutoff } });
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
    res.json({ 
      roomId: room.roomId,
      filesCount: room.files?.length || 0,
      notesCount: room.notes?.length || 0,
      userCount, 
      maxUsers: 2,
      createdAt: room.createdAt,
      lastActivity: room.lastActivity
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket ready for connections`);
  console.log(`⏰ Room data persists for 24 hours`);
});
