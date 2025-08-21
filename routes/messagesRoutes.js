// routes/messagesRoutes.js
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const DisputeRequest = require('../models/DisputeRequest');

const router = express.Router({ mergeParams: true });

// @desc Add a new message to a dispute
// @route POST /api/disputes/:disputeId/messages
// @access Private
router.post('/', protect, async (req, res) => {
    try {
        const { text, attachments } = req.body;
        const disputeId = req.params.disputeId;

        const dispute = await DisputeRequest.findById(disputeId);
        if (!dispute) {
            return res.status(404).json({ message: 'Dispute not found' });
        }

        const newMessage = {
            sender: req.user._id,
            text,
            attachments: attachments || [],
        };
        
        dispute.messages.push(newMessage);
        await dispute.save();

        res.status(201).json(newMessage);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// @desc Get all messages for a specific dispute
// @route GET /api/disputes/:disputeId/messages
// @access Private
router.get('/', protect, async (req, res) => {
    try {
        const disputeId = req.params.disputeId;

        const dispute = await DisputeRequest.findById(disputeId)
            .populate('messages.sender', 'firstName lastName');
        if (!dispute) {
            return res.status(404).json({ message: 'Dispute not found' });
        }

        res.json(dispute.messages);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;