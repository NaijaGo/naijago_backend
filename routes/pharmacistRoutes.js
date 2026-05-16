const express = require('express');
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');
const {
  getPharmacySubscriptionSettings,
  getUserPharmacyAccess,
  purchasePharmacySubscription,
} = require('../services/pharmacySubscriptionService');
const { pharmacistAccessPayload } = require('../utils/pharmacistEligibility');

const router = express.Router();

// @desc    Approved vendors request pharmacist verification
// @route   POST /api/pharmacist/request
// @access  Private/Vendor
router.post('/request', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (!user.isVendor || user.vendorStatus !== 'approved') {
      return res.status(403).json({
        message: 'You must be an approved vendor before requesting pharmacist approval.',
      });
    }

    if (user.role === 'pharmacist' || user.pharmacistStatus === 'approved') {
      user.pharmacistStatus = 'approved';
      await user.save();
      return res.status(200).json({
        message: 'Your pharmacist vendor access is already approved.',
        pharmacistStatus: user.pharmacistStatus,
        isPharmacist: true,
      });
    }

    if (['sent', 'received', 'reviewing'].includes(user.pharmacistStatus)) {
      return res.status(200).json({
        message: 'Your pharmacist approval request is already under review.',
        pharmacistStatus: user.pharmacistStatus,
        isPharmacist: false,
      });
    }

    user.pharmacistStatus = 'sent';
    user.pharmacistRequestDate = new Date();
    user.pharmacistRejectionDate = undefined;

    user.notifications.push({
      type: 'vendor_status_update',
      message: 'Your pharmacist approval request was submitted and is under review.',
      relatedModel: 'User',
      relatedId: user._id,
    });

    await user.save();

    res.status(201).json({
      message: 'Pharmacist approval request submitted successfully.',
      pharmacistStatus: user.pharmacistStatus,
      isPharmacist: false,
    });
  } catch (error) {
    console.error('Pharmacist request error:', error);
    res.status(500).json({ message: 'Server error submitting pharmacist request.' });
  }
});

// @desc    Get current pharmacist approval status
// @route   GET /api/pharmacist/status
// @access  Private
router.get('/status', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(
      'role pharmacistStatus pharmacistRequestDate pharmacistRejectionDate isVendor vendorStatus',
    );

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const access = pharmacistAccessPayload(user);
    res.status(200).json({
      ...access,
      pharmacistRequestDate: user.pharmacistRequestDate,
      pharmacistRejectionDate: user.pharmacistRejectionDate,
    });
  } catch (error) {
    console.error('Pharmacist status error:', error);
    res.status(500).json({ message: 'Server error fetching pharmacist status.' });
  }
});

// @desc    Get pharmacist chat subscription plans
// @route   GET /api/pharmacist/subscription/plans
// @access  Private
router.get('/subscription/plans', protect, async (req, res) => {
  try {
    const settings = await getPharmacySubscriptionSettings();
    res.status(200).json({
      plans: settings.plans.filter((plan) => plan.isActive),
      updatedAt: settings.updatedAt,
      source: settings.source,
    });
  } catch (error) {
    console.error('Pharmacy subscription plans error:', error);
    res.status(500).json({ message: 'Server error fetching pharmacist subscription plans.' });
  }
});

// @desc    Get current user's pharmacist chat access
// @route   GET /api/pharmacist/subscription/status
// @access  Private
router.get('/subscription/status', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('pharmacySubscription userWalletBalance');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.status(200).json({
      access: getUserPharmacyAccess(user),
      walletBalance: user.userWalletBalance || 0,
    });
  } catch (error) {
    console.error('Pharmacy subscription status error:', error);
    res.status(500).json({ message: 'Server error fetching pharmacist subscription status.' });
  }
});

// @desc    Purchase pharmacist chat subscription from user wallet
// @route   POST /api/pharmacist/subscription/purchase
// @access  Private
router.post('/subscription/purchase', protect, async (req, res) => {
  try {
    const { planType } = req.body;
    const result = await purchasePharmacySubscription({
      userId: req.user._id,
      planType,
    });

    res.status(200).json({
      message: 'Pharmacist chat access purchased successfully.',
      ...result,
    });
  } catch (error) {
    console.error('Pharmacy subscription purchase error:', error);
    res.status(error.statusCode || 500).json({
      message: error.message || 'Server error purchasing pharmacist subscription.',
      ...(error.details || {}),
    });
  }
});

module.exports = router;
