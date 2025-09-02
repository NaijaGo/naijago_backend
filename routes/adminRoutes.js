// adminRoutes.js
const express = require('express');
const User = require('../models/User'); // Import the User model
const Dispute = require('../models/DisputeRequest'); // Import the Dispute model
const { protect } = require('../middleware/authMiddleware'); // Import the protect middleware

const router = express.Router();

// --- Middleware for Admin Authorization ---
// This middleware checks if the authenticated user is an administrator.
const authorizeAdmin = (req, res, next) => {
    // The 'protect' middleware should have already attached req.user
    if (req.user && req.user.isAdmin) {
        next(); // User is an admin, proceed to the next middleware/route handler
    } else {
        // If not an admin, return a forbidden error
        res.status(403).json({ message: 'Not authorized as an admin' });
    }
};

// --- Admin Routes ---

// @desc    Get all vendor requests (users with vendorStatus 'sent', 'received', 'reviewing')
// @route   GET /api/admin/vendor-requests
// @access  Private (Admin only)
router.get('/vendor-requests', protect, authorizeAdmin, async (req, res) => {
    try {
        // Find users who have submitted a vendor request and are not yet approved/rejected
        const vendorRequests = await User.find({
            vendorStatus: { $in: ['sent', 'received', 'reviewing'] }
        }).select('-password -emailVerificationToken -deviceVerificationToken -passwordResetToken'); // Exclude sensitive fields

        res.status(200).json(vendorRequests);
    } catch (error) {
        console.error('Error fetching vendor requests:', error);
        res.status(500).json({ message: 'Server error fetching vendor requests.' });
    }
});

// @desc    Update a user's vendor status (approve/reject)
// @route   PUT /api/admin/vendor-status/:userId
// @access  Private (Admin only)
router.put('/vendor-status/:userId', protect, authorizeAdmin, async (req, res) => {
    const { userId } = req.params;
    const { status } = req.body; // Expected status: 'approved' or 'rejected'

    // Validate the status input
    if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status provided. Must be "approved" or "rejected".' });
    }

    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Update the vendor status
        user.vendorStatus = status;

        if (status === 'approved') {
            user.isVendor = true; // Mark as a vendor
            user.vendorRejectionDate = undefined; // Clear any previous rejection date
        } else if (status === 'rejected') {
            user.isVendor = false; // Ensure not marked as a vendor
            user.vendorRejectionDate = Date.now(); // Record rejection date for cooldown
        }

        await user.save();

        res.status(200).json({
            message: `Vendor status for ${user.email} updated to ${status}.`,
            userId: user._id,
            vendorStatus: user.vendorStatus,
            isVendor: user.isVendor,
            vendorRejectionDate: user.vendorRejectionDate,
        });

    } catch (error) {
        console.error('Error updating vendor status:', error);
        res.status(500).json({ message: 'Server error updating vendor status.' });
    }
});

// @desc    Get all disputes
// @route   GET /api/admin/disputes
// @access  Private (Admin only)
router.get('/disputes', protect, authorizeAdmin, async (req, res) => {
    try {
        const disputes = await Dispute.find({})
            .populate('user', 'firstName lastName email')
            .populate('order', 'totalPrice _id');
        res.status(200).json(disputes);
    } catch (error) {
        console.error('Error fetching disputes:', error);
        res.status(500).json({ message: 'Server error fetching disputes.' });
    }
});

// @desc    Send a message to a dispute chat
// @route   POST /api/admin/disputes/:disputeId/message
// @access  Private (Admin only)
router.post('/disputes/:disputeId/message', protect, authorizeAdmin, async (req, res) => {
    const { disputeId } = req.params;
    const { text } = req.body;

    if (!text) {
        return res.status(400).json({ message: 'Message text is required.' });
    }

    try {
        const dispute = await Dispute.findById(disputeId);
        if (!dispute) {
            return res.status(404).json({ message: 'Dispute not found.' });
        }

        const newMessage = {
            sender: req.user._id,
            senderType: 'Admin',
            text,
        };

        dispute.messages.push(newMessage);
        await dispute.save();

        res.status(200).json({ message: 'Message sent successfully.', newMessage });
    } catch (error) {
        console.error('Error sending message to dispute:', error);
        res.status(500).json({ message: 'Server error sending message.' });
    }
});

// @desc    Update dispute status
// @route   PUT /api/admin/disputes/:disputeId/status
// @access  Private (Admin only)
router.put('/disputes/:disputeId/status', protect, authorizeAdmin, async (req, res) => {
    const { disputeId } = req.params;
    const { status } = req.body;

    if (!['pending', 'resolved'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status provided. Must be "pending" or "resolved".' });
    }

    try {
        const dispute = await Dispute.findById(disputeId);
        if (!dispute) {
            return res.status(404).json({ message: 'Dispute not found.' });
        }
        
        dispute.status = status;
        await dispute.save();

        res.status(200).json({ message: `Dispute status updated to ${status}.` });
    } catch (error) {
        console.error('Error updating dispute status:', error);
        res.status(500).json({ message: 'Server error updating dispute status.' });
    }
});

module.exports = router;