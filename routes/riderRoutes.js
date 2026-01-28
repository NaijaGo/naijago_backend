// routes/riderRoutes.js
const express = require('express');
const router = express.Router();
const { 
  // Authentication
  registerRider, 
  loginRider,
  
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

// ============================================
// PROTECTED ROUTES (Rider authentication required)
// ============================================

// Apply protect middleware to all routes below
router.use(protect);

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




// const express = require('express');
// const router = express.Router();
// const { 
//   registerRider, 
//   loginRider, 
//   getRiderProfile,
//   getAvailableOrdersForRider,
//   claimOrder,
//   verifyPickupOTP,
//   verifyDeliveryOTP,
//   getActiveDeliveries,
//   getCompletedShipments,
//   updateRiderLocation,
//   updateRiderStatus
// } = require('../controllers/riderController');
// const { protect } = require('../middleware/authMiddleware');

// // Public routes
// router.post('/register', registerRider);
// router.post('/login', loginRider);

// // Protected routes (require rider authentication)
// router.use(protect);

// // Profile & status
// router.get('/profile', getRiderProfile);
// router.put('/location', updateRiderLocation); // Optional: for real-time tracking
// router.put('/status', updateRiderStatus); // Optional: mark available/unavailable

// // Order management
// router.get('/orders/available', getAvailableOrdersForRider);
// router.put('/orders/claim/:id', claimOrder);
// router.post('/orders/verify-pickup', verifyPickupOTP);
// router.post('/orders/verify-delivery', verifyDeliveryOTP);
// router.get('/orders/active', getActiveDeliveries);
// router.get('/orders/completed', getCompletedShipments);

// module.exports = router;