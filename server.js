
// server.js (UPDATED WITH BOTH INDIVIDUAL & COMPANY RIDERS)
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
const { initializeReferralProgramSettings } = require('./services/referralService');
const { initializeDeliveryFeeSettings } = require('./services/deliveryFeeService');
const { initializePharmacySubscriptionSettings } = require('./services/pharmacySubscriptionService');
const { startScheduledNotificationRunner } = require('./services/scheduledNotificationRunner');
const notificationService = require('./services/notificationService');
const { cleanupObsoleteIndexes } = require('./utils/dbIndexMaintenance');

const app = express();
app.set('trust proxy', true);

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

// Routes (KEEP BOTH - add company routes, keep rider routes)
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/referrals', require('./routes/referralRoutes'));
app.use('/api/referral', require('./routes/referralRoutes'));
app.use('/api/carousels', require('./routes/carouselRoutes'));
app.use('/api/companies', require('./routes/companyRoutes')); // ADDED
app.use('/api/vendor', require('./routes/vendorRoutes'));
app.use('/api/pharmacist', require('./routes/pharmacistRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/admin', require('./routes/adminCarouselRoutes'));
app.use('/api/products', require('./routes/productRoutes'));
app.use('/api/orders', require('./routes/orderRoutes'));
app.use('/api/reviews', require('./routes/reviewsRoutes'));
app.use('/api/wallet', require('./routes/walletRoutes'));
app.use('/api/subscriptions', require('./routes/subscriptionRoutes'));
app.use('/api/returns', require('./routes/returnsRoutes'));
app.use('/api/chat', require('./routes/chatRoutes'));
// AI chatbot is intentionally not mounted; pharmacy consultations are human-only.
app.use('/api/disputes', require('./routes/disputesRoutes'));
app.use('/api/riders', require('./routes/riderRoutes')); // KEEP THIS!
app.use('/api/mapbox', require('./routes/mapboxRoutes'));
app.use('/api/uploads', require('./routes/uploadsRoutes'));
app.use('/api/analytics', require('./routes/analyticsRoutes'));
app.use('/api/food-readiness-campaigns', require('./routes/foodReadinessCampaignRoutes'));

// Add this near your other route middleware
app.use('/api/companyadmin',  require('./routes/adminCompanyRoutes'));

// Health/root
app.get('/', (req, res) => res.json({ 
  message: 'NaijaGo Backend API is running!',
  features: 'Individual Riders + Company System'
}));

// HTTP + Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_ORIGIN || '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  }
});

// Socket auth (JWT handshake)
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication token required'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const UserModel = require('./models/User');
    const RiderModel = require('./models/Rider');
    const CompanyModel = require('./models/Company');
    const CompanyRiderModel = require('./models/CompanyRider');

    let account = await UserModel.findById(decoded.id)
      .select('firstName lastName email role isAdmin isVendor vendorStatus pharmacistStatus')
      .lean();
    let inferredRole = decoded.role || account?.role || 'user';

    if (account?.isAdmin) {
      inferredRole = 'admin';
    } else if (account?.pharmacistStatus === 'approved' || account?.role === 'pharmacist') {
      inferredRole = 'pharmacist';
    } else if (account?.isVendor === true) {
      inferredRole = 'vendor';
    }

    if (!account) {
      account = await RiderModel.findById(decoded.id)
        .select('fullName email')
        .lean();
      if (account) {
        inferredRole = 'rider';
      }
    }

    if (!account) {
      account = await CompanyModel.findById(decoded.id)
        .select('companyName email')
        .lean();
      if (account) {
        inferredRole = 'company';
      }
    }

    if (!account) {
      account = await CompanyRiderModel.findById(decoded.id)
        .select('fullName email')
        .lean();
      if (account) {
        inferredRole = 'company_rider';
      }
    }

    if (!account) return next(new Error('Account not found'));

    const fullName = account.fullName || account.companyName || '';
    const [firstName = '', ...lastNameParts] = fullName.split(' ');
    socket.user = {
      id: decoded.id,
      role: inferredRole,
      email: decoded.email || account.email,
      firstName: decoded.firstName || account.firstName || firstName,
      lastName: decoded.lastName || account.lastName || lastNameParts.join(' ')
    };

    return next();
  } catch (err) {
    console.error('Socket auth failed:', err.message);
    next(new Error('Authentication failed'));
  }
});

// Existing models + New company models
const Message = require('./models/Message');
const DisputeRequest = require('./models/DisputeRequest');
const ChatSession = require('./models/ChatSession');
const ChatMessage = require('./models/ChatMessage');
const User = require('./models/User');
const Rider = require('./models/Rider'); // KEEP
const MainOrder = require('./models/MainOrder');
const Shipment = require('./models/Shipment');

// New company models
const Company = require('./models/Company');
const CompanyRider = require('./models/CompanyRider');
const CompanyDelivery = require('./models/CompanyDelivery');

// expose io to controllers
app.set('io', io);

// ============================================
// REAL-TIME TRACKING & NOTIFICATION SYSTEM
// ============================================

// In-memory tracking stores (BOTH SYSTEMS)
const onlineUsers = new Map(); // userId -> socketId
const onlineRiders = new Map(); // riderId -> {socketId, location, lastUpdate} - INDIVIDUAL
const onlineCompanies = new Map(); // companyId -> socketId - NEW
const onlineCompanyRiders = new Map(); // companyRiderId -> {socketId, companyId, location} - NEW
const onlineAdmins = new Map(); // adminId -> socketId
const onlineVendors = new Map(); // vendorId -> socketId
const onlinePharmacists = new Map(); // pharmacist userId -> socketId
app.set('onlineUsers', onlineUsers);
app.set('onlinePharmacists', onlinePharmacists);

// Room management for order tracking (BOTH SYSTEMS)
const orderRooms = new Map(); // orderId -> [socketIds]
const riderRooms = new Map(); // riderId -> [orderIds being tracked]
const companyOrderRooms = new Map(); // orderId -> [companySocketIds] - NEW

// Helper functions - UPDATED TO HANDLE BOTH
function getUserTypeFromRole(role) {
  if (role === 'rider') return 'rider'; // INDIVIDUAL RIDER
  if (role === 'company_rider') return 'company_rider'; // COMPANY RIDER - NEW
  if (role === 'company') return 'company'; // COMPANY - NEW
  if (role === 'admin') return 'admin';
  if (role === 'pharmacist') return 'vendor';
  if (role === 'vendor') return 'vendor';
  return 'user';
}

function broadcastToAdmins(event, data) {
  onlineAdmins.forEach((socketId, adminId) => {
    io.to(socketId).emit(event, data);
  });
}

function broadcastToVendors(vendorIds, event, data) {
  vendorIds.forEach(vendorId => {
    const socketId = onlineVendors.get(vendorId);
    if (socketId) {
      io.to(socketId).emit(event, data);
    }
  });
}

async function getOnlinePharmacistPayload() {
  const socketPharmacistIds = Array.from(onlinePharmacists.keys());
  if (socketPharmacistIds.length === 0) {
    return { online: false, count: 0, pharmacists: [] };
  }
  const pharmacists = await User.find({
    _id: { $in: socketPharmacistIds },
    isVendor: true,
    vendorStatus: 'approved',
    pharmacistStatus: 'approved',
    $or: [
      { role: 'pharmacist' },
      { pharmacistStatus: 'approved' },
    ],
  })
    .select('firstName lastName businessName phoneNumber businessSupportPhone isAvailable')
    .lean();
  const list = pharmacists.map((user) => {
    const id = String(user._id);
    return {
      id,
      name:
        user.businessName ||
        [user.firstName, user.lastName].filter(Boolean).join(' ') ||
        'Pharmacist',
      phoneNumber: user.businessSupportPhone || user.phoneNumber || '',
      hasSocket: onlinePharmacists.has(id),
    };
  });
  return { online: list.length > 0, count: list.length, pharmacists: list };
}

async function broadcastPharmacistStatus() {
  try {
    io.emit('pharmacistStatus', await getOnlinePharmacistPayload());
  } catch (error) {
    console.error('Broadcast pharmacist status failed:', error);
    io.emit('pharmacistStatus', { online: onlinePharmacists.size > 0, count: onlinePharmacists.size, pharmacists: [] });
  }
}

async function getApprovedPharmacist(userId) {
  if (!userId) return false;
  const user = await User.findById(userId)
    .select('role isVendor vendorStatus pharmacistStatus isAvailable firstName lastName businessName')
    .lean();
  const approved = Boolean(
    user &&
    user.isVendor === true &&
    user.vendorStatus === 'approved' &&
    (user.role === 'pharmacist' || user.pharmacistStatus === 'approved') &&
    user.pharmacistStatus === 'approved'
  );
  return approved ? user : null;
}

async function isApprovedPharmacist(userId) {
  return Boolean(await getApprovedPharmacist(userId));
}

async function notifyUserOfPharmacyMessage(session, textPreview, pharmacistId) {
  if (!session?.user) return;
  const pharmacist = pharmacistId
    ? await User.findById(pharmacistId).select('firstName lastName businessName').lean()
    : null;
  const pharmacistName =
    pharmacist?.businessName ||
    [pharmacist?.firstName, pharmacist?.lastName].filter(Boolean).join(' ') ||
    'A pharmacist';
  const payload = {
    type: 'pharmacy_chat_message',
    sessionId: String(session._id),
    message: `${pharmacistName}: ${String(textPreview || 'You have a new pharmacy chat message.').slice(0, 220)}`,
    createdAt: new Date(),
  };

  await User.findByIdAndUpdate(session.user, {
    $push: {
      notifications: {
        $each: [{
          type: 'general',
          message: payload.message,
          read: false,
          data: { type: payload.type, sessionId: payload.sessionId },
          createdAt: payload.createdAt,
        }],
        $position: 0,
        $slice: 100,
      },
    },
  });

  const userSocketId = onlineUsers.get(String(session.user));
  if (userSocketId) {
    io.to(userSocketId).emit('pharmacy_chat_message', payload);
    io.to(userSocketId).emit(`user_${session.user}`, payload);
  }
  io.emit(`user_${session.user}`, payload);

  notificationService.sendToUser(String(session.user), {
    title: 'New pharmacy chat message',
    message: payload.message,
    data: payload,
  }).catch((error) => {
    console.error(`User pharmacy chat push failed for ${session.user}:`, error.message);
  });
}

async function sendPharmacistPush(pharmacistId, session, textPreview) {
  if (!pharmacistId) return;
  const message = String(textPreview || 'A customer is waiting for pharmacist support.').slice(0, 220);
  notificationService.sendToUser(String(pharmacistId), {
    title: 'New pharmacist consultation',
    message,
    data: {
      type: 'pharmacy_consultation_request',
      sessionId: String(session._id),
      userId: String(session.user),
    },
  }).catch((error) => {
    console.error(`Pharmacist push failed for ${pharmacistId}:`, error.message);
  });
}

async function sendOnlinePharmacistPushes(session, textPreview) {
  const onlinePharmacistIds = Array.from(onlinePharmacists.keys());

  const pharmacists = await User.find({
    isVendor: true,
    vendorStatus: 'approved',
    pharmacistStatus: 'approved',
    $or: [{ role: 'pharmacist' }, { pharmacistStatus: 'approved' }],
    $and: [
      {
        $or: [
          { isAvailable: true },
          ...(onlinePharmacistIds.length ? [{ _id: { $in: onlinePharmacistIds } }] : []),
        ],
      },
    ],
  }).select('_id').lean();

  await Promise.allSettled(
    pharmacists.map((pharmacist) =>
      sendPharmacistPush(String(pharmacist._id), session, textPreview)
    )
  );
}

function formatChatMessage(message) {
  return {
    id: message._id,
    session: String(message.session),
    senderType: message.senderType,
    sender: message.sender ? String(message.sender) : null,
    text: message.message,
    createdAt: message.createdAt,
  };
}

function hasExplicitPharmacyAccessGrant(session) {
  return Boolean(
    session?.pharmacyAccessGrantedAt &&
      ['one_time', 'subscription', 'admin'].includes(session?.pharmacyAccessSource)
  );
}

async function createAndEmitSystemMessage(sessionId, text) {
  const systemMessage = await ChatMessage.create({
    session: sessionId,
    senderType: 'system',
    sender: null,
    message: text,
  });
  const formatted = formatChatMessage(systemMessage);
  io.to(`chat_${sessionId}`).emit('new_message', formatted);
  return formatted;
}

function notifyOnlinePharmacists(session, textPreview) {
  for (const socketId of onlinePharmacists.values()) {
    io.to(socketId).emit('incoming_chat_request', {
      sessionId: String(session._id),
      userId: String(session.user),
      textPreview: String(textPreview || 'A customer is waiting for pharmacist support.').slice(0, 300),
      createdAt: new Date(),
    });
  }
  sendOnlinePharmacistPushes(session, textPreview).catch((error) => {
    console.error('Failed to send online pharmacist pushes:', error);
  });
}

function notifyAssignedPharmacist(session, textPreview) {
  if (!session?.pharmacist) return false;

  sendPharmacistPush(String(session.pharmacist), session, textPreview).catch((error) => {
    console.error('Failed to send assigned pharmacist push:', error);
  });

  const socketId = onlinePharmacists.get(String(session.pharmacist));
  if (!socketId) return false;

  io.to(socketId).emit('incoming_chat_request', {
    sessionId: String(session._id),
    userId: String(session.user),
    textPreview: String(textPreview || 'A customer is waiting for pharmacist support.').slice(0, 300),
    createdAt: new Date(),
  });
  return true;
}

