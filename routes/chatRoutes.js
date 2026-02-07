// routes/chatRoutes.js
const express = require('express');
const { startChat } = require('../controllers/chatController'); // Removed sendMessage
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/start', protect, startChat);
// router.post('/send', protect, sendMessage); // REMOVED: Messaging is now socket-only

module.exports = router;