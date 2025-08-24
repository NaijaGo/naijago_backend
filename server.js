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
const { PythonShell } = require('python-shell');
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
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || '*',
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  credentials: true,
}));

// Rate limit auth endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/auth', authLimiter);

// Static (if using local uploads)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/vendor', require('./routes/vendorRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/products', require('./routes/productRoutes'));
app.use('/api/orders', require('./routes/orderRoutes'));
app.use('/api/reviews', require('./routes/reviewsRoutes'));
app.use('/api/wallet', require('./routes/walletRoutes'));
app.use('/api/returns', require('./routes/returnsRoutes'));
app.use('/api/disputes', require('./routes/disputesRoutes'));
app.use('/api/uploads', require('./routes/uploadsRoutes'));

// Health/root
app.get('/', (req, res) => res.json({ message: 'NaijaGo Backend API is running!' }));

// HTTP + Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_ORIGIN || '*', methods: ['GET','POST'] },
  pingTimeout: 60000
});

// Socket auth
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

const Message = require('./models/Message');
const DisputeRequest = require('./models/DisputeRequest');

// Expose io to controllers
app.set('io', io);

io.on('connection', (socket) => {
  console.log('Socket connected', socket.user?.id);

  socket.on('joinDispute', async (disputeId) => {
    socket.join(`dispute_${disputeId}`);
  });

  socket.on('leaveDispute', (disputeId) => {
    socket.leave(`dispute_${disputeId}`);
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
        attachments
      });
      dispute.messages.push({ sender: socket.user.id, text, attachments });
      await dispute.save();

      const out = {
        id: messageDoc._id,
        dispute: String(disputeId),
        sender: socket.user.id,
        text,
        attachments,
        createdAt: messageDoc.createdAt
      };
      io.to(`dispute_${disputeId}`).emit('message', out);
      if (cb) cb({ success: true, message: out });
    } catch (err) {
      console.error('sendMessage socket error', err);
      if (cb) cb({ error: 'Failed to send message' });
    }
  });

  socket.on('disconnect', () => {});
});

// 404 + error handler (must be last)
app.use(notFound);
app.use(errorHandler);

server.listen(PORT, '0.0.0.0', () => {
  console.log(colors.cyan.underline(`Server running on http://0.0.0.0:${PORT}`));
});
