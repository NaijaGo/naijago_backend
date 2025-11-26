// server.js (production-ready - replace your existing server.js after backup)
const express = require('express');
const dotenv = require('dotenv').config();
const colors = require('colors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const fs = require('fs');

const connectDB = require('./config/db');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');

const app = express();
app.set('trust proxy', true);

connectDB();

const PORT = process.env.PORT || 5000;

// Core middleware
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// CORS (tighten in prod)
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  })
);

// Rate limit auth endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/auth', authLimiter);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes (unchanged)
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/vendor', require('./routes/vendorRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/products', require('./routes/productRoutes'));
app.use('/api/orders', require('./routes/orderRoutes'));
app.use('/api/reviews', require('./routes/reviewsRoutes'));
app.use('/api/wallet', require('./routes/walletRoutes'));
app.use('/api/returns', require('./routes/returnsRoutes'));
app.use('/api/chat', require('./routes/chatRoutes'));
app.use('/api/chatbot', require('./routes/chatbotRoutes'));
app.use('/api/disputes', require('./routes/disputesRoutes'));
app.use('/api/uploads', require('./routes/uploadsRoutes'));

// Health/root
app.get('/', (req, res) => res.json({ message: 'NaijaGo Backend API is running!' }));

// HTTP + Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_ORIGIN || '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
});

// Socket auth (JWT handshake)
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Auth error'));
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    return next();
  } catch (err) {
    console.error('Socket auth failed', err);
    next(new Error('Auth error'));
  }
});

// Existing models (leave intact)
const Message = require('./models/Message');
const DisputeRequest = require('./models/DisputeRequest');

// Chat models & user model
const ChatSession = require('./models/ChatSession');
const ChatMessage = require('./models/ChatMessage');
const User = require('./models/User'); // used for available pharmacist lookup

// AI helper
const { getAIResponse } = require('./utils/aiChatService');

// expose io to controllers
app.set('io', io);

// -------------------
// Chat & presence socket logic (production-ready)
// -------------------

// In-memory map: pharmacistId -> socketId (for connected pharmacists)
// NOTE: for horizontal scaling use socket.io-redis adapter and a shared presence store.
const onlinePharmacists = new Map();
app.set('onlinePharmacists', onlinePharmacists);

// Helper to read common id/role fields from JWT payload
function socketUserId(payload) {
  return payload?.sub || payload?.id || payload?._id || payload?.userId || null;
}
function socketUserRole(payload) {
  return payload?.role || payload?.user_role || payload?.userRole || null;
}

function broadcastPharmacistStatus() {
  const count = onlinePharmacists.size;
  io.emit('pharmacistStatus', { online: count > 0, count });
}

/**
 * Helper function to create and emit a system/info message.
 * @param {string} sessionId - ID of the chat room
 * @param {string} text - The system message text
 */
async function emitSystemMessage(sessionId, text) {
  try {
    const sysMsg = await ChatMessage.create({
      session: sessionId,
      senderType: 'system', // Use 'system' for announcements/events
      sender: null,
      message: text,
    });

    const outSys = {
      id: sysMsg._id,
      session: String(sessionId),
      senderType: 'system',
      sender: null,
      text: sysMsg.message,
      createdAt: sysMsg.createdAt,
    };
    io.to(`chat_${sessionId}`).emit('new_message', outSys);
    return outSys;
  } catch (error) {
    console.error('Failed to emit system message:', error);
  }
}


