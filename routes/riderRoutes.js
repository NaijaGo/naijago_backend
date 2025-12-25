const express = require('express');
const router = express.Router();
const { registerRider, loginRider } = require('../controllers/riderController');
const Rider = require('../models/Rider'); // Import model for the verify route

router.post('/register', registerRider);
router.post('/login', loginRider);

// @desc    Verify rider email
// @route   GET /api/riders/verify-email/:token
router.get('/verify-email/:token', async (req, res) => {
    try {
        const rider = await Rider.findOne({
            emailVerificationToken: req.params.token,
            emailVerificationExpires: { $gt: Date.now() } // Check if not expired
        });

        if (!rider) {
            return res.status(400).send('<h1>Link Expired</h1><p>This verification link is invalid or has expired.</p>');
        }

        rider.isEmailVerified = true;
        rider.emailVerificationToken = undefined;
        rider.emailVerificationExpires = undefined;
        await rider.save();

        // You can redirect to your frontend login page or show a success message
        res.send('<h1>Email Verified!</h1><p>Your email is now verified. Our admin team will review your documents shortly.</p>');
    } catch (error) {
        res.status(500).send('Server Error');
    }
});

module.exports = router;