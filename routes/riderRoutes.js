const express = require('express');
const router = express.Router();
const { 
  registerRider, 
  loginRider, 
  getAvailableShipments, 
  claimShipment, 
  finalizeRiderDelivery,
  getRiderProfile,
  getCompletedShipments,
  getAvailableOrdersForRider
} = require('../controllers/riderController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const Rider = require('../models/Rider');

// --- Public Routes ---
router.post('/register', registerRider);
router.post('/login', loginRider);

// Email Verification Route
router.get('/verify-email/:token', async (req, res) => {
    try {
        const rider = await Rider.findOne({
            emailVerificationToken: req.params.token,
            emailVerificationExpires: { $gt: Date.now() }
        });

        if (!rider) {
            return res.status(400).send('<h1>Link Expired</h1>');
        }

        rider.isEmailVerified = true;
        rider.emailVerificationToken = undefined;
        rider.emailVerificationExpires = undefined;
        await rider.save();

        res.send('<h1>Email Verified!</h1><p>Our admin team will review your documents shortly.</p>');
    } catch (error) {
        res.status(500).send('Server Error');
    }
});

// --- Protected Rider Dashboard Routes ---
// Requires rider to be logged in and have the 'dispatch' role
router.get('/available', protect, authorizeRoles('dispatch'), getAvailableShipments);
router.put('/claim/:id', protect, authorizeRoles('dispatch'), claimShipment);
router.put('/verify-delivery/:id', protect, authorizeRoles('dispatch'), finalizeRiderDelivery);

// ← Add this new one
router.get('/profile', protect, authorizeRoles('dispatch'), getRiderProfile);

router.get('/completed', protect, authorizeRoles('dispatch'), getCompletedShipments);

router.get('/orders/available', protect, authorizeRoles('dispatch'), getAvailableOrdersForRider);

module.exports = router;