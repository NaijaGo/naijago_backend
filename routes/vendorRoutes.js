const express = require('express');
const User = require('../models/User'); // Import the User model
const { protect, authorizeRoles } = require('../middleware/authMiddleware'); // Import the protect middleware
const Product = require('../models/Product');
const Order = require('../models/MainOrder')
const router = express.Router();

// --- Vendor Routes ---

const operatingDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const phonePattern = /^(?:\+?234|0)[789]\d{9}$/;

const defaultOperatingHours = () => operatingDays.map((day) => ({
    day,
    isOpen: true,
    openTime: '09:00',
    closeTime: '19:00',
    lastOrderTime: '18:30',
}));

function toBoolean(value, fallback = false) {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return fallback;
}

function toNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function sanitizeText(value, maxLength = 160) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
}

function sanitizeLocation(value) {
    if (!value || typeof value !== 'object') return undefined;
    const latitude = Number(value.latitude);
    const longitude = Number(value.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return undefined;
    }
    return {
        latitude,
        longitude,
        formattedAddress: sanitizeText(value.formattedAddress, 220),
    };
}

function sanitizeOperatingHours(value) {
    const sourceByDay = new Map();
    if (Array.isArray(value)) {
        value.forEach((entry) => {
            if (entry && operatingDays.includes(entry.day)) {
                sourceByDay.set(entry.day, entry);
            }
        });
    }

    return operatingDays.map((day) => {
        const entry = sourceByDay.get(day) || {};
        const openTime = timePattern.test(entry.openTime || '') ? entry.openTime : '09:00';
        const closeTime = timePattern.test(entry.closeTime || '') ? entry.closeTime : '19:00';
        const lastOrderTime = timePattern.test(entry.lastOrderTime || '') ? entry.lastOrderTime : closeTime;
        return {
            day,
            isOpen: toBoolean(entry.isOpen, true),
            openTime,
            closeTime,
            lastOrderTime,
        };
    });
}

function buildVendorProfile(user) {
    return {
        businessName: user.businessName || '',
        businessCategories: user.businessCategories || [],
        businessLogoUrl: user.businessLogoUrl || '',
        businessWhatsAppNumber: user.businessWhatsAppNumber || user.alternatePhoneNumber || user.phoneNumber || '',
        businessSupportPhone: user.businessSupportPhone || user.phoneNumber || '',
        businessLocation: user.businessLocation || null,
        deliveryRadiusKm: user.deliveryRadiusKm ?? 15,
        prepTimeMinutes: user.prepTimeMinutes ?? 30,
        isTemporarilyClosed: user.isTemporarilyClosed === true,
        temporaryClosureReason: user.temporaryClosureReason || '',
        operatingHours: user.operatingHours?.length ? user.operatingHours : defaultOperatingHours(),
        vendorStatus: user.vendorStatus,
        isVendor: user.isVendor,
        pharmacistStatus: user.pharmacistStatus,
        isPharmacist: user.role === 'pharmacist',
    };
}

// @desc    Submit a vendor registration request
// @route   POST /api/vendor/request
// @access  Private (Authenticated User)
router.post('/request', protect, async (req, res) => {
    // UPDATED: Added businessLocation to the request body destructuring
    const {
        firstName,
        lastName,
        gender,
        businessName,
        businessCategories,
        termsAccepted,
        businessLocation,
        alternatePhoneNumber
    } = req.body;
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
        user.alternatePhoneNumber =
            typeof alternatePhoneNumber === 'string' && alternatePhoneNumber.trim()
                ? alternatePhoneNumber.trim()
                : user.alternatePhoneNumber;
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

// @desc    Get the approved vendor's editable business profile
// @route   GET /api/vendor/profile
// @access  Private/Vendor
router.get('/profile', protect, authorizeRoles('vendor'), async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select(
            'businessName businessCategories businessLogoUrl businessWhatsAppNumber businessSupportPhone businessLocation deliveryRadiusKm prepTimeMinutes isTemporarilyClosed temporaryClosureReason operatingHours vendorStatus isVendor pharmacistStatus role phoneNumber alternatePhoneNumber'
        );

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        res.status(200).json(buildVendorProfile(user));
    } catch (error) {
        console.error('Error fetching vendor profile:', error);
        res.status(500).json({ message: 'Server error fetching vendor profile.' });
    }
});

