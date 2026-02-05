const express = require('express');
const router = express.Router();
const multer = require('multer');
const { companyAuth } = require('../middleware/companyAuth');
const {
  registerCompany,
  verifyEmail,
  loginCompany,
  getProfile,
  getStats,
  getRiders,
  addRider,
  updateRider,
  deleteRider,
  bulkUploadRiders,
  updateRiderStatus,
  getDeliveries,
  getDelivery,
  getSettlements,
  getSettlement,
  requestSettlement,
  getAnalytics,
  updateProfile
} = require('../controllers/companyController');

// Multer configuration for CSV upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || 
        file.mimetype === 'application/vnd.ms-excel' ||
        file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// Public routes
router.post('/register', registerCompany);
router.get('/verify-email/:token', verifyEmail);
router.post('/login', loginCompany);

// Protected routes (require company authentication)
router.use(companyAuth);

// Company profile routes
router.get('/profile', getProfile);
router.put('/profile', updateProfile);
router.get('/stats', getStats);
router.get('/analytics', getAnalytics);

// Rider management routes
router.get('/riders', getRiders);
router.post('/riders', addRider);
router.put('/riders/:id', updateRider);
router.delete('/riders/:id', deleteRider);
router.post('/riders/bulk', upload.single('file'), bulkUploadRiders);
router.put('/riders/:id/status', updateRiderStatus);

// Delivery management routes
router.get('/deliveries', getDeliveries);
router.get('/deliveries/:id', getDelivery);

// Settlement management routes
router.get('/settlements', getSettlements);
router.get('/settlements/:id', getSettlement);
router.post('/settlements/request', requestSettlement);

// Error handling for file upload
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: `File upload error: ${error.message}`
    });
  } else if (error) {
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }
  next();
});

module.exports = router;