io.on('connection', (socket) => {
  try {
    const decoded = socket.user || {};
    const userId = socketUserId(decoded);
    const userRole = socketUserRole(decoded);

    console.log('Socket connected', { userId, userRole, socketId: socket.id });

    // If pharmacist connected via socket, track presence
    if (userRole === 'pharmacist' && userId) {
      onlinePharmacists.set(String(userId), socket.id);
      console.log('Pharmacist online ->', userId);
      broadcastPharmacistStatus();
    }

    // ========== Keep existing dispute handlers (unchanged) ==========
    socket.on('joinDispute', async (disputeId) => {
      try {
        socket.join(`dispute_${disputeId}`);
      } catch (err) {
        console.error('joinDispute error', err);
      }
    });

    socket.on('leaveDispute', (disputeId) => {
      try {
        socket.leave(`dispute_${disputeId}`);
      } catch (err) {
        console.error('leaveDispute error', err);
      }
    });

    socket.on('sendMessage', async (payload, cb) => {
      try {
        const { disputeId, text = '', attachments = [] } = payload;
        const dispute = await DisputeRequest.findById(disputeId);
        if (!dispute) return cb && cb({ error: 'Dispute not found' });

        const messageDoc = await Message.create({
          dispute: disputeId,
          sender: socket.user.id,
          text,
          attachments,
        });
        dispute.messages.push({ sender: socket.user.id, text, attachments });
        await dispute.save();

        const out = {
          id: messageDoc._id,
          dispute: String(disputeId),
          sender: socket.user.id,
          text,
          attachments,
          createdAt: messageDoc.createdAt,
        };
        io.to(`dispute_${disputeId}`).emit('message', out);
        if (cb) cb({ success: true, message: out });
      } catch (err) {
        console.error('sendMessage socket error', err);
        if (cb) cb({ error: 'Failed to send message' });
      }
    });
    // ========== End dispute handlers ==========

    // ========== Chat session handlers (UPDATED) ==========

//     // join_chat: client joins room and requests history
//     socket.on('join_chat', async (payload, cb) => {
//       try {
//         const { sessionId } = payload || {};
//         if (!sessionId) return cb && cb({ error: 'sessionId required' });

//         socket.join(`chat_${sessionId}`);

//         const session = await ChatSession.findById(sessionId).lean();
//         const messages = session
//           ? await ChatMessage.find({ session: session._id }).sort({ createdAt: 1 }).lean()
//           : [];
//         
//         // If a pharmacist is connecting, update their availability status in DB and notify user if they are the assigned pharmacist
//         if (userRole === 'pharmacist' && userId) {
//           // This ensures that if a pharmacist connects, they are marked as available in the DB
//           await User.findByIdAndUpdate(userId, { isAvailable: true }); 
//         }

//         return cb && cb({ success: true, session, messages });
//       } catch (err) {
//         console.error('join_chat error', err);
//         return cb && cb({ error: 'join failed' });
//       }
//     });

    // ... (Lines 265 - 280)

    // join_chat: client joins room and requests history
    socket.on('join_chat', async (payload, cb) => {
      try {
        const { sessionId } = payload || {};
        if (!sessionId) {
            console.error('join_chat: sessionId required');
            // 🔑 FIX: Return a clean error object on missing ID
            return cb && cb({ success: false, message: 'Session ID is required' });
        }

        socket.join(`chat_${sessionId}`);

        const session = await ChatSession.findById(sessionId).lean();
        
        if (!session) {
            console.error(`join_chat: Session not found for ID: ${sessionId}`);
            // 🔑 FIX: Return a clean error object if session is not found
            return cb && cb({ success: false, message: 'Chat session not found' });
        }
        
        const messages = await ChatMessage.find({ session: session._id }).sort({ createdAt: 1 }).lean();

        // If a pharmacist is connecting, update their availability status in DB and notify user if they are the assigned pharmacist
        if (userRole === 'pharmacist' && userId) {
          await User.findByIdAndUpdate(userId, { isAvailable: true }); 
        }

        // 🔑 CRITICAL FIX: Ensure the successful object keys match Flutter's expected structure
        // This is what Flutter is now expecting: { success: true, session: {...}, messages: [...] }
        return cb && cb({ 
            success: true, 
            session: session, // The full session object
            messages: messages // The array of messages (can be empty)
        });
        
      } catch (err) {
        console.error('join_chat error:', err);
        // 🔑 FIX: Return a clean error object on server error
        return cb && cb({ success: false, message: 'Server error during chat join' });
      }
    });

    // leave_chat
    socket.on('leave_chat', ({ sessionId }) => {
      try {
        if (!sessionId) return;
        socket.leave(`chat_${sessionId}`);
      } catch (err) {
        console.error('leave_chat error', err);
      }
    });

    // send_chat_message: core message flow (user -> AI/human)
    socket.on('send_chat_message', async (payload, cb) => {
      try {
        const { sessionId, text } = payload || {};
        if (!sessionId || !text) return cb && cb({ error: 'sessionId and text required' });

        const session = await ChatSession.findById(sessionId);
        if (!session) return cb && cb({ error: 'session not found' });

        // Only allow AI/Pharmacist to send if they are the current assignment or AI is still active
        if (userRole === 'pharmacist' && String(session.pharmacist) !== String(userId)) {
          return cb && cb({ error: 'pharmacist is not assigned to this session' });
        }

        // determine sender type
        const senderType = userRole === 'pharmacist' ? 'pharmacist' : 'user';
        const sender = userId || null;

        // persist user message
        const userMsg = await ChatMessage.create({
          session: session._id,
          senderType,
          sender,
          message: text,
        });

        const outUser = {
          id: userMsg._id,
          session: String(session._id),
          senderType: userMsg.senderType,
          sender,
          text: userMsg.message,
          createdAt: userMsg.createdAt,
        };

        // broadcast user's message to the room
        io.to(`chat_${sessionId}`).emit('new_message', outUser);

        // *** AI/Pharmacist Logic: Only AI replies if pharmacist is NULL ***

        // If session already assigned to a pharmacist (or pharmacist sent the message) -> human handles replies. AI stops.
        if (session.pharmacist || senderType === 'pharmacist') return cb && cb({ success: true, message: outUser });

        // If no pharmacist assigned, check for availability / fall back to AI
        
        // Check for available pharmacists (online via socket OR marked isAvailable: true in DB)
        let availablePharmacistId = onlinePharmacists.keys().next().value;
        let availablePharmacistDetails = null;

        if (availablePharmacistId) {
          availablePharmacistDetails = await User.findById(availablePharmacistId, 'name');
        } else {
          // No socket-connected pharmacist — check DB for any pharmacist marked isAvailable: true
          availablePharmacistDetails = await User.findOne({ role: 'pharmacist', isAvailable: true }).lean();
        }

        // If any pharmacist is available (either via socket or DB flag), notify them and queue the user.
        if (availablePharmacistDetails) {
          const pharmId = String(availablePharmacistDetails._id || availablePharmacistId);

          // Send notification event to the specific pharmacist's socket (if they are online)
          const pharmacistSocketId = onlinePharmacists.get(pharmId);
          if (pharmacistSocketId) {
            io.to(pharmacistSocketId).emit('incoming_chat_request', {
              sessionId: String(session._id),
              userId: session.user,
              textPreview: text.slice(0, 300),
              createdAt: new Date(),
            });
          }

          // system message to user while waiting for claim
          await emitSystemMessage(
            session._id,
            'A certified pharmacist has been notified. They will join the chat shortly. The AI is on standby.'
          );

          return cb && cb({ success: true, message: outUser, waitingForPharmacist: true });
        }

        // No pharmacist available -> call AI fallback
        const aiReplyText = await getAIResponse(text);

        const aiMsg = await ChatMessage.create({
          session: session._id,
          senderType: 'ai',
          sender: null,
          message: aiReplyText,
        });

        const outAi = {
          id: aiMsg._id,
          session: String(session._id),
          senderType: 'ai',
          sender: null,
          text: aiMsg.message,
          createdAt: aiMsg.createdAt,
        };

        io.to(`chat_${sessionId}`).emit('new_message', outAi);

        return cb && cb({ success: true, message: outUser, aiReply: outAi });
      } catch (err) {
        console.error('send_chat_message error', err);
        return cb && cb({ error: 'failed to send' });
      }
    });

    // pharmacist_claim_session: pharmacist accepts a session (socket MUST be a pharmacist)
    socket.on('pharmacist_claim_session', async (payload, cb) => {
      try {
        const { sessionId } = payload || {};
        if (!sessionId) return cb && cb({ error: 'sessionId required' });
        if (userRole !== 'pharmacist') return cb && cb({ error: 'only pharmacists can claim' });

        const session = await ChatSession.findById(sessionId);
        if (!session) return cb && cb({ error: 'session not found' });

        // Double check if already assigned to prevent overwrites
        if (session.pharmacist) {
          return cb && cb({ success: false, message: 'Session already claimed.' });
        }

        // Update session
        session.pharmacist = userId;
        session.status = 'assigned';
        await session.save();

        // Fetch pharmacist name for announcement
        const pharmacistUser = await User.findById(userId, 'firstName lastName');
        const pharmacistName = pharmacistUser ? `${pharmacistUser.firstName} ${pharmacistUser.lastName}` : 'A certified pharmacist';

        // Emit the system message to the user: "Name of pharmacist" joined the chat room
        await emitSystemMessage(
          session._id,
          `${pharmacistName} has joined the chat room. The AI has stepped aside.`
        );
        
        // Also emit the pharmacist_joined event for client-side state management (e.g., turning off AI typing indicator)
        io.to(`chat_${sessionId}`).emit('pharmacist_joined', {
          pharmacistId: session.pharmacist,
          name: pharmacistName,
        });

        return cb && cb({ success: true, session });
      } catch (err) {
        console.error('pharmacist_claim_session error', err);
        return cb && cb({ error: 'claim failed' });
      }
    });

    // handle disconnect: cleanup presence map & broadcast
    socket.on('disconnect', async () => {
      try {
        if (userRole === 'pharmacist' && userId) {
          // Remove from in-memory map
          for (const [pharmId, sId] of onlinePharmacists.entries()) {
            if (sId === socket.id) onlinePharmacists.delete(pharmId);
          }
          
          // Update DB status (logged out status to determine availability)
          await User.findByIdAndUpdate(userId, { isAvailable: false });

          broadcastPharmacistStatus();
          console.log('Pharmacist disconnected:', userId);
        } else {
          console.log('Socket disconnected', socket.id);
        }
      } catch (err) {
        console.error('disconnect error', err);
      }
    });
  } catch (outerErr) {
    console.error('socket connection error', outerErr);
  }
});
// ------------------- end socket logic -------------------

// 404 + error handler (must be last)
app.use(notFound);
app.use(errorHandler);

server.listen(PORT, '0.0.0.0', () => {
  console.log(colors.cyan.underline(`Server running on http://0.0.0.0:${PORT}`));
});