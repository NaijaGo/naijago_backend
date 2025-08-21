// routes/disputesRoutes.js
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { createDispute, getUserDisputes, getDisputeById } = require('../controllers/disputesController');
const messagesRoutes = require('./messagesRoutes');

const router = express.Router();

// Use the messagesRoutes for handling dispute chat functionality
router.use('/:disputeId/messages', messagesRoutes);

// @desc Create new dispute
// @route POST /api/disputes
// @access Private
router.post('/', protect, createDispute);

// @desc Get disputes for logged-in user
// @route GET /api/disputes
// @access Private
router.get('/', protect, getUserDisputes);

// @desc Get single dispute by ID
// @route GET /api/disputes/:id
// @access Private
router.get('/:id', protect, getDisputeById);

module.exports = router;