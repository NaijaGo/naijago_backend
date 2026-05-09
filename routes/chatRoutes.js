// routes/chatRoutes.js
const express = require('express');
const {
  claimSession,
  getPharmacistQueue,
  sendMessage,
  startChat,
} = require('../controllers/chatController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/start', protect, startChat);
router.post('/send', protect, sendMessage);
router.get('/pharmacist/queue', protect, getPharmacistQueue);
router.post('/pharmacist/claim/:sessionId', protect, claimSession);

module.exports = router;
