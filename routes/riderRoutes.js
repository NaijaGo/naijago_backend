// routes/riderRoutes.js
const express = require('express');
const router = express.Router();
const Rider = require('../models/Rider');
const { 
  // Authentication
  registerRider, 
  loginRider,
  verifyRiderEmail,
  
  // Profile Management
  getRiderProfile,
  updateRiderProfile,
  updateRiderLocation,
  updateRiderStatus,
  updateBankAccount,
  
  // Order Management
  getAvailableOrders,
  claimOrder,
  verifyPickupOTP,
  verifyDeliveryOTP,
  getActiveDeliveries,
  getCompletedDeliveries,
  cancelDelivery,
  
  // Location Access
  getVendorLocation,
  getDeliveryLocation,
  
  // Earnings & Wallet
  getEarnings,
  getDashboardStats,
  requestWithdrawal,
  
  // Admin/Management (protected by admin role)
  getNearbyRiders
} = require('../controllers/riderController');

const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const { riderProtect } = require('../middleware/riderAuthMiddleware'); // NEW

// ============================================
// PUBLIC ROUTES (No authentication required)
// ============================================

/**
 * @route   POST /api/riders/register
 * @desc    Register a new rider
 * @access  Public
 */
router.post('/register', registerRider);

/**
 * @route   POST /api/riders/login
 * @desc    Authenticate rider & get token
 * @access  Public
 */
router.post('/login', loginRider);

/**
 * @route   GET /api/riders/verify-email/:token
 * @desc    Verify rider email with token
 * @access  Public
 */
router.get('/verify-email/:token', verifyRiderEmail);

// ============================================
// PROTECTED ROUTES (Rider authentication required)
// ============================================

// Apply riderProtect middleware to all routes below (instead of protect)
router.use(riderProtect); // CHANGED: Use riderProtect instead of protect

/**
 * @route   GET /api/riders/profile
 * @desc    Get rider profile
 * @access  Private (Rider only)
 */
router.get('/profile', getRiderProfile);

/**
 * @route   PUT /api/riders/profile
 * @desc    Update rider profile
 * @access  Private (Rider only)
 */
router.put('/profile', updateRiderProfile);

/**
 * @route   PUT /api/riders/location
 * @desc    Update rider's current location (real-time tracking)
 * @access  Private (Rider only)
 */
router.put('/location', updateRiderLocation);

/**
 * @route   PUT /api/riders/status
 * @desc    Update rider availability status (active/available)
 * @access  Private (Rider only)
 */
router.put('/status', updateRiderStatus);

/**
 * @route   PUT /api/riders/bank-account
 * @desc    Update rider's bank account details
 * @access  Private (Rider only)
 */
router.put('/bank-account', updateBankAccount);

// ============================================
// ORDER MANAGEMENT ROUTES
// ============================================

/**
 * @route   GET /api/riders/orders/available
 * @desc    Get available orders for rider (paid but not delivered)
 * @access  Private (Rider only)
 */
router.get('/orders/available', getAvailableOrders);

/**
 * @route   PUT /api/riders/orders/claim/:id
 * @desc    Claim an entire order (all shipments)
 * @access  Private (Rider only)
 */
router.put('/orders/claim/:id', claimOrder);

/**
 * @route   POST /api/riders/orders/verify-pickup
 * @desc    Verify pickup OTP at vendor location
 * @access  Private (Rider only)
 */
router.post('/orders/verify-pickup', verifyPickupOTP);

/**
 * @route   POST /api/riders/orders/verify-delivery
 * @desc    Verify delivery OTP at customer location
 * @access  Private (Rider only)
 */
router.post('/orders/verify-delivery', verifyDeliveryOTP);

/**
 * @route   GET /api/riders/orders/active
 * @desc    Get rider's active deliveries
 * @access  Private (Rider only)
 */
router.get('/orders/active', getActiveDeliveries);

/**
 * @route   GET /api/riders/orders/completed
 * @desc    Get rider's completed deliveries
 * @access  Private (Rider only)
 */
router.get('/orders/completed', getCompletedDeliveries);

/**
 * @route   POST /api/riders/orders/cancel
 * @desc    Cancel a claimed delivery (with reason)
 * @access  Private (Rider only)
 */
router.post('/orders/cancel', cancelDelivery);

// ============================================
// LOCATION ACCESS ROUTES
// ============================================

/**
 * @route   GET /api/riders/location/vendor/:shipmentId
 * @desc    Get vendor location for a specific shipment
 * @access  Private (Rider only)
 */
router.get('/location/vendor/:shipmentId', getVendorLocation);

/**
 * @route   GET /api/riders/location/delivery/:orderId
 * @desc    Get delivery location for a specific order
 * @access  Private (Rider only)
 */
router.get('/location/delivery/:orderId', getDeliveryLocation);

// ============================================
// EARNINGS & WALLET ROUTES
// ============================================

/**
 * @route   GET /api/riders/earnings
 * @desc    Get rider's earnings and wallet information
 * @access  Private (Rider only)
 */
router.get('/earnings', getEarnings);

/**
 * @route   GET /api/riders/dashboard
 * @desc    Get rider dashboard statistics
 * @access  Private (Rider only)
 */
router.get('/dashboard', getDashboardStats);

/**
 * @route   GET /api/riders/notifications
 * @desc    Get rider in-app notifications
 * @access  Private (Rider only)
 */
router.get('/notifications', async (req, res) => {
  try {
    const rider = await Rider.findById(req.rider._id).select('notifications');
    if (!rider) {
      return res.status(404).json({ success: false, message: 'Rider not found' });
    }

    const notifications = [...(rider.notifications || [])].sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );

    res.json({ success: true, notifications });
  } catch (error) {
    console.error('Get rider notifications error:', error);
    res.status(500).json({ success: false, message: 'Unable to load notifications' });
  }
});

/**
 * @route   PUT /api/riders/notifications/mark-read/:notificationId
 * @desc    Mark a rider notification as read
 * @access  Private (Rider only)
 */
router.put('/notifications/mark-read/:notificationId', async (req, res) => {
  try {
    const rider = await Rider.findOneAndUpdate(
      {
        _id: req.rider._id,
        'notifications._id': req.params.notificationId,
      },
      { $set: { 'notifications.$.read': true } },
      { new: true }
    ).select('notifications');

    if (!rider) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    res.json({ success: true, message: 'Notification marked as read' });
  } catch (error) {
    console.error('Mark rider notification read error:', error);
    res.status(500).json({ success: false, message: 'Unable to update notification' });
  }
});

/**
 * @route   PUT /api/riders/notifications/mark-read
 * @desc    Mark all rider notifications as read
 * @access  Private (Rider only)
 */
router.put('/notifications/mark-read', async (req, res) => {
  try {
    await Rider.updateOne(
      { _id: req.rider._id },
      { $set: { 'notifications.$[].read': true } }
    );

    res.json({ success: true, message: 'Notifications marked as read' });
  } catch (error) {
    console.error('Mark all rider notifications read error:', error);
    res.status(500).json({ success: false, message: 'Unable to update notifications' });
  }
});

/**
 * @route   POST /api/riders/withdraw
 * @desc    Request withdrawal from rider's wallet
 * @access  Private (Rider only)
 */
router.post('/withdraw', requestWithdrawal);

// ============================================
// ADMIN/MANAGEMENT ROUTES
// ============================================

/**
 * @route   GET /api/riders/nearby
 * @desc    Get nearby available riders (for admin/dispatch)
 * @access  Private (Admin/Dispatch only)
 */
router.get('/nearby', authorizeRoles('admin', 'dispatch'), getNearbyRiders);

module.exports = router;
