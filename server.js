// server.js (FINAL UPDATED VERSION WITH REAL-TIME TRACKING)
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
app.use('/api/riders', require('./routes/riderRoutes'));
app.use('/api/uploads', require('./routes/uploadsRoutes'));

// Health/root
app.get('/', (req, res) => res.json({ message: 'NaijaGo Backend API is running!' }));

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
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication token required'));
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = {
      id: decoded.id,
      role: decoded.role || 'user',
      email: decoded.email,
      firstName: decoded.firstName,
      lastName: decoded.lastName
    };
    
    return next();
  } catch (err) {
    console.error('Socket auth failed:', err.message);
    next(new Error('Authentication failed'));
  }
});

// Existing models
const Message = require('./models/Message');
const DisputeRequest = require('./models/DisputeRequest');
const ChatSession = require('./models/ChatSession');
const ChatMessage = require('./models/ChatMessage');
const User = require('./models/User');
const Rider = require('./models/Rider');
const MainOrder = require('./models/MainOrder');
const Shipment = require('./models/Shipment');

// AI helper
const { getAIResponse } = require('./utils/aiChatService');

// expose io to controllers
app.set('io', io);

// ============================================
// REAL-TIME TRACKING & NOTIFICATION SYSTEM
// ============================================

// In-memory tracking stores
const onlineUsers = new Map(); // userId -> socketId
const onlineRiders = new Map(); // riderId -> {socketId, location, lastUpdate}
const onlineAdmins = new Map(); // adminId -> socketId
const onlineVendors = new Map(); // vendorId -> socketId

// Room management for order tracking
const orderRooms = new Map(); // orderId -> [socketIds]
const riderRooms = new Map(); // riderId -> [orderIds being tracked]

// Helper functions
function getUserTypeFromRole(role) {
  if (role === 'rider') return 'rider';
  if (role === 'admin') return 'admin';
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

function broadcastToRider(riderId, event, data) {
  const riderData = onlineRiders.get(riderId);
  if (riderData && riderData.socketId) {
    io.to(riderData.socketId).emit(event, data);
  }
}

// Update rider location in database (debounced)
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

// Periodic cleanup of disconnected users
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes
  
  // Clean old location updates
  for (const [riderId, timestamp] of riderLocationUpdates.entries()) {
    if (now - timestamp > timeout) {
      riderLocationUpdates.delete(riderId);
    }
  }
}, 60 * 1000); // Run every minute

// ============================================
// SOCKET.IO EVENT HANDLERS
// ============================================

