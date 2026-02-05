// routes/adminCompanyRoutes.js
const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const Company = require('../models/Company');
const Settlement = require('../models/Settlement');
const CompanyDelivery = require('../models/CompanyDelivery');

// @desc    Get all companies
// @route   GET /api/admin/companies
// @access  Private/Admin
router.get('/companies', protect, authorizeRoles('admin'), async (req, res) => {
    try {
        const companies = await Company.find()
            .select('-password -verificationCode -verificationExpires')
            .sort({ createdAt: -1 });
        
        res.json(companies);
    } catch (error) {
        console.error('Error fetching companies:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @desc    Get single company
// @route   GET /api/admin/companies/:id
// @access  Private/Admin
router.get('/companies/:id', protect, authorizeRoles('admin'), async (req, res) => {
    try {
        const company = await Company.findById(req.params.id)
            .select('-password -verificationCode -verificationExpires');
        
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }
        
        // Get recent settlements
        const settlements = await Settlement.find({ company: company._id })
            .sort({ createdAt: -1 })
            .limit(10);
        
        // Get recent deliveries
        const deliveries = await CompanyDelivery.find({ company: company._id })
            .populate('mainOrder', 'createdAt totalPrice')
            .sort({ createdAt: -1 })
            .limit(10);
        
        res.json({
            ...company.toObject(),
            settlements,
            recentDeliveries: deliveries
        });
    } catch (error) {
        console.error('Error fetching company:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @desc    Update company status
// @route   PUT /api/admin/companies/:id/status
// @access  Private/Admin
router.put('/companies/:id/status', protect, authorizeRoles('admin'), async (req, res) => {
    try {
        const { status } = req.body;
        
        if (!['active', 'suspended', 'pending'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }
        
        const company = await Company.findByIdAndUpdate(
            req.params.id,
            { status },
            { new: true }
        ).select('-password');
        
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }
        
        res.json({
            message: `Company status updated to ${status}`,
            company
        });
    } catch (error) {
        console.error('Error updating company status:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @desc    Process company settlement
// @route   PUT /api/admin/companies/:id/settlements/:settlementId/process
// @access  Private/Admin
router.put('/companies/:id/settlements/:settlementId/process', protect, authorizeRoles('admin'), async (req, res) => {
    try {
        const { status, paymentReference } = req.body;
        
        const settlement = await Settlement.findOne({
            _id: req.params.settlementId,
            company: req.params.id
        });
        
        if (!settlement) {
            return res.status(404).json({ message: 'Settlement not found' });
        }
        
        if (settlement.status === 'paid') {
            return res.status(400).json({ message: 'Settlement already paid' });
        }
        
        settlement.status = status || 'paid';
        settlement.paidAt = Date.now();
        settlement.paymentReference = paymentReference;
        settlement.processedBy = req.user._id;
        
        await settlement.save();
        
        res.json({
            message: 'Settlement processed successfully',
            settlement
        });
    } catch (error) {
        console.error('Error processing settlement:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;