async function emitConsultationQueueForPharmacist(socket, pharmacistId) {
  const onlinePharmacistIds = Array.from(onlinePharmacists.keys());
  const sessions = await ChatSession.find({
    pharmacyAccessGrantedAt: { $ne: null },
    pharmacyAccessSource: { $in: ['one_time', 'subscription', 'admin'] },
    $or: [
      {
        status: 'open',
        $or: [{ pharmacist: { $exists: false } }, { pharmacist: null }],
      },
      {
        status: 'assigned',
        pharmacist: pharmacistId,
      },
      {
        status: 'assigned',
        pharmacist: { $nin: onlinePharmacistIds },
      },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  for (const session of sessions) {
    const latestMessage = await ChatMessage.findOne({
      session: session._id,
      senderType: 'user',
    })
      .sort({ createdAt: -1 })
      .lean();

    socket.emit('incoming_chat_request', {
      sessionId: String(session._id),
      userId: String(session.user),
      textPreview: latestMessage?.message || 'A customer is waiting for pharmacist support.',
      createdAt: latestMessage?.createdAt || session.createdAt,
    });
  }
}

function broadcastToRider(riderId, event, data) {
  const riderData = onlineRiders.get(riderId);
  if (riderData && riderData.socketId) {
    io.to(riderData.socketId).emit(event, data);
  }
}

function broadcastToCompany(companyId, event, data) {
  const socketId = onlineCompanies.get(companyId);
  if (socketId) {
    io.to(socketId).emit(event, data);
  }
}

function broadcastToCompanyRider(riderId, event, data) {
  const riderData = onlineCompanyRiders.get(riderId);
  if (riderData && riderData.socketId) {
    io.to(riderData.socketId).emit(event, data);
  }
}

// Update rider location in database (debounced) - FOR INDIVIDUAL RIDERS
const riderLocationUpdates = new Map();
async function updateRiderLocationInDB(riderId, location) {
  try {
    await Rider.findByIdAndUpdate(riderId, {
      'currentLocation.lat': location.lat,
      'currentLocation.lng': location.lng,
      'currentLocation.lastUpdated': new Date(),
      'currentLocation.address': location.address || '',
      lastActive: new Date()
    });
  } catch (error) {
    console.error('Error updating rider location in DB:', error);
  }
}

// Update company rider location in database - NEW
const companyRiderLocationUpdates = new Map();
async function updateCompanyRiderLocationInDB(riderId, location) {
  try {
    await CompanyRider.findByIdAndUpdate(riderId, {
      'currentLocation.lat': location.lat,
      'currentLocation.lng': location.lng,
      'currentLocation.lastUpdated': new Date(),
      'currentLocation.address': location.address || '',
      lastActivity: new Date()
    });
  } catch (error) {
    console.error('Error updating company rider location in DB:', error);
  }
}

// Periodic cleanup of disconnected users
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes
  
  // Clean old location updates for individual riders
  for (const [riderId, timestamp] of riderLocationUpdates.entries()) {
    if (now - timestamp > timeout) {
      riderLocationUpdates.delete(riderId);
    }
  }
  
  // Clean old location updates for company riders
  for (const [riderId, timestamp] of companyRiderLocationUpdates.entries()) {
    if (now - timestamp > timeout) {
      companyRiderLocationUpdates.delete(riderId);
    }
  }
}, 60 * 1000); // Run every minute

// ============================================
// SOCKET.IO EVENT HANDLERS (ORIGINAL + COMPANY)
// ============================================

io.on('connection', (socket) => {
  console.log('🔌 New socket connection:', socket.id, 'User:', socket.user?.id, 'Role:', socket.user?.role);

  const userId = socket.user?.id;
  const userRole = socket.user?.role;
  const userType = getUserTypeFromRole(userRole);

  // Store user connection
  onlineUsers.set(userId, socket.id);
  
  // Store in appropriate role-based map
  if (userType === 'rider') {
    // INDIVIDUAL RIDER - ORIGINAL CODE
    onlineRiders.set(userId, {
      socketId: socket.id,
      location: null,
      lastUpdate: Date.now(),
      isAvailable: false,
      isActive: false
    });
    
    // Fetch rider's current status from DB
    Rider.findById(userId).then(rider => {
      if (rider) {
        const riderData = onlineRiders.get(userId);
        riderData.isAvailable = rider.isAvailable || false;
        riderData.isActive = rider.isActive || false;
        riderData.location = rider.currentLocation || null;
        onlineRiders.set(userId, riderData);
        
        // Notify admins of rider coming online
        broadcastToAdmins('rider_status_change', {
          riderId: userId,
          status: 'online',
          isAvailable: riderData.isAvailable,
          isActive: riderData.isActive,
          location: riderData.location,
          timestamp: new Date()
        });
      }
    }).catch(console.error);
    
  } else if (userType === 'company_rider') {
    // COMPANY RIDER - NEW CODE
    CompanyRider.findById(userId).then(rider => {
      if (rider && rider.company) {
        onlineCompanyRiders.set(userId, {
          socketId: socket.id,
          companyId: rider.company,
          location: rider.currentLocation || null,
          lastUpdate: Date.now(),
          isActive: rider.isActive || false,
          isAvailable: rider.isAvailable || false
        });
        
        // Notify company of rider coming online
        broadcastToCompany(rider.company.toString(), 'company_rider_online', {
          riderId: userId,
          riderName: rider.fullName,
          status: 'online',
          isActive: rider.isActive,
          isAvailable: rider.isAvailable,
          timestamp: new Date()
        });
        
        // Also notify admins
        broadcastToAdmins('company_rider_online', {
          riderId: userId,
          riderName: rider.fullName,
          companyId: rider.company,
          timestamp: new Date()
        });
      }
    }).catch(console.error);
    
  } else if (userType === 'company') {
    // COMPANY - NEW CODE
    onlineCompanies.set(userId, socket.id);
    
    // Send company dashboard update
    socket.emit('company_dashboard_update', {
      message: 'Company dashboard connected',
      timestamp: new Date()
    });
    
  } else if (userType === 'admin') {
    onlineAdmins.set(userId, socket.id);
  } else if (userType === 'vendor') {
    onlineVendors.set(userId, socket.id);
  }

  getApprovedPharmacist(userId)
    .then((pharmacist) => {
      if (!pharmacist) return;
      if (pharmacist.isAvailable === true) {
        onlinePharmacists.set(String(userId), socket.id);
      } else {
        onlinePharmacists.delete(String(userId));
      }
      broadcastPharmacistStatus();
      emitConsultationQueueForPharmacist(socket, userId).catch((error) => {
        console.error('Failed to emit pharmacist consultation queue:', error);
      });
    })
    .catch((error) => {
      console.error('Pharmacist presence check failed:', error);
    });

  // Send initial connection confirmation
  socket.emit('connection_established', {
    message: 'Connected to real-time server',
    userId,
    userType,
    timestamp: new Date()
  });
  getOnlinePharmacistPayload()
    .then((payload) => socket.emit('pharmacistStatus', payload))
    .catch((error) => {
      console.error('Failed to emit initial pharmacist status:', error);
    });

  // ============================================
  // RIDER-SPECIFIC EVENTS (ORIGINAL - INDIVIDUAL RIDERS)
  // ============================================
  
  if (userType === 'rider') {
    
    // Rider updates their location
    socket.on('rider_location_update', async (data) => {
      try {
        const { lat, lng, address, orderId } = data;
        
        if (!lat || !lng) {
          return socket.emit('error', { message: 'Latitude and longitude required' });
        }

        // Update in-memory store
        const riderData = onlineRiders.get(userId) || {};
        riderData.location = { lat, lng, address, timestamp: new Date() };
        riderData.lastUpdate = Date.now();
        onlineRiders.set(userId, riderData);

        // Debounced DB update (max once every 30 seconds per rider)
        const lastUpdate = riderLocationUpdates.get(userId) || 0;
        if (Date.now() - lastUpdate > 30000) { // 30 seconds
          riderLocationUpdates.set(userId, Date.now());
          await updateRiderLocationInDB(userId, { lat, lng, address });
        }

        // Broadcast to tracking rooms (admins tracking this rider)
        io.emit(`rider_${userId}_location`, {
          riderId: userId,
          location: { lat, lng, address },
          timestamp: new Date(),
          orderId
        });

        // If tracking a specific order, update order room
        if (orderId) {
          io.to(`order_${orderId}`).emit('rider_location', {
            riderId: userId,
            location: { lat, lng, address },
            timestamp: new Date()
          });
        }

        // Notify admins of rider movement
        broadcastToAdmins('rider_location_update', {
          riderId: userId,
          riderName: socket.user?.firstName + ' ' + socket.user?.lastName,
          plateNumber: (await Rider.findById(userId).select('plateNumber'))?.plateNumber || 'N/A',
          location: { lat, lng, address },
          timestamp: new Date()
        });

        socket.emit('location_update_success', {
          message: 'Location updated',
          timestamp: new Date()
        });

      } catch (error) {
        console.error('Rider location update error:', error);
        socket.emit('error', { message: 'Failed to update location' });
      }
    });

    // Rider updates availability status
    socket.on('rider_status_update', async (data) => {
      try {
        const { isAvailable, isActive } = data;
        
        const riderData = onlineRiders.get(userId) || {};
        if (isAvailable !== undefined) riderData.isAvailable = isAvailable;
        if (isActive !== undefined) riderData.isActive = isActive;
        onlineRiders.set(userId, riderData);

        // Update in database
        const updateData = { lastActive: new Date() };
        if (isAvailable !== undefined) updateData.isAvailable = isAvailable;
        if (isActive !== undefined) updateData.isActive = isActive;
        await Rider.findByIdAndUpdate(userId, { $set: updateData });

        // Broadcast to admins
        broadcastToAdmins('rider_status_change', {
          riderId: userId,
          status: 'status_updated',
          isAvailable: riderData.isAvailable,
          isActive: riderData.isActive,
          timestamp: new Date()
        });

        socket.emit('status_update_success', {
          isAvailable: riderData.isAvailable,
          isActive: riderData.isActive,
          timestamp: new Date()
        });

      } catch (error) {
        console.error('Rider status update error:', error);
        socket.emit('error', { message: 'Failed to update status' });
      }
    });

    // Rider joins order tracking room
    socket.on('join_order_tracking', (data) => {
      const { orderId } = data;
      if (!orderId) return;

      socket.join(`order_${orderId}`);
      
      // Track which orders this rider is tracking
      const currentOrders = riderRooms.get(userId) || [];
      if (!currentOrders.includes(orderId)) {
        currentOrders.push(orderId);
        riderRooms.set(userId, currentOrders);
      }

      // Add to order rooms tracking
      const orderSockets = orderRooms.get(orderId) || [];
      if (!orderSockets.includes(socket.id)) {
        orderSockets.push(socket.id);
        orderRooms.set(orderId, orderSockets);
      }

      socket.emit('order_tracking_joined', { orderId });
    });

    // Rider leaves order tracking room
    socket.on('leave_order_tracking', (data) => {
      const { orderId } = data;
      if (!orderId) return;

      socket.leave(`order_${orderId}`);
      
      // Remove from rider's tracked orders
      const currentOrders = riderRooms.get(userId) || [];
      const updatedOrders = currentOrders.filter(id => id !== orderId);
      if (updatedOrders.length === 0) {
        riderRooms.delete(userId);
      } else {
        riderRooms.set(userId, updatedOrders);
      }

      // Remove from order rooms
      const orderSockets = orderRooms.get(orderId) || [];
      const updatedSockets = orderSockets.filter(id => id !== socket.id);
      if (updatedSockets.length === 0) {
        orderRooms.delete(orderId);
      } else {
        orderRooms.set(orderId, updatedSockets);
      }

      socket.emit('order_tracking_left', { orderId });
    });

    // Rider requests vendor location
    socket.on('request_vendor_location', async (data) => {
      try {
        const { shipmentId, orderId } = data;
        
        const shipment = await Shipment.findById(shipmentId)
          .populate('vendor', 'businessName phoneNumber businessLocation');
        
        if (!shipment) {
          return socket.emit('error', { message: 'Shipment not found' });
        }

        // Check if rider is assigned to this shipment
        if (shipment.rider?.toString() !== userId) {
          return socket.emit('error', { message: 'Not authorized for this shipment' });
        }

        socket.emit('vendor_location', {
          shipmentId,
          vendor: {
            name: shipment.vendor.businessName,
            phone: shipment.vendor.phoneNumber,
            location: shipment.vendor.businessLocation
          },
          timestamp: new Date()
        });

      } catch (error) {
        console.error('Vendor location request error:', error);
        socket.emit('error', { message: 'Failed to get vendor location' });
      }
    });

    // Rider requests delivery location
    socket.on('request_delivery_location', async (data) => {
      try {
        const { orderId } = data;
        
        const order = await MainOrder.findById(orderId)
          .select('shippingAddress userLocation')
          .populate('user', 'firstName lastName phoneNumber');
        
        if (!order) {
          return socket.emit('error', { message: 'Order not found' });
        }

        // Check if rider is assigned to this order
        if (order.rider?.toString() !== userId) {
          return socket.emit('error', { message: 'Not authorized for this order' });
        }

        socket.emit('delivery_location', {
          orderId,
          customer: {
            name: `${order.user.firstName} ${order.user.lastName}`,
            phone: order.user.phoneNumber
          },
          deliveryAddress: order.shippingAddress,
          coordinates: order.userLocation,
          timestamp: new Date()
        });

      } catch (error) {
        console.error('Delivery location request error:', error);
        socket.emit('error', { message: 'Failed to get delivery location' });
      }
    });

    // Rider sends delivery update
    socket.on('delivery_update', async (data) => {
      try {
        const { orderId, status, message, photos = [] } = data;
        
        const order = await MainOrder.findById(orderId);
        if (!order) {
          return socket.emit('error', { message: 'Order not found' });
        }

        // Check if rider is assigned
        if (order.rider?.toString() !== userId) {
          return socket.emit('error', { message: 'Not authorized for this order' });
        }

        // Broadcast to order room
        io.to(`order_${orderId}`).emit('delivery_status_update', {
          orderId,
          riderId: userId,
          riderName: socket.user?.firstName + ' ' + socket.user?.lastName,
          status,
          message,
          photos,
          timestamp: new Date()
        });

        // Notify admin
        broadcastToAdmins('delivery_update', {
          orderId,
          riderId: userId,
          riderName: socket.user?.firstName + ' ' + socket.user?.lastName,
          status,
          message,
          photos,
          timestamp: new Date()
        });

        // Notify user if they're online
        const userSocketId = onlineUsers.get(order.user.toString());
        if (userSocketId) {
          io.to(userSocketId).emit('delivery_update', {
            orderId,
            status,
            message,
            photos,
            timestamp: new Date()
          });
        }

        socket.emit('delivery_update_sent', { orderId });

      } catch (error) {
        console.error('Delivery update error:', error);
        socket.emit('error', { message: 'Failed to send delivery update' });
      }
    });
  }

  // ============================================
  // COMPANY RIDER-SPECIFIC EVENTS (NEW)
  // ============================================
  
  if (userType === 'company_rider') {
    
    // Company rider updates location
    socket.on('company_rider_location_update', async (data) => {
      try {
        const { lat, lng, address, deliveryId } = data;
        
        if (!lat || !lng) {
          return socket.emit('error', { message: 'Latitude and longitude required' });
        }

        // Get rider company
        const rider = await CompanyRider.findById(userId).select('company');
        if (!rider) {
          return socket.emit('error', { message: 'Rider not found' });
        }

        // Update in-memory store
        const riderData = onlineCompanyRiders.get(userId) || {};
        riderData.location = { lat, lng, address, timestamp: new Date() };
        riderData.lastUpdate = Date.now();
        onlineCompanyRiders.set(userId, riderData);

        // Debounced DB update
        const lastUpdate = companyRiderLocationUpdates.get(userId) || 0;
        if (Date.now() - lastUpdate > 30000) {
          companyRiderLocationUpdates.set(userId, Date.now());
          await updateCompanyRiderLocationInDB(userId, { lat, lng, address });
        }

        // Notify company
        broadcastToCompany(rider.company.toString(), 'company_rider_location', {
          riderId: userId,
          location: { lat, lng, address },
          timestamp: new Date()
        });

        // If tracking a specific delivery, update delivery room
        if (deliveryId) {
          io.to(`company_delivery_${deliveryId}`).emit('company_rider_location', {
            riderId: userId,
            location: { lat, lng, address },
            timestamp: new Date()
          });
        }

        socket.emit('company_location_update_success', {
          message: 'Location updated',
          timestamp: new Date()
        });

      } catch (error) {
        console.error('Company rider location update error:', error);
        socket.emit('error', { message: 'Failed to update location' });
      }
    });

    // Company rider updates availability status
    socket.on('company_rider_status_update', async (data) => {
      try {
        const { isAvailable, isActive } = data;
        
        const riderData = onlineCompanyRiders.get(userId) || {};
        if (isAvailable !== undefined) riderData.isAvailable = isAvailable;
        if (isActive !== undefined) riderData.isActive = isActive;
        onlineCompanyRiders.set(userId, riderData);

        // Update in database
        await CompanyRider.findByIdAndUpdate(userId, {
          isAvailable: isAvailable !== undefined ? isAvailable : undefined,
          isActive: isActive !== undefined ? isActive : undefined,
          lastActivity: new Date()
        });

        // Get rider company
        const rider = await CompanyRider.findById(userId).select('company');
        if (rider) {
          // Notify company
          broadcastToCompany(rider.company.toString(), 'company_rider_status', {
            riderId: userId,
            isAvailable: riderData.isAvailable,
            isActive: riderData.isActive,
            timestamp: new Date()
          });
        }

        socket.emit('company_status_update_success', {
          isAvailable: riderData.isAvailable,
          isActive: riderData.isActive,
          timestamp: new Date()
        });

      } catch (error) {
        console.error('Company rider status update error:', error);
        socket.emit('error', { message: 'Failed to update status' });
      }
    });

    // Company rider sends delivery update
    socket.on('company_rider_delivery_update', async (data) => {
      try {
        const { deliveryId, status, message, photos = [] } = data;
        
        const delivery = await CompanyDelivery.findById(deliveryId);
        if (!delivery) {
          return socket.emit('error', { message: 'Delivery not found' });
        }

        // Check if rider is assigned to this delivery
        if (delivery.rider?.toString() !== userId) {
          return socket.emit('error', { message: 'Not authorized for this delivery' });
        }

        // Update delivery status
        delivery.status = status;
        if (status === 'delivered') {
          delivery.completedAt = new Date();
        }
        await delivery.save();

        // Notify company
        broadcastToCompany(delivery.company.toString(), 'company_delivery_status_update', {
          deliveryId,
          riderId: userId,
          riderName: socket.user?.firstName + ' ' + socket.user?.lastName,
          status,
          message,
          photos,
          timestamp: new Date()
        });

        // Notify admin
        broadcastToAdmins('company_delivery_update', {
          deliveryId,
          companyId: delivery.company,
          riderId: userId,
          riderName: socket.user?.firstName + ' ' + socket.user?.lastName,
          status,
          message,
          photos,
          timestamp: new Date()
        });

        socket.emit('company_delivery_update_sent', { deliveryId });

      } catch (error) {
        console.error('Company rider delivery update error:', error);
        socket.emit('error', { message: 'Failed to send delivery update' });
      }
    });
  }

  // ============================================
  // COMPANY-SPECIFIC EVENTS (NEW)
  // ============================================
  
  if (userType === 'company') {
    
    // Company requests dashboard stats
    socket.on('company_dashboard_stats', async () => {
      try {
        const company = await Company.findById(userId).select('stats');
        const riders = await CompanyRider.countDocuments({ company: userId });
        const activeRiders = await CompanyRider.countDocuments({ 
          company: userId, 
          isActive: true 
        });
        const pendingDeliveries = await CompanyDelivery.countDocuments({
          company: userId,
          status: { $in: ['pending', 'assigned'] }
        });
        const completedToday = await CompanyDelivery.countDocuments({
          company: userId,
          status: 'delivered',
          completedAt: { 
            $gte: new Date().setHours(0, 0, 0, 0),
            $lt: new Date().setHours(23, 59, 59, 999)
          }
        });

        socket.emit('company_stats_update', {
          stats: company.stats,
          riders: {
            total: riders,
            active: activeRiders
          },
          deliveries: {
            pending: pendingDeliveries,
            completedToday: completedToday
          },
          timestamp: new Date()
        });

      } catch (error) {
        console.error('Company stats error:', error);
        socket.emit('error', { message: 'Failed to load stats' });
      }
    });

    // Company monitors its riders
    socket.on('company_monitor_riders', async () => {
      try {
        const riders = await CompanyRider.find({ company: userId })
          .select('fullName phoneNumber plateNumber isActive isAvailable currentLocation lastActivity');
        
        const onlineRidersData = [];
        riders.forEach(rider => {
          const onlineData = onlineCompanyRiders.get(rider._id.toString());
          if (onlineData) {
            onlineRidersData.push({
              ...rider.toObject(),
              isOnline: true,
              socketId: onlineData.socketId,
              lastUpdate: onlineData.lastUpdate
            });
          } else {
            onlineRidersData.push({
              ...rider.toObject(),
              isOnline: false
            });
          }
        });

        socket.emit('company_riders_list', {
          riders: onlineRidersData,
          count: onlineRidersData.length,
          timestamp: new Date()
        });

      } catch (error) {
        console.error('Company monitor riders error:', error);
        socket.emit('error', { message: 'Failed to load riders' });
      }
    });
  }

  // ============================================
  // ADMIN-SPECIFIC EVENTS (BOTH SYSTEMS)
  // ============================================
  
  if (userType === 'admin') {
    
    // Admin requests all online riders (BOTH TYPES)
    socket.on('get_online_riders', async () => {
      try {
        const individualIds = Array.from(onlineRiders.keys());
        const companyRiderIds = Array.from(onlineCompanyRiders.keys());

        const [individualDocs, companyRiderDocs] = await Promise.all([
          Rider.find({
            status: 'approved',
            $or: [
              { isAvailable: true, isActive: true },
              { _id: { $in: individualIds } },
            ],
          })
            .select('fullName phoneNumber plateNumber vehicleType isAvailable isActive status currentLocation')
            .lean(),
          CompanyRider.find({
            $or: [
              { isAvailable: true, isActive: true, status: 'active' },
              { _id: { $in: companyRiderIds } },
            ],
          })
            .populate('company', 'companyName phoneNumber status')
            .select('fullName phoneNumber plateNumber vehicleType isAvailable isActive status company currentLocation')
            .lean()
        ]);

        const individualById = new Map(
          individualDocs.map((rider) => [rider._id.toString(), rider])
        );
        const companyRiderById = new Map(
          companyRiderDocs.map((rider) => [rider._id.toString(), rider])
        );

        // Individual riders. Include DB-available riders even when the mobile OS
        // has paused their socket in the background.
        const individualRiders = individualDocs.map((rider) => {
          const riderId = rider._id.toString();
          const data = onlineRiders.get(riderId) || {};
          return {
            riderId,
            _id: riderId,
            type: 'individual',
            fullName: rider.fullName || 'Individual Rider',
            phoneNumber: rider.phoneNumber || '',
            plateNumber: rider.plateNumber || '',
            vehicleType: rider.vehicleType || '',
            status: rider.status || '',
            socketId: data.socketId || null,
            location: data.location || rider.currentLocation,
            lastUpdate: data.lastUpdate || rider.currentLocation?.lastUpdated || rider.lastActive,
            isAvailable: data.isAvailable ?? rider.isAvailable ?? false,
            isActive: data.isActive ?? rider.isActive ?? false,
            isSocketConnected: Boolean(data.socketId)
          };
        });

        // Company riders
        const companyRidersList = companyRiderDocs.map((rider) => {
          const riderId = rider._id.toString();
          const data = onlineCompanyRiders.get(riderId) || {};
          const company = rider.company || {};
          return {
            riderId,
            _id: riderId,
            type: 'company',
            companyId: data.companyId || company._id,
            companyName: company.companyName || 'Company',
            companyPhone: company.phoneNumber || '',
            fullName: rider.fullName || 'Company Rider',
            phoneNumber: rider.phoneNumber || '',
            plateNumber: rider.plateNumber || '',
            vehicleType: rider.vehicleType || '',
            status: rider.status || '',
            socketId: data.socketId || null,
            location: data.location || rider.currentLocation,
            lastUpdate: data.lastUpdate || rider.currentLocation?.updatedAt || rider.lastActivity,
            isAvailable: data.isAvailable ?? rider.isAvailable ?? false,
            isActive: data.isActive ?? rider.isActive ?? false,
            isSocketConnected: Boolean(data.socketId)
          };
        });

        socket.emit('online_riders_list', {
          individualRiders,
          companyRiders: companyRidersList,
          total: individualRiders.length + companyRidersList.length,
          timestamp: new Date()
        });
      } catch (error) {
        console.error('Get online riders error:', error);
        socket.emit('error', { message: 'Failed to load online riders' });
      }
    });

    // Admin starts tracking a specific rider (BOTH TYPES)
    socket.on('track_rider', (data) => {
      const { riderId, riderType = 'individual' } = data;
      
      if (riderType === 'individual') {
        socket.join(`rider_tracking_${riderId}`);
        socket.emit('rider_tracking_started', { riderId, type: 'individual' });
        
        // Send current rider location if available
        const riderData = onlineRiders.get(riderId);
        if (riderData?.location) {
          socket.emit('rider_location', {
            riderId,
            type: 'individual',
            location: riderData.location,
            isAvailable: riderData.isAvailable,
            isActive: riderData.isActive,
            timestamp: new Date(riderData.lastUpdate)
          });
        }
      } else if (riderType === 'company') {
        socket.join(`company_rider_tracking_${riderId}`);
        socket.emit('rider_tracking_started', { riderId, type: 'company' });
        
        // Send current rider location if available
        const riderData = onlineCompanyRiders.get(riderId);
        if (riderData?.location) {
          socket.emit('rider_location', {
            riderId,
            type: 'company',
            companyId: riderData.companyId,
            location: riderData.location,
            isAvailable: riderData.isAvailable,
            isActive: riderData.isActive,
            timestamp: new Date(riderData.lastUpdate)
          });
        }
      }
    });

    // Admin assigns rider to order (BOTH OPTIONS)
    socket.on('assign_rider_to_order', async (data) => {
      try {
        const { orderId, riderId, riderType = 'individual', companyId } = data;
        
        if (riderType === 'individual') {
          // ORIGINAL LOGIC for individual riders
          const order = await MainOrder.findByIdAndUpdate(
            orderId,
            { 
              rider: riderId, 
              isClaimed: true, 
              claimedAt: new Date(),
              assignedToCompany: null // Clear company assignment if any
            },
            { new: true }
          )
            .populate('rider', 'fullName phoneNumber plateNumber')
            .populate('user', 'firstName lastName phoneNumber');

          if (!order) {
            return socket.emit('error', { message: 'Order not found' });
          }

          // Update all shipments
          await Shipment.updateMany(
            { mainOrder: orderId },
            { 
              rider: riderId,
              isClaimed: true,
              claimedAt: new Date(),
              shipmentStatus: 'out_for_delivery'
            }
          );

          // Notify rider
          broadcastToRider(riderId, 'order_assigned', {
            orderId,
            orderDetails: {
              shippingAddress: order.shippingAddress,
              totalPrice: order.totalPrice,
              customerName: order.user?.firstName + ' ' + order.user?.lastName
            },
            assignedBy: socket.user?.firstName + ' ' + socket.user?.lastName,
            timestamp: new Date()
          });

          notificationService.sendToUser(String(riderId), {
            title: 'Delivery assigned',
            message: `Admin assigned you to order ${orderId}. Open the rider app to start the delivery.`,
            data: {
              type: 'order_assigned',
              orderId,
              riderId,
            },
          }).catch((error) => {
            console.error(`Admin rider assignment push failed for ${riderId}:`, error.message);
          });

          // Broadcast to order room
          io.to(`order_${orderId}`).emit('rider_assigned', {
            orderId,
            riderId,
            riderName: order.rider?.fullName,
            riderPhone: order.rider?.phoneNumber,
            timestamp: new Date()
          });

          if (order.user?._id) {
            notificationService.sendToUser(String(order.user._id), {
              title: 'Rider assigned',
              message: `${order.rider?.fullName || 'A rider'} has been assigned to your order.`,
              data: {
                type: 'rider_assigned',
                orderId,
                riderId,
                riderName: order.rider?.fullName,
                riderPhone: order.rider?.phoneNumber,
              },
            }).catch((error) => {
              console.error(`Customer rider assignment push failed for ${order.user._id}:`, error.message);
            });
          }

          socket.emit('rider_assigned_success', {
            orderId,
            riderId,
            riderType: 'individual',
            message: 'Individual rider assigned successfully'
          });

        } else if (riderType === 'company' && companyId) {
          // NEW LOGIC for company assignment
          const order = await MainOrder.findById(orderId)
            .populate('user', 'firstName lastName phoneNumber')
            .populate({
              path: 'shipments',
              populate: { path: 'vendor', select: 'businessName businessLocation phoneNumber' }
            });

          if (!order) {
            return socket.emit('error', { message: 'Order not found' });
          }

          // Create company delivery record
          const delivery = await CompanyDelivery.create({
            company: companyId,
            mainOrder: orderId,
            rider: riderId || null, // Can assign specific company rider or let company assign
            customer: {
              name: `${order.user.firstName} ${order.user.lastName}`,
              phoneNumber: order.user.phoneNumber,
              address: order.shippingAddress.address
            },
            pickupDetails: {
              vendorName: order.shipments[0]?.vendor?.businessName || 'Vendor',
              vendorAddress: order.shipments[0]?.vendor?.businessLocation || '',
              pickupOTP: Math.floor(100000 + Math.random() * 900000).toString()
            },
            deliveryDetails: {
              deliveryAddress: order.shippingAddress.address,
              city: order.shippingAddress.city,
              postalCode: order.shippingAddress.postalCode,
              deliveryOTP: Math.floor(100000 + Math.random() * 900000).toString()
            },
            items: order.shipments.flatMap(shipment => 
              shipment.items.map(item => ({
                name: item.name,
                quantity: item.quantity,
                price: item.price
              }))
            ),
            amount: order.totalShippingPrice,
            status: riderId ? 'assigned' : 'pending'
          });

          // Update main order
          order.assignedToCompany = companyId;
          if (riderId) {
            order.rider = riderId;
          }
          await order.save();

          // Notify company
          broadcastToCompany(companyId, 'new_delivery_assigned', {
            deliveryId: delivery._id,
            customer: delivery.customer,
            amount: delivery.amount,
            pickupDetails: delivery.pickupDetails,
            timestamp: new Date()
          });

          // If specific rider assigned, notify them
          if (riderId) {
            broadcastToCompanyRider(riderId, 'company_delivery_assigned', {
              deliveryId: delivery._id,
              deliveryDetails: {
                pickupDetails: delivery.pickupDetails,
                deliveryDetails: delivery.deliveryDetails,
                amount: delivery.amount
              },
              assignedBy: socket.user?.firstName + ' ' + socket.user?.lastName,
              timestamp: new Date()
            });
          }

          socket.emit('rider_assigned_success', {
            orderId,
            riderId,
            companyId,
            riderType: 'company',
            deliveryId: delivery._id,
            message: 'Company assigned to delivery'
          });
        }

      } catch (error) {
        console.error('Assign rider error:', error);
        socket.emit('error', { message: 'Failed to assign rider' });
      }
    });

    // Admin sends message to rider (BOTH TYPES)
    socket.on('admin_to_rider_message', async (data) => {
      try {
        const { riderId, message, orderId, riderType = 'individual' } = data;
        
        if (riderType === 'individual') {
          broadcastToRider(riderId, 'admin_message', {
            adminId: userId,
            adminName: socket.user?.firstName + ' ' + socket.user?.lastName,
            message,
            orderId,
            timestamp: new Date()
          });
        } else if (riderType === 'company') {
          broadcastToCompanyRider(riderId, 'admin_message', {
            adminId: userId,
            adminName: socket.user?.firstName + ' ' + socket.user?.lastName,
            message,
            orderId,
            timestamp: new Date()
          });
        }

        socket.emit('message_sent', { riderId, message, riderType });

      } catch (error) {
        console.error('Admin to rider message error:', error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });
  }

  // ============================================
  // KEEP ALL ORIGINAL VENDOR & USER EVENTS
  // (These should work with both systems)
  // ============================================
  
  // [KEEP ALL ORIGINAL VENDOR EVENTS FROM ORIGINAL CODE]
  // [KEEP ALL ORIGINAL USER EVENTS FROM ORIGINAL CODE]
  // [KEEP ALL ORIGINAL COMMON EVENTS FROM ORIGINAL CODE]
  // [KEEP ALL ORIGINAL CHAT & DISPUTE HANDLERS FROM ORIGINAL CODE]

  socket.on('join_chat', async (payload, cb) => {
    try {
      const { sessionId } = payload || {};
      if (!sessionId) {
        return cb && cb({ success: false, error: 'sessionId required' });
      }

      const session = await ChatSession.findById(sessionId).lean();
      if (!session) {
        return cb && cb({ success: false, error: 'Chat session not found' });
      }
      if (!hasExplicitPharmacyAccessGrant(session)) {
        return cb && cb({
          success: false,
          code: 'PHARMACY_SUBSCRIPTION_REQUIRED',
          error: 'Pharmacist chat subscription required',
        });
      }

      const isOwner = String(session.user) === String(userId);
      const isAssignedPharmacist =
        session.pharmacist && String(session.pharmacist) === String(userId);
      const canUsePharmacistTools = await isApprovedPharmacist(userId);

      const canPreviewOpenSession = canUsePharmacistTools && !session.pharmacist;

      if (!isOwner && !isAssignedPharmacist && !canPreviewOpenSession) {
        return cb && cb({ success: false, error: 'Not authorized for this chat' });
      }

      socket.join(`chat_${sessionId}`);

      const messages = await ChatMessage.find({
        session: session._id,
        senderType: { $ne: 'ai' },
      })
        .sort({ createdAt: 1 })
        .lean();

      return cb && cb({
        success: true,
        session,
        messages: messages.map(formatChatMessage),
      });
    } catch (error) {
      console.error('join_chat error:', error);
      return cb && cb({ success: false, error: 'Server error during chat join' });
    }
  });

  socket.on('leave_chat', ({ sessionId } = {}) => {
    if (sessionId) socket.leave(`chat_${sessionId}`);
  });

  socket.on('send_chat_message', async (payload, cb) => {
    try {
      const { sessionId, text } = payload || {};
      const cleanText = String(text || '').trim();
      if (!sessionId || !cleanText) {
        return cb && cb({ success: false, error: 'sessionId and text required' });
      }

      const session = await ChatSession.findById(sessionId);
      if (!session) {
        return cb && cb({ success: false, error: 'session not found' });
      }
      if (!hasExplicitPharmacyAccessGrant(session)) {
        return cb && cb({
          success: false,
          code: 'PHARMACY_SUBSCRIPTION_REQUIRED',
          error: 'Pharmacist chat subscription required',
        });
      }

      const canUsePharmacistTools = await isApprovedPharmacist(userId);
      const isAssignedPharmacist =
        session.pharmacist && String(session.pharmacist) === String(userId);
      const isOwner = String(session.user) === String(userId);
      const senderType = canUsePharmacistTools ? 'pharmacist' : 'user';

      if (senderType === 'pharmacist' && !isAssignedPharmacist) {
        return cb && cb({
          success: false,
          error: 'Only the assigned pharmacist can reply to this consultation',
        });
      }

      if (senderType === 'user' && !isOwner) {
        return cb && cb({ success: false, error: 'Not authorized for this chat' });
      }

      const chatMessage = await ChatMessage.create({
        session: session._id,
        senderType,
        sender: userId,
        message: cleanText,
      });
      const formatted = formatChatMessage(chatMessage);
      io.to(`chat_${sessionId}`).emit('new_message', formatted);

      if (senderType === 'user') {
        const assignedNotified = notifyAssignedPharmacist(session, cleanText);
        if (!assignedNotified) {
          notifyOnlinePharmacists(session, cleanText);
        }
      } else if (senderType === 'pharmacist') {
        notifyUserOfPharmacyMessage(session, cleanText, userId).catch((error) => {
          console.error('Failed to notify user of pharmacy message:', error);
        });
      }

      return cb && cb({ success: true, message: formatted });
    } catch (error) {
      console.error('send_chat_message error:', error);
      return cb && cb({ success: false, error: 'failed to send' });
    }
  });

  socket.on('pharmacist_claim_session', async (payload, cb) => {
    try {
      const { sessionId } = payload || {};
      if (!sessionId) {
        return cb && cb({ success: false, message: 'sessionId required' });
      }

      const canUsePharmacistTools = await isApprovedPharmacist(userId);
      if (!canUsePharmacistTools) {
        return cb && cb({
          success: false,
          message: 'Only approved pharmacists can claim customer consultations.',
        });
      }

      const session = await ChatSession.findById(sessionId);
      if (!session) {
        return cb && cb({ success: false, message: 'session not found' });
      }
      if (!hasExplicitPharmacyAccessGrant(session)) {
        return cb && cb({
          success: false,
          code: 'PHARMACY_SUBSCRIPTION_REQUIRED',
          message: 'This consultation is waiting for pharmacist chat access before it can be claimed.',
        });
      }

      const wasAlreadyAssignedToMe =
        session.pharmacist && String(session.pharmacist) === String(userId);

      const assignedPharmacistOnline =
        session.pharmacist && onlinePharmacists.has(String(session.pharmacist));

      if (session.pharmacist && !wasAlreadyAssignedToMe && assignedPharmacistOnline) {
        return cb && cb({
          success: false,
          message: 'This consultation has already been claimed.',
        });
      }

      session.pharmacist = userId;
      session.status = 'assigned';
      await session.save();

      socket.join(`chat_${sessionId}`);

      if (!wasAlreadyAssignedToMe) {
        const pharmacistUser = await User.findById(userId)
          .select('firstName lastName businessName')
          .lean();
        const pharmacistName =
          pharmacistUser?.businessName ||
          [pharmacistUser?.firstName, pharmacistUser?.lastName].filter(Boolean).join(' ') ||
          'A certified pharmacist';

        await createAndEmitSystemMessage(
          sessionId,
          `${pharmacistName} has joined the consultation.`
        );

        io.to(`chat_${sessionId}`).emit('pharmacist_joined', {
          pharmacistId: String(userId),
          name: pharmacistName,
        });
      }

      return cb && cb({ success: true, session });
    } catch (error) {
      console.error('pharmacist_claim_session error:', error);
      return cb && cb({ success: false, message: 'claim failed' });
    }
  });

  socket.on('pharmacist_status_update', async (payload, cb) => {
    try {
      const pharmacist = await getApprovedPharmacist(userId);
      if (!pharmacist) {
        return cb && cb({ success: false, message: 'Only approved pharmacists can update availability.' });
      }

      const online = payload?.online === true || payload?.isAvailable === true;
      await User.findByIdAndUpdate(userId, {
        $set: { isAvailable: online, lastActive: new Date() },
      });

      if (online) {
        onlinePharmacists.set(String(userId), socket.id);
        emitConsultationQueueForPharmacist(socket, userId).catch((error) => {
          console.error('Failed to emit pharmacist consultation queue:', error);
        });
      } else {
        onlinePharmacists.delete(String(userId));
      }

      await broadcastPharmacistStatus();
      return cb && cb({ success: true, online, count: onlinePharmacists.size });
    } catch (error) {
      console.error('pharmacist_status_update error:', error);
      return cb && cb({ success: false, message: 'Unable to update pharmacist status.' });
    }
  });

  // ============================================
  // DISCONNECTION HANDLER (UPDATED FOR BOTH)
  // ============================================

  socket.on('disconnect', async (reason) => {
    console.log('🔌 Socket disconnected:', socket.id, 'Reason:', reason, 'User:', userId);

    // Remove from online users
    onlineUsers.delete(userId);

    // Remove from role-specific maps
    if (userType === 'rider') {
      onlineRiders.delete(userId);
      
      // Notify admins of rider going offline
      broadcastToAdmins('rider_status_change', {
        riderId: userId,
        status: 'offline',
        timestamp: new Date()
      });

      // Clean up rider rooms
      riderRooms.delete(userId);
      
    } else if (userType === 'company_rider') {
      const riderData = onlineCompanyRiders.get(userId);
      if (riderData) {
        // Notify company of rider going offline
        broadcastToCompany(riderData.companyId, 'company_rider_offline', {
          riderId: userId,
          timestamp: new Date()
        });
      }
      onlineCompanyRiders.delete(userId);
      
    } else if (userType === 'company') {
      onlineCompanies.delete(userId);
      
    } else if (userType === 'admin') {
      onlineAdmins.delete(userId);
    } else if (userType === 'vendor') {
      onlineVendors.delete(userId);
    }

    if (onlinePharmacists.get(String(userId)) === socket.id) {
      onlinePharmacists.delete(String(userId));
      broadcastPharmacistStatus();
    }

    // Clean up order rooms
    for (const [orderId, sockets] of orderRooms.entries()) {
      const updatedSockets = sockets.filter(id => id !== socket.id);
      if (updatedSockets.length === 0) {
        orderRooms.delete(orderId);
      } else {
        orderRooms.set(orderId, updatedSockets);
      }
    }

    // Clean up company order rooms
    for (const [deliveryId, sockets] of companyOrderRooms.entries()) {
      const updatedSockets = sockets.filter(id => id !== socket.id);
      if (updatedSockets.length === 0) {
        companyOrderRooms.delete(deliveryId);
      } else {
        companyOrderRooms.set(deliveryId, updatedSockets);
      }
    }

    // [KEEP ORIGINAL PHARMACIST CLEANUP CODE]

    console.log(`📊 Online stats: Individual Riders: ${onlineRiders.size}, Company Riders: ${onlineCompanyRiders.size}, Companies: ${onlineCompanies.size}, Admins: ${onlineAdmins.size}, Vendors: ${onlineVendors.size}`);
  });
});

// ============================================
// HELPER FUNCTIONS FOR CONTROLLERS TO USE
// ============================================

// Function for controllers to emit events (BOTH SYSTEMS)
app.set('emitOrderUpdate', (orderId, data) => {
  io.to(`order_${orderId}`).emit('order_update', data);
});

app.set('emitDeliveryUpdate', (deliveryId, data) => {
  io.to(`company_delivery_${deliveryId}`).emit('delivery_update', data);
});

app.set('emitCompanyUpdate', (companyId, data) => {
  broadcastToCompany(companyId, 'company_update', data);
});

app.set('emitRiderUpdate', (riderId, data) => {
  // Try both systems
  broadcastToRider(riderId, 'rider_update', data);
  broadcastToCompanyRider(riderId, 'rider_update', data);
});

app.set('notifyAdmin', (data) => {
  broadcastToAdmins('admin_notification', data);
});

app.set('notifyAdminRiderStatus', (data) => {
  broadcastToAdmins('rider_status_change', data);
});

app.set('notifyCompany', (companyId, data) => {
  broadcastToCompany(companyId, 'company_notification', data);
});

app.set('notifyRider', (riderId, data) => {
  broadcastToRider(riderId, 'notification', data);
});

app.set('notifyCompanyRider', (riderId, data) => {
  broadcastToCompanyRider(riderId, 'notification', data);
});

app.set('notifyVendor', (vendorId, data) => {
  const socketId = onlineVendors.get(vendorId);
  if (socketId) {
    io.to(socketId).emit('vendor_notification', data);
  }
});

// 404 + error handler (must be last)
app.use(notFound);
app.use(errorHandler);

const startServer = async () => {
  await connectDB();
  await cleanupObsoleteIndexes();
  const referralSettingsState = await initializeReferralProgramSettings();
  const deliveryFeeSettingsState = await initializeDeliveryFeeSettings();
  const pharmacySubscriptionState = await initializePharmacySubscriptionSettings();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(colors.cyan.underline(`🚀 Server running on http://0.0.0.0:${PORT}`));
    console.log(colors.green(`📡 Real-time tracking system active with DUAL RIDER SYSTEM`));
    console.log(colors.yellow(`📊 Available socket events:`));
    console.log(colors.yellow(`   - Individual Rider: rider_location_update, status_update, delivery_update`));
    console.log(colors.yellow(`   - Company Rider: company_rider_location_update, company_rider_status_update`));
    console.log(colors.yellow(`   - Company: company_dashboard_stats, company_monitor_riders`));
    console.log(colors.yellow(`   - Admin: track_rider (with type), assign_rider_to_order (with type)`));
    console.log(colors.yellow(`   - Vendor: shipment_ready_for_pickup (works with both)`));
    console.log(colors.yellow(`   - User: track_my_order (works with both)`));
    console.log(
      colors.blue(
        `🎁 Referral reward setting ready at ₦${referralSettingsState.referralRewardAmount}.`,
      ),
    );
    console.log(
      colors.blue(
        `🚚 Delivery fee zones ready with ${deliveryFeeSettingsState.zoneCount} configured Abuja areas. Fallback: ₦${deliveryFeeSettingsState.minimumDeliveryFee} min, ₦${deliveryFeeSettingsState.fallbackRatePerKm}/km.`,
      ),
    );
    console.log(
      colors.blue(
        `💊 Pharmacist chat plans ready: ${pharmacySubscriptionState.plans
          .map((plan) => `${plan.planType}=₦${plan.price}`)
          .join(', ')}.`,
      ),
    );
    if (process.env.DISABLE_IN_PROCESS_SCHEDULED_NOTIFICATIONS !== 'true') {
      startScheduledNotificationRunner(app);
      console.log(colors.green('⏰ Scheduled notification runner active.'));
    } else {
      console.log(colors.yellow('⏰ In-process scheduled notification runner disabled; use worker:scheduled-notifications.'));
    }
  });
};

startServer().catch((error) => {
  console.error(colors.red.bold(`Server startup error: ${error.message}`));
  process.exit(1);
});










// +++++++++++++++++++++++++++++++++++++++++++++++++++++++++
// SECOND VERSION
// +++++++++++++++++++++++++++++++++++++++++++++++++++++++++
// // server.js (UPDATED FOR COMPANY-MANAGED SYSTEM)
// const express = require('express');
// const dotenv = require('dotenv').config();
// const colors = require('colors');
// const path = require('path');
// const http = require('http');
// const { Server } = require('socket.io');
// const jwt = require('jsonwebtoken');
// const helmet = require('helmet');
// const compression = require('compression');
// const rateLimit = require('express-rate-limit');
// const cors = require('cors');
// const fs = require('fs');

// const connectDB = require('./config/db');
// const { notFound, errorHandler } = require('./middleware/errorMiddleware');

// const app = express();
// app.set('trust proxy', true);

// connectDB();

// const PORT = process.env.PORT || 5000;

// // Core middleware
// app.use(helmet());
// app.use(compression());
// app.use(express.json({ limit: '1mb' }));
// app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// // CORS (tighten in prod)
// app.use(
//   cors({
//     origin: process.env.FRONTEND_ORIGIN || '*',
//     methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
//     credentials: true,
//   })
// );

// // Rate limit auth endpoints
// const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
// app.use('/api/auth', authLimiter);

// app.use(express.static(path.join(__dirname, 'public')));
// app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// // Routes (REMOVED individual rider routes, ADDED company routes)
// app.use('/api/auth', require('./routes/authRoutes'));
// app.use('/api/companies', require('./routes/companyRoutes')); // ADDED
// app.use('/api/vendor', require('./routes/vendorRoutes'));
// app.use('/api/admin', require('./routes/adminRoutes'));
// app.use('/api/products', require('./routes/productRoutes'));
// app.use('/api/orders', require('./routes/orderRoutes'));
// app.use('/api/reviews', require('./routes/reviewsRoutes'));
// app.use('/api/wallet', require('./routes/walletRoutes'));
// app.use('/api/returns', require('./routes/returnsRoutes'));
// app.use('/api/chat', require('./routes/chatRoutes'));
// app.use('/api/chatbot', require('./routes/chatbotRoutes'));
// app.use('/api/disputes', require('./routes/disputesRoutes'));
// // REMOVED: app.use('/api/riders', require('./routes/riderRoutes')); // Individual rider routes removed
// app.use('/api/uploads', require('./routes/uploadsRoutes'));

// // Health/root
// app.get('/', (req, res) => res.json({ message: 'NaijaGo Company-Managed System API is running!' }));

// // HTTP + Socket.IO
// const server = http.createServer(app);
// const io = new Server(server, {
//   cors: { origin: process.env.FRONTEND_ORIGIN || '*', methods: ['GET', 'POST'] },
//   pingTimeout: 60000,
//   connectionStateRecovery: {
//     maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
//     skipMiddlewares: true,
//   }
// });

// // Socket auth (JWT handshake)
// io.use((socket, next) => {
//   try {
//     const token = socket.handshake.auth?.token;
//     if (!token) return next(new Error('Authentication token required'));
    
//     const decoded = jwt.verify(token, process.env.JWT_SECRET);
//     socket.user = {
//       id: decoded.id,
//       role: decoded.role || 'user',
//       email: decoded.email,
//       firstName: decoded.firstName,
//       lastName: decoded.lastName
//     };
    
//     return next();
//   } catch (err) {
//     console.error('Socket auth failed:', err.message);
//     next(new Error('Authentication failed'));
//   }
// });

// // Models needed for company system
// const Company = require('./models/Company');
// const CompanyRider = require('./models/CompanyRider');
// const CompanyDelivery = require('./models/CompanyDelivery');
// const Message = require('./models/Message');
// const DisputeRequest = require('./models/DisputeRequest');
// const ChatSession = require('./models/ChatSession');
// const ChatMessage = require('./models/ChatMessage');
// const User = require('./models/User');
// const MainOrder = require('./models/MainOrder');
// const Shipment = require('./models/Shipment');
// const Settlement = require('./models/Settlement');

// // AI helper
// const { getAIResponse } = require('./utils/aiChatService');

// // expose io to controllers
// app.set('io', io);

// // ============================================
// // COMPANY REAL-TIME TRACKING & NOTIFICATION SYSTEM
// // ============================================

// // In-memory tracking stores (COMPANY-FOCUSED)
// const onlineUsers = new Map(); // userId -> socketId
// const onlineCompanies = new Map(); // companyId -> socketId
// const onlineCompanyRiders = new Map(); // riderId -> {socketId, companyId, location, lastUpdate}
// const onlineAdmins = new Map(); // adminId -> socketId
// const onlineVendors = new Map(); // vendorId -> socketId

// // Room management for order tracking (COMPANY-FOCUSED)
// const companyOrderRooms = new Map(); // orderId -> [companySocketIds]
// const riderOrderRooms = new Map(); // riderId -> [orderIds being tracked]

// // Helper functions for company system
// function getUserTypeFromRole(role) {
//   if (role === 'company') return 'company';
//   if (role === 'admin') return 'admin';
//   if (role === 'vendor') return 'vendor';
//   if (role === 'company_rider') return 'company_rider';
//   return 'user';
// }

// function broadcastToAdmins(event, data) {
//   onlineAdmins.forEach((socketId, adminId) => {
//     io.to(socketId).emit(event, data);
//   });
// }

// function broadcastToCompanies(companyIds, event, data) {
//   companyIds.forEach(companyId => {
//     const socketId = onlineCompanies.get(companyId);
//     if (socketId) {
//       io.to(socketId).emit(event, data);
//     }
//   });
// }

// function broadcastToCompany(companyId, event, data) {
//   const socketId = onlineCompanies.get(companyId);
//   if (socketId) {
//     io.to(socketId).emit(event, data);
//   }
// }

// function broadcastToCompanyRider(riderId, event, data) {
//   const riderData = onlineCompanyRiders.get(riderId);
//   if (riderData && riderData.socketId) {
//     io.to(riderData.socketId).emit(event, data);
//   }
// }

// // Update company rider location in database (debounced)
// const companyRiderLocationUpdates = new Map();
// async function updateCompanyRiderLocationInDB(riderId, location) {
//   try {
//     await CompanyRider.findByIdAndUpdate(riderId, {
//       'currentLocation.lat': location.lat,
//       'currentLocation.lng': location.lng,
//       'currentLocation.lastUpdated': new Date(),
//       'currentLocation.address': location.address || '',
//       lastActivity: new Date()
//     });
//   } catch (error) {
//     console.error('Error updating company rider location in DB:', error);
//   }
// }

// // Periodic cleanup of disconnected users
// setInterval(() => {
//   const now = Date.now();
//   const timeout = 5 * 60 * 1000; // 5 minutes
  
//   // Clean old location updates
//   for (const [riderId, timestamp] of companyRiderLocationUpdates.entries()) {
//     if (now - timestamp > timeout) {
//       companyRiderLocationUpdates.delete(riderId);
//     }
//   }
// }, 60 * 1000); // Run every minute

// // ============================================
// // SOCKET.IO EVENT HANDLERS (COMPANY-FOCUSED)
// // ============================================

// io.on('connection', (socket) => {
//   console.log('🔌 New socket connection:', socket.id, 'User:', socket.user?.id, 'Role:', socket.user?.role);

//   const userId = socket.user?.id;
//   const userRole = socket.user?.role;
//   const userType = getUserTypeFromRole(userRole);

//   // Store user connection
//   onlineUsers.set(userId, socket.id);
  
//   // Store in appropriate role-based map
//   if (userType === 'company') {
//     onlineCompanies.set(userId, socket.id);
    
//     // Send company dashboard update
//     socket.emit('company_dashboard_update', {
//       message: 'Company dashboard connected',
//       timestamp: new Date()
//     });
    
//   } else if (userType === 'company_rider') {
//     // Get company for this rider
//     CompanyRider.findById(userId).then(rider => {
//       if (rider && rider.company) {
//         onlineCompanyRiders.set(userId, {
//           socketId: socket.id,
//           companyId: rider.company,
//           location: rider.currentLocation || null,
//           lastUpdate: Date.now(),
//           isActive: rider.isActive || false,
//           isAvailable: rider.isAvailable || false
//         });
        
//         // Notify company of rider coming online
//         broadcastToCompany(rider.company.toString(), 'company_rider_online', {
//           riderId: userId,
//           riderName: rider.fullName,
//           status: 'online',
//           isActive: rider.isActive,
//           isAvailable: rider.isAvailable,
//           timestamp: new Date()
//         });
        
//         // Notify admins
//         broadcastToAdmins('company_rider_online', {
//           riderId: userId,
//           riderName: rider.fullName,
//           companyId: rider.company,
//           timestamp: new Date()
//         });
//       }
//     }).catch(console.error);
    
//   } else if (userType === 'admin') {
//     onlineAdmins.set(userId, socket.id);
//   } else if (userType === 'vendor') {
//     onlineVendors.set(userId, socket.id);
//   }

//   // Send initial connection confirmation
//   socket.emit('connection_established', {
//     message: 'Connected to NaijaGo real-time server',
//     userId,
//     userType,
//     timestamp: new Date()
//   });

//   // ============================================
//   // COMPANY-SPECIFIC EVENTS
//   // ============================================
  
//   if (userType === 'company') {
    
//     // Company requests dashboard stats
//     socket.on('company_dashboard_stats', async () => {
//       try {
//         const company = await Company.findById(userId).select('stats');
//         const riders = await CompanyRider.countDocuments({ company: userId });
//         const activeRiders = await CompanyRider.countDocuments({ 
//           company: userId, 
//           isActive: true 
//         });
//         const pendingDeliveries = await CompanyDelivery.countDocuments({
//           company: userId,
//           status: { $in: ['pending', 'assigned'] }
//         });
//         const completedToday = await CompanyDelivery.countDocuments({
//           company: userId,
//           status: 'delivered',
//           completedAt: { 
//             $gte: new Date().setHours(0, 0, 0, 0),
//             $lt: new Date().setHours(23, 59, 59, 999)
//           }
//         });

//         socket.emit('company_stats_update', {
//           stats: company.stats,
//           riders: {
//             total: riders,
//             active: activeRiders
//           },
//           deliveries: {
//             pending: pendingDeliveries,
//             completedToday: completedToday
//           },
//           timestamp: new Date()
//         });

//       } catch (error) {
//         console.error('Company stats error:', error);
//         socket.emit('error', { message: 'Failed to load stats' });
//       }
//     });

//     // Company monitors its riders
//     socket.on('company_monitor_riders', async () => {
//       try {
//         const riders = await CompanyRider.find({ company: userId })
//           .select('fullName phoneNumber plateNumber isActive isAvailable currentLocation lastActivity');
        
//         const onlineRidersData = [];
//         riders.forEach(rider => {
//           const onlineData = onlineCompanyRiders.get(rider._id.toString());
//           if (onlineData) {
//             onlineRidersData.push({
//               ...rider.toObject(),
//               isOnline: true,
//               socketId: onlineData.socketId,
//               lastUpdate: onlineData.lastUpdate
//             });
//           } else {
//             onlineRidersData.push({
//               ...rider.toObject(),
//               isOnline: false
//             });
//           }
//         });

//         socket.emit('company_riders_list', {
//           riders: onlineRidersData,
//           count: onlineRidersData.length,
//           timestamp: new Date()
//         });

//       } catch (error) {
//         console.error('Company monitor riders error:', error);
//         socket.emit('error', { message: 'Failed to load riders' });
//       }
//     });

//     // Company tracks its deliveries
//     socket.on('company_track_deliveries', async (data) => {
//       try {
//         const { status, startDate, endDate } = data || {};
        
//         const query = { company: userId };
//         if (status && status !== 'all') {
//           query.status = status;
//         }
//         if (startDate || endDate) {
//           query.createdAt = {};
//           if (startDate) query.createdAt.$gte = new Date(startDate);
//           if (endDate) query.createdAt.$lte = new Date(endDate);
//         }

//         const deliveries = await CompanyDelivery.find(query)
//           .populate('rider', 'fullName phoneNumber riderId')
//           .sort({ createdAt: -1 })
//           .limit(50);

//         socket.emit('company_deliveries_list', {
//           deliveries,
//           count: deliveries.length,
//           timestamp: new Date()
//         });

//       } catch (error) {
//         console.error('Company track deliveries error:', error);
//         socket.emit('error', { message: 'Failed to load deliveries' });
//       }
//     });

//     // Company assigns rider to delivery
//     socket.on('company_assign_rider', async (data) => {
//       try {
//         const { deliveryId, riderId } = data;
        
//         // Verify company owns both delivery and rider
//         const delivery = await CompanyDelivery.findOne({
//           _id: deliveryId,
//           company: userId
//         });
        
//         const rider = await CompanyRider.findOne({
//           _id: riderId,
//           company: userId
//         });

//         if (!delivery) {
//           return socket.emit('error', { message: 'Delivery not found or not authorized' });
//         }
        
//         if (!rider) {
//           return socket.emit('error', { message: 'Rider not found or not authorized' });
//         }

//         // Update delivery with rider assignment
//         delivery.rider = riderId;
//         delivery.status = 'assigned';
//         await delivery.save();

//         // Notify rider if online
//         const riderData = onlineCompanyRiders.get(riderId);
//         if (riderData) {
//           io.to(riderData.socketId).emit('delivery_assigned', {
//             deliveryId,
//             deliveryDetails: {
//               pickupDetails: delivery.pickupDetails,
//               deliveryDetails: delivery.deliveryDetails,
//               amount: delivery.amount
//             },
//             assignedBy: socket.user?.firstName + ' ' + socket.user?.lastName,
//             timestamp: new Date()
//           });
//         }

//         // Notify admin
//         broadcastToAdmins('company_rider_assigned', {
//           deliveryId,
//           companyId: userId,
//           companyName: socket.user?.firstName + ' ' + socket.user?.lastName,
//           riderId,
//           riderName: rider.fullName,
//           timestamp: new Date()
//         });

//         socket.emit('rider_assigned_success', {
//           deliveryId,
//           riderId,
//           message: 'Rider assigned successfully'
//         });

//       } catch (error) {
//         console.error('Company assign rider error:', error);
//         socket.emit('error', { message: 'Failed to assign rider' });
//       }
//     });

//     // Company sends message to its rider
//     socket.on('company_to_rider_message', async (data) => {
//       try {
//         const { riderId, message, deliveryId } = data;
        
//         // Verify rider belongs to company
//         const rider = await CompanyRider.findOne({
//           _id: riderId,
//           company: userId
//         });

//         if (!rider) {
//           return socket.emit('error', { message: 'Rider not found or not authorized' });
//         }

//         broadcastToCompanyRider(riderId, 'company_message', {
//           companyId: userId,
//           companyName: socket.user?.firstName + ' ' + socket.user?.lastName,
//           message,
//           deliveryId,
//           timestamp: new Date()
//         });

//         socket.emit('message_sent', { riderId, message });

//       } catch (error) {
//         console.error('Company to rider message error:', error);
//         socket.emit('error', { message: 'Failed to send message' });
//       }
//     });

//     // Company joins delivery tracking room
//     socket.on('company_join_delivery_tracking', (data) => {
//       const { deliveryId } = data;
//       if (!deliveryId) return;

//       socket.join(`company_delivery_${deliveryId}`);
      
//       // Add to company order rooms tracking
//       const currentDeliveries = companyOrderRooms.get(deliveryId) || [];
//       if (!currentDeliveries.includes(socket.id)) {
//         currentDeliveries.push(socket.id);
//         companyOrderRooms.set(deliveryId, currentDeliveries);
//       }

//       socket.emit('delivery_tracking_joined', { deliveryId });
//     });
//   }

//   // ============================================
//   // COMPANY RIDER-SPECIFIC EVENTS
//   // ============================================
  
//   if (userType === 'company_rider') {
    
//     // Company rider updates location
//     socket.on('company_rider_location_update', async (data) => {
//       try {
//         const { lat, lng, address, deliveryId } = data;
        
//         if (!lat || !lng) {
//           return socket.emit('error', { message: 'Latitude and longitude required' });
//         }

//         // Get rider company
//         const rider = await CompanyRider.findById(userId).select('company');
//         if (!rider) {
//           return socket.emit('error', { message: 'Rider not found' });
//         }

//         // Update in-memory store
//         const riderData = onlineCompanyRiders.get(userId) || {};
//         riderData.location = { lat, lng, address, timestamp: new Date() };
//         riderData.lastUpdate = Date.now();
//         onlineCompanyRiders.set(userId, riderData);

//         // Debounced DB update
//         const lastUpdate = companyRiderLocationUpdates.get(userId) || 0;
//         if (Date.now() - lastUpdate > 30000) {
//           companyRiderLocationUpdates.set(userId, Date.now());
//           await updateCompanyRiderLocationInDB(userId, { lat, lng, address });
//         }

//         // Notify company
//         broadcastToCompany(rider.company.toString(), 'company_rider_location', {
//           riderId: userId,
//           location: { lat, lng, address },
//           timestamp: new Date()
//         });

//         // If tracking a specific delivery, update delivery room
//         if (deliveryId) {
//           io.to(`company_delivery_${deliveryId}`).emit('rider_location_update', {
//             riderId: userId,
//             location: { lat, lng, address },
//             timestamp: new Date()
//           });
//         }

//         socket.emit('location_update_success', {
//           message: 'Location updated',
//           timestamp: new Date()
//         });

//       } catch (error) {
//         console.error('Company rider location update error:', error);
//         socket.emit('error', { message: 'Failed to update location' });
//       }
//     });

//     // Company rider updates availability status
//     socket.on('company_rider_status_update', async (data) => {
//       try {
//         const { isAvailable, isActive } = data;
        
//         const riderData = onlineCompanyRiders.get(userId) || {};
//         if (isAvailable !== undefined) riderData.isAvailable = isAvailable;
//         if (isActive !== undefined) riderData.isActive = isActive;
//         onlineCompanyRiders.set(userId, riderData);

//         // Update in database
//         await CompanyRider.findByIdAndUpdate(userId, {
//           isAvailable: isAvailable !== undefined ? isAvailable : undefined,
//           isActive: isActive !== undefined ? isActive : undefined,
//           lastActivity: new Date()
//         });

//         // Get rider company
//         const rider = await CompanyRider.findById(userId).select('company');
//         if (rider) {
//           // Notify company
//           broadcastToCompany(rider.company.toString(), 'company_rider_status', {
//             riderId: userId,
//             isAvailable: riderData.isAvailable,
//             isActive: riderData.isActive,
//             timestamp: new Date()
//           });
//         }

//         socket.emit('status_update_success', {
//           isAvailable: riderData.isAvailable,
//           isActive: riderData.isActive,
//           timestamp: new Date()
//         });

//       } catch (error) {
//         console.error('Company rider status update error:', error);
//         socket.emit('error', { message: 'Failed to update status' });
//       }
//     });

//     // Company rider sends delivery update
//     socket.on('company_rider_delivery_update', async (data) => {
//       try {
//         const { deliveryId, status, message, photos = [] } = data;
        
//         const delivery = await CompanyDelivery.findById(deliveryId);
//         if (!delivery) {
//           return socket.emit('error', { message: 'Delivery not found' });
//         }

//         // Check if rider is assigned to this delivery
//         if (delivery.rider?.toString() !== userId) {
//           return socket.emit('error', { message: 'Not authorized for this delivery' });
//         }

//         // Update delivery status
//         delivery.status = status;
//         if (status === 'delivered') {
//           delivery.completedAt = new Date();
//         }
//         await delivery.save();

//         // Notify company
//         broadcastToCompany(delivery.company.toString(), 'delivery_status_update', {
//           deliveryId,
//           riderId: userId,
//           riderName: socket.user?.firstName + ' ' + socket.user?.lastName,
//           status,
//           message,
//           photos,
//           timestamp: new Date()
//         });

//         // Notify admin
//         broadcastToAdmins('company_delivery_update', {
//           deliveryId,
//           companyId: delivery.company,
//           riderId: userId,
//           riderName: socket.user?.firstName + ' ' + socket.user?.lastName,
//           status,
//           message,
//           photos,
//           timestamp: new Date()
//         });

//         socket.emit('delivery_update_sent', { deliveryId });

//       } catch (error) {
//         console.error('Company rider delivery update error:', error);
//         socket.emit('error', { message: 'Failed to send delivery update' });
//       }
//     });

//     // Company rider requests delivery details
//     socket.on('company_rider_delivery_details', async (data) => {
//       try {
//         const { deliveryId } = data;
        
//         const delivery = await CompanyDelivery.findById(deliveryId)
//           .populate('company', 'companyName');

//         if (!delivery) {
//           return socket.emit('error', { message: 'Delivery not found' });
//         }

//         // Check if rider is assigned
//         if (delivery.rider?.toString() !== userId) {
//           return socket.emit('error', { message: 'Not authorized for this delivery' });
//         }

//         socket.emit('delivery_details', {
//           deliveryId,
//           pickupDetails: delivery.pickupDetails,
//           deliveryDetails: delivery.deliveryDetails,
//           items: delivery.items,
//           amount: delivery.amount,
//           companyName: delivery.company?.companyName,
//           timestamp: new Date()
//         });

//       } catch (error) {
//         console.error('Delivery details error:', error);
//         socket.emit('error', { message: 'Failed to get delivery details' });
//       }
//     });
//   }

//   // ============================================
//   // ADMIN-SPECIFIC EVENTS (COMPANY-FOCUSED)
//   // ============================================
  
//   if (userType === 'admin') {
    
//     // Admin requests all companies
//     socket.on('admin_get_companies', async () => {
//       try {
//         const companies = await Company.find()
//           .select('companyName email phoneNumber contactPerson status stats')
//           .limit(100);

//         const onlineCompaniesData = companies.map(company => ({
//           ...company.toObject(),
//           isOnline: onlineCompanies.has(company._id.toString())
//         }));

//         socket.emit('companies_list', {
//           companies: onlineCompaniesData,
//           count: companies.length,
//           timestamp: new Date()
//         });

//       } catch (error) {
//         console.error('Admin get companies error:', error);
//         socket.emit('error', { message: 'Failed to load companies' });
//       }
//     });

//     // Admin requests company details
//     socket.on('admin_get_company_details', async (data) => {
//       try {
//         const { companyId } = data;
        
//         const company = await Company.findById(companyId)
//           .select('-password -verificationCode -verificationExpires');
        
//         const riders = await CompanyRider.find({ company: companyId })
//           .select('fullName phoneNumber plateNumber isActive isAvailable status');
        
//         const deliveries = await CompanyDelivery.find({ company: companyId })
//           .sort({ createdAt: -1 })
//           .limit(20)
//           .populate('rider', 'fullName');

//         const settlements = await Settlement.find({ company: companyId })
//           .sort({ createdAt: -1 })
//           .limit(10);

//         socket.emit('company_details', {
//           company,
//           riders: {
//             total: riders.length,
//             active: riders.filter(r => r.isActive).length,
//             list: riders
//           },
//           deliveries: {
//             total: await CompanyDelivery.countDocuments({ company: companyId }),
//             list: deliveries
//           },
//           settlements: {
//             total: settlements.length,
//             list: settlements
//           },
//           isOnline: onlineCompanies.has(companyId),
//           timestamp: new Date()
//         });

//       } catch (error) {
//         console.error('Admin get company details error:', error);
//         socket.emit('error', { message: 'Failed to load company details' });
//       }
//     });

//     // Admin creates settlement for company
//     socket.on('admin_create_settlement', async (data) => {
//       try {
//         const { companyId, periodStart, periodEnd, deliveries } = data;
        
//         // Calculate total amount from deliveries
//         const deliveryDocs = await CompanyDelivery.find({
//           _id: { $in: deliveries },
//           company: companyId,
//           isSettled: false
//         });

//         if (deliveryDocs.length === 0) {
//           return socket.emit('error', { message: 'No unsettled deliveries found' });
//         }

//         const totalAmount = deliveryDocs.reduce((sum, delivery) => sum + delivery.companyEarnings, 0);
//         const commission = totalAmount * 0.15; // 15% commission example
//         const netAmount = totalAmount - commission;

//         // Create settlement
//         const settlement = await Settlement.create({
//           company: companyId,
//           period: {
//             startDate: new Date(periodStart),
//             endDate: new Date(periodEnd)
//           },
//           deliveries: deliveries,
//           amount: totalAmount,
//           commission: commission,
//           netAmount: netAmount,
//           status: 'pending'
//         });

//         // Notify company
//         broadcastToCompany(companyId, 'settlement_created', {
//           settlementId: settlement._id,
//           reference: settlement.reference,
//           amount: settlement.netAmount,
//           period: settlement.period,
//           timestamp: new Date()
//         });

//         socket.emit('settlement_created_success', {
//           settlementId: settlement._id,
//           reference: settlement.reference,
//           message: 'Settlement created successfully'
//         });

//       } catch (error) {
//         console.error('Admin create settlement error:', error);
//         socket.emit('error', { message: 'Failed to create settlement' });
//       }
//     });

//     // Admin assigns delivery to company
//     socket.on('admin_assign_to_company', async (data) => {
//       try {
//         const { orderId, companyId } = data;
        
//         // Get main order details
//         const mainOrder = await MainOrder.findById(orderId)
//           .populate('user', 'firstName lastName phoneNumber')
//           .populate({
//             path: 'shipments',
//             populate: { path: 'vendor', select: 'businessName businessLocation phoneNumber' }
//           });

//         if (!mainOrder) {
//           return socket.emit('error', { message: 'Order not found' });
//         }

//         // Create company delivery record
//         const delivery = await CompanyDelivery.create({
//           company: companyId,
//           mainOrder: orderId,
//           customer: {
//             name: `${mainOrder.user.firstName} ${mainOrder.user.lastName}`,
//             phoneNumber: mainOrder.user.phoneNumber,
//             address: mainOrder.shippingAddress.address
//           },
//           pickupDetails: {
//             vendorName: mainOrder.shipments[0]?.vendor?.businessName || 'Vendor',
//             vendorAddress: mainOrder.shipments[0]?.vendor?.businessLocation || '',
//             pickupOTP: Math.floor(100000 + Math.random() * 900000).toString()
//           },
//           deliveryDetails: {
//             deliveryAddress: mainOrder.shippingAddress.address,
//             city: mainOrder.shippingAddress.city,
//             postalCode: mainOrder.shippingAddress.postalCode,
//             deliveryOTP: Math.floor(100000 + Math.random() * 900000).toString()
//           },
//           items: mainOrder.shipments.flatMap(shipment => 
//             shipment.items.map(item => ({
//               name: item.name,
//               quantity: item.quantity,
//               price: item.price
//             }))
//           ),
//           amount: mainOrder.totalShippingPrice,
//           commission: mainOrder.totalShippingPrice * 0.15, // 15% commission
//           companyEarnings: mainOrder.totalShippingPrice * 0.85, // 85% to company
//           status: 'pending'
//         });

//         // Update main order
//         mainOrder.assignedToCompany = companyId;
//         await mainOrder.save();

//         // Notify company
//         broadcastToCompany(companyId, 'new_delivery_assigned', {
//           deliveryId: delivery._id,
//           customer: delivery.customer,
//           amount: delivery.companyEarnings,
//           pickupDetails: delivery.pickupDetails,
//           timestamp: new Date()
//         });

//         socket.emit('delivery_assigned_to_company', {
//           deliveryId: delivery._id,
//           companyId,
//           message: 'Delivery assigned to company'
//         });

//       } catch (error) {
//         console.error('Admin assign to company error:', error);
//         socket.emit('error', { message: 'Failed to assign delivery' });
//       }
//     });
//   }

//   // ============================================
//   // VENDOR-SPECIFIC EVENTS (UNCHANGED)
//   // ============================================
  
//   if (userType === 'vendor') {
    
//     // Vendor marks shipment ready for pickup
//     socket.on('shipment_ready_for_pickup', async (data) => {
//       try {
//         const { shipmentId } = data;
        
//         const shipment = await Shipment.findByIdAndUpdate(
//           shipmentId,
//           { shipmentStatus: 'ready_for_pickup' },
//           { new: true }
//         ).populate('mainOrder', 'assignedToCompany');

//         if (!shipment) {
//           return socket.emit('error', { message: 'Shipment not found' });
//         }

//         // Check if vendor owns this shipment
//         if (shipment.vendor.toString() !== userId) {
//           return socket.emit('error', { message: 'Not authorized for this shipment' });
//         }

//         // If assigned to company, notify them
//         if (shipment.mainOrder?.assignedToCompany) {
//           // Find company delivery for this order
//           const delivery = await CompanyDelivery.findOne({
//             mainOrder: shipment.mainOrder._id,
//             company: shipment.mainOrder.assignedToCompany
//           });
          
//           if (delivery) {
//             delivery.pickupDetails.vendorName = shipment.vendor?.businessName || 'Vendor';
//             delivery.pickupDetails.vendorAddress = shipment.vendor?.businessLocation || '';
//             await delivery.save();

//             broadcastToCompany(shipment.mainOrder.assignedToCompany.toString(), 'shipment_ready', {
//               shipmentId,
//               vendorId: userId,
//               vendorName: socket.user?.firstName + ' ' + socket.user?.lastName,
//               deliveryId: delivery._id,
//               timestamp: new Date()
//             });
//           }
//         }

//         // Notify admin
//         broadcastToAdmins('shipment_ready_for_pickup', {
//           shipmentId,
//           vendorId: userId,
//           vendorName: socket.user?.firstName + ' ' + socket.user?.lastName,
//           orderId: shipment.mainOrder?._id,
//           companyId: shipment.mainOrder?.assignedToCompany,
//           timestamp: new Date()
//         });

//         socket.emit('shipment_ready_confirmed', { shipmentId });

//       } catch (error) {
//         console.error('Shipment ready error:', error);
//         socket.emit('error', { message: 'Failed to mark shipment ready' });
//       }
//     });
//   }

//   // ============================================
//   // USER-SPECIFIC EVENTS (CUSTOMER) (UNCHANGED)
//   // ============================================
  
//   if (userType === 'user') {
    
//     // User tracks their order
//     socket.on('track_my_order', (data) => {
//       const { orderId } = data;
      
//       // Verify user owns this order
//       MainOrder.findById(orderId).then(order => {
//         if (!order || order.user.toString() !== userId) {
//           return socket.emit('error', { message: 'Order not found or not authorized' });
//         }
        
//         socket.join(`order_${orderId}`);
//         socket.join(`user_order_${userId}_${orderId}`);
        
//         socket.emit('order_tracking_started', {
//           orderId,
//           message: 'Now tracking your order in real-time'
//         });

//         // If assigned to company, get company info
//         if (order.assignedToCompany) {
//           Company.findById(order.assignedToCompany).then(company => {
//             if (company) {
//               socket.emit('company_assigned', {
//                 companyName: company.companyName,
//                 contactPerson: company.contactPerson,
//                 phoneNumber: company.phoneNumber
//               });
//             }
//           });
//         }

//       }).catch(error => {
//         console.error('Order tracking error:', error);
//         socket.emit('error', { message: 'Failed to track order' });
//       });
//     });
//   }

//   // ============================================
//   // COMMON EVENTS (ALL USER TYPES)
//   // ============================================

//   // Join delivery room for tracking
//   socket.on('join_delivery_room', (data) => {
//     const { deliveryId } = data;
//     if (deliveryId) {
//       socket.join(`company_delivery_${deliveryId}`);
//       socket.emit('joined_delivery_room', { deliveryId });
//     }
//   });

//   // Leave delivery room
//   socket.on('leave_delivery_room', (data) => {
//     const { deliveryId } = data;
//     if (deliveryId) {
//       socket.leave(`company_delivery_${deliveryId}`);
//       socket.emit('left_delivery_room', { deliveryId });
//     }
//   });

//   // Ping/pong for connection health
//   socket.on('ping', (data) => {
//     socket.emit('pong', {
//       timestamp: new Date(),
//       ...data
//     });
//   });

//   // ============================================
//   // KEEP EXISTING CHAT & DISPUTE HANDLERS (UNCHANGED)
//   // ============================================
  
//   // ... [Keep all your existing chat and dispute handlers exactly as they were]
//   // I'm preserving your existing chat system
  
//   socket.on('joinDispute', async (disputeId) => {
//     try {
//       socket.join(`dispute_${disputeId}`);
//     } catch (err) {
//       console.error('joinDispute error', err);
//     }
//   });

//   socket.on('leaveDispute', (disputeId) => {
//     try {
//       socket.leave(`dispute_${disputeId}`);
//     } catch (err) {
//       console.error('leaveDispute error', err);
//     }
//   });

//   socket.on('sendMessage', async (payload, cb) => {
//     try {
//       const { disputeId, text = '', attachments = [] } = payload;
//       const dispute = await DisputeRequest.findById(disputeId);
//       if (!dispute) return cb && cb({ error: 'Dispute not found' });

//       const messageDoc = await Message.create({
//         dispute: disputeId,
//         sender: socket.user.id,
//         text,
//         attachments,
//       });
//       dispute.messages.push({ sender: socket.user.id, text, attachments });
//       await dispute.save();

//       const out = {
//         id: messageDoc._id,
//         dispute: String(disputeId),
//         sender: socket.user.id,
//         text,
//         attachments,
//         createdAt: messageDoc.createdAt,
//       };
//       io.to(`dispute_${disputeId}`).emit('message', out);
//       if (cb) cb({ success: true, message: out });
//     } catch (err) {
//       console.error('sendMessage socket error', err);
//       if (cb) cb({ error: 'Failed to send message' });
//     }
//   });

//   // Chat session handlers (keep existing)
//   const onlinePharmacists = new Map();
//   app.set('onlinePharmacists', onlinePharmacists);

//   function socketUserId(payload) {
//     return payload?.sub || payload?.id || payload?._id || payload?.userId || null;
//   }

//   function socketUserRole(payload) {
//     return payload?.role || payload?.user_role || payload?.userRole || null;
//   }

//   function broadcastPharmacistStatus() {
//     const count = onlinePharmacists.size;
//     io.emit('pharmacistStatus', { online: count > 0, count });
//   }

//   async function emitSystemMessage(sessionId, text) {
//     try {
//       const sysMsg = await ChatMessage.create({
//         session: sessionId,
//         senderType: 'system',
//         sender: null,
//         message: text,
//       });

//       const outSys = {
//         id: sysMsg._id,
//         session: String(sessionId),
//         senderType: 'system',
//         sender: null,
//         text: sysMsg.message,
//         createdAt: sysMsg.createdAt,
//       };
//       io.to(`chat_${sessionId}`).emit('new_message', outSys);
//       return outSys;
//     } catch (error) {
//       console.error('Failed to emit system message:', error);
//     }
//   }

//   // If pharmacist connected via socket, track presence
//   if (userRole === 'pharmacist' && userId) {
//     onlinePharmacists.set(String(userId), socket.id);
//     broadcastPharmacistStatus();
//   }

//   // Chat handlers (keep existing)
//   socket.on('join_chat', async (payload, cb) => {
//     try {
//       const { sessionId } = payload || {};
//       if (!sessionId) {
//         console.error('join_chat: sessionId required');
//         return cb && cb({ success: false, message: 'Session ID is required' });
//       }

//       socket.join(`chat_${sessionId}`);

//       const session = await ChatSession.findById(sessionId).lean();
      
//       if (!session) {
//         console.error(`join_chat: Session not found for ID: ${sessionId}`);
//         return cb && cb({ success: false, message: 'Chat session not found' });
//       }
      
//       const messages = await ChatMessage.find({ session: session._id }).sort({ createdAt: 1 }).lean();
      
//       if (userRole === 'pharmacist' && userId) {
//         await User.findByIdAndUpdate(userId, { isAvailable: true });
//       }

//       return cb && cb({ success: true, session: session, messages: messages });
//     } catch (err) {
//       console.error('join_chat error', err);
//       return cb && cb({ success: false, message: 'Server error during chat join' });
//     }
//   });

//   socket.on('leave_chat', ({ sessionId }) => {
//     try {
//       if (!sessionId) return;
//       socket.leave(`chat_${sessionId}`);
//     } catch (err) {
//       console.error('leave_chat error', err);
//     }
//   });

//   socket.on('send_chat_message', async (payload, cb) => {
//     try {
//       const { sessionId, text } = payload || {};
//       if (!sessionId || !text) return cb && cb({ error: 'sessionId and text required' });

//       const session = await ChatSession.findById(sessionId);
//       if (!session) return cb && cb({ error: 'session not found' });

//       const senderType = userRole === 'pharmacist' ? 'pharmacist' : 'user';
//       const sender = userId || null;

//       if (session.pharmacist || senderType === 'pharmacist') {
//         if (userRole === 'pharmacist' && String(session.pharmacist) !== String(userId)) {
//           return cb && cb({ error: 'pharmacist is not assigned to this session' });
//         }
        
//         const userMsg = await ChatMessage.create({
//           session: session._id,
//           senderType,
//           sender,
//           message: text,
//         });
//         const outUser = {
//           id: userMsg._id,
//           session: String(session._id),
//           senderType: userMsg.senderType,
//           sender,
//           text: userMsg.message,
//           createdAt: userMsg.createdAt,
//         };
//         io.to(`chat_${sessionId}`).emit('new_message', outUser);
//         return cb && cb({ success: true, message: outUser });
//       }

//       const userMsg = await ChatMessage.create({
//         session: session._id,
//         senderType,
//         sender,
//         message: text,
//       });

//       const outUser = {
//         id: userMsg._id,
//         session: String(session._id),
//         senderType: userMsg.senderType,
//         sender,
//         text: userMsg.message,
//         createdAt: userMsg.createdAt,
//       };

//       io.to(`chat_${sessionId}`).emit('new_message', outUser);

//       let availablePharmacistId = onlinePharmacists.keys().next().value;
//       let availablePharmacistDetails = null;

//       if (availablePharmacistId) {
//         availablePharmacistDetails = await User.findById(availablePharmacistId, 'name');
//       } else {
//         availablePharmacistDetails = await User.findOne({ role: 'pharmacist', isAvailable: true }).lean();
//       }

//       if (availablePharmacistDetails) {
//         const pharmId = String(availablePharmacistDetails._id || availablePharmacistId);
//         const pharmacistSocketId = onlinePharmacists.get(pharmId);
//         if (pharmacistSocketId) {
//           io.to(pharmacistSocketId).emit('incoming_chat_request', {
//             sessionId: String(session._id),
//             userId: session.user,
//             textPreview: text.slice(0, 300),
//             createdAt: new Date(),
//           });
//         }

//         await emitSystemMessage(
//           session._id,
//           'A certified pharmacist has been notified. They will join the chat shortly. The AI is on standby.'
//         );
//       }

//       const aiReplyText = await getAIResponse(text);

//       const aiMsg = await ChatMessage.create({
//         session: session._id,
//         senderType: 'ai',
//         sender: null,
//         message: aiReplyText,
//       });

//       const outAi = {
//         id: aiMsg._id,
//         session: String(session._id),
//         senderType: 'ai',
//         sender: null,
//         text: aiMsg.message,
//         createdAt: aiMsg.createdAt,
//       };

//       io.to(`chat_${sessionId}`).emit('new_message', outAi);

//       return cb && cb({ success: true, message: outUser, aiReply: outAi });

//     } catch (err) {
//       console.error('send_chat_message error', err);
//       return cb && cb({ error: 'failed to send' });
//     }
//   });

//   socket.on('pharmacist_claim_session', async (payload, cb) => {
//     try {
//       const { sessionId } = payload || {};
//       if (!sessionId) return cb && cb({ error: 'sessionId required' });
//       if (userRole !== 'pharmacist') return cb && cb({ error: 'only pharmacists can claim' });

//       const session = await ChatSession.findById(sessionId);
//       if (!session) return cb && cb({ error: 'session not found' });

//       if (session.pharmacist) {
//         return cb && cb({ success: false, message: 'Session already claimed.' });
//       }

//       session.pharmacist = userId;
//       session.status = 'assigned';
//       await session.save();

//       const pharmacistUser = await User.findById(userId, 'firstName lastName');
//       const pharmacistName = pharmacistUser ? `${pharmacistUser.firstName} ${pharmacistUser.lastName}` : 'A certified pharmacist';

//       await emitSystemMessage(
//         session._id,
//         `${pharmacistName} has joined the chat room. The AI has stepped aside.`
//       );
      
//       io.to(`chat_${sessionId}`).emit('pharmacist_joined', {
//         pharmacistId: session.pharmacist,
//         name: pharmacistName,
//       });

//       return cb && cb({ success: true, session });
//     } catch (err) {
//       console.error('pharmacist_claim_session error', err);
//       return cb && cb({ error: 'claim failed' });
//     }
//   });

//   // ============================================
//   // DISCONNECTION HANDLER (UPDATED)
//   // ============================================

//   socket.on('disconnect', async (reason) => {
//     console.log('🔌 Socket disconnected:', socket.id, 'Reason:', reason, 'User:', userId, 'Role:', userRole);

//     // Remove from online users
//     onlineUsers.delete(userId);

//     // Remove from role-specific maps
//     if (userType === 'company') {
//       onlineCompanies.delete(userId);
      
//     } else if (userType === 'company_rider') {
//       const riderData = onlineCompanyRiders.get(userId);
//       if (riderData) {
//         // Notify company of rider going offline
//         broadcastToCompany(riderData.companyId, 'company_rider_offline', {
//           riderId: userId,
//           timestamp: new Date()
//         });
//       }
//       onlineCompanyRiders.delete(userId);
      
//     } else if (userType === 'admin') {
//       onlineAdmins.delete(userId);
//     } else if (userType === 'vendor') {
//       onlineVendors.delete(userId);
//     }

//     // Clean up delivery rooms
//     for (const [deliveryId, sockets] of companyOrderRooms.entries()) {
//       const updatedSockets = sockets.filter(id => id !== socket.id);
//       if (updatedSockets.length === 0) {
//         companyOrderRooms.delete(deliveryId);
//       } else {
//         companyOrderRooms.set(deliveryId, updatedSockets);
//       }
//     }

//     // Pharmacist cleanup (existing)
//     if (userRole === 'pharmacist' && userId) {
//       for (const [pharmId, sId] of onlinePharmacists.entries()) {
//         if (sId === socket.id) onlinePharmacists.delete(pharmId);
//       }
      
//       await User.findByIdAndUpdate(userId, { isAvailable: false });
//       broadcastPharmacistStatus();
//     }

//     console.log(`📊 Online stats: Companies: ${onlineCompanies.size}, Company Riders: ${onlineCompanyRiders.size}, Admins: ${onlineAdmins.size}, Vendors: ${onlineVendors.size}`);
//   });
// });

// // ============================================
// // HELPER FUNCTIONS FOR CONTROLLERS TO USE
// // ============================================

// // Function for controllers to emit events (COMPANY-FOCUSED)
// app.set('emitDeliveryUpdate', (deliveryId, data) => {
//   io.to(`company_delivery_${deliveryId}`).emit('delivery_update', data);
// });

// app.set('emitCompanyUpdate', (companyId, data) => {
//   broadcastToCompany(companyId, 'company_update', data);
// });

// app.set('emitRiderUpdate', (riderId, data) => {
//   broadcastToCompanyRider(riderId, 'rider_update', data);
// });

// app.set('notifyAdmin', (data) => {
//   broadcastToAdmins('admin_notification', data);
// });

// app.set('notifyCompany', (companyId, data) => {
//   broadcastToCompany(companyId, 'company_notification', data);
// });

// app.set('notifyCompanyRider', (riderId, data) => {
//   broadcastToCompanyRider(riderId, 'notification', data);
// });

// app.set('notifyVendor', (vendorId, data) => {
//   const socketId = onlineVendors.get(vendorId);
//   if (socketId) {
//     io.to(socketId).emit('vendor_notification', data);
//   }
// });

// // 404 + error handler (must be last)
// app.use(notFound);
// app.use(errorHandler);

// server.listen(PORT, '0.0.0.0', () => {
//   console.log(colors.cyan.underline(`🚀 Server running on http://0.0.0.0:${PORT}`));
//   console.log(colors.green(`📡 Company-Managed Real-time System Active`));
//   console.log(colors.yellow(`📊 Available socket events:`));
//   console.log(colors.yellow(`   - Company: dashboard_stats, monitor_riders, assign_rider`));
//   console.log(colors.yellow(`   - Company Rider: location_update, status_update, delivery_update`));
//   console.log(colors.yellow(`   - Admin: get_companies, create_settlement, assign_to_company`));
//   console.log(colors.yellow(`   - Vendor: shipment_ready_for_pickup`));
//   console.log(colors.yellow(`   - User: track_my_order`));
// });











// +++++++++++++++++++++++++++++++++++++++++++++++++++++++++
// FIRST VERSION
// +++++++++++++++++++++++++++++++++++++++++++++++++++++++++

// // server.js (FINAL UPDATED VERSION WITH REAL-TIME TRACKING)
// const express = require('express');
// const dotenv = require('dotenv').config();
// const colors = require('colors');
// const path = require('path');
// const http = require('http');
// const { Server } = require('socket.io');
// const jwt = require('jsonwebtoken');
// const helmet = require('helmet');
// const compression = require('compression');
// const rateLimit = require('express-rate-limit');
// const cors = require('cors');
// const fs = require('fs');

// const connectDB = require('./config/db');
// const { notFound, errorHandler } = require('./middleware/errorMiddleware');

// const app = express();
// app.set('trust proxy', true);

// connectDB();

// const PORT = process.env.PORT || 5000;

// // Core middleware
// app.use(helmet());
// app.use(compression());
// app.use(express.json({ limit: '1mb' }));
// app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// // CORS (tighten in prod)
// app.use(
//   cors({
//     origin: process.env.FRONTEND_ORIGIN || '*',
//     methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
//     credentials: true,
//   })
// );

// // Rate limit auth endpoints
// const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
// app.use('/api/auth', authLimiter);

// app.use(express.static(path.join(__dirname, 'public')));
// app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// // Routes (unchanged)
// app.use('/api/auth', require('./routes/authRoutes'));
// app.use('/api/companies', require('./routes/companyRoutes'));
// app.use('/api/vendor', require('./routes/vendorRoutes'));
// app.use('/api/admin', require('./routes/adminRoutes'));
// app.use('/api/products', require('./routes/productRoutes'));
// app.use('/api/orders', require('./routes/orderRoutes'));
// app.use('/api/reviews', require('./routes/reviewsRoutes'));
// app.use('/api/wallet', require('./routes/walletRoutes'));
// app.use('/api/returns', require('./routes/returnsRoutes'));
// app.use('/api/chat', require('./routes/chatRoutes'));
// app.use('/api/chatbot', require('./routes/chatbotRoutes'));
// app.use('/api/disputes', require('./routes/disputesRoutes'));
// app.use('/api/riders', require('./routes/riderRoutes'));
// app.use('/api/uploads', require('./routes/uploadsRoutes'));

// // Health/root
// app.get('/', (req, res) => res.json({ message: 'NaijaGo Backend API is running!' }));

// // HTTP + Socket.IO
// const server = http.createServer(app);
// const io = new Server(server, {
//   cors: { origin: process.env.FRONTEND_ORIGIN || '*', methods: ['GET', 'POST'] },
//   pingTimeout: 60000,
//   connectionStateRecovery: {
//     maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
//     skipMiddlewares: true,
//   }
// });

// // Socket auth (JWT handshake)
// io.use((socket, next) => {
//   try {
//     const token = socket.handshake.auth?.token;
//     if (!token) return next(new Error('Authentication token required'));
    
//     const decoded = jwt.verify(token, process.env.JWT_SECRET);
//     socket.user = {
//       id: decoded.id,
//       role: decoded.role || 'user',
//       email: decoded.email,
//       firstName: decoded.firstName,
//       lastName: decoded.lastName
//     };
    
//     return next();
//   } catch (err) {
//     console.error('Socket auth failed:', err.message);
//     next(new Error('Authentication failed'));
//   }
// });

// // Existing models
// const Message = require('./models/Message');
// const DisputeRequest = require('./models/DisputeRequest');
// const ChatSession = require('./models/ChatSession');
// const ChatMessage = require('./models/ChatMessage');
// const User = require('./models/User');
// const Rider = require('./models/Rider');
// const MainOrder = require('./models/MainOrder');
// const Shipment = require('./models/Shipment');

// // AI helper
// const { getAIResponse } = require('./utils/aiChatService');

// // expose io to controllers
// app.set('io', io);

// // ============================================
// // REAL-TIME TRACKING & NOTIFICATION SYSTEM
// // ============================================

// // In-memory tracking stores
// const onlineUsers = new Map(); // userId -> socketId
// const onlineRiders = new Map(); // riderId -> {socketId, location, lastUpdate}
// const onlineAdmins = new Map(); // adminId -> socketId
// const onlineVendors = new Map(); // vendorId -> socketId

// // Room management for order tracking
// const orderRooms = new Map(); // orderId -> [socketIds]
// const riderRooms = new Map(); // riderId -> [orderIds being tracked]

// // Helper functions
// function getUserTypeFromRole(role) {
//   if (role === 'rider') return 'rider';
//   if (role === 'admin') return 'admin';
//   if (role === 'vendor') return 'vendor';
//   return 'user';
// }

// function broadcastToAdmins(event, data) {
//   onlineAdmins.forEach((socketId, adminId) => {
//     io.to(socketId).emit(event, data);
//   });
// }

// function broadcastToVendors(vendorIds, event, data) {
//   vendorIds.forEach(vendorId => {
//     const socketId = onlineVendors.get(vendorId);
//     if (socketId) {
//       io.to(socketId).emit(event, data);
//     }
//   });
// }

// function broadcastToRider(riderId, event, data) {
//   const riderData = onlineRiders.get(riderId);
//   if (riderData && riderData.socketId) {
//     io.to(riderData.socketId).emit(event, data);
//   }
// }

// // Update rider location in database (debounced)
// const riderLocationUpdates = new Map();
// async function updateRiderLocationInDB(riderId, location) {
//   try {
//     await Rider.findByIdAndUpdate(riderId, {
//       'currentLocation.lat': location.lat,
//       'currentLocation.lng': location.lng,
//       'currentLocation.lastUpdated': new Date(),
//       'currentLocation.address': location.address || '',
//       lastActive: new Date()
//     });
//   } catch (error) {
//     console.error('Error updating rider location in DB:', error);
//   }
// }

// // Periodic cleanup of disconnected users
// setInterval(() => {
//   const now = Date.now();
//   const timeout = 5 * 60 * 1000; // 5 minutes
  
//   // Clean old location updates
//   for (const [riderId, timestamp] of riderLocationUpdates.entries()) {
//     if (now - timestamp > timeout) {
//       riderLocationUpdates.delete(riderId);
//     }
//   }
// }, 60 * 1000); // Run every minute

// // ============================================
// // SOCKET.IO EVENT HANDLERS
// // ============================================

// io.on('connection', (socket) => {
//   console.log('🔌 New socket connection:', socket.id, 'User:', socket.user?.id);

//   const userId = socket.user?.id;
//   const userRole = socket.user?.role;
//   const userType = getUserTypeFromRole(userRole);

//   // Store user connection
//   onlineUsers.set(userId, socket.id);
  
//   // Store in appropriate role-based map
//   if (userType === 'rider') {
//     onlineRiders.set(userId, {
//       socketId: socket.id,
//       location: null,
//       lastUpdate: Date.now(),
//       isAvailable: false,
//       isActive: false
//     });
    
//     // Fetch rider's current status from DB
//     Rider.findById(userId).then(rider => {
//       if (rider) {
//         const riderData = onlineRiders.get(userId);
//         riderData.isAvailable = rider.isAvailable || false;
//         riderData.isActive = rider.isActive || false;
//         riderData.location = rider.currentLocation || null;
//         onlineRiders.set(userId, riderData);
        
//         // Notify admins of rider coming online
//         broadcastToAdmins('rider_status_change', {
//           riderId: userId,
//           status: 'online',
//           isAvailable: riderData.isAvailable,
//           isActive: riderData.isActive,
//           location: riderData.location,
//           timestamp: new Date()
//         });
//       }
//     }).catch(console.error);
    
//   } else if (userType === 'admin') {
//     onlineAdmins.set(userId, socket.id);
//   } else if (userType === 'vendor') {
//     onlineVendors.set(userId, socket.id);
//   }

//   // Send initial connection confirmation
//   socket.emit('connection_established', {
//     message: 'Connected to real-time server',
//     userId,
//     userType,
//     timestamp: new Date()
//   });

//   // ============================================
//   // RIDER-SPECIFIC EVENTS
//   // ============================================
  
//   if (userType === 'rider') {
    
//     // Rider updates their location
//     socket.on('rider_location_update', async (data) => {
//       try {
//         const { lat, lng, address, orderId } = data;
        
//         if (!lat || !lng) {
//           return socket.emit('error', { message: 'Latitude and longitude required' });
//         }

//         // Update in-memory store
//         const riderData = onlineRiders.get(userId) || {};
//         riderData.location = { lat, lng, address, timestamp: new Date() };
//         riderData.lastUpdate = Date.now();
//         onlineRiders.set(userId, riderData);

//         // Debounced DB update (max once every 30 seconds per rider)
//         const lastUpdate = riderLocationUpdates.get(userId) || 0;
//         if (Date.now() - lastUpdate > 30000) { // 30 seconds
//           riderLocationUpdates.set(userId, Date.now());
//           await updateRiderLocationInDB(userId, { lat, lng, address });
//         }

//         // Broadcast to tracking rooms (admins tracking this rider)
//         io.emit(`rider_${userId}_location`, {
//           riderId: userId,
//           location: { lat, lng, address },
//           timestamp: new Date(),
//           orderId
//         });

//         // If tracking a specific order, update order room
//         if (orderId) {
//           io.to(`order_${orderId}`).emit('rider_location', {
//             riderId: userId,
//             location: { lat, lng, address },
//             timestamp: new Date()
//           });
//         }

//         // Notify admins of rider movement
//         broadcastToAdmins('rider_location_update', {
//           riderId: userId,
//           riderName: socket.user?.firstName + ' ' + socket.user?.lastName,
//           plateNumber: (await Rider.findById(userId).select('plateNumber'))?.plateNumber || 'N/A',
//           location: { lat, lng, address },
//           timestamp: new Date()
//         });

//         socket.emit('location_update_success', {
//           message: 'Location updated',
//           timestamp: new Date()
//         });

//       } catch (error) {
//         console.error('Rider location update error:', error);
//         socket.emit('error', { message: 'Failed to update location' });
//       }
//     });

//     // Rider updates availability status
//     socket.on('rider_status_update', async (data) => {
//       try {
//         const { isAvailable, isActive } = data;
        
//         const riderData = onlineRiders.get(userId) || {};
//         if (isAvailable !== undefined) riderData.isAvailable = isAvailable;
//         if (isActive !== undefined) riderData.isActive = isActive;
//         onlineRiders.set(userId, riderData);

//         // Update in database
//         await Rider.findByIdAndUpdate(userId, {
//           isAvailable: isAvailable !== undefined ? isAvailable : undefined,
//           isActive: isActive !== undefined ? isActive : undefined,
//           lastActive: new Date()
//         });

//         // Broadcast to admins
//         broadcastToAdmins('rider_status_change', {
//           riderId: userId,
//           status: 'status_updated',
//           isAvailable: riderData.isAvailable,
//           isActive: riderData.isActive,
//           timestamp: new Date()
//         });

//         socket.emit('status_update_success', {
//           isAvailable: riderData.isAvailable,
//           isActive: riderData.isActive,
//           timestamp: new Date()
//         });

//       } catch (error) {
//         console.error('Rider status update error:', error);
//         socket.emit('error', { message: 'Failed to update status' });
//       }
//     });

//     // Rider joins order tracking room
//     socket.on('join_order_tracking', (data) => {
//       const { orderId } = data;
//       if (!orderId) return;

//       socket.join(`order_${orderId}`);
      
//       // Track which orders this rider is tracking
//       const currentOrders = riderRooms.get(userId) || [];
//       if (!currentOrders.includes(orderId)) {
//         currentOrders.push(orderId);
//         riderRooms.set(userId, currentOrders);
//       }

//       // Add to order rooms tracking
//       const orderSockets = orderRooms.get(orderId) || [];
//       if (!orderSockets.includes(socket.id)) {
//         orderSockets.push(socket.id);
//         orderRooms.set(orderId, orderSockets);
//       }

//       socket.emit('order_tracking_joined', { orderId });
//     });

//     // Rider leaves order tracking room
//     socket.on('leave_order_tracking', (data) => {
//       const { orderId } = data;
//       if (!orderId) return;

//       socket.leave(`order_${orderId}`);
      
//       // Remove from rider's tracked orders
//       const currentOrders = riderRooms.get(userId) || [];
//       const updatedOrders = currentOrders.filter(id => id !== orderId);
//       if (updatedOrders.length === 0) {
//         riderRooms.delete(userId);
//       } else {
//         riderRooms.set(userId, updatedOrders);
//       }

//       // Remove from order rooms
//       const orderSockets = orderRooms.get(orderId) || [];
//       const updatedSockets = orderSockets.filter(id => id !== socket.id);
//       if (updatedSockets.length === 0) {
//         orderRooms.delete(orderId);
//       } else {
//         orderRooms.set(orderId, updatedSockets);
//       }

//       socket.emit('order_tracking_left', { orderId });
//     });

//     // Rider requests vendor location
//     socket.on('request_vendor_location', async (data) => {
//       try {
//         const { shipmentId, orderId } = data;
        
//         const shipment = await Shipment.findById(shipmentId)
//           .populate('vendor', 'businessName phoneNumber businessLocation');
        
//         if (!shipment) {
//           return socket.emit('error', { message: 'Shipment not found' });
//         }

//         // Check if rider is assigned to this shipment
//         if (shipment.rider?.toString() !== userId) {
//           return socket.emit('error', { message: 'Not authorized for this shipment' });
//         }

//         socket.emit('vendor_location', {
//           shipmentId,
//           vendor: {
//             name: shipment.vendor.businessName,
//             phone: shipment.vendor.phoneNumber,
//             location: shipment.vendor.businessLocation
//           },
//           timestamp: new Date()
//         });

//       } catch (error) {
//         console.error('Vendor location request error:', error);
//         socket.emit('error', { message: 'Failed to get vendor location' });
//       }
//     });

//     // Rider requests delivery location
//     socket.on('request_delivery_location', async (data) => {
//       try {
//         const { orderId } = data;
        
//         const order = await MainOrder.findById(orderId)
//           .select('shippingAddress userLocation')
//           .populate('user', 'firstName lastName phoneNumber');
        
//         if (!order) {
//           return socket.emit('error', { message: 'Order not found' });
//         }

//         // Check if rider is assigned to this order
//         if (order.rider?.toString() !== userId) {
//           return socket.emit('error', { message: 'Not authorized for this order' });
//         }

//         socket.emit('delivery_location', {
//           orderId,
//           customer: {
//             name: `${order.user.firstName} ${order.user.lastName}`,
//             phone: order.user.phoneNumber
//           },
//           deliveryAddress: order.shippingAddress,
//           coordinates: order.userLocation,
//           timestamp: new Date()
//         });

//       } catch (error) {
//         console.error('Delivery location request error:', error);
//         socket.emit('error', { message: 'Failed to get delivery location' });
//       }
//     });

//     // Rider sends delivery update
//     socket.on('delivery_update', async (data) => {
//       try {
//         const { orderId, status, message, photos = [] } = data;
        
//         const order = await MainOrder.findById(orderId);
//         if (!order) {
//           return socket.emit('error', { message: 'Order not found' });
//         }

//         // Check if rider is assigned
//         if (order.rider?.toString() !== userId) {
//           return socket.emit('error', { message: 'Not authorized for this order' });
//         }

//         // Broadcast to order room
//         io.to(`order_${orderId}`).emit('delivery_status_update', {
//           orderId,
//           riderId: userId,
//           riderName: socket.user?.firstName + ' ' + socket.user?.lastName,
//           status,
//           message,
//           photos,
//           timestamp: new Date()
//         });

//         // Notify admin
//         broadcastToAdmins('delivery_update', {
//           orderId,
//           riderId: userId,
//           riderName: socket.user?.firstName + ' ' + socket.user?.lastName,
//           status,
//           message,
//           photos,
//           timestamp: new Date()
//         });

//         // Notify user if they're online
//         const userSocketId = onlineUsers.get(order.user.toString());
//         if (userSocketId) {
//           io.to(userSocketId).emit('delivery_update', {
//             orderId,
//             status,
//             message,
//             photos,
//             timestamp: new Date()
//           });
//         }

//         socket.emit('delivery_update_sent', { orderId });

//       } catch (error) {
//         console.error('Delivery update error:', error);
//         socket.emit('error', { message: 'Failed to send delivery update' });
//       }
//     });
//   }

//   // ============================================
//   // ADMIN-SPECIFIC EVENTS
//   // ============================================
  
//   if (userType === 'admin') {
    
//     // Admin requests all online riders
//     socket.on('get_online_riders', () => {
//       const riders = Array.from(onlineRiders.entries()).map(([riderId, data]) => ({
//         riderId,
//         socketId: data.socketId,
//         location: data.location,
//         lastUpdate: data.lastUpdate,
//         isAvailable: data.isAvailable,
//         isActive: data.isActive
//       }));
      
//       socket.emit('online_riders_list', {
//         riders,
//         count: riders.length,
//         timestamp: new Date()
//       });
//     });

//     // Admin starts tracking a specific rider
//     socket.on('track_rider', (data) => {
//       const { riderId } = data;
      
//       socket.join(`rider_tracking_${riderId}`);
//       socket.emit('rider_tracking_started', { riderId });
      
//       // Send current rider location if available
//       const riderData = onlineRiders.get(riderId);
//       if (riderData?.location) {
//         socket.emit('rider_location', {
//           riderId,
//           location: riderData.location,
//           isAvailable: riderData.isAvailable,
//           isActive: riderData.isActive,
//           timestamp: new Date(riderData.lastUpdate)
//         });
//       }
//     });

//     // Admin stops tracking a rider
//     socket.on('stop_tracking_rider', (data) => {
//       const { riderId } = data;
//       socket.leave(`rider_tracking_${riderId}`);
//       socket.emit('rider_tracking_stopped', { riderId });
//     });

//     // Admin tracks an order
//     socket.on('track_order', (data) => {
//       const { orderId } = data;
//       socket.join(`order_${orderId}`);
//       socket.emit('order_tracking_started', { orderId });
//     });

//     // Admin sends message to rider
//     socket.on('admin_to_rider_message', async (data) => {
//       try {
//         const { riderId, message, orderId } = data;
        
//         broadcastToRider(riderId, 'admin_message', {
//           adminId: userId,
//           adminName: socket.user?.firstName + ' ' + socket.user?.lastName,
//           message,
//           orderId,
//           timestamp: new Date()
//         });

//         socket.emit('message_sent', { riderId, message });

//       } catch (error) {
//         console.error('Admin to rider message error:', error);
//         socket.emit('error', { message: 'Failed to send message' });
//       }
//     });

//     // Admin assigns rider to order
//     socket.on('assign_rider_to_order', async (data) => {
//       try {
//         const { orderId, riderId } = data;
        
//         // Update order in database
//         const order = await MainOrder.findByIdAndUpdate(
//           orderId,
//           { rider: riderId, isClaimed: true, claimedAt: new Date() },
//           { new: true }
//         ).populate('rider', 'fullName phoneNumber plateNumber');

//         if (!order) {
//           return socket.emit('error', { message: 'Order not found' });
//         }

//         // Update all shipments
//         await Shipment.updateMany(
//           { mainOrder: orderId },
//           { 
//             rider: riderId,
//             isClaimed: true,
//             claimedAt: new Date(),
//             shipmentStatus: 'out_for_delivery'
//           }
//         );

//         // Notify rider
//         broadcastToRider(riderId, 'order_assigned', {
//           orderId,
//           orderDetails: {
//             shippingAddress: order.shippingAddress,
//             totalPrice: order.totalPrice,
//             customerName: order.user?.firstName + ' ' + order.user?.lastName
//           },
//           assignedBy: socket.user?.firstName + ' ' + socket.user?.lastName,
//           timestamp: new Date()
//         });

//         // Broadcast to order room
//         io.to(`order_${orderId}`).emit('rider_assigned', {
//           orderId,
//           riderId,
//           riderName: order.rider?.fullName,
//           riderPhone: order.rider?.phoneNumber,
//           timestamp: new Date()
//         });

//         socket.emit('rider_assigned_success', {
//           orderId,
//           riderId,
//           message: 'Rider assigned successfully'
//         });

//       } catch (error) {
//         console.error('Assign rider error:', error);
//         socket.emit('error', { message: 'Failed to assign rider' });
//       }
//     });
//   }

//   // ============================================
//   // VENDOR-SPECIFIC EVENTS
//   // ============================================
  
//   if (userType === 'vendor') {
    
//     // Vendor marks shipment ready for pickup
//     socket.on('shipment_ready_for_pickup', async (data) => {
//       try {
//         const { shipmentId } = data;
        
//         const shipment = await Shipment.findByIdAndUpdate(
//           shipmentId,
//           { shipmentStatus: 'ready_for_pickup' },
//           { new: true }
//         ).populate('mainOrder', 'rider');

//         if (!shipment) {
//           return socket.emit('error', { message: 'Shipment not found' });
//         }

//         // Check if vendor owns this shipment
//         if (shipment.vendor.toString() !== userId) {
//           return socket.emit('error', { message: 'Not authorized for this shipment' });
//         }

//         // If rider already assigned, notify them
//         if (shipment.mainOrder?.rider) {
//           broadcastToRider(shipment.mainOrder.rider.toString(), 'shipment_ready', {
//             shipmentId,
//             vendorId: userId,
//             vendorName: socket.user?.firstName + ' ' + socket.user?.lastName,
//             timestamp: new Date()
//           });
//         }

//         // Notify admin
//         broadcastToAdmins('shipment_ready_for_pickup', {
//           shipmentId,
//           vendorId: userId,
//           vendorName: socket.user?.firstName + ' ' + socket.user?.lastName,
//           orderId: shipment.mainOrder?._id,
//           timestamp: new Date()
//         });

//         socket.emit('shipment_ready_confirmed', { shipmentId });

//       } catch (error) {
//         console.error('Shipment ready error:', error);
//         socket.emit('error', { message: 'Failed to mark shipment ready' });
//       }
//     });

//     // Vendor sends message to rider
//     socket.on('vendor_to_rider_message', async (data) => {
//       try {
//         const { riderId, shipmentId, message } = data;
        
//         // Verify vendor has shipment with this rider
//         const shipment = await Shipment.findOne({
//           _id: shipmentId,
//           vendor: userId,
//           rider: riderId
//         });

//         if (!shipment) {
//           return socket.emit('error', { message: 'Not authorized to message this rider' });
//         }

//         broadcastToRider(riderId, 'vendor_message', {
//           vendorId: userId,
//           vendorName: socket.user?.firstName + ' ' + socket.user?.lastName,
//           shipmentId,
//           message,
//           timestamp: new Date()
//         });

//         socket.emit('message_sent', { riderId, message });

//       } catch (error) {
//         console.error('Vendor to rider message error:', error);
//         socket.emit('error', { message: 'Failed to send message' });
//       }
//     });
//   }

//   // ============================================
//   // USER-SPECIFIC EVENTS (CUSTOMER)
//   // ============================================
  
//   if (userType === 'user') {
    
//     // User tracks their order
//     socket.on('track_my_order', (data) => {
//       const { orderId } = data;
      
//       // Verify user owns this order
//       MainOrder.findById(orderId).then(order => {
//         if (!order || order.user.toString() !== userId) {
//           return socket.emit('error', { message: 'Order not found or not authorized' });
//         }
        
//         socket.join(`order_${orderId}`);
//         socket.join(`user_order_${userId}_${orderId}`);
        
//         socket.emit('order_tracking_started', {
//           orderId,
//           message: 'Now tracking your order in real-time'
//         });

//         // Send current order status if available
//         if (order.rider) {
//           Rider.findById(order.rider).then(rider => {
//             if (rider?.currentLocation) {
//               socket.emit('rider_location', {
//                 riderId: order.rider,
//                 riderName: rider.fullName,
//                 riderPhone: rider.phoneNumber,
//                 location: rider.currentLocation,
//                 timestamp: new Date()
//               });
//             }
//           });
//         }

//       }).catch(error => {
//         console.error('Order tracking error:', error);
//         socket.emit('error', { message: 'Failed to track order' });
//       });
//     });

//     // User requests order status update
//     socket.on('request_order_update', async (data) => {
//       try {
//         const { orderId } = data;
        
//         const order = await MainOrder.findById(orderId)
//           .populate('rider', 'fullName phoneNumber plateNumber currentLocation')
//           .populate({
//             path: 'shipments',
//             populate: { path: 'vendor', select: 'businessName phoneNumber' }
//           });

//         if (!order || order.user.toString() !== userId) {
//           return socket.emit('error', { message: 'Order not found or not authorized' });
//         }

//         socket.emit('order_status_update', {
//           orderId,
//           status: order.mainOrderStatus,
//           rider: order.rider ? {
//             name: order.rider.fullName,
//             phone: order.rider.phoneNumber,
//             plateNumber: order.rider.plateNumber,
//             location: order.rider.currentLocation
//           } : null,
//           shipments: order.shipments.map(shipment => ({
//             id: shipment._id,
//             status: shipment.shipmentStatus,
//             vendor: shipment.vendor.businessName,
//             vendorPhone: shipment.vendor.phoneNumber
//           })),
//           timestamp: new Date()
//         });

//       } catch (error) {
//         console.error('Order update request error:', error);
//         socket.emit('error', { message: 'Failed to get order update' });
//       }
//     });
//   }

//   // ============================================
//   // COMMON EVENTS (ALL USER TYPES)
//   // ============================================

//   // Join order room for tracking
//   socket.on('join_order_room', (data) => {
//     const { orderId } = data;
//     if (orderId) {
//       socket.join(`order_${orderId}`);
//       socket.emit('joined_order_room', { orderId });
//     }
//   });

//   // Leave order room
//   socket.on('leave_order_room', (data) => {
//     const { orderId } = data;
//     if (orderId) {
//       socket.leave(`order_${orderId}`);
//       socket.emit('left_order_room', { orderId });
//     }
//   });

//   // Ping/pong for connection health
//   socket.on('ping', (data) => {
//     socket.emit('pong', {
//       timestamp: new Date(),
//       ...data
//     });
//   });

//   // ============================================
//   // KEEP EXISTING CHAT & DISPUTE HANDLERS (UNCHANGED)
//   // ============================================
  
//   // ... [Keep all your existing chat and dispute handlers from original server.js]
//   // I'm preserving your existing chat system exactly as it was
  
//   socket.on('joinDispute', async (disputeId) => {
//     try {
//       socket.join(`dispute_${disputeId}`);
//     } catch (err) {
//       console.error('joinDispute error', err);
//     }
//   });

//   socket.on('leaveDispute', (disputeId) => {
//     try {
//       socket.leave(`dispute_${disputeId}`);
//     } catch (err) {
//       console.error('leaveDispute error', err);
//     }
//   });

//   socket.on('sendMessage', async (payload, cb) => {
//     try {
//       const { disputeId, text = '', attachments = [] } = payload;
//       const dispute = await DisputeRequest.findById(disputeId);
//       if (!dispute) return cb && cb({ error: 'Dispute not found' });

//       const messageDoc = await Message.create({
//         dispute: disputeId,
//         sender: socket.user.id,
//         text,
//         attachments,
//       });
//       dispute.messages.push({ sender: socket.user.id, text, attachments });
//       await dispute.save();

//       const out = {
//         id: messageDoc._id,
//         dispute: String(disputeId),
//         sender: socket.user.id,
//         text,
//         attachments,
//         createdAt: messageDoc.createdAt,
//       };
//       io.to(`dispute_${disputeId}`).emit('message', out);
//       if (cb) cb({ success: true, message: out });
//     } catch (err) {
//       console.error('sendMessage socket error', err);
//       if (cb) cb({ error: 'Failed to send message' });
//     }
//   });

//   // Chat session handlers
//   const onlinePharmacists = new Map();
//   app.set('onlinePharmacists', onlinePharmacists);

//   function socketUserId(payload) {
//     return payload?.sub || payload?.id || payload?._id || payload?.userId || null;
//   }

//   function socketUserRole(payload) {
//     return payload?.role || payload?.user_role || payload?.userRole || null;
//   }

//   function broadcastPharmacistStatus() {
//     const count = onlinePharmacists.size;
//     io.emit('pharmacistStatus', { online: count > 0, count });
//   }

//   async function emitSystemMessage(sessionId, text) {
//     try {
//       const sysMsg = await ChatMessage.create({
//         session: sessionId,
//         senderType: 'system',
//         sender: null,
//         message: text,
//       });

//       const outSys = {
//         id: sysMsg._id,
//         session: String(sessionId),
//         senderType: 'system',
//         sender: null,
//         text: sysMsg.message,
//         createdAt: sysMsg.createdAt,
//       };
//       io.to(`chat_${sessionId}`).emit('new_message', outSys);
//       return outSys;
//     } catch (error) {
//       console.error('Failed to emit system message:', error);
//     }
//   }

//   // If pharmacist connected via socket, track presence
//   if (userRole === 'pharmacist' && userId) {
//     onlinePharmacists.set(String(userId), socket.id);
//     broadcastPharmacistStatus();
//   }

//   // Chat handlers (keep existing)
//   socket.on('join_chat', async (payload, cb) => {
//     try {
//       const { sessionId } = payload || {};
//       if (!sessionId) {
//         console.error('join_chat: sessionId required');
//         return cb && cb({ success: false, message: 'Session ID is required' });
//       }

//       socket.join(`chat_${sessionId}`);

//       const session = await ChatSession.findById(sessionId).lean();
      
//       if (!session) {
//         console.error(`join_chat: Session not found for ID: ${sessionId}`);
//         return cb && cb({ success: false, message: 'Chat session not found' });
//       }
      
//       const messages = await ChatMessage.find({ session: session._id }).sort({ createdAt: 1 }).lean();
      
//       if (userRole === 'pharmacist' && userId) {
//         await User.findByIdAndUpdate(userId, { isAvailable: true });
//       }

//       return cb && cb({ success: true, session: session, messages: messages });
//     } catch (err) {
//       console.error('join_chat error', err);
//       return cb && cb({ success: false, message: 'Server error during chat join' });
//     }
//   });

//   socket.on('leave_chat', ({ sessionId }) => {
//     try {
//       if (!sessionId) return;
//       socket.leave(`chat_${sessionId}`);
//     } catch (err) {
//       console.error('leave_chat error', err);
//     }
//   });

//   socket.on('send_chat_message', async (payload, cb) => {
//     try {
//       const { sessionId, text } = payload || {};
//       if (!sessionId || !text) return cb && cb({ error: 'sessionId and text required' });

//       const session = await ChatSession.findById(sessionId);
//       if (!session) return cb && cb({ error: 'session not found' });

//       const senderType = userRole === 'pharmacist' ? 'pharmacist' : 'user';
//       const sender = userId || null;

//       if (session.pharmacist || senderType === 'pharmacist') {
//         if (userRole === 'pharmacist' && String(session.pharmacist) !== String(userId)) {
//           return cb && cb({ error: 'pharmacist is not assigned to this session' });
//         }
        
//         const userMsg = await ChatMessage.create({
//           session: session._id,
//           senderType,
//           sender,
//           message: text,
//         });
//         const outUser = {
//           id: userMsg._id,
//           session: String(session._id),
//           senderType: userMsg.senderType,
//           sender,
//           text: userMsg.message,
//           createdAt: userMsg.createdAt,
//         };
//         io.to(`chat_${sessionId}`).emit('new_message', outUser);
//         return cb && cb({ success: true, message: outUser });
//       }

//       const userMsg = await ChatMessage.create({
//         session: session._id,
//         senderType,
//         sender,
//         message: text,
//       });

//       const outUser = {
//         id: userMsg._id,
//         session: String(session._id),
//         senderType: userMsg.senderType,
//         sender,
//         text: userMsg.message,
//         createdAt: userMsg.createdAt,
//       };

//       io.to(`chat_${sessionId}`).emit('new_message', outUser);

//       let availablePharmacistId = onlinePharmacists.keys().next().value;
//       let availablePharmacistDetails = null;

//       if (availablePharmacistId) {
//         availablePharmacistDetails = await User.findById(availablePharmacistId, 'name');
//       } else {
//         availablePharmacistDetails = await User.findOne({ role: 'pharmacist', isAvailable: true }).lean();
//       }

//       if (availablePharmacistDetails) {
//         const pharmId = String(availablePharmacistDetails._id || availablePharmacistId);
//         const pharmacistSocketId = onlinePharmacists.get(pharmId);
//         if (pharmacistSocketId) {
//           io.to(pharmacistSocketId).emit('incoming_chat_request', {
//             sessionId: String(session._id),
//             userId: session.user,
//             textPreview: text.slice(0, 300),
//             createdAt: new Date(),
//           });
//         }

//         await emitSystemMessage(
//           session._id,
//           'A certified pharmacist has been notified. They will join the chat shortly. The AI is on standby.'
//         );
//       }

//       const aiReplyText = await getAIResponse(text);

//       const aiMsg = await ChatMessage.create({
//         session: session._id,
//         senderType: 'ai',
//         sender: null,
//         message: aiReplyText,
//       });

//       const outAi = {
//         id: aiMsg._id,
//         session: String(session._id),
//         senderType: 'ai',
//         sender: null,
//         text: aiMsg.message,
//         createdAt: aiMsg.createdAt,
//       };

//       io.to(`chat_${sessionId}`).emit('new_message', outAi);

//       return cb && cb({ success: true, message: outUser, aiReply: outAi });

//     } catch (err) {
//       console.error('send_chat_message error', err);
//       return cb && cb({ error: 'failed to send' });
//     }
//   });

//   socket.on('pharmacist_claim_session', async (payload, cb) => {
//     try {
//       const { sessionId } = payload || {};
//       if (!sessionId) return cb && cb({ error: 'sessionId required' });
//       if (userRole !== 'pharmacist') return cb && cb({ error: 'only pharmacists can claim' });

//       const session = await ChatSession.findById(sessionId);
//       if (!session) return cb && cb({ error: 'session not found' });

//       if (session.pharmacist) {
//         return cb && cb({ success: false, message: 'Session already claimed.' });
//       }

//       session.pharmacist = userId;
//       session.status = 'assigned';
//       await session.save();

//       const pharmacistUser = await User.findById(userId, 'firstName lastName');
//       const pharmacistName = pharmacistUser ? `${pharmacistUser.firstName} ${pharmacistUser.lastName}` : 'A certified pharmacist';

//       await emitSystemMessage(
//         session._id,
//         `${pharmacistName} has joined the chat room. The AI has stepped aside.`
//       );
      
//       io.to(`chat_${sessionId}`).emit('pharmacist_joined', {
//         pharmacistId: session.pharmacist,
//         name: pharmacistName,
//       });

//       return cb && cb({ success: true, session });
//     } catch (err) {
//       console.error('pharmacist_claim_session error', err);
//       return cb && cb({ error: 'claim failed' });
//     }
//   });

//   // ============================================
//   // DISCONNECTION HANDLER
//   // ============================================

//   socket.on('disconnect', async (reason) => {
//     console.log('🔌 Socket disconnected:', socket.id, 'Reason:', reason, 'User:', userId);

//     // Remove from online users
//     onlineUsers.delete(userId);

//     // Remove from role-specific maps
//     if (userType === 'rider') {
//       onlineRiders.delete(userId);
      
//       // Notify admins of rider going offline
//       broadcastToAdmins('rider_status_change', {
//         riderId: userId,
//         status: 'offline',
//         timestamp: new Date()
//       });

//       // Clean up rider rooms
//       riderRooms.delete(userId);
//     } else if (userType === 'admin') {
//       onlineAdmins.delete(userId);
//     } else if (userType === 'vendor') {
//       onlineVendors.delete(userId);
//     }

//     // Clean up order rooms
//     for (const [orderId, sockets] of orderRooms.entries()) {
//       const updatedSockets = sockets.filter(id => id !== socket.id);
//       if (updatedSockets.length === 0) {
//         orderRooms.delete(orderId);
//       } else {
//         orderRooms.set(orderId, updatedSockets);
//       }
//     }

//     // Pharmacist cleanup (existing)
//     if (userRole === 'pharmacist' && userId) {
//       for (const [pharmId, sId] of onlinePharmacists.entries()) {
//         if (sId === socket.id) onlinePharmacists.delete(pharmId);
//       }
      
//       await User.findByIdAndUpdate(userId, { isAvailable: false });
//       broadcastPharmacistStatus();
//     }

//     console.log(`📊 Online stats: Users: ${onlineUsers.size}, Riders: ${onlineRiders.size}, Admins: ${onlineAdmins.size}, Vendors: ${onlineVendors.size}`);
//   });
// });

// // ============================================
// // HELPER FUNCTIONS FOR CONTROLLERS TO USE
// // ============================================

// // Function for controllers to emit events
// app.set('emitOrderUpdate', (orderId, data) => {
//   io.to(`order_${orderId}`).emit('order_update', data);
// });

// app.set('emitRiderUpdate', (riderId, data) => {
//   io.to(`rider_tracking_${riderId}`).emit('rider_update', data);
// });

// app.set('notifyAdmin', (data) => {
//   broadcastToAdmins('admin_notification', data);
// });

// app.set('notifyRider', (riderId, data) => {
//   broadcastToRider(riderId, 'notification', data);
// });

// app.set('notifyVendor', (vendorId, data) => {
//   const socketId = onlineVendors.get(vendorId);
//   if (socketId) {
//     io.to(socketId).emit('vendor_notification', data);
//   }
// });

// // 404 + error handler (must be last)
// app.use(notFound);
// app.use(errorHandler);

// server.listen(PORT, '0.0.0.0', () => {
//   console.log(colors.cyan.underline(`🚀 Server running on http://0.0.0.0:${PORT}`));
//   console.log(colors.green(`📡 Real-time tracking system active`));
//   console.log(colors.yellow(`📊 Available socket events:`));
//   console.log(colors.yellow(`   - Rider: location_update, status_update, delivery_update`));
//   console.log(colors.yellow(`   - Admin: track_rider, assign_rider, admin_to_rider_message`));
//   console.log(colors.yellow(`   - Vendor: shipment_ready_for_pickup, vendor_to_rider_message`));
//   console.log(colors.yellow(`   - User: track_my_order, request_order_update`));
// });