// @desc    Update the approved vendor's business profile and default operating settings
// @route   PUT /api/vendor/profile
// @access  Private/Vendor
router.put('/profile', protect, authorizeRoles('vendor'), async (req, res) => {
    try {
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const businessName = sanitizeText(req.body.businessName, 80);
        if (!businessName) {
            return res.status(400).json({ message: 'Business name is required.' });
        }

        const whatsappNumber = sanitizeText(req.body.businessWhatsAppNumber, 20);
        const supportPhone = sanitizeText(req.body.businessSupportPhone, 20);

        if (whatsappNumber && !phonePattern.test(whatsappNumber)) {
            return res.status(400).json({ message: 'Please enter a valid Nigerian WhatsApp number.' });
        }

        if (supportPhone && !phonePattern.test(supportPhone)) {
            return res.status(400).json({ message: 'Please enter a valid Nigerian support phone number.' });
        }

        user.businessName = businessName;
        user.businessLogoUrl = sanitizeText(req.body.businessLogoUrl, 400);
        user.businessWhatsAppNumber = whatsappNumber || undefined;
        user.businessSupportPhone = supportPhone || undefined;
        user.deliveryRadiusKm = toNumber(req.body.deliveryRadiusKm, user.deliveryRadiusKm ?? 15, 0, 100);
        user.prepTimeMinutes = toNumber(req.body.prepTimeMinutes, user.prepTimeMinutes ?? 30, 0, 240);
        user.isTemporarilyClosed = toBoolean(req.body.isTemporarilyClosed, false);
        user.temporaryClosureReason = sanitizeText(req.body.temporaryClosureReason, 160);
        user.operatingHours = sanitizeOperatingHours(req.body.operatingHours);

        const businessLocation = sanitizeLocation(req.body.businessLocation);
        if (businessLocation) {
            user.businessLocation = businessLocation;
        }

        await user.save();

        res.status(200).json({
            message: 'Vendor profile updated.',
            vendorProfile: buildVendorProfile(user),
        });
    } catch (error) {
        console.error('Error updating vendor profile:', error);
        res.status(500).json({ message: 'Server error updating vendor profile.' });
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

// // The corrected GET /api/vendor/stats route with the proper logic
// router.get('/stats', protect, authorizeRoles('vendor'), async (req, res) => {
//   try {
//     const vendorId = req.user._id;

//     // Use an aggregation pipeline to get both total stock and total sales
//     const statsResult = await Product.aggregate([
//       // Stage 1: Filter products by the current vendor
//       {
//         $match: {
//           vendor: vendorId,
//           isActive: true // Consider only active products
//         }
//       },
//       // Stage 2: Group the products and calculate the totals
//       {
//         $group: {
//           _id: null,
//           totalProducts: { $sum: 1 }, // Count the number of products (documents)
//           totalStockQuantity: { $sum: '$stockQuantity' } // Sum up the stock of all products
//         }
//       }
//     ]);

//     // Handle case where vendor has no products
//     const totalProducts = statsResult.length > 0 ? statsResult[0].totalProducts : 0;
//     const totalStockQuantity = statsResult.length > 0 ? statsResult[0].totalStockQuantity : 0;

//     // 2. Calculate the number of sold products by aggregating order items
//     const soldProductsResult = await Order.aggregate([
//       // Match orders where at least one item belongs to this vendor
//       { 
//         $match: {
//           'orderItems.vendor': vendorId,
//           orderStatus: { $in: ['shipped', 'delivered'] } 
//         }
//       },
//       // Deconstruct the array to process each item
//       { $unwind: '$orderItems' },
//       // Filter for only the items belonging to this specific vendor
//       { 
//         $match: {
//           'orderItems.vendor': vendorId
//         }
//       },
//       // Group the items and sum their quantities
//       {
//         $group: {
//           _id: null,
//           productsSold: { $sum: '$orderItems.quantity' }
//         }
//       }
//     ]);

//     const productsSold = soldProductsResult.length > 0 ? soldProductsResult[0].productsSold : 0;
    
//     // 3. Calculate the number of unsold products (correct logic)
//     const productsUnsold = totalStockQuantity; // The total unsold quantity is just the current total stock

//     // Send a successful response with the calculated stats
//     res.status(200).json({
//       totalProducts,
//       productsSold,
//       productsUnsold,
//     });

//   } catch (error) {
//     console.error('Error fetching vendor stats:', error);
//     res.status(500).json({ message: 'Server error fetching vendor statistics.' });
//   }
// });


// @desc    Get vendor statistics (CORRECTED - Single Source of Truth)
// @route   GET /api/vendor/stats
// @access  Private/Vendor
router.get('/stats', protect, authorizeRoles('vendor'), async (req, res) => {
  try {
    const vendorId = req.user._id;

    // Single efficient aggregation from Product model
    const statsResult = await Product.aggregate([
      {
        $match: {
          vendor: vendorId,
          isActive: true
        }
      },
      {
        $group: {
          _id: null,
          totalProducts: { $sum: 1 },
          totalStockQuantity: { $sum: '$stockQuantity' },
          // ✅ CORRECT: Sum the salesCount that's already updated during payment
          productsSold: { $sum: '$salesCount' }
        }
      }
    ]);

    // Handle vendor with no products
    const result = statsResult.length > 0 ? statsResult[0] : {
      totalProducts: 0,
      totalStockQuantity: 0,
      productsSold: 0
    };

    res.status(200).json({
      totalProducts: result.totalProducts,
      productsSold: result.productsSold,
      productsUnsold: result.totalStockQuantity,
    });

  } catch (error) {
    console.error('Error fetching vendor stats:', error);
    res.status(500).json({ message: 'Server error fetching vendor statistics.' });
  }
});
module.exports = router;
