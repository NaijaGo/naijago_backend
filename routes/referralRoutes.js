const express = require('express');
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');
const { buildReferralSummary } = require('../services/referralService');

const router = express.Router();

const sendReferralSummary = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const summary = await buildReferralSummary(user);
    return res.status(200).json(summary);
  } catch (error) {
    console.error('Error loading referral summary:', error);
    return res.status(500).json({
      message: 'Server error fetching referral summary.',
    });
  }
};

router.get('/', protect, sendReferralSummary);
router.get('/summary', protect, sendReferralSummary);

module.exports = router;
