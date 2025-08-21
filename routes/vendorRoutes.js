const express = require('express');
const User = require('../models/User'); // Import the User model
const { protect, authorizeRoles } = require('../middleware/authMiddleware'); // Import the protect middleware
const Product = require('../models/Product');
const Order = require('../models/Order')
const router = express.Router();

// --- Vendor Routes ---

// @desc    Submit a vendor registration request
// @route   POST /api/vendor/request
// @access  Private (Authenticated User)
router.post('/request', protect, async (req, res) => {
    // UPDATED: Added businessLocation to the request body destructuring
    const { firstName, lastName, gender, businessName, businessCategories, termsAccepted, businessLocation } = req.body;
    const userId = req.user.id; // User ID from the authenticated token

    // UPDATED: Added a check for businessLocation
    if (!firstName || !lastName || !gender || !businessName || !businessCategories || businessCategories.length === 0 || !termsAccepted || !businessLocation) {
        return res.status(400).json({ message: 'Please fill all required fields and accept terms.' });
    }

    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Prevent resubmission if already approved or pending review
        if (user.isVendor || ['sent', 'received', 'reviewing'].includes(user.vendorStatus)) {
            return res.status(400).json({ message: 'You already have a pending or approved vendor status.' });
        }

        // Check if user was recently rejected and cannot resubmit yet
        if (user.vendorStatus === 'rejected' && user.vendorRejectionDate) {
            const nextAttemptDate = new Date(user.vendorRejectionDate.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days later
            if (new Date() < nextAttemptDate) {
                const remainingTime = nextAttemptDate.getTime() - new Date().getTime();
                const days = Math.ceil(remainingTime / (1000 * 60 * 60 * 24));
                return res.status(403).json({
                    message: `You were recently rejected. Please try again in ${days} days.`,
                    vendorStatus: 'rejected',
                    vendorRejectionDate: user.vendorRejectionDate,
                });
            }
        }

        // Update user's vendor request details
        user.firstName = firstName;
        user.lastName = lastName;
        user.gender = gender;
        user.businessName = businessName;
        user.businessCategories = businessCategories;
        user.businessLocation = businessLocation; // NEW: Save the business location data
        // user.profilePicUrl = profilePicUrl; // Will be implemented when image upload is ready
        user.vendorStatus = 'sent'; // Initial status: request sent
        user.vendorRequestDate = Date.now(); // Record the request date
        user.vendorRejectionDate = undefined; // Clear any previous rejection date

        await user.save();

        res.status(200).json({ message: 'Vendor request submitted successfully. Status: sent.', vendorStatus: user.vendorStatus });

    } catch (error) {
        console.error('Vendor request submission error:', error);
        res.status(500).json({ message: 'Server error during vendor request submission.' });
    }
});

// @desc    Get current user's vendor status
// @route   GET /api/vendor/status
// @access  Private (Authenticated User)
router.get('/status', protect, async (req, res) => { // Changed path from /user/vendor-status to /status
    try {
        const user = await User.findById(req.user.id).select('vendorStatus vendorRejectionDate isVendor');
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }
        res.status(200).json({
            vendorStatus: user.vendorStatus,
            vendorRejectionDate: user.vendorRejectionDate,
            isVendor: user.isVendor,
        });
    } catch (error) {
        console.error('Error fetching vendor status:', error);
        res.status(500).json({ message: 'Server error fetching vendor status.' });
    }
});

// The corrected GET /api/vendor/stats route with the proper logic
router.get('/stats', protect, authorizeRoles('vendor'), async (req, res) => {
  try {
    const vendorId = req.user._id;

    // Use an aggregation pipeline to get both total stock and total sales
    const statsResult = await Product.aggregate([
      // Stage 1: Filter products by the current vendor
      {
        $match: {
          vendor: vendorId,
          isActive: true // Consider only active products
        }
      },
      // Stage 2: Group the products and calculate the totals
      {
        $group: {
          _id: null,
          totalProducts: { $sum: 1 }, // Count the number of products (documents)
          totalStockQuantity: { $sum: '$stockQuantity' } // Sum up the stock of all products
        }
      }
    ]);

    // Handle case where vendor has no products
    const totalProducts = statsResult.length > 0 ? statsResult[0].totalProducts : 0;
    const totalStockQuantity = statsResult.length > 0 ? statsResult[0].totalStockQuantity : 0;

    // 2. Calculate the number of sold products by aggregating order items
    const soldProductsResult = await Order.aggregate([
      // Match orders where at least one item belongs to this vendor
      { 
        $match: {
          'orderItems.vendor': vendorId,
          orderStatus: { $in: ['shipped', 'delivered'] } 
        }
      },
      // Deconstruct the array to process each item
      { $unwind: '$orderItems' },
      // Filter for only the items belonging to this specific vendor
      { 
        $match: {
          'orderItems.vendor': vendorId
        }
      },
      // Group the items and sum their quantities
      {
        $group: {
          _id: null,
          productsSold: { $sum: '$orderItems.quantity' }
        }
      }
    ]);

    const productsSold = soldProductsResult.length > 0 ? soldProductsResult[0].productsSold : 0;
    
    // 3. Calculate the number of unsold products (correct logic)
    const productsUnsold = totalStockQuantity; // The total unsold quantity is just the current total stock

    // Send a successful response with the calculated stats
    res.status(200).json({
      totalProducts,
      productsSold,
      productsUnsold,
    });

  } catch (error) {
    console.error('Error fetching vendor stats:', error);
    res.status(500).json({ message: 'Server error fetching vendor statistics.' });
  }
});
module.exports = router;