// routes/chatRoutes.js
const express = require('express');
const { startChat, sendMessage } = require('../controllers/chatController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/start', protect, startChat);
router.post('/send', protect, sendMessage);

module.exports = router;