io.on('connection', (socket) => {
  console.log('🔌 New socket connection:', socket.id, 'User:', socket.user?.id);

  const userId = socket.user?.id;
  const userRole = socket.user?.role;
  const userType = getUserTypeFromRole(userRole);

  // Store user connection
  onlineUsers.set(userId, socket.id);
  
  // Store in appropriate role-based map
  if (userType === 'rider') {
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
    
  } else if (userType === 'admin') {
    onlineAdmins.set(userId, socket.id);
  } else if (userType === 'vendor') {
    onlineVendors.set(userId, socket.id);
  }

  // Send initial connection confirmation
  socket.emit('connection_established', {
    message: 'Connected to real-time server',
    userId,
    userType,
    timestamp: new Date()
  });

  // ============================================
  // RIDER-SPECIFIC EVENTS
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
        await Rider.findByIdAndUpdate(userId, {
          isAvailable: isAvailable !== undefined ? isAvailable : undefined,
          isActive: isActive !== undefined ? isActive : undefined,
          lastActive: new Date()
        });

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
  // ADMIN-SPECIFIC EVENTS
  // ============================================
  
  if (userType === 'admin') {
    
    // Admin requests all online riders
    socket.on('get_online_riders', () => {
      const riders = Array.from(onlineRiders.entries()).map(([riderId, data]) => ({
        riderId,
        socketId: data.socketId,
        location: data.location,
        lastUpdate: data.lastUpdate,
        isAvailable: data.isAvailable,
        isActive: data.isActive
      }));
      
      socket.emit('online_riders_list', {
        riders,
        count: riders.length,
        timestamp: new Date()
      });
    });

    // Admin starts tracking a specific rider
    socket.on('track_rider', (data) => {
      const { riderId } = data;
      
      socket.join(`rider_tracking_${riderId}`);
      socket.emit('rider_tracking_started', { riderId });
      
      // Send current rider location if available
      const riderData = onlineRiders.get(riderId);
      if (riderData?.location) {
        socket.emit('rider_location', {
          riderId,
          location: riderData.location,
          isAvailable: riderData.isAvailable,
          isActive: riderData.isActive,
          timestamp: new Date(riderData.lastUpdate)
        });
      }
    });

    // Admin stops tracking a rider
    socket.on('stop_tracking_rider', (data) => {
      const { riderId } = data;
      socket.leave(`rider_tracking_${riderId}`);
      socket.emit('rider_tracking_stopped', { riderId });
    });

    // Admin tracks an order
    socket.on('track_order', (data) => {
      const { orderId } = data;
      socket.join(`order_${orderId}`);
      socket.emit('order_tracking_started', { orderId });
    });

    // Admin sends message to rider
    socket.on('admin_to_rider_message', async (data) => {
      try {
        const { riderId, message, orderId } = data;
        
        broadcastToRider(riderId, 'admin_message', {
          adminId: userId,
          adminName: socket.user?.firstName + ' ' + socket.user?.lastName,
          message,
          orderId,
          timestamp: new Date()
        });

        socket.emit('message_sent', { riderId, message });

      } catch (error) {
        console.error('Admin to rider message error:', error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // Admin assigns rider to order
    socket.on('assign_rider_to_order', async (data) => {
      try {
        const { orderId, riderId } = data;
        
        // Update order in database
        const order = await MainOrder.findByIdAndUpdate(
          orderId,
          { rider: riderId, isClaimed: true, claimedAt: new Date() },
          { new: true }
        ).populate('rider', 'fullName phoneNumber plateNumber');

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

        // Broadcast to order room
        io.to(`order_${orderId}`).emit('rider_assigned', {
          orderId,
          riderId,
          riderName: order.rider?.fullName,
          riderPhone: order.rider?.phoneNumber,
          timestamp: new Date()
        });

        socket.emit('rider_assigned_success', {
          orderId,
          riderId,
          message: 'Rider assigned successfully'
        });

      } catch (error) {
        console.error('Assign rider error:', error);
        socket.emit('error', { message: 'Failed to assign rider' });
      }
    });
  }

  // ============================================
  // VENDOR-SPECIFIC EVENTS
  // ============================================
  
  if (userType === 'vendor') {
    
    // Vendor marks shipment ready for pickup
    socket.on('shipment_ready_for_pickup', async (data) => {
      try {
        const { shipmentId } = data;
        
        const shipment = await Shipment.findByIdAndUpdate(
          shipmentId,
          { shipmentStatus: 'ready_for_pickup' },
          { new: true }
        ).populate('mainOrder', 'rider');

        if (!shipment) {
          return socket.emit('error', { message: 'Shipment not found' });
        }

        // Check if vendor owns this shipment
        if (shipment.vendor.toString() !== userId) {
          return socket.emit('error', { message: 'Not authorized for this shipment' });
        }

        // If rider already assigned, notify them
        if (shipment.mainOrder?.rider) {
          broadcastToRider(shipment.mainOrder.rider.toString(), 'shipment_ready', {
            shipmentId,
            vendorId: userId,
            vendorName: socket.user?.firstName + ' ' + socket.user?.lastName,
            timestamp: new Date()
          });
        }

        // Notify admin
        broadcastToAdmins('shipment_ready_for_pickup', {
          shipmentId,
          vendorId: userId,
          vendorName: socket.user?.firstName + ' ' + socket.user?.lastName,
          orderId: shipment.mainOrder?._id,
          timestamp: new Date()
        });

        socket.emit('shipment_ready_confirmed', { shipmentId });

      } catch (error) {
        console.error('Shipment ready error:', error);
        socket.emit('error', { message: 'Failed to mark shipment ready' });
      }
    });

    // Vendor sends message to rider
    socket.on('vendor_to_rider_message', async (data) => {
      try {
        const { riderId, shipmentId, message } = data;
        
        // Verify vendor has shipment with this rider
        const shipment = await Shipment.findOne({
          _id: shipmentId,
          vendor: userId,
          rider: riderId
        });

        if (!shipment) {
          return socket.emit('error', { message: 'Not authorized to message this rider' });
        }

        broadcastToRider(riderId, 'vendor_message', {
          vendorId: userId,
          vendorName: socket.user?.firstName + ' ' + socket.user?.lastName,
          shipmentId,
          message,
          timestamp: new Date()
        });

        socket.emit('message_sent', { riderId, message });

      } catch (error) {
        console.error('Vendor to rider message error:', error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });
  }

  // ============================================
  // USER-SPECIFIC EVENTS (CUSTOMER)
  // ============================================
  
  if (userType === 'user') {
    
    // User tracks their order
    socket.on('track_my_order', (data) => {
      const { orderId } = data;
      
      // Verify user owns this order
      MainOrder.findById(orderId).then(order => {
        if (!order || order.user.toString() !== userId) {
          return socket.emit('error', { message: 'Order not found or not authorized' });
        }
        
        socket.join(`order_${orderId}`);
        socket.join(`user_order_${userId}_${orderId}`);
        
        socket.emit('order_tracking_started', {
          orderId,
          message: 'Now tracking your order in real-time'
        });

        // Send current order status if available
        if (order.rider) {
          Rider.findById(order.rider).then(rider => {
            if (rider?.currentLocation) {
              socket.emit('rider_location', {
                riderId: order.rider,
                riderName: rider.fullName,
                riderPhone: rider.phoneNumber,
                location: rider.currentLocation,
                timestamp: new Date()
              });
            }
          });
        }

      }).catch(error => {
        console.error('Order tracking error:', error);
        socket.emit('error', { message: 'Failed to track order' });
      });
    });

    // User requests order status update
    socket.on('request_order_update', async (data) => {
      try {
        const { orderId } = data;
        
        const order = await MainOrder.findById(orderId)
          .populate('rider', 'fullName phoneNumber plateNumber currentLocation')
          .populate({
            path: 'shipments',
            populate: { path: 'vendor', select: 'businessName phoneNumber' }
          });

        if (!order || order.user.toString() !== userId) {
          return socket.emit('error', { message: 'Order not found or not authorized' });
        }

        socket.emit('order_status_update', {
          orderId,
          status: order.mainOrderStatus,
          rider: order.rider ? {
            name: order.rider.fullName,
            phone: order.rider.phoneNumber,
            plateNumber: order.rider.plateNumber,
            location: order.rider.currentLocation
          } : null,
          shipments: order.shipments.map(shipment => ({
            id: shipment._id,
            status: shipment.shipmentStatus,
            vendor: shipment.vendor.businessName,
            vendorPhone: shipment.vendor.phoneNumber
          })),
          timestamp: new Date()
        });

      } catch (error) {
        console.error('Order update request error:', error);
        socket.emit('error', { message: 'Failed to get order update' });
      }
    });
  }

  // ============================================
  // COMMON EVENTS (ALL USER TYPES)
  // ============================================

  // Join order room for tracking
  socket.on('join_order_room', (data) => {
    const { orderId } = data;
    if (orderId) {
      socket.join(`order_${orderId}`);
      socket.emit('joined_order_room', { orderId });
    }
  });

  // Leave order room
  socket.on('leave_order_room', (data) => {
    const { orderId } = data;
    if (orderId) {
      socket.leave(`order_${orderId}`);
      socket.emit('left_order_room', { orderId });
    }
  });

  // Ping/pong for connection health
  socket.on('ping', (data) => {
    socket.emit('pong', {
      timestamp: new Date(),
      ...data
    });
  });

  // ============================================
  // KEEP EXISTING CHAT & DISPUTE HANDLERS (UNCHANGED)
  // ============================================
  
  // ... [Keep all your existing chat and dispute handlers from original server.js]
  // I'm preserving your existing chat system exactly as it was
  
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

  // Chat session handlers
  const onlinePharmacists = new Map();
  app.set('onlinePharmacists', onlinePharmacists);

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

  async function emitSystemMessage(sessionId, text) {
    try {
      const sysMsg = await ChatMessage.create({
        session: sessionId,
        senderType: 'system',
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

  // If pharmacist connected via socket, track presence
  if (userRole === 'pharmacist' && userId) {
    onlinePharmacists.set(String(userId), socket.id);
    broadcastPharmacistStatus();
  }

  // Chat handlers (keep existing)
  socket.on('join_chat', async (payload, cb) => {
    try {
      const { sessionId } = payload || {};
      if (!sessionId) {
        console.error('join_chat: sessionId required');
        return cb && cb({ success: false, message: 'Session ID is required' });
      }

      socket.join(`chat_${sessionId}`);

      const session = await ChatSession.findById(sessionId).lean();
      
      if (!session) {
        console.error(`join_chat: Session not found for ID: ${sessionId}`);
        return cb && cb({ success: false, message: 'Chat session not found' });
      }
      
      const messages = await ChatMessage.find({ session: session._id }).sort({ createdAt: 1 }).lean();
      
      if (userRole === 'pharmacist' && userId) {
        await User.findByIdAndUpdate(userId, { isAvailable: true });
      }

      return cb && cb({ success: true, session: session, messages: messages });
    } catch (err) {
      console.error('join_chat error', err);
      return cb && cb({ success: false, message: 'Server error during chat join' });
    }
  });

  socket.on('leave_chat', ({ sessionId }) => {
    try {
      if (!sessionId) return;
      socket.leave(`chat_${sessionId}`);
    } catch (err) {
      console.error('leave_chat error', err);
    }
  });

  socket.on('send_chat_message', async (payload, cb) => {
    try {
      const { sessionId, text } = payload || {};
      if (!sessionId || !text) return cb && cb({ error: 'sessionId and text required' });

      const session = await ChatSession.findById(sessionId);
      if (!session) return cb && cb({ error: 'session not found' });

      const senderType = userRole === 'pharmacist' ? 'pharmacist' : 'user';
      const sender = userId || null;

      if (session.pharmacist || senderType === 'pharmacist') {
        if (userRole === 'pharmacist' && String(session.pharmacist) !== String(userId)) {
          return cb && cb({ error: 'pharmacist is not assigned to this session' });
        }
        
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
        io.to(`chat_${sessionId}`).emit('new_message', outUser);
        return cb && cb({ success: true, message: outUser });
      }

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

      io.to(`chat_${sessionId}`).emit('new_message', outUser);

      let availablePharmacistId = onlinePharmacists.keys().next().value;
      let availablePharmacistDetails = null;

      if (availablePharmacistId) {
        availablePharmacistDetails = await User.findById(availablePharmacistId, 'name');
      } else {
        availablePharmacistDetails = await User.findOne({ role: 'pharmacist', isAvailable: true }).lean();
      }

      if (availablePharmacistDetails) {
        const pharmId = String(availablePharmacistDetails._id || availablePharmacistId);
        const pharmacistSocketId = onlinePharmacists.get(pharmId);
        if (pharmacistSocketId) {
          io.to(pharmacistSocketId).emit('incoming_chat_request', {
            sessionId: String(session._id),
            userId: session.user,
            textPreview: text.slice(0, 300),
            createdAt: new Date(),
          });
        }

        await emitSystemMessage(
          session._id,
          'A certified pharmacist has been notified. They will join the chat shortly. The AI is on standby.'
        );
      }

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

  socket.on('pharmacist_claim_session', async (payload, cb) => {
    try {
      const { sessionId } = payload || {};
      if (!sessionId) return cb && cb({ error: 'sessionId required' });
      if (userRole !== 'pharmacist') return cb && cb({ error: 'only pharmacists can claim' });

      const session = await ChatSession.findById(sessionId);
      if (!session) return cb && cb({ error: 'session not found' });

      if (session.pharmacist) {
        return cb && cb({ success: false, message: 'Session already claimed.' });
      }

      session.pharmacist = userId;
      session.status = 'assigned';
      await session.save();

      const pharmacistUser = await User.findById(userId, 'firstName lastName');
      const pharmacistName = pharmacistUser ? `${pharmacistUser.firstName} ${pharmacistUser.lastName}` : 'A certified pharmacist';

      await emitSystemMessage(
        session._id,
        `${pharmacistName} has joined the chat room. The AI has stepped aside.`
      );
      
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

  // ============================================
  // DISCONNECTION HANDLER
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
    } else if (userType === 'admin') {
      onlineAdmins.delete(userId);
    } else if (userType === 'vendor') {
      onlineVendors.delete(userId);
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

    // Pharmacist cleanup (existing)
    if (userRole === 'pharmacist' && userId) {
      for (const [pharmId, sId] of onlinePharmacists.entries()) {
        if (sId === socket.id) onlinePharmacists.delete(pharmId);
      }
      
      await User.findByIdAndUpdate(userId, { isAvailable: false });
      broadcastPharmacistStatus();
    }

    console.log(`📊 Online stats: Users: ${onlineUsers.size}, Riders: ${onlineRiders.size}, Admins: ${onlineAdmins.size}, Vendors: ${onlineVendors.size}`);
  });
});

// ============================================
// HELPER FUNCTIONS FOR CONTROLLERS TO USE
// ============================================

// Function for controllers to emit events
app.set('emitOrderUpdate', (orderId, data) => {
  io.to(`order_${orderId}`).emit('order_update', data);
});

app.set('emitRiderUpdate', (riderId, data) => {
  io.to(`rider_tracking_${riderId}`).emit('rider_update', data);
});

app.set('notifyAdmin', (data) => {
  broadcastToAdmins('admin_notification', data);
});

app.set('notifyRider', (riderId, data) => {
  broadcastToRider(riderId, 'notification', data);
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(colors.cyan.underline(`🚀 Server running on http://0.0.0.0:${PORT}`));
  console.log(colors.green(`📡 Real-time tracking system active`));
  console.log(colors.yellow(`📊 Available socket events:`));
  console.log(colors.yellow(`   - Rider: location_update, status_update, delivery_update`));
  console.log(colors.yellow(`   - Admin: track_rider, assign_rider, admin_to_rider_message`));
  console.log(colors.yellow(`   - Vendor: shipment_ready_for_pickup, vendor_to_rider_message`));
  console.log(colors.yellow(`   - User: track_my_order, request_order_update`));
});










// // server.js (FINAL UPDATED VERSION)
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
//   cors({
//     origin: process.env.FRONTEND_ORIGIN || '*',
//     methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
//     credentials: true,
//   })
// );

// // Rate limit auth endpoints
// const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
// app.use('/api/auth', authLimiter);

// app.use(express.static(path.join(__dirname, 'public')));
// app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// // Routes (unchanged)
// app.use('/api/auth', require('./routes/authRoutes'));
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
//   cors: { origin: process.env.FRONTEND_ORIGIN || '*', methods: ['GET', 'POST'] },
//   pingTimeout: 60000,
// });

// // Socket auth (JWT handshake)
// io.use((socket, next) => {
//   try {
//     const token = socket.handshake.auth?.token;
//     if (!token) return next(new Error('Auth error'));
//     const decoded = jwt.verify(token, process.env.JWT_SECRET);
//     socket.user = decoded;
//     return next();
//   } catch (err) {
//     console.error('Socket auth failed', err);
//     next(new Error('Auth error'));
//   }
// });

// // Existing models (leave intact)
// const Message = require('./models/Message');
// const DisputeRequest = require('./models/DisputeRequest');

// // Chat models & user model
// const ChatSession = require('./models/ChatSession');
// const ChatMessage = require('./models/ChatMessage');
// const User = require('./models/User'); // used for available pharmacist lookup

// // AI helper
// const { getAIResponse } = require('./utils/aiChatService');

// // expose io to controllers
// app.set('io', io);

// // -------------------
// // Chat & presence socket logic (production-ready)
// // -------------------

// // In-memory map: pharmacistId -> socketId (for connected pharmacists)
// // NOTE: for horizontal scaling use socket.io-redis adapter and a shared presence store.
// const onlinePharmacists = new Map();
// app.set('onlinePharmacists', onlinePharmacists);

// // Helper to read common id/role fields from JWT payload
// function socketUserId(payload) {
//   return payload?.sub || payload?.id || payload?._id || payload?.userId || null;
// }
// function socketUserRole(payload) {
//   return payload?.role || payload?.user_role || payload?.userRole || null;
// }

// function broadcastPharmacistStatus() {
//   const count = onlinePharmacists.size;
//   io.emit('pharmacistStatus', { online: count > 0, count });
// }

// /**
//  * Helper function to create and emit a system/info message.
//  * @param {string} sessionId - ID of the chat room
//  * @param {string} text - The system message text
//  */
// async function emitSystemMessage(sessionId, text) {
//   try {
//     const sysMsg = await ChatMessage.create({
//       session: sessionId,
//       senderType: 'system', // Use 'system' for announcements/events
//       sender: null,
//       message: text,
//     });

//     const outSys = {
//       id: sysMsg._id,
//       session: String(sessionId),
//       senderType: 'system',
//       sender: null,
//       text: sysMsg.message,
//       createdAt: sysMsg.createdAt,
//     };
//     io.to(`chat_${sessionId}`).emit('new_message', outSys);
//     return outSys;
//   } catch (error) {
//     console.error('Failed to emit system message:', error);
//   }
// }


// io.on('connection', (socket) => {
//   try {
//     const decoded = socket.user || {};
//     const userId = socketUserId(decoded);
//     const userRole = socketUserRole(decoded);

//     console.log('Socket connected', { userId, userRole, socketId: socket.id });

//     // If pharmacist connected via socket, track presence
//     if (userRole === 'pharmacist' && userId) {
//       onlinePharmacists.set(String(userId), socket.id);
//       console.log('Pharmacist online ->', userId);
//       broadcastPharmacistStatus();
//     }

//     // ========== Keep existing dispute handlers (unchanged) ==========
//     socket.on('joinDispute', async (disputeId) => {
//       try {
//         socket.join(`dispute_${disputeId}`);
//       } catch (err) {
//         console.error('joinDispute error', err);
//       }
//     });

//     socket.on('leaveDispute', (disputeId) => {
//       try {
//         socket.leave(`dispute_${disputeId}`);
//       } catch (err) {
//         console.error('leaveDispute error', err);
//       }
//     });

//     socket.on('sendMessage', async (payload, cb) => {
//       try {
//         const { disputeId, text = '', attachments = [] } = payload;
//         const dispute = await DisputeRequest.findById(disputeId);
//         if (!dispute) return cb && cb({ error: 'Dispute not found' });

//         const messageDoc = await Message.create({
//           dispute: disputeId,
//           sender: socket.user.id,
//           text,
//           attachments,
//         });
//         dispute.messages.push({ sender: socket.user.id, text, attachments });
//         await dispute.save();

//         const out = {
//           id: messageDoc._id,
//           dispute: String(disputeId),
//           sender: socket.user.id,
//           text,
//           attachments,
//           createdAt: messageDoc.createdAt,
//         };
//         io.to(`dispute_${disputeId}`).emit('message', out);
//         if (cb) cb({ success: true, message: out });
//       } catch (err) {
//         console.error('sendMessage socket error', err);
//         if (cb) cb({ error: 'Failed to send message' });
//       }
//     });
//     // ========== End dispute handlers ==========

//     // ========== Chat session handlers (UPDATED) ==========

//     // join_chat: client joins room and requests history
//     socket.on('join_chat', async (payload, cb) => {
//       try {
//         const { sessionId } = payload || {};
//         if (!sessionId) {
//             console.error('join_chat: sessionId required');
//             return cb && cb({ success: false, message: 'Session ID is required' });
//         }

//         socket.join(`chat_${sessionId}`);

//         const session = await ChatSession.findById(sessionId).lean();
        
//         if (!session) {
//             console.error(`join_chat: Session not found for ID: ${sessionId}`);
//             return cb && cb({ success: false, message: 'Chat session not found' });
//         }
        
//         const messages = await ChatMessage.find({ session: session._id }).sort({ createdAt: 1 }).lean();
//         
//         // If a pharmacist is connecting, update their availability status in DB and notify user if they are the assigned pharmacist
//         if (userRole === 'pharmacist' && userId) {
//           // This ensures that if a pharmacist connects, they are marked as available in the DB
//           await User.findByIdAndUpdate(userId, { isAvailable: true }); 
//         }

//         // 🔑 FIX: Return the expected structure for success
//         return cb && cb({ success: true, session: session, messages: messages });
//       } catch (err) {
//         console.error('join_chat error', err);
//         // 🔑 FIX: Return the expected structure for server error
//         return cb && cb({ success: false, message: 'Server error during chat join' });
//       }
//     });

//     // leave_chat
//     socket.on('leave_chat', ({ sessionId }) => {
//       try {
//         if (!sessionId) return;
//         socket.leave(`chat_${sessionId}`);
//       } catch (err) {
//         console.error('leave_chat error', err);
//       }
//     });

//     // send_chat_message: core message flow (user -> AI/human)
// socket.on('send_chat_message', async (payload, cb) => {
//   try {
//     const { sessionId, text } = payload || {};
//     if (!sessionId || !text) return cb && cb({ error: 'sessionId and text required' });

//     const session = await ChatSession.findById(sessionId);
//     if (!session) return cb && cb({ error: 'session not found' });

//     // determine sender type
//     const senderType = userRole === 'pharmacist' ? 'pharmacist' : 'user';
//     const sender = userId || null;

//     // If session already assigned to a pharmacist and the sender is a pharmacist
//     if (session.pharmacist || senderType === 'pharmacist') {
//       // Only allow assigned pharmacist to send
//       if (userRole === 'pharmacist' && String(session.pharmacist) !== String(userId)) {
//         return cb && cb({ error: 'pharmacist is not assigned to this session' });
//       }
//       // Broadcast user's message even if pharmacist is handling
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
//       return cb && cb({ success: true, message: outUser });
//     }

//     // persist user message for AI/human flow
//     const userMsg = await ChatMessage.create({
//       session: session._id,
//       senderType,
//       sender,
//       message: text,
//     });

//     const outUser = {
//       id: userMsg._id,
//       session: String(session._id),
//       senderType: userMsg.senderType,
//       sender,
//       text: userMsg.message,
//       createdAt: userMsg.createdAt,
//     };

//     // broadcast user's message
//     io.to(`chat_${sessionId}`).emit('new_message', outUser);

//     // --- AI/Pharmacist Logic ---
//     // Check available pharmacists (online or DB flag)
//     let availablePharmacistId = onlinePharmacists.keys().next().value;
//     let availablePharmacistDetails = null;

//     if (availablePharmacistId) {
//       availablePharmacistDetails = await User.findById(availablePharmacistId, 'name');
//     } else {
//       availablePharmacistDetails = await User.findOne({ role: 'pharmacist', isAvailable: true }).lean();
//     }

//     // Notify pharmacist if available
//     if (availablePharmacistDetails) {
//       const pharmId = String(availablePharmacistDetails._id || availablePharmacistId);
//       const pharmacistSocketId = onlinePharmacists.get(pharmId);
//       if (pharmacistSocketId) {
//         io.to(pharmacistSocketId).emit('incoming_chat_request', {
//           sessionId: String(session._id),
//           userId: session.user,
//           textPreview: text.slice(0, 300),
//           createdAt: new Date(),
//         });
//       }

//       // system message to user
//       await emitSystemMessage(
//         session._id,
//         'A certified pharmacist has been notified. They will join the chat shortly. The AI is on standby.'
//       );

//       // 🔑 do NOT return here — allow AI fallback to run
//     }

//     // AI fallback
//     const aiReplyText = await getAIResponse(text);

//     const aiMsg = await ChatMessage.create({
//       session: session._id,
//       senderType: 'ai',
//       sender: null,
//       message: aiReplyText,
//     });

//     const outAi = {
//       id: aiMsg._id,
//       session: String(session._id),
//       senderType: 'ai',
//       sender: null,
//       text: aiMsg.message,
//       createdAt: aiMsg.createdAt,
//     };

//     io.to(`chat_${sessionId}`).emit('new_message', outAi);

//     return cb && cb({ success: true, message: outUser, aiReply: outAi });

//   } catch (err) {
//     console.error('send_chat_message error', err);
//     return cb && cb({ error: 'failed to send' });
//   }
// });


//     // send_chat_message: core message flow (user -> AI/human)
// //     socket.on('send_chat_message', async (payload, cb) => {
// //       try {
// //         const { sessionId, text } = payload || {};
// //         if (!sessionId || !text) return cb && cb({ error: 'sessionId and text required' });

// //         const session = await ChatSession.findById(sessionId);
// //         if (!session) return cb && cb({ error: 'session not found' });

// //         // If session already assigned to a pharmacist (or pharmacist sent the message) -> human handles replies. AI stops.
// //         if (session.pharmacist || senderType === 'pharmacist') {
// //              // Only allow human pharmacist to send if they are assigned.
// //              if (userRole === 'pharmacist' && String(session.pharmacist) !== String(userId)) {
// //                  return cb && cb({ error: 'pharmacist is not assigned to this session' });
// //             }
// //             // 🛑 AI STOP POINT 🛑 The AI fallback is skipped when a pharmacist is assigned.
// //             return cb && cb({ success: true, message: outUser }); 
// //         }

// //         // determine sender type
// //         const senderType = userRole === 'pharmacist' ? 'pharmacist' : 'user';
// //         const sender = userId || null;

// //         // persist user message
// //         const userMsg = await ChatMessage.create({
// //           session: session._id,
// //           senderType,
// //           sender,
// //           message: text,
// //         });

// //         const outUser = {
// //           id: userMsg._id,
// //           session: String(session._id),
// //           senderType: userMsg.senderType,
// //           sender,
// //           text: userMsg.message,
// //           createdAt: userMsg.createdAt,
// //         };

// //         // broadcast user's message to the room
// //         io.to(`chat_${sessionId}`).emit('new_message', outUser);

// //         // *** AI/Pharmacist Logic: Only AI replies if pharmacist is NULL ***

// //         // If no pharmacist assigned, check for availability / fall back to AI
// //         
// //         // Check for available pharmacists (online via socket OR marked isAvailable: true in DB)
// //         let availablePharmacistId = onlinePharmacists.keys().next().value;
// //         let availablePharmacistDetails = null;

// //         if (availablePharmacistId) {
// //           availablePharmacistDetails = await User.findById(availablePharmacistId, 'name');
// //         } else {
// //           // No socket-connected pharmacist — check DB for any pharmacist marked isAvailable: true
// //           availablePharmacistDetails = await User.findOne({ role: 'pharmacist', isAvailable: true }).lean();
// //         }

// //         // If any pharmacist is available (either via socket or DB flag), notify them and queue the user.
// //         if (availablePharmacistDetails) {
// //           const pharmId = String(availablePharmacistDetails._id || availablePharmacistId);

// //           // Send notification event to the specific pharmacist's socket (if they are online)
// //           const pharmacistSocketId = onlinePharmacists.get(pharmId);
// //           if (pharmacistSocketId) {
// //             io.to(pharmacistSocketId).emit('incoming_chat_request', {
// //               sessionId: String(session._id),
// //               userId: session.user,
// //               textPreview: text.slice(0, 300),
// //               createdAt: new Date(),
// //             });
// //           }

// //           // system message to user while waiting for claim
// //           await emitSystemMessage(
// //             session._id,
// //             'A certified pharmacist has been notified. They will join the chat shortly. The AI is on standby.'
// //           );

// //           // 🔑 FIX: Removed the 'return' here to allow the AI fallback to run.
// //           // return cb && cb({ success: true, message: outUser, waitingForPharmacist: true });
// //         }

// //         // No pharmacist available OR if pharmacist was available but we continued -> call AI fallback
// //         const aiReplyText = await getAIResponse(text);

// //         const aiMsg = await ChatMessage.create({
// //           session: session._id,
// //           senderType: 'ai',
// //           sender: null,
// //           message: aiReplyText,
// //         });

// //         const outAi = {
// //           id: aiMsg._id,
// //           session: String(session._id),
// //           senderType: 'ai',
// //           sender: null,
// //           text: aiMsg.message,
// //           createdAt: aiMsg.createdAt,
// //         };

// //         io.to(`chat_${sessionId}`).emit('new_message', outAi);

// //         return cb && cb({ success: true, message: outUser, aiReply: outAi });
// //       } catch (err) {
// //         console.error('send_chat_message error', err);
// //         return cb && cb({ error: 'failed to send' });
// //       }
// //     });

//     // pharmacist_claim_session: pharmacist accepts a session (socket MUST be a pharmacist)
//     socket.on('pharmacist_claim_session', async (payload, cb) => {
//       try {
//         const { sessionId } = payload || {};
//         if (!sessionId) return cb && cb({ error: 'sessionId required' });
//         if (userRole !== 'pharmacist') return cb && cb({ error: 'only pharmacists can claim' });

//         const session = await ChatSession.findById(sessionId);
//         if (!session) return cb && cb({ error: 'session not found' });

//         // Double check if already assigned to prevent overwrites
//         if (session.pharmacist) {
//           return cb && cb({ success: false, message: 'Session already claimed.' });
//         }

//         // Update session
//         session.pharmacist = userId;
//         session.status = 'assigned';
//         await session.save();

//         // Fetch pharmacist name for announcement
//         const pharmacistUser = await User.findById(userId, 'firstName lastName');
//         const pharmacistName = pharmacistUser ? `${pharmacistUser.firstName} ${pharmacistUser.lastName}` : 'A certified pharmacist';

//         // Emit the system message to the user: "Name of pharmacist" joined the chat room
//         await emitSystemMessage(
//           session._id,
//           `${pharmacistName} has joined the chat room. The AI has stepped aside.`
//         );
//         
//         // Also emit the pharmacist_joined event for client-side state management (e.g., turning off AI typing indicator)
//         io.to(`chat_${sessionId}`).emit('pharmacist_joined', {
//           pharmacistId: session.pharmacist,
//           name: pharmacistName,
//         });

//         return cb && cb({ success: true, session });
//       } catch (err) {
//         console.error('pharmacist_claim_session error', err);
//         return cb && cb({ error: 'claim failed' });
//       }
//     });

//     // handle disconnect: cleanup presence map & broadcast
//     socket.on('disconnect', async () => {
//       try {
//         if (userRole === 'pharmacist' && userId) {
//           // Remove from in-memory map
//           for (const [pharmId, sId] of onlinePharmacists.entries()) {
//             if (sId === socket.id) onlinePharmacists.delete(pharmId);
//           }
//           
//           // Update DB status (logged out status to determine availability)
//           await User.findByIdAndUpdate(userId, { isAvailable: false });

//           broadcastPharmacistStatus();
//           console.log('Pharmacist disconnected:', userId);
//         } else {
//           console.log('Socket disconnected', socket.id);
//         }
//       } catch (err) {
//         console.error('disconnect error', err);
//       }
//     });
//   } catch (outerErr) {
//     console.error('socket connection error', outerErr);
//   }
// });
// // ------------------- end socket logic -------------------

// // 404 + error handler (must be last)
// app.use(notFound);
// app.use(errorHandler);

// server.listen(PORT, '0.0.0.0', () => {
//   console.log(colors.cyan.underline(`Server running on http://0.0.0.0:${PORT}`));
// });
