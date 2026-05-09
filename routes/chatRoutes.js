// routes/chatRoutes.js
const express = require('express');
const {
  claimSession,
  getOnlinePharmacists,
  getPharmacistQueue,
  sendMessage,
  startChat,
  updatePharmacistAvailability,
} = require('../controllers/chatController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/start', protect, startChat);
router.post('/send', protect, sendMessage);
router.get('/pharmacists/online', protect, getOnlinePharmacists);
router.get('/pharmacist/queue', protect, getPharmacistQueue);
router.put('/pharmacist/status', protect, updatePharmacistAvailability);
router.post('/pharmacist/claim/:sessionId', protect, claimSession);

module.exports = router;
