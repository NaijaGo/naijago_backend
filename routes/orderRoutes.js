// routes/orderRoutes.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const MainOrder = require('../models/MainOrder');
const Shipment = require('../models/Shipment');
const Product = require('../models/Product');
const User = require('../models/User');
const Rider = require('../models/Rider');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const axios = require("axios");
const notificationService = require('../services/notificationService');

// Category-based commission rates
const CATEGORY_COMMISSION_RATES = {
    // HIGH COMMISSION CATEGORIES (15%) - Luxury/High-margin items
    'high': {
        rate: 0.15,
        categories: [
            // Luxury Fashion
            'Fashion > Men\'s Fashion',
            'Fashion > Women\'s Fashion',
            'Fashion > Watches',
            'Fashion > Jewelry',
            'Fashion > Eyewear',
            
            // Electronics & Tech
            'Electronics > Televisions & Video',
            'Electronics > Camera & Photo',
            'Electronics > Gadgets',
            'Electronics > Drones',
            'Electronics > Smart Home Devices',
            'Computing > Computers',
            
            // Luxury Items
            'Home & Office > Furniture',
            'Home & Office > Appliances',
            'Home & Office > Lighting',
            'Home & Office > Home Security',
            
            // Health & Beauty Luxury
            'Health & Beauty > Make Up',
            'Health & Beauty > Fragrance',
            'Health & Beauty > Skin Care & Cosmetics',
            
            // Automotive
            'Automobiles > Performance Parts',
            
            // Gaming
            'Gaming > Play Station',
            'Gaming > Xbox',
            'Gaming > Nintendo',
            'Gaming > PC Gaming',
            'Gaming > VR Headsets',
            
            // Sporting Goods (High-end)
            'Sporting Goods > Cardio Training',
            'Sporting Goods > Strength & Training Equipment',
            
            // Musical Instruments
            'Music & Instruments > Guitars',
            'Music & Instruments > Keyboards & Pianos',
            'Music & Instruments > Audio Equipment',
            
            // Photography
            'Photography > Cameras',
            'Photography > Lenses',
        ]
    },
    
    // MEDIUM COMMISSION CATEGORIES (12.5%) - Mid-range items
    'medium': {
        rate: 0.125,
        categories: [
            // Fashion (non-luxury)
            'Fashion > Kids\' Fashion',
            'Fashion > Luggages & Travel Gear',
            'Fashion > Hair & Wigs',
            'Fashion > Footwear',
            'Fashion > Bags & Purses',
            'Fashion > Belts & Accessories',
            'Fashion > Traditional Attire',
            'Fashion > Underwear & Lingerie',
            'Fashion > Sportswear',
            
            // Electronics (mid-range)
            'Electronics > Audios',
            'Electronics > Home Theater Systems',
            'Electronics > Headphones & Earbuds',
            'Electronics > Car Electronics',
            'Electronics > Batteries & Power',
            'Computing > Data Storage',
            'Computing > Printers & Computer Accessories',
            'Computing > Keyboards & Mice',
            
            // Home & Office (mid-range)
            'Home & Office > Home & Kitchen',
            'Home & Office > Home Interior & Exterior',
            'Home & Office > Office Products',
            'Home & Office > Cleaning Supplies',
            'Home & Office > Storage & Organization',
            'Home & Office > Garden & Outdoor',
            'Home & Office > Bedding & Bath',
            
            // Health & Beauty (mid-range)
            'Health & Beauty > Hair Care',
            'Health & Beauty > Oral Care',
            'Health & Beauty > Personal Care',
            'Health & Beauty > Shaving & Hair Removal',
            'Health & Beauty > Vitamins & Supplements',
            
            // Baby Products
            'Baby Products > Apparels & Accessories',
            'Baby Products > Diapering',
            'Baby Products > Feeding',
            'Baby Products > Baby Toddlers Toys',
            'Baby Products > Gears',
            'Baby Products > Bathing & Skin Care',
            'Baby Products > Potty Training',
            'Baby Products > Safety',
            'Baby Products > Nursery Furniture',
            'Baby Products > Strollers & Prams',
            'Baby Products > Car Seats',
            'Baby Products > Educational Toys',
            
            // Books & Stationery
            'Books & Stationery > Fiction Books',
            'Books & Stationery > Comics',
            'Books & Stationery > Technology',
            'Books & Stationery > Business',
            'Books & Stationery > Story',
            'Books & Stationery > Religious',
            'Books & Stationery > Non-Fiction',
            'Books & Stationery > Academic Textbooks',
            'Books & Stationery > Children Books',
            'Books & Stationery > Magazines',
            'Books & Stationery > Writing Instruments',
            'Books & Stationery > Office Supplies',
            'Books & Stationery > Art Supplies',
            'Books & Stationery > Calendars & Planners',
        ]
    },
    
    // LOW COMMISSION CATEGORIES (10%) - Low-margin/essential items
    'low': {
        rate: 0.10,
        categories: [
            // Groceries & Essentials
            'Groceries > Beer, Wine & Spirits',
            'Groceries > Food Cupboard',
            'Groceries > House Hold Cleaning',
            'Groceries > Fresh Produce',
            'Groceries > Dairy & Eggs',
            'Groceries > Seafood',
            
            // Health & Medicine
            'Health & Beauty > Medicine',
            'Health & Beauty > Condoms',
            'Health & Beauty > Sex Toys',
            'Health & Beauty > First Aid',
            'Health & Beauty > Medical Equipment',
            'Health & Beauty > Feminine Care',
            
            // Automotive Essentials
            'Automobiles > Car Care',
            'Automobiles > Car Exterior and Interior Accessories',
            'Automobiles > Tools & Equipment',
            'Automobiles > Oils & Fluids',
            'Automobiles > Car Safety',
            
            // Animal Products
            'Animal Products > Chicken Feeds',
            'Animal Products > Dog Feeds',
            'Animal Products > Cat Feeds',
            'Animal Products > Fish Feeds',
            'Animal Products > Pig Feeds',
            'Animal Products > Pet Accessories',
            'Animal Products > Pet Health & Care',
            'Animal Products > Pet Toys',
            'Animal Products > Pet Clothing',
            'AnimalProducts > Pet Grooming',
            'Animal Products > Aquarium Supplies',
            'Animal Products > Bird Supplies',
            
            // Building & Construction
            'Building & Construction > Building Materials',
            'Building & Construction > Electrical',
            'Building & Construction > Plumbing',
            'Building & Construction > Tools & Machinery',
            'Building & Construction > Safety Equipment',
            'Building & Construction > Paints & Coatings',
            'Building & Construction > Hardware',
            
            // Industrial & Scientific
            'Industrial & Scientific > Lab Equipment',
            'Industrial & Scientific > Packaging & Shipping',
            'Industrial & Scientific > Janitorial & Sanitation',
            
            // Agriculture
            'Agriculture > Fertilizers',
            'Agriculture > Pesticides',
            
            // Toys & Games (non-electronic)
            'Toys & Games > Dolls',
            'Toys & Games > Educational Toys',
            'Toys & Games > Outdoor Toys',
            'Toys & Games > Remote Control Toys',
            'Toys & Games > Stuffed Animals',
            'Toys & Games > Toy Vehicles',
            
            // Arts & Crafts
            'Arts & Crafts > Painting',
            'Arts & Crafts > Beading & Jewelry Making',
            'Arts & Crafts > Clay & Pottery',
            
            // Food & Beverage Equipment
            'Food & Beverage > Restaurant Equipment',
            'Food & Beverage > Catering Supplies',
            'Food & Beverage > Baking Supplies',
            'Food & Beverage > Food Processing',
            'Food & Beverage > Beverage Equipment',
            'Food & Beverage > Kitchen Utensils',
            'Food & Beverage > Food Packaging',
            
            // Travel & Tourism
            'Travel & Tourism > Travel Accessories',
            'Travel & Tourism > Luggage',
            'Travel & Tourism > Hotel Supplies',
            
            // Wedding & Events
            'Wedding & Events > Wedding Attire',
        ]
    }
};

// Helper function to get commission rate based on category
function getCommissionRateForCategory(category) {
    // Check each commission tier
    for (const [tier, data] of Object.entries(CATEGORY_COMMISSION_RATES)) {
        if (data.categories.includes(category)) {
            return data.rate;
        }
    }
    
    // Default rate if category not found
    return 0.125; // 12.5% default
}

// 👇 START OF ADDITIONS 1: Distance Calculation Utility (KEEPING THIS)
/**
 * Calculates the distance between two geographical coordinates using the Haversine formula.
 * @param {number} lat1 Latitude of point 1
 * @param {number} lon1 Longitude of point 1
 * @param {number} lat2 Latitude of point 2
 * @param {number} lon2 Longitude of point 2
 * @returns {number} Distance in Kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the Earth in kilometers
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c; // Distance in km
  return parseFloat(distance.toFixed(2)); // Round to 2 decimal places
}
// 👆 END OF ADDITIONS 1

// --- Helper Function: Shipping Cost (Based on your N200/km rule) ---
const calculateShippingCost = (distanceKm, city) => {
    const ratePerKm = 200;
    let shippingPrice = distanceKm * ratePerKm;
    
    // Minimum flat fee as a business rule
    if (shippingPrice < 1000) {
        shippingPrice = 1000.00; 
    }
    
    return parseFloat(shippingPrice.toFixed(2));
};
// ------------------------------------------------------------------

// @desc    Get all orders (Admin access only)
// @route   GET /api/orders
// @access  Private/Admin
router.get('/', protect, async (req, res) => {
  try {
      // Find MainOrder documents and populate the linked shipments
      const orders = await MainOrder.find({}) 
        .populate('user', 'firstName lastName email phoneNumber') 
        .populate({
            path: 'shipments',
            populate: {
                path: 'vendor', // Populate vendor details within each shipment
                select: 'businessName phoneNumber businessLocation'
            }
        })
        .populate('rider', 'fullName phoneNumber plateNumber') // Populate rider info
        .sort({ createdAt: -1 });

      res.status(200).json(orders);
  } catch (error) {
      console.error('Error fetching all orders:', error);
      res.status(500).json({ message: 'Error fetching all orders.', error: error.message });
  }
});

// ---
// ## Price Calculation Route

// @desc    Calculate total price, split by vendor, and return summary
// @route   POST /api/orders/calculate_summary
// @access  Private

// @desc    Calculate total price, split by vendor, and return summary
// @route   POST /api/orders/calculate_summary
// @access  Private
router.post('/summary', protect, async (req, res) => {
    const { cartItems, shippingAddress, userLocation } = req.body;

    if (!cartItems || cartItems.length === 0) {
        return res.status(400).json({ message: 'No items in cart for summary calculation' });
    }
    if (!shippingAddress || !userLocation) {
        return res.status(400).json({ message: 'Shipping address and location are required' });
    }
    
    try {
        const vendorCartMap = new Map();
        let totalSubtotal = 0;
        let totalPlatformFees = 0;

        // 1. Group items by vendor and calculate subtotal for each vendor
        for (const item of cartItems) {
            // Fetch product, vendor, and category data
            const [product, vendorUser] = await Promise.all([
                Product.findById(item.product, 'price imageUrls vendor category'),
                User.findById(item.vendor, 'businessName businessLocation')
            ]);
            
            if (!product) {
                return res.status(404).json({ message: `Product not found: ${item.name}` });
            }
            
            const vendorId = product.vendor.toString(); 

            if (!vendorUser || !vendorUser.businessLocation) {
                 return res.status(404).json({ message: `Vendor or location not found for product: ${item.name}` });
            }

            const itemPrice = product.price * item.quantity;
            totalSubtotal += itemPrice;

            // Get category-based commission rate
            const productCategory = product.category || 'Uncategorized';
            const commissionRate = getCommissionRateForCategory(productCategory);
            const itemCommission = itemPrice * commissionRate;
            totalPlatformFees += itemCommission;

            if (!vendorCartMap.has(vendorId)) {
                vendorCartMap.set(vendorId, {
                    vendorId: vendorId,
                    vendorName: vendorUser.businessName,
                    vendorLocation: vendorUser.businessLocation,
                    items: [],
                    subtotal: 0,
                    platformFee: 0,
                    commissionRate: 0,
                });
            }
            
            const vendorData = vendorCartMap.get(vendorId);
            vendorData.items.push({
                product: item.product,
                name: item.name,
                image: product.imageUrls[0],
                quantity: item.quantity,
                price: product.price,
                selectedSize: item.selectedSize || null,
                category: productCategory, // Store category for reference
                commissionRate: commissionRate, // Store individual commission rate
                itemCommission: itemCommission, // Store calculated commission
            });
            
            vendorData.subtotal += itemPrice;
            vendorData.platformFee += itemCommission;
            // Store the average commission rate for this vendor's shipment
            vendorData.commissionRate = vendorData.platformFee / vendorData.subtotal;
        }

        // 2. Calculate fees for each shipment
        const shipmentSummaries = [];
        let totalShippingPrice = 0;

        for (const data of vendorCartMap.values()) {
            const vendorLocation = data.vendorLocation;
            
            // Calculate Distance (Haversine)
            const distanceKm = calculateDistance(
                vendorLocation.latitude,
                vendorLocation.longitude,
                userLocation.latitude,
                userLocation.longitude
            );
            
            // Calculate Shipping Price
            const shippingPrice = calculateShippingCost(distanceKm, shippingAddress.city);
            
            totalShippingPrice += shippingPrice;

            shipmentSummaries.push({
                vendorId: data.vendorId,
                vendorName: data.vendorName,
                vendorLocation: vendorLocation, 
                subtotal: parseFloat(data.subtotal.toFixed(2)),
                shippingPrice: shippingPrice,
                platformFee: parseFloat(data.platformFee.toFixed(2)),
                commissionRate: parseFloat(data.commissionRate.toFixed(3)),
                // Total cost for the items and delivery from this specific vendor
                totalShipmentCost: parseFloat((data.subtotal + shippingPrice).toFixed(2)), 
                items: data.items,
                commissionBreakdown: {
                    rate: data.commissionRate,
                    amount: data.platformFee,
                    description: `Commission applied based on product categories`
                }
            });
        }
        
        const totalPrice = totalSubtotal + totalShippingPrice + (req.body.taxPrice || 0.0);

        // 3. Prepare commission breakdown for response
        const commissionBreakdown = {};
        cartItems.forEach(item => {
            // Calculate commission per item for transparency
            // (You might want to fetch the product again or store commission in vendorCartMap)
        });

        // 4. Respond to Flutter
        res.json({
            totalSubtotal: parseFloat(totalSubtotal.toFixed(2)),
            totalShippingPrice: parseFloat(totalShippingPrice.toFixed(2)),
            totalPlatformFees: parseFloat(totalPlatformFees.toFixed(2)),
            totalPrice: parseFloat(totalPrice.toFixed(2)),
            taxPrice: req.body.taxPrice || 0.0,
            shipmentSummaries,
            userLocation, 
            shippingAddress,
            commissionSummary: {
                totalCommission: parseFloat(totalPlatformFees.toFixed(2)),
                averageRate: parseFloat((totalPlatformFees / totalSubtotal).toFixed(3)),
                note: 'Commission rates vary by product category (10-15%)'
            }
        });

    } catch (error) {
        console.error('Error calculating order summary:', error);
        res.status(500).json({ message: 'Error calculating order summary.', error: error.message });
    }
});

// ## Order Creation Route

// @desc    Create new MainOrder and associated Shipment documents
// @route   POST /api/orders
// @access  Private
router.post('/', protect, async (req, res) => {
    // ⚠️ We now receive the entire calculated summary from Flutter.
    const { 
        shippingAddress, 
        paymentMethod,
        totalSubtotal,
        totalShippingPrice,
        totalPlatformFees,
        totalPrice,
        taxPrice,
        userLocation,
        shipmentSummaries, // The calculated breakdown array is VITAL
    } = req.body;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        if (!shipmentSummaries || shipmentSummaries.length === 0) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'No shipment summaries provided. Please calculate summary first.' });
        }

        // --- Step 1: Stock Check (Must check stock for ALL items across ALL shipments) ---
        for (const summary of shipmentSummaries) {
            for (const item of summary.items) {
                const product = await Product.findById(item.product).session(session);
                if (!product) {
                    await session.abortTransaction();
                    session.endSession();
                    return res.status(404).json({ message: `Product not found: ${item.name}` });
                }
                if (product.stockQuantity < item.quantity) {
                    await session.abortTransaction();
                    session.endSession();
                    return res.status(400).json({ message: `Insufficient stock for ${product.name}. Available: ${product.stockQuantity}` });
                }
            }
        }
        
        // --- Step 2: Create the MainOrder document (The Receipt) ---
        const mainOrder = new MainOrder({ // Use MainOrder model
            user: req.user._id,
            shippingAddress,
            userLocation,
            totalSubtotal,
            totalPlatformFees,
            totalShippingPrice,
            totalTaxPrice: taxPrice || 0.0,
            totalPrice,
            paymentMethod,
            isPaid: false, 
            mainOrderStatus: 'pending_payment',
            shipments: [], // Start empty, populate in next step
        });

        const createdMainOrder = await mainOrder.save({ session });
        
        const shipmentIds = [];
        
        // --- Step 3: Create Shipment documents for each vendor ---
        for (const summary of shipmentSummaries) {
            const newShipment = new Shipment({
                mainOrder: createdMainOrder._id,
                vendor: summary.vendor,
                vendorLocation: summary.vendorLocation,
                items: summary.items.map(item => ({
                    product: item.product,
                    name: item.name,
                    image: item.image,
                    quantity: item.quantity,
                    price: item.price,
                    selectedSize: item.selectedSize || null,
                    category: item.category, // Store category
                    commissionRate: item.commissionRate, // Store individual item commission rate
                })),
                subtotal: summary.subtotal,
                platformFee: summary.platformFee,
                shippingPrice: summary.shippingPrice,
                commissionRate: summary.commissionRate, // Store average commission rate for this shipment
                shipmentStatus: 'processing',
                isDelivered: false,
            });

            const createdShipment = await newShipment.save({ session });
            shipmentIds.push(createdShipment._id);
        }
        
        // --- Step 4: Link Shipments back to the MainOrder ---
        createdMainOrder.shipments = shipmentIds;
        await createdMainOrder.save({ session });

        await session.commitTransaction();
        session.endSession();

        // Return the MainOrder (with populated shipment IDs)
        res.status(201).json(createdMainOrder);

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error creating multi-vendor order:', error);
        res.status(500).json({ message: 'Server Error during order creation.', error: error.message });
    }
});

// ---

// ## Status Update, User, and Vendor Routes

// @desc    Update pending orders to processing after some time delay / server check
// @route   POST /api/orders/update-pending-to-processing
// @access  Private (called by client's polling timer)
router.post('/update-pending-to-processing', protect, async (req, res) => {
    try {
        // Logic now uses MainOrder and updates associated Shipments
        const mainOrdersResult = await MainOrder.updateMany(
            { 
                mainOrderStatus: 'pending_payment', 
                isPaid: true 
            },
            { $set: { mainOrderStatus: 'processing' } }
        );

        // This route is deprecated by the immediate update in the payment routes, but kept for legacy/polling cleanup.
        // It should update all associated Shipments to 'processing' as well.
        const ordersToUpdate = await MainOrder.find({ mainOrderStatus: 'processing', isPaid: true, shipments: { $ne: [] } }).select('shipments');
        const shipmentIds = ordersToUpdate.flatMap(order => order.shipments);

        const shipmentsResult = await Shipment.updateMany(
            { _id: { $in: shipmentIds }, shipmentStatus: 'awaiting_payment' },
            { $set: { shipmentStatus: 'processing' } }
        );

        res.json({ 
            message: `Successfully updated ${mainOrdersResult.modifiedCount} paid main orders to 'processing' and ${shipmentsResult.modifiedCount} shipments.`,
            count: mainOrdersResult.modifiedCount 
        });
    } catch (error) {
        console.error('Error updating pending orders:', error);
        res.status(500).json({ message: 'Server Error during pending order update' });
    }
});


// @desc    Get logged in user's orders (Now fetching MainOrders)
// @route   GET /api/orders/my
// @access  Private
router.get('/my', protect, async (req, res) => {
    try {
        // Fetch MainOrder and populate linked Shipments
        const orders = await MainOrder.find({ user: req.user.id })
            .populate({
                path: 'shipments',
                populate: [
                    { 
                        path: 'vendor', 
                        select: 'businessName businessLocation' 
                    },
                    { 
                        path: 'items.product', 
                        select: 'name imageUrls price category' 
                    }
                ]
            })
            .populate('rider', 'fullName phoneNumber plateNumber')
            .sort({ createdAt: -1 });
        
        // Add logging for debugging
        console.log(`User ${req.user.id} fetched ${orders.length} orders`);
        if (orders.length > 0 && orders[0].shipments && orders[0].shipments.length > 0) {
            const firstShipment = orders[0].shipments[0];
            if (firstShipment.items && firstShipment.items.length > 0) {
                console.log('First item in user order:', JSON.stringify(firstShipment.items[0], null, 2));
            }
        }
        
        res.json(orders);
    } catch (error) {
        console.error('Error fetching user orders:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});


// @desc    Get vendor-specific shipments
// @route   GET /api/orders/vendor
// @access  Private/Vendor
router.get('/vendor', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
    try {
        // Vendors now only care about their Shipments, not the entire MainOrder
        const shipments = await Shipment.find({ vendor: req.user.id })
            .populate({
                path: 'mainOrder',
                select: 'shippingAddress userLocation totalPrice paymentMethod createdAt rider mainOrderStatus',
                populate: [
                    {
                        path: 'user',
                        select: 'firstName lastName email phoneNumber'
                    },
                    {
                        path: 'rider',
                        select: 'fullName phoneNumber plateNumber'
                    }
                ]
            })
            .populate('vendor', 'businessName phoneNumber')
            .populate('rider', 'fullName phoneNumber plateNumber')
            .populate('items.product', 'name imageUrls price stockQuantity category')
            .sort({ createdAt: -1 });
        
        // Add logging to debug
        console.log(`Vendor ${req.user.id} fetched ${shipments.length} shipments`);
        if (shipments.length > 0 && shipments[0].items.length > 0) {
            console.log('First item in first shipment:', JSON.stringify(shipments[0].items[0], null, 2));
        }
        
        res.json(shipments);
    } catch (error) {
        console.error('Error fetching vendor orders:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});

    // @desc    Get commission rates for different categories
    // @route   GET /api/orders/commission-rates
    // @access  Public
    router.get('/commission-rates', async (req, res) => {
        try {
            const commissionStructure = {};
            
            // Transform the CATEGORY_COMMISSION_RATES for easier consumption
            for (const [tier, data] of Object.entries(CATEGORY_COMMISSION_RATES)) {
                commissionStructure[tier] = {
                    rate: data.rate * 100, // Convert to percentage
                    rateDecimal: data.rate,
                    description: getTierDescription(tier),
                    exampleCategories: data.categories.slice(0, 5) // Show first 5 examples
                };
            }
            
            res.json({
                success: true,
                commissionStructure,
                note: 'Commission rates are applied per product based on category',
                defaultRate: 0.125 // Default if category not found
            });
        } catch (error) {
            console.error('Error fetching commission rates:', error);
            res.status(500).json({ 
                success: false, 
                message: 'Error fetching commission rates', 
                error: error.message 
            });
        }
    });

    // Helper function for tier descriptions
    function getTierDescription(tier) {
        switch(tier) {
            case 'high':
                return 'Luxury & High-margin items (Electronics, Luxury Fashion, etc.)';
            case 'medium':
                return 'Mid-range items (Regular Fashion, Home Goods, etc.)';
            case 'low':
                return 'Essentials & Low-margin items (Groceries, Medicine, Animal Feed, etc.)';
            default:
                return 'Standard items';
        }
    }


// ## Wallet Payment Route (Escrow)

// @desc     Update MainOrder/Shipments to paid + Debit User Wallet (NO IMMEDIATE VENDOR CREDIT)
// @route    PUT /api/orders/:id/pay/wallet
// @access   Private
router.put('/:id/pay/wallet', protect, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const mainOrder = await MainOrder.findById(req.params.id).session(session);

        if (!mainOrder) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Main Order not found' });
        }

        if (mainOrder.isPaid) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Order is already paid' });
        }

        // 1. Authorization check
        if (mainOrder.user.toString() !== req.user.id.toString()) {
            await session.abortTransaction();
            session.endSession();
            return res.status(401).json({ message: 'Not authorized to modify this order' });
        }
        
        // 2. Fetch the user (buyer) document within the transaction
        const buyer = await User.findById(req.user.id).session(session);
        if (!buyer) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Buyer user account not found.' });
        }

        // 3. Balance check
        const orderTotal = mainOrder.totalPrice; // Total price user must pay
        if (buyer.userWalletBalance < orderTotal) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ 
                message: `Insufficient wallet balance. Required: ₦${orderTotal.toFixed(2)}, Available: ₦${buyer.userWalletBalance.toFixed(2)}`
            });
        }
        
        // 4. Debit the buyer's wallet
        const updatedBuyer = await User.findByIdAndUpdate(
            req.user.id,
            { $inc: { userWalletBalance: -orderTotal } },
            { new: true, session }
        );
        
        // 5. Update MainOrder payment status (Funds are now HELD by the platform/Escrow)
        mainOrder.isPaid = true;
        mainOrder.paidAt = Date.now();
        mainOrder.mainOrderStatus = 'processing'; // Transition to processing
        mainOrder.paymentResult = {
            id: 'WALLET-' + Date.now().toString(), 
            status: 'successful',
            payment_type: 'Wallet Balance',
            amount: orderTotal,
            currency: 'NGN',
            email_address: buyer.email,
        };

           // After successful payment, send notification to user
            try {
            await notificationService.sendToUser(req.user.id.toString(), {
                title: 'Payment Successful!',
                message: `Your payment of ₦${orderTotal.toFixed(2)} was successful. Order #${mainOrder._id}`,
                data: {
                    type: 'payment_success',
                    orderId: mainOrder._id,
                    amount: orderTotal
                }
            });
        } catch (notifError) {
            console.error('Payment notification failed:', notifError);
        }

        // 6. Process product stock updates and update Shipment status
        const shipments = await Shipment.find({ mainOrder: mainOrder._id }).session(session);
        const productUpdates = [];


        for (const shipment of shipments) {
            // Update Shipment status to processing
            shipment.shipmentStatus = 'processing';
            await shipment.save({ session });

            // const message = `New paid order! Shipment ${shipment._id} is ready for processing. Platform Fee deducted: ₦${shipment.platformFee.toFixed(2)} will be retained.`;

            // await User.findByIdAndUpdate(
            //     shipment.vendor,
            //     {
            //         $push: {
            //             notifications: {
            //                 $each: [
            //                     {
            //                         type: 'new_order',
            //                         message: message,
            //                         isRead: false,
            //                         relatedModel: 'Shipment',
            //                         relatedId: shipment._id,
            //                     },
            //                 ],
            //                 $position: 0, 
            //             },
            //         },
            //     },
            //     { new: true, session }
            // );

            // ✅ Enhanced notification with shipment details (NO BUYER INFO)
                const itemSummary = shipment.items.map(item => 
                `${item.quantity}x ${item.name} (₦${item.price.toFixed(2)} each)`
                ).join(', ');

                const message = `📦 New Order Received! 
                Shipment #${shipment._id.toString().slice(-6)}
                Items: ${itemSummary}
                Subtotal: ₦${shipment.subtotal.toFixed(2)}
                Shipping: ₦${shipment.shippingPrice.toFixed(2)}
                Platform Fee: ₦${shipment.platformFee.toFixed(2)}
                Status: Ready for processing`;

                await User.findByIdAndUpdate(
                    shipment.vendor,
                    {
                        $push: {
                            notifications: {
                                $each: [{
                                    type: 'new_order',
                                    message: message,
                                    isRead: false,
                                    relatedModel: 'Shipment',
                                    relatedId: shipment._id,
                                    // Add shipment details (NO BUYER INFO)
                                    shipmentDetails: {
                                        orderId: mainOrder._id,
                                        items: shipment.items.map(item => ({
                                            productName: item.name,
                                            quantity: item.quantity,
                                            price: item.price,
                                            total: item.quantity * item.price
                                        })),
                                        subtotal: shipment.subtotal,
                                        platformFee: shipment.platformFee,
                                        shippingPrice: shipment.shippingPrice,
                                        totalShipment: shipment.subtotal + shipment.shippingPrice,
                                        status: 'processing'
                                    }
                                }],
                                $position: 0,
                            },
                        },
                    },
                    { new: true, session }
                );
            // END: NEW VENDOR NOTIFICATION FOR PAID ORDER
            
            // Queue product updates
            for (const item of shipment.items) {
                const soldCount = item.quantity;
                productUpdates.push(
                    Product.findByIdAndUpdate(
                        item.product,
                        { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
                        { new: true, session }
                    )
                );
            }
        }

        await Promise.all(productUpdates);
        
        // 7. VENDOR CREDITS (85%) ARE HELD UNTIL ORDER COMPLETION.

        const updatedOrder = await mainOrder.save({ session });
        await session.commitTransaction();
        session.endSession();

        // 8. Success response
        res.json({
            ...updatedOrder.toObject(),
            newBuyerWalletBalance: updatedBuyer.userWalletBalance, 
        });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error processing wallet payment for order:', error.message);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});

// ## Flutterwave Payment Route (Escrow)

// @desc     Update MainOrder/Shipments to paid + verify Flutterwave (NO IMMEDIATE VENDOR CREDIT)
// @route    PUT /api/orders/:id/pay
// @access   Private
router.put('/:id/pay', protect, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const mainOrder = await MainOrder.findById(req.params.id).session(session);

    if (!mainOrder) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Main Order not found' });
    }

    if (mainOrder.isPaid) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Order is already paid' });
    }

    if (mainOrder.user.toString() !== req.user.id.toString()) {
      await session.abortTransaction();
      session.endSession();
      return res.status(401).json({ message: 'Not authorized to modify this order' });
    }

    const { transaction_id } = req.body;
    if (!transaction_id) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Transaction ID is required' });
    }

    // ✅ Verify payment with Flutterwave
    const flwResponse = await axios.get(
      `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
      {
        headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` }
      }
    );

    const flwData = flwResponse.data;

    // ❌ If verification fails, remove order
    if (flwData.status !== "success" || flwData.data.status !== "successful") {
      await MainOrder.deleteOne({ _id: mainOrder._id }, { session });
      // Also delete associated shipments to prevent orphaned documents
      await Shipment.deleteMany({ mainOrder: mainOrder._id }, { session }); 
      await session.commitTransaction();
      session.endSession();
      return res.status(400).json({
        message: 'Payment verification failed and order has been removed.',
        flutterwave: flwData
      });
    }

    // ✅ Verified — update MainOrder payment and status
    mainOrder.isPaid = true;
    mainOrder.paidAt = Date.now();
    mainOrder.mainOrderStatus = 'processing'; // Transition to processing
    mainOrder.paymentResult = {
      id: flwData.data.id,
      status: flwData.data.status,
      tx_ref: flwData.data.tx_ref,
      flw_ref: flwData.data.flw_ref,
      amount: flwData.data.amount,
      currency: flwData.data.currency,
      email_address: flwData.data.customer.email,
    };

    // Update Product Stock and Shipment status
    const shipments = await Shipment.find({ mainOrder: mainOrder._id }).session(session);
    const productUpdates = [];

    for (const shipment of shipments) {
        // Update Shipment status to processing
        shipment.shipmentStatus = 'processing';
        await shipment.save({ session });

        for (const item of shipment.items) {
            const soldCount = item.quantity;
            productUpdates.push(
                Product.findByIdAndUpdate(
                    item.product,
                    { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
                    { new: true, session }
                )
            );
        }
    }

    await Promise.all(productUpdates);

    // ❌ VENDOR CREDITS (85%) ARE HELD UNTIL ORDER COMPLETION.

    const updatedOrder = await mainOrder.save({ session });
    await session.commitTransaction();
    session.endSession();

    res.json(updatedOrder);

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Error verifying payment and updating order:', error.response?.data || error.message);
    res.status(500).json({ message: 'Server Error', error: error.response?.data || error.message });
  }
});


// ## Shipment Delivery and Vendor Payout Route (UPDATED)

// @desc     Mark a specific Shipment as delivered, update metrics (NO PAYOUT HERE)
// @route    PUT /api/orders/shipments/:id/deliver
// @access   Private/Admin/Vendor (Vendor can only mark their own shipments as delivered)
router.put('/shipments/:id/deliver', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
    const SHIPMENT_ID = req.params.id;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        // 1. Find the Shipment and ensure it's not already delivered
        const shipment = await Shipment.findById(SHIPMENT_ID).session(session);

        if (!shipment) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Shipment not found' });
        }

        if (shipment.isDelivered) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Shipment is already marked as delivered' });
        }
        
        // 2. Authorization: Vendor can only update their own shipments unless they are an admin
        if (req.user.role === 'vendor' && shipment.vendor.toString() !== req.user.id.toString()) {
            await session.abortTransaction();
            session.endSession();
            return res.status(401).json({ message: 'Not authorized to update this shipment' });
        }
        
        // 3. NO VENDOR CREDITING HERE - Only mark as delivered
        // Vendor will be credited when MainOrder is marked as 'completed' by admin
        
        // 4. Update the Shipment status
        shipment.isDelivered = true;
        shipment.deliveredAt = Date.now();
        shipment.shipmentStatus = 'delivered';

        const updatedShipment = await shipment.save({ session });
        
        // 5. Check if all Shipments in the MainOrder are now delivered
        const mainOrder = await MainOrder.findById(shipment.mainOrder).session(session);
        const pendingShipments = await Shipment.countDocuments({ 
            mainOrder: mainOrder._id, 
            isDelivered: false 
        }).session(session);

        if (pendingShipments === 0) {
            // All shipments for this MainOrder are delivered
            // Update status to 'delivered' but DON'T credit yet
            mainOrder.isDelivered = true;
            mainOrder.deliveredAt = Date.now();
            mainOrder.mainOrderStatus = 'delivered'; // Changed from 'completed' to 'delivered'
            await mainOrder.save({ session });
            
            // Send notification to admin that order is ready for completion/verification
            const adminUsers = await User.find({ role: 'admin' }).session(session);
            for (const admin of adminUsers) {
                await User.findByIdAndUpdate(
                    admin._id,
                    {
                        $push: {
                            notifications: {
                                type: 'order_ready_for_completion',
                                message: `Order ${mainOrder._id} has all shipments delivered and is ready for final verification and completion.`,
                                isRead: false,
                                relatedModel: 'MainOrder',
                                relatedId: mainOrder._id,
                            }
                        }
                    },
                    { new: true, session }
                );
            }
            
            // Emit socket notification
            const io = req.app.get('io');
            if (io) {
                io.emit('admin_notification', {
                    type: 'order_ready_for_completion',
                    message: `Order ${mainOrder._id} has all shipments delivered and is ready for final verification and completion.`,
                    orderId: mainOrder._id,
                    timestamp: Date.now()
                });
            }
        }

        await session.commitTransaction();
        session.endSession();

        res.json({
            message: `Shipment ${SHIPMENT_ID} marked as delivered. Order will be completed after admin verification.`,
            shipment: updatedShipment,
        });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error processing shipment delivery:', error.message);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});


router.put('/shipments/:id/status-update', protect, authorizeRoles('admin'), async (req, res) => {
    const { status } = req.body; // Expects a status like 'out_for_delivery'
    const SHIPMENT_ID = req.params.id;

    // Validate the incoming status against the Shipment enum values, excluding 'delivered' and 'awaiting_payment'
    const validStatuses = ['processing', 'ready_for_pickup', 'out_for_delivery', 'returned', 'cancelled'];
    
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ 
            message: `Invalid or non-updatable shipment status provided. Must be one of: ${validStatuses.join(', ')}` 
        });
    }

    try {
        const shipment = await Shipment.findById(SHIPMENT_ID);

        if (!shipment) {
            return res.status(404).json({ message: 'Shipment not found' });
        }
        
        // Prevent accidental updates if already delivered
        if (shipment.shipmentStatus === 'delivered') {
            return res.status(400).json({ message: 'Cannot update status of an already delivered shipment.' });
        }

        // Update the status
        shipment.shipmentStatus = status;
        await shipment.save();

        res.json({ message: `Shipment ${SHIPMENT_ID} status updated to ${status}.`, shipment });

    } catch (error) {
        console.error('Error during generic status update:', error);
        res.status(500).json({ message: 'Server Error during status update.', error: error.message });
    }
});


// @desc    Update order status by dispatch rider
// @route   PUT /api/orders/:id/dispatch-status
// @access  Private/Dispatch
router.put('/:id/dispatch-status', protect, authorizeRoles('dispatch', 'admin'), async (req, res) => {
    const { status } = req.body;
    
    if (!['shipped', 'delivered'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status provided.' });
    }

    try {
        const order = await Order.findById(req.params.id);

        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        if (status === 'shipped' && (order.orderStatus === 'pending' || order.orderStatus === 'processing')) {
            order.orderStatus = status;
        } else if (status === 'delivered' && order.orderStatus === 'shipped') {
            order.orderStatus = status;
            order.isDelivered = true;
            order.deliveredAt = Date.now();
        } else {
            return res.status(400).json({ message: 'Invalid status transition.' });
        }

        const updatedOrder = await order.save();
        res.json(updatedOrder);
    } catch (error) {
        console.error('Error updating order status:', error);
        if (error.kind === 'ObjectId') {
            return res.status(400).json({ message: 'Invalid Order ID format' });
        }
        res.status(500).json({ message: 'Server Error' });
    }
});



// @desc    Update MainOrder status (Admin only) - UPDATED FOR SIMULTANEOUS PAYOUT
// @route   PUT /api/orders/:id/status
// @access  Private/Admin
// router.put('/:id/status', protect, authorizeRoles('admin'), async (req, res) => {
//     const { status } = req.body;
//     const MAIN_ORDER_ID = req.params.id;

//     // 1. Basic validation: MUST match the Mongoose model's enum
//     const validStatuses = [
//         'pending_payment', 
//         'processing', 
//         'partially_shipped', 
//         'shipped', 
//         'out_for_delivery',
//         'delivered', 
//         'completed',
//         'cancelled'
//     ];

//     if (!validStatuses.includes(status)) {
//         return res.status(400).json({ 
//             message: `Invalid main order status: ${status}. Must be one of: ${validStatuses.join(', ')}` 
//         });
//     }

//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         const mainOrder = await MainOrder.findById(MAIN_ORDER_ID).session(session);

//         if (!mainOrder) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(404).json({ message: 'Main Order not found.' });
//         }

//         // NEW: Prevent double-crediting / double-delivery
//         if (status === 'completed' && mainOrder.mainOrderStatus === 'completed') {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ 
//                 message: 'Order already marked as completed and credited. No further action allowed.' 
//             });
//         }

//         // 2. Update the status
//         mainOrder.mainOrderStatus = status;

//         // SIMULTANEOUS PAYOUT LOGIC ONLY WHEN STATUS IS 'completed'
//         if (status === 'completed') {
//             mainOrder.isDelivered = true;
//             mainOrder.deliveredAt = Date.now();
//             mainOrder.shipmentStatus = 'delivered';
//             mainOrder.vendorPaidAt = Date.now();

//             // Credit logic only if order is paid
//             if (mainOrder.isPaid) {
//                 // Fetch all shipments for this order
//                 const shipments = await Shipment.find({ mainOrder: MAIN_ORDER_ID }).session(session);

//                 let totalRiderPayout = 0;
//                 let totalVendorPayout = 0;
//                 let payoutDetails = [];

//                 for (const shipment of shipments) {
//                     // Calculate vendor payout for this shipment (subtotal - platform fee)
//                     const vendorEarning = shipment.subtotal - shipment.platformFee;
//                     totalVendorPayout += vendorEarning;

//                     // Calculate distance for rider payout (150 per km)
//                     let riderPayoutPerShipment = 0;
//                     if (shipment.vendorLocation && mainOrder.userLocation) {
//                         const distance = calculateDistance(
//                             shipment.vendorLocation.latitude,
//                             shipment.vendorLocation.longitude,
//                             mainOrder.userLocation.latitude,
//                             mainOrder.userLocation.longitude
//                         );
//                         riderPayoutPerShipment = distance * 150;
//                         totalRiderPayout += riderPayoutPerShipment;
//                     }

//                     // 1. PAY VENDOR (85% of subtotal)
//                     const updatedVendor = await User.findByIdAndUpdate(
//                         shipment.vendor,
//                         {
//                             $inc: { vendorWalletBalance: vendorEarning },
//                             $push: {
//                                 notifications: {
//                                     $each: [{
//                                         type: 'delivery_payout',
//                                         message: `Payout of ₦${vendorEarning.toFixed(2)} received for completed order ${mainOrder._id}. Platform Fee: ₦${shipment.platformFee.toFixed(2)}.`,
//                                         isRead: false,
//                                         relatedModel: 'MainOrder',
//                                         relatedId: mainOrder._id,
//                                     }],
//                                     $position: 0,
//                                 },
//                             },
//                         },
//                         { new: true, session }
//                     );

//                     // 2. Store payout details
//                     payoutDetails.push({
//                         vendorId: shipment.vendor,
//                         vendorName: updatedVendor?.businessName || 'Unknown Vendor',
//                         vendorPayout: vendorEarning,
//                         shipmentId: shipment._id,
//                         distance: calculateDistance(
//                             shipment.vendorLocation.latitude,
//                             shipment.vendorLocation.longitude,
//                             mainOrder.userLocation.latitude,
//                             mainOrder.userLocation.longitude
//                         ),
//                         riderPayout: riderPayoutPerShipment
//                     });

//                     // Auto-update each shipment to delivered if not already
//                     if (!shipment.isDelivered) {
//                         shipment.shipmentStatus = 'delivered';
//                         shipment.isDelivered = true;
//                         shipment.deliveredAt = Date.now();
//                         await shipment.save({ session });
//                     }
//                 }

//                 // 3. PAY RIDER (150 per km across all shipments) - SIMULTANEOUS WITH VENDORS
//                 if (mainOrder.rider && totalRiderPayout > 0) {
//                     await Rider.findByIdAndUpdate(
//                         mainOrder.rider,
//                         { 
//                             $inc: { 
//                                 walletBalance: totalRiderPayout, 
//                                 totalEarnings: totalRiderPayout,
//                                 completedDeliveries: 1 
//                             },
//                             $push: {
//                                 notifications: {
//                                     type: 'delivery_payout',
//                                     message: `₦${totalRiderPayout.toFixed(2)} credited for completing order ${mainOrder._id}.`,
//                                     isRead: false,
//                                     relatedModel: 'MainOrder',
//                                     relatedId: mainOrder._id,
//                                 }
//                             }
//                         },
//                         { session }
//                     );
//                 } else {
//                     console.warn(`No rider assigned for completed order ${MAIN_ORDER_ID} - skipping rider credit`);
//                 }

//                 // 4. Update order with payout details
//                 mainOrder.payoutDetails = {
//                     totalVendorPayout,
//                     totalRiderPayout,
//                     payoutDate: Date.now(),
//                     details: payoutDetails
//                 };

//                 // Log the payout for admin
//                 console.log(`✅ Order ${MAIN_ORDER_ID} completed. Total payouts: 
//                   - Vendors: ₦${totalVendorPayout.toFixed(2)} 
//                   - Rider: ₦${totalRiderPayout.toFixed(2)}`);

//                 // Emit socket notification about completed payout
//                 const io = req.app.get('io');
//                 if (io) {
//                     io.emit('order_payout_completed', {
//                         orderId: MAIN_ORDER_ID,
//                         totalVendorPayout,
//                         totalRiderPayout,
//                         payoutDetails,
//                         timestamp: Date.now()
//                     });
//                 }

//             } else {
//                 console.warn(`Order ${MAIN_ORDER_ID} marked as completed but not paid - skipping payouts`);
//             }
//         }

//         const updatedMainOrder = await mainOrder.save({ session });
//         await session.commitTransaction();
//         session.endSession();

//         res.json({ 
//             message: `Main Order ${MAIN_ORDER_ID} status updated to ${status}.${status === 'completed' ? ' Vendors and rider paid simultaneously.' : ''}`, 
//             order: updatedMainOrder,
//             ...(status === 'completed' && mainOrder.isPaid ? {
//                 payoutSummary: {
//                     totalVendorPayout: mainOrder.payoutDetails?.totalVendorPayout || 0,
//                     totalRiderPayout: mainOrder.payoutDetails?.totalRiderPayout || 0,
//                     payoutDate: mainOrder.payoutDetails?.payoutDate
//                 }
//             } : {})
//         });

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error updating main order status:', error);
//         res.status(500).json({ message: 'Server Error during main order status update.', error: error.message });
//     }
// });

// @desc    Update MainOrder status (Admin only) - UPDATED FOR SIMULTANEOUS PAYOUT
// @route   PUT /api/orders/:id/status
// @access  Private/Admin
router.put('/:id/status', protect, authorizeRoles('admin'), async (req, res) => {
    const { status } = req.body;
    const MAIN_ORDER_ID = req.params.id;

    // 1. Basic validation: MUST match the Mongoose model's enum
    const validStatuses = [
        'pending_payment', 
        'processing', 
        'partially_shipped', 
        'shipped', 
        'out_for_delivery',
        'delivered', 
        'completed',
        'cancelled'
    ];

    if (!validStatuses.includes(status)) {
        return res.status(400).json({ 
            message: `Invalid main order status: ${status}. Must be one of: ${validStatuses.join(', ')}` 
        });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const mainOrder = await MainOrder.findById(MAIN_ORDER_ID).session(session);

        if (!mainOrder) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Main Order not found.' });
        }

        // NEW: Prevent double-crediting / double-delivery
        if (status === 'completed' && mainOrder.mainOrderStatus === 'completed') {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ 
                message: 'Order already marked as completed and credited. No further action allowed.' 
            });
        }

        // 2. Update the status
        mainOrder.mainOrderStatus = status;

        // SIMULTANEOUS PAYOUT LOGIC ONLY WHEN STATUS IS 'completed'
        if (status === 'completed') {
            mainOrder.isDelivered = true;
            mainOrder.deliveredAt = Date.now();
            mainOrder.shipmentStatus = 'delivered';
            mainOrder.vendorPaidAt = Date.now();

            // Credit logic only if order is paid
            if (mainOrder.isPaid) {
                // Fetch all shipments for this order
                const shipments = await Shipment.find({ mainOrder: MAIN_ORDER_ID }).session(session);

                let totalRiderPayout = 0;
                let totalVendorPayout = 0;
                let totalCompanySettlement = 0; // ⬅️ ADD THIS
                let payoutDetails = [];

                for (const shipment of shipments) {
                    // Calculate vendor payout for this shipment (subtotal - platform fee)
                    const vendorEarning = shipment.subtotal - shipment.platformFee;
                    totalVendorPayout += vendorEarning;

                    // Calculate distance for rider payout (150 per km)
                    let riderPayoutPerShipment = 0;
                    let companySettlementPerShipment = 0; // ⬅️ ADD THIS
                    if (shipment.vendorLocation && mainOrder.userLocation) {
                        const distance = calculateDistance(
                            shipment.vendorLocation.latitude,
                            shipment.vendorLocation.longitude,
                            mainOrder.userLocation.latitude,
                            mainOrder.userLocation.longitude
                        );
                        
                        // ⬇️ ADD THIS: Calculate company settlement (₦150/km per shipment)
                        companySettlementPerShipment = distance * 150;
                        totalCompanySettlement += companySettlementPerShipment;
                        
                        // Rider gets the full distance payout
                        riderPayoutPerShipment = distance * 150;
                        totalRiderPayout += riderPayoutPerShipment;
                    }

                    // 1. PAY VENDOR (85% of subtotal)
                    const updatedVendor = await User.findByIdAndUpdate(
                        shipment.vendor,
                        {
                            $inc: { vendorWalletBalance: vendorEarning },
                            $push: {
                                notifications: {
                                    $each: [{
                                        type: 'delivery_payout',
                                        message: `Payout of ₦${vendorEarning.toFixed(2)} received for completed order ${mainOrder._id}. Platform Fee: ₦${shipment.platformFee.toFixed(2)}.`,
                                        isRead: false,
                                        relatedModel: 'MainOrder',
                                        relatedId: mainOrder._id,
                                    }],
                                    $position: 0,
                                },
                            },
                        },
                        { new: true, session }
                    );

                    // After payment, notify all vendors in the order

                    try {
                        await notificationService.sendToUser(shipment.vendor.toString(), {
                            title: '📦 New Order!',
                            message: `You have a new order from ${buyer.firstName}. Check your vendor dashboard.`,
                            data: {
                                type: 'new_order_vendor',
                                orderId: mainOrder._id,
                                shipmentId: shipment._id
                            }
                        });
                    } catch (vendorNotifError) {
                        console.error(`Failed to notify vendor ${shipment.vendor}:`, vendorNotifError);
                    }

                    // ⬇️ ADD THIS: Update company settlement if order has a company
                    if (mainOrder.company) {
                        await Company.findByIdAndUpdate(
                            mainOrder.company,
                            {
                                $inc: { 
                                    'stats.pendingSettlement': companySettlementPerShipment,
                                    'stats.totalEarnings': companySettlementPerShipment,
                                    'stats.completedDeliveries': 1
                                }
                            },
                            { session }
                        );
                        
                        // Also update shipment with company reference
                        shipment.company = mainOrder.company;
                        await shipment.save({ session });
                        
                        // Create CompanyDelivery record
                        const CompanyDelivery = mongoose.model('CompanyDelivery');
                        const companyDelivery = new CompanyDelivery({
                            company: mainOrder.company,
                            mainOrder: mainOrder._id,
                            shipment: shipment._id,
                            rider: mainOrder.rider,
                            customer: {
                                name: `${mainOrder.user.firstName} ${mainOrder.user.lastName}`,
                                phoneNumber: mainOrder.user.phoneNumber,
                                address: mainOrder.shippingAddress.address
                            },
                            amount: companySettlementPerShipment,
                            companyEarnings: companySettlementPerShipment,
                            status: 'delivered',
                            settlementStatus: 'unpaid'
                        });
                        await companyDelivery.save({ session });
                    }

                    // 2. Store payout details
                    payoutDetails.push({
                        vendorId: shipment.vendor,
                        vendorName: updatedVendor?.businessName || 'Unknown Vendor',
                        vendorPayout: vendorEarning,
                        shipmentId: shipment._id,
                        distance: calculateDistance(
                            shipment.vendorLocation.latitude,
                            shipment.vendorLocation.longitude,
                            mainOrder.userLocation.latitude,
                            mainOrder.userLocation.longitude
                        ),
                        riderPayout: riderPayoutPerShipment,
                        companySettlement: companySettlementPerShipment // ⬅️ ADD THIS
                    });

                    // Auto-update each shipment to delivered if not already
                    if (!shipment.isDelivered) {
                        shipment.shipmentStatus = 'delivered';
                        shipment.isDelivered = true;
                        shipment.deliveredAt = Date.now();
                        await shipment.save({ session });
                    }
                }

                // 3. Update MainOrder with company settlement data
                mainOrder.companySettlementEarnings = totalCompanySettlement; // ⬅️ ADD THIS
                mainOrder.companySettlementStatus = 'unpaid'; // ⬅️ ADD THIS

                // 4. PAY RIDER (150 per km across all shipments) - SIMULTANEOUS WITH VENDORS
                if (mainOrder.rider && totalRiderPayout > 0) {
                    await Rider.findByIdAndUpdate(
                        mainOrder.rider,
                        { 
                            $inc: { 
                                walletBalance: totalRiderPayout, 
                                totalEarnings: totalRiderPayout,
                                completedDeliveries: 1 
                            },
                            $push: {
                                notifications: {
                                    type: 'delivery_payout',
                                    message: `₦${totalRiderPayout.toFixed(2)} credited for completing order ${mainOrder._id}.`,
                                    isRead: false,
                                    relatedModel: 'MainOrder',
                                    relatedId: mainOrder._id,
                                }
                            }
                        },
                        { session }
                    );
                } else {
                    console.warn(`No rider assigned for completed order ${MAIN_ORDER_ID} - skipping rider credit`);
                }

                // 5. Update order with payout details
                mainOrder.payoutDetails = {
                    totalVendorPayout,
                    totalRiderPayout,
                    totalCompanySettlement, // ⬅️ ADD THIS
                    payoutDate: Date.now(),
                    details: payoutDetails
                };

                // Log the payout for admin
                console.log(`✅ Order ${MAIN_ORDER_ID} completed. Total payouts: 
                  - Vendors: ₦${totalVendorPayout.toFixed(2)} 
                  - Rider: ₦${totalRiderPayout.toFixed(2)}
                  - Company Settlement: ₦${totalCompanySettlement.toFixed(2)}`);

                // Emit socket notification about completed payout
                const io = req.app.get('io');
                if (io) {
                    io.emit('order_payout_completed', {
                        orderId: MAIN_ORDER_ID,
                        totalVendorPayout,
                        totalRiderPayout,
                        totalCompanySettlement, // ⬅️ ADD THIS
                        payoutDetails,
                        timestamp: Date.now()
                    });
                }

            } else {
                console.warn(`Order ${MAIN_ORDER_ID} marked as completed but not paid - skipping payouts`);
            }
        }

        const updatedMainOrder = await mainOrder.save({ session });
        await session.commitTransaction();
        session.endSession();

        res.json({ 
            message: `Main Order ${MAIN_ORDER_ID} status updated to ${status}.${status === 'completed' ? ' Vendors and rider paid simultaneously.' : ''}`, 
            order: updatedMainOrder,
            ...(status === 'completed' && mainOrder.isPaid ? {
                payoutSummary: {
                    totalVendorPayout: mainOrder.payoutDetails?.totalVendorPayout || 0,
                    totalRiderPayout: mainOrder.payoutDetails?.totalRiderPayout || 0,
                    totalCompanySettlement: mainOrder.payoutDetails?.totalCompanySettlement || 0, // ⬅️ ADD THIS
                    payoutDate: mainOrder.payoutDetails?.payoutDate
                }
            } : {})
        });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error updating main order status:', error);
        res.status(500).json({ message: 'Server Error during main order status update.', error: error.message });
    }


    // Send notification based on status
    try {
        let title, message;
        
        switch(status) {
            case 'processing':
                title = 'Order Processing';
                message = `Order #${MAIN_ORDER_ID} is now being processed by our vendors.`;
                break;
            case 'shipped':
                title = 'Order Shipped!';
                message = `Your order #${MAIN_ORDER_ID} has been shipped. Track your delivery in the app.`;
                break;
            case 'delivered':
                title = 'Order Delivered!';
                message = `Your order #${MAIN_ORDER_ID} has been delivered. Please confirm receipt.`;
                break;
            case 'completed':
                title = 'Order Completed';
                message = `Order #${MAIN_ORDER_ID} is complete. Thank you for shopping with Naijago!`;
                break;
        }

        if (title && message) {
            await notificationService.sendToUser(mainOrder.user.toString(), {
                title,
                message,
                data: {
                    type: 'order_update',
                    orderId: MAIN_ORDER_ID,
                    status: status
                }
            });
        }
    } catch (notifError) {
        console.error('Status update notification failed:', notifError);
    }
});

// @desc    Get single order by ID
// @route   GET /api/orders/:id
// @access  Private
router.get('/:id', protect, async (req, res) => {
    try {
        const order = await MainOrder.findById(req.params.id)
            .populate('user', 'firstName lastName email phoneNumber')
            .populate('rider', 'fullName phoneNumber plateNumber')
            .populate({
                path: 'shipments',
                populate: [
                    { path: 'vendor', select: 'businessName phoneNumber' },
                    { path: 'items.product', select: 'name imageUrls price stockQuantity' }
                ]
            });

        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        const isOwner = order.user.toString() === req.user.id.toString();
        const isAdmin = req.user.isAdmin;
        const isDispatchRider = req.user.role === 'dispatch';
        const isVendor = order.shipments?.some(shipment =>
            shipment.vendor && shipment.vendor._id.toString() === req.user.id.toString()
        );

        if (!isOwner && !isAdmin && !isDispatchRider && !isVendor) {
            return res.status(401).json({ message: 'Not authorized to view this order' });
        }
        
        res.json(order);
    } catch (error) {
        console.error('Error fetching single order:', error);
        if (error.kind === 'ObjectId') {
            return res.status(400).json({ message: 'Invalid Order ID format' });
        }
        res.status(500).json({ message: 'Server Error' });
    }
});


// @desc    All orders for Admin
// @route   GET /api/orders/admin
// @access  Private/Admin
router.get('/admin', protect, authorizeRoles('admin'), async (req, res) => {
    try {
        const orders = await MainOrder.find({})
            .populate('user', 'firstName lastName email phoneNumber')
            .populate('rider', 'fullName phoneNumber plateNumber')
            .populate({
                path: 'shipments',
                populate: [
                    { path: 'vendor', select: 'businessName phoneNumber' },
                    { path: 'items.product', select: 'name imageUrls price stockQuantity' }
                ]
            })
            .sort({ createdAt: -1 });

        res.json(orders);
    } catch (error) {
        console.error('Error fetching all orders for admin:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});


module.exports = router;




















// const express = require('express');
// const mongoose = require('mongoose');
// const router = express.Router();
// const MainOrder = require('../models/MainOrder');
// const Shipment = require('../models/Shipment');
// const Product = require('../models/Product');
// const User = require('../models/User');
// const Rider = require('../models/Rider');
// const { protect, authorizeRoles } = require('../middleware/authMiddleware');
// const axios = require("axios");


// // Category-based commission rates
// const CATEGORY_COMMISSION_RATES = {
//     // HIGH COMMISSION CATEGORIES (15%) - Luxury/High-margin items
//     'high': {
//         rate: 0.15,
//         categories: [
//             // Luxury Fashion
//             'Fashion > Men\'s Fashion',
//             'Fashion > Women\'s Fashion',
//             'Fashion > Watches',
//             'Fashion > Jewelry',
//             'Fashion > Eyewear',
            
//             // Electronics & Tech
//             'Electronics > Televisions & Video',
//             'Electronics > Camera & Photo',
//             'Electronics > Gadgets',
//             'Electronics > Drones',
//             'Electronics > Smart Home Devices',
//             'Computing > Computers',
            
//             // Luxury Items
//             'Home & Office > Furniture',
//             'Home & Office > Appliances',
//             'Home & Office > Lighting',
//             'Home & Office > Home Security',
            
//             // Health & Beauty Luxury
//             'Health & Beauty > Make Up',
//             'Health & Beauty > Fragrance',
//             'Health & Beauty > Skin Care & Cosmetics',
            
//             // Automotive
//             'Automobiles > Performance Parts',
            
//             // Gaming
//             'Gaming > Play Station',
//             'Gaming > Xbox',
//             'Gaming > Nintendo',
//             'Gaming > PC Gaming',
//             'Gaming > VR Headsets',
            
//             // Sporting Goods (High-end)
//             'Sporting Goods > Cardio Training',
//             'Sporting Goods > Strength & Training Equipment',
            
//             // Musical Instruments
//             'Music & Instruments > Guitars',
//             'Music & Instruments > Keyboards & Pianos',
//             'Music & Instruments > Audio Equipment',
            
//             // Photography
//             'Photography > Cameras',
//             'Photography > Lenses',
//         ]
//     },
    
//     // MEDIUM COMMISSION CATEGORIES (12.5%) - Mid-range items
//     'medium': {
//         rate: 0.125,
//         categories: [
//             // Fashion (non-luxury)
//             'Fashion > Kids\' Fashion',
//             'Fashion > Luggages & Travel Gear',
//             'Fashion > Hair & Wigs',
//             'Fashion > Footwear',
//             'Fashion > Bags & Purses',
//             'Fashion > Belts & Accessories',
//             'Fashion > Traditional Attire',
//             'Fashion > Underwear & Lingerie',
//             'Fashion > Sportswear',
            
//             // Electronics (mid-range)
//             'Electronics > Audios',
//             'Electronics > Home Theater Systems',
//             'Electronics > Headphones & Earbuds',
//             'Electronics > Car Electronics',
//             'Electronics > Batteries & Power',
//             'Computing > Data Storage',
//             'Computing > Printers & Computer Accessories',
//             'Computing > Keyboards & Mice',
            
//             // Home & Office (mid-range)
//             'Home & Office > Home & Kitchen',
//             'Home & Office > Home Interior & Exterior',
//             'Home & Office > Office Products',
//             'Home & Office > Cleaning Supplies',
//             'Home & Office > Storage & Organization',
//             'Home & Office > Garden & Outdoor',
//             'Home & Office > Bedding & Bath',
            
//             // Health & Beauty (mid-range)
//             'Health & Beauty > Hair Care',
//             'Health & Beauty > Oral Care',
//             'Health & Beauty > Personal Care',
//             'Health & Beauty > Shaving & Hair Removal',
//             'Health & Beauty > Vitamins & Supplements',
            
//             // Baby Products
//             'Baby Products > Apparels & Accessories',
//             'Baby Products > Diapering',
//             'Baby Products > Feeding',
//             'Baby Products > Baby Toddlers Toys',
//             'Baby Products > Gears',
//             'Baby Products > Bathing & Skin Care',
//             'Baby Products > Potty Training',
//             'Baby Products > Safety',
//             'Baby Products > Nursery Furniture',
//             'Baby Products > Strollers & Prams',
//             'Baby Products > Car Seats',
//             'Baby Products > Educational Toys',
            
//             // Books & Stationery
//             'Books & Stationery > Fiction Books',
//             'Books & Stationery > Comics',
//             'Books & Stationery > Technology',
//             'Books & Stationery > Business',
//             'Books & Stationery > Story',
//             'Books & Stationery > Religious',
//             'Books & Stationery > Non-Fiction',
//             'Books & Stationery > Academic Textbooks',
//             'Books & Stationery > Children Books',
//             'Books & Stationery > Magazines',
//             'Books & Stationery > Writing Instruments',
//             'Books & Stationery > Office Supplies',
//             'Books & Stationery > Art Supplies',
//             'Books & Stationery > Calendars & Planners',
//         ]
//     },
    
//     // LOW COMMISSION CATEGORIES (10%) - Low-margin/essential items
//     'low': {
//         rate: 0.10,
//         categories: [
//             // Groceries & Essentials
//             'Groceries > Beer, Wine & Spirits',
//             'Groceries > Food Cupboard',
//             'Groceries > House Hold Cleaning',
//             'Groceries > Fresh Produce',
//             'Groceries > Dairy & Eggs',
//             'Groceries > Seafood',
            
//             // Health & Medicine
//             'Health & Beauty > Medicine',
//             'Health & Beauty > Condoms',
//             'Health & Beauty > Sex Toys',
//             'Health & Beauty > First Aid',
//             'Health & Beauty > Medical Equipment',
//             'Health & Beauty > Feminine Care',
            
//             // Automotive Essentials
//             'Automobiles > Car Care',
//             'Automobiles > Car Exterior and Interior Accessories',
//             'Automobiles > Tools & Equipment',
//             'Automobiles > Oils & Fluids',
//             'Automobiles > Car Safety',
            
//             // Animal Products
//             'Animal Products > Chicken Feeds',
//             'Animal Products > Dog Feeds',
//             'Animal Products > Cat Feeds',
//             'Animal Products > Fish Feeds',
//             'Animal Products > Pig Feeds',
//             'Animal Products > Pet Accessories',
//             'Animal Products > Pet Health & Care',
//             'Animal Products > Pet Toys',
//             'Animal Products > Pet Clothing',
//             'Animal Products > Pet Grooming',
//             'Animal Products > Aquarium Supplies',
//             'Animal Products > Bird Supplies',
            
//             // Building & Construction
//             'Building & Construction > Building Materials',
//             'Building & Construction > Electrical',
//             'Building & Construction > Plumbing',
//             'Building & Construction > Tools & Machinery',
//             'Building & Construction > Safety Equipment',
//             'Building & Construction > Paints & Coatings',
//             'Building & Construction > Hardware',
            
//             // Industrial & Scientific
//             'Industrial & Scientific > Lab Equipment',
//             'Industrial & Scientific > Packaging & Shipping',
//             'Industrial & Scientific > Janitorial & Sanitation',
            
//             // Agriculture
//             'Agriculture > Fertilizers',
//             'Agriculture > Pesticides',
            
//             // Toys & Games (non-electronic)
//             'Toys & Games > Dolls',
//             'Toys & Games > Educational Toys',
//             'Toys & Games > Outdoor Toys',
//             'Toys & Games > Remote Control Toys',
//             'Toys & Games > Stuffed Animals',
//             'Toys & Games > Toy Vehicles',
            
//             // Arts & Crafts
//             'Arts & Crafts > Painting',
//             'Arts & Crafts > Beading & Jewelry Making',
//             'Arts & Crafts > Clay & Pottery',
            
//             // Food & Beverage Equipment
//             'Food & Beverage > Restaurant Equipment',
//             'Food & Beverage > Catering Supplies',
//             'Food & Beverage > Baking Supplies',
//             'Food & Beverage > Food Processing',
//             'Food & Beverage > Beverage Equipment',
//             'Food & Beverage > Kitchen Utensils',
//             'Food & Beverage > Food Packaging',
            
//             // Travel & Tourism
//             'Travel & Tourism > Travel Accessories',
//             'Travel & Tourism > Luggage',
//             'Travel & Tourism > Hotel Supplies',
            
//             // Wedding & Events
//             'Wedding & Events > Wedding Attire',
//         ]
//     }
// };

// // Helper function to get commission rate based on category
// function getCommissionRateForCategory(category) {
//     // Check each commission tier
//     for (const [tier, data] of Object.entries(CATEGORY_COMMISSION_RATES)) {
//         if (data.categories.includes(category)) {
//             return data.rate;
//         }
//     }
    
//     // Default rate if category not found
//     return 0.125; // 12.5% default
// }

// // 👇 START OF ADDITIONS 1: Distance Calculation Utility (KEEPING THIS)
// /**
//  * Calculates the distance between two geographical coordinates using the Haversine formula.
//  * @param {number} lat1 Latitude of point 1
//  * @param {number} lon1 Longitude of point 1
//  * @param {number} lat2 Latitude of point 2
//  * @param {number} lon2 Longitude of point 2
//  * @returns {number} Distance in Kilometers
//  */
// function calculateDistance(lat1, lon1, lat2, lon2) {
//   const R = 6371; // Radius of the Earth in kilometers
//   const dLat = (lat2 - lat1) * (Math.PI / 180);
//   const dLon = (lon2 - lon1) * (Math.PI / 180);
//   const a =
//     Math.sin(dLat / 2) * Math.sin(dLat / 2) +
//     Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
//     Math.sin(dLon / 2) * Math.sin(dLon / 2);
//   const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
//   const distance = R * c; // Distance in km
//   return parseFloat(distance.toFixed(2)); // Round to 2 decimal places
// }
// // 👆 END OF ADDITIONS 1

// // --- Helper Function: Shipping Cost (Based on your N100/km rule) ---
// const calculateShippingCost = (distanceKm, city) => {
//     const ratePerKm = 200;
//     let shippingPrice = distanceKm * ratePerKm;
    
//     // Minimum flat fee as a business rule
//     if (shippingPrice < 1000) {
//         shippingPrice = 1000.00; 
//     }
    
//     return parseFloat(shippingPrice.toFixed(2));
// };
// // ------------------------------------------------------------------

// // @desc    Get all orders (Admin access only)
// // @route   GET /api/orders
// // @access  Private/Admin
// router.get('/', protect, async (req, res) => {
//   try {
//       // Find MainOrder documents and populate the linked shipments
//       const orders = await MainOrder.find({}) 
//         .populate('user', 'firstName lastName email phoneNumber') 
//         .populate({
//             path: 'shipments',
//             populate: {
//                 path: 'vendor', // Populate vendor details within each shipment
//                 select: 'businessName phoneNumber businessLocation'
//             }
//         })
//         .sort({ createdAt: -1 });

//       res.status(200).json(orders);
//   } catch (error) {
//       console.error('Error fetching all orders:', error);
//       res.status(500).json({ message: 'Error fetching all orders.', error: error.message });
//   }
// });

// // ---
// // ## Price Calculation Route

// // @desc    Calculate total price, split by vendor, and return summary
// // @route   POST /api/orders/calculate_summary
// // @access  Private

// // @desc    Calculate total price, split by vendor, and return summary
// // @route   POST /api/orders/calculate_summary
// // @access  Private
// router.post('/summary', protect, async (req, res) => {
//     const { cartItems, shippingAddress, userLocation } = req.body;

//     if (!cartItems || cartItems.length === 0) {
//         return res.status(400).json({ message: 'No items in cart for summary calculation' });
//     }
//     if (!shippingAddress || !userLocation) {
//         return res.status(400).json({ message: 'Shipping address and location are required' });
//     }
    
//     try {
//         const vendorCartMap = new Map();
//         let totalSubtotal = 0;
//         let totalPlatformFees = 0;

//         // 1. Group items by vendor and calculate subtotal for each vendor
//         for (const item of cartItems) {
//             // Fetch product, vendor, and category data
//             const [product, vendorUser] = await Promise.all([
//                 Product.findById(item.product, 'price imageUrls vendor category'),
//                 User.findById(item.vendor, 'businessName businessLocation')
//             ]);
            
//             if (!product) {
//                 return res.status(404).json({ message: `Product not found: ${item.name}` });
//             }
            
//             const vendorId = product.vendor.toString(); 

//             if (!vendorUser || !vendorUser.businessLocation) {
//                  return res.status(404).json({ message: `Vendor or location not found for product: ${item.name}` });
//             }

//             const itemPrice = product.price * item.quantity;
//             totalSubtotal += itemPrice;

//             // Get category-based commission rate
//             const productCategory = product.category || 'Uncategorized';
//             const commissionRate = getCommissionRateForCategory(productCategory);
//             const itemCommission = itemPrice * commissionRate;
//             totalPlatformFees += itemCommission;

//             if (!vendorCartMap.has(vendorId)) {
//                 vendorCartMap.set(vendorId, {
//                     vendorId: vendorId,
//                     vendorName: vendorUser.businessName,
//                     vendorLocation: vendorUser.businessLocation,
//                     items: [],
//                     subtotal: 0,
//                     platformFee: 0,
//                     commissionRate: 0,
//                 });
//             }
            
//             const vendorData = vendorCartMap.get(vendorId);
//             vendorData.items.push({
//                 product: item.product,
//                 name: item.name,
//                 image: product.imageUrls[0],
//                 quantity: item.quantity,
//                 price: product.price,
//                 selectedSize: item.selectedSize || null,
//                 category: productCategory, // Store category for reference
//                 commissionRate: commissionRate, // Store individual commission rate
//                 itemCommission: itemCommission, // Store calculated commission
//             });
            
//             vendorData.subtotal += itemPrice;
//             vendorData.platformFee += itemCommission;
//             // Store the average commission rate for this vendor's shipment
//             vendorData.commissionRate = vendorData.platformFee / vendorData.subtotal;
//         }

//         // 2. Calculate fees for each shipment
//         const shipmentSummaries = [];
//         let totalShippingPrice = 0;

//         for (const data of vendorCartMap.values()) {
//             const vendorLocation = data.vendorLocation;
            
//             // Calculate Distance (Haversine)
//             const distanceKm = calculateDistance(
//                 vendorLocation.latitude,
//                 vendorLocation.longitude,
//                 userLocation.latitude,
//                 userLocation.longitude
//             );
            
//             // Calculate Shipping Price
//             const shippingPrice = calculateShippingCost(distanceKm, shippingAddress.city);
            
//             totalShippingPrice += shippingPrice;

//             shipmentSummaries.push({
//                 vendorId: data.vendorId,
//                 vendorName: data.vendorName,
//                 vendorLocation: vendorLocation, 
//                 subtotal: parseFloat(data.subtotal.toFixed(2)),
//                 shippingPrice: shippingPrice,
//                 platformFee: parseFloat(data.platformFee.toFixed(2)),
//                 commissionRate: parseFloat(data.commissionRate.toFixed(3)),
//                 // Total cost for the items and delivery from this specific vendor
//                 totalShipmentCost: parseFloat((data.subtotal + shippingPrice).toFixed(2)), 
//                 items: data.items,
//                 commissionBreakdown: {
//                     rate: data.commissionRate,
//                     amount: data.platformFee,
//                     description: `Commission applied based on product categories`
//                 }
//             });
//         }
        
//         const totalPrice = totalSubtotal + totalShippingPrice + (req.body.taxPrice || 0.0);

//         // 3. Prepare commission breakdown for response
//         const commissionBreakdown = {};
//         cartItems.forEach(item => {
//             // Calculate commission per item for transparency
//             // (You might want to fetch the product again or store commission in vendorCartMap)
//         });

//         // 4. Respond to Flutter
//         res.json({
//             totalSubtotal: parseFloat(totalSubtotal.toFixed(2)),
//             totalShippingPrice: parseFloat(totalShippingPrice.toFixed(2)),
//             totalPlatformFees: parseFloat(totalPlatformFees.toFixed(2)),
//             totalPrice: parseFloat(totalPrice.toFixed(2)),
//             taxPrice: req.body.taxPrice || 0.0,
//             shipmentSummaries,
//             userLocation, 
//             shippingAddress,
//             commissionSummary: {
//                 totalCommission: parseFloat(totalPlatformFees.toFixed(2)),
//                 averageRate: parseFloat((totalPlatformFees / totalSubtotal).toFixed(3)),
//                 note: 'Commission rates vary by product category (10-15%)'
//             }
//         });

//     } catch (error) {
//         console.error('Error calculating order summary:', error);
//         res.status(500).json({ message: 'Error calculating order summary.', error: error.message });
//     }
// });
// // router.post('/summary', protect, async (req, res) => {
// //     const { cartItems, shippingAddress, userLocation } = req.body;
// //     const PLATFORM_COMMISSION_RATE = 0.15; // 15% rate

// //     if (!cartItems || cartItems.length === 0) {
// //         return res.status(400).json({ message: 'No items in cart for summary calculation' });
// //     }
// //     if (!shippingAddress || !userLocation) {
// //         return res.status(400).json({ message: 'Shipping address and location are required' });
// //     }
    
// //     try {
// //         const vendorCartMap = new Map();
// //         let totalSubtotal = 0;

// //         // 1. Group items by vendor and calculate subtotal for each vendor
// //         for (const item of cartItems) {
// //             // Fetch product and vendor data in parallel for efficiency
// //             const [product, vendorUser] = await Promise.all([
// //                 Product.findById(item.product, 'price imageUrls vendor'),
// //                 User.findById(item.vendor, 'businessName businessLocation')
// //             ]);
            
// //             if (!product) {
// //                 return res.status(404).json({ message: `Product not found: ${item.name}` });
// //             }
// //             // Use the vendor ID from the Product schema for consistency
// //             const vendorId = product.vendor.toString(); 

// //             if (!vendorUser || !vendorUser.businessLocation) {
// //                  return res.status(404).json({ message: `Vendor or location not found for product: ${item.name}` });
// //             }

// //             const itemPrice = product.price * item.quantity;
// //             totalSubtotal += itemPrice;

// //             if (!vendorCartMap.has(vendorId)) {
// //                 vendorCartMap.set(vendorId, {
// //                     vendorId: vendorId,
// //                     vendorName: vendorUser.businessName,
// //                     vendorLocation: vendorUser.businessLocation,
// //                     items: [],
// //                     subtotal: 0,
// //                 });
// //             }
            
// //             // vendorCartMap.get(vendorId).items.push({
// //             //     product: item.product,
// //             //     name: item.name, // Use name from cart for frontend display
// //             //     image: product.imageUrls[0], // Use product data for image
// //             //     quantity: item.quantity,
// //             //     price: product.price, // Use product data for price verification
// //             // });

// //             vendorCartMap.get(vendorId).items.push({
// //                 product: item.product,
// //                 name: item.name, // Use name from cart for frontend display
// //                 image: product.imageUrls[0], // Use product data for image
// //                 quantity: item.quantity,
// //                 price: product.price, // Use product data for price verification
// //                 selectedSize: item.selectedSize || null, // NEW: Include selected size
// //             });
            
// //             vendorCartMap.get(vendorId).subtotal += itemPrice;
// //         }

// //         // 2. Calculate fees for each shipment
// //         const shipmentSummaries = [];
// //         let totalShippingPrice = 0;
// //         let totalPlatformFees = 0;

// //         for (const data of vendorCartMap.values()) {
// //             const vendorLocation = data.vendorLocation;
            
// //             // Calculate Distance (Haversine)
// //             const distanceKm = calculateDistance(
// //                 vendorLocation.latitude,
// //                 vendorLocation.longitude,
// //                 userLocation.latitude,
// //                 userLocation.longitude
// //             );
            
// //             // Calculate Shipping Price
// //             const shippingPrice = calculateShippingCost(distanceKm, shippingAddress.city);
            
// //             // Calculate Platform Commission
// //             const platformFee = data.subtotal * PLATFORM_COMMISSION_RATE;

// //             totalShippingPrice += shippingPrice;
// //             totalPlatformFees += platformFee;

// //             shipmentSummaries.push({
// //                 vendorId: data.vendorId,
// //                 vendorName: data.vendorName,
// //                 vendorLocation: vendorLocation, 
// //                 subtotal: parseFloat(data.subtotal.toFixed(2)),
// //                 shippingPrice: shippingPrice,
// //                 platformFee: parseFloat(platformFee.toFixed(2)),
// //                 // Total cost for the items and delivery from this specific vendor
// //                 totalShipmentCost: parseFloat((data.subtotal + shippingPrice).toFixed(2)), 
// //                 items: data.items,
// //             });
// //         }
        
// //         const totalPrice = totalSubtotal + totalShippingPrice + (req.body.taxPrice || 0.0);

// //         // 3. Respond to Flutter
// //         res.json({
// //             totalSubtotal: parseFloat(totalSubtotal.toFixed(2)),
// //             totalShippingPrice: parseFloat(totalShippingPrice.toFixed(2)),
// //             totalPlatformFees: parseFloat(totalPlatformFees.toFixed(2)),
// //             totalPrice: parseFloat(totalPrice.toFixed(2)), // User-facing total
// //             taxPrice: req.body.taxPrice || 0.0,
// //             shipmentSummaries, // Detailed breakdown
// //             userLocation, 
// //             shippingAddress,
// //         });

// //     } catch (error) {
// //         console.error('Error calculating order summary:', error);
// //         res.status(500).json({ message: 'Error calculating order summary.', error: error.message });
// //     }
// // });


// // ## Order Creation Route

// // @desc    Create new MainOrder and associated Shipment documents
// // @route   POST /api/orders
// // @access  Private
// router.post('/', protect, async (req, res) => {
//     // ⚠️ We now receive the entire calculated summary from Flutter.
//     const { 
//         shippingAddress, 
//         paymentMethod,
//         totalSubtotal,
//         totalShippingPrice,
//         totalPlatformFees,
//         totalPrice,
//         taxPrice,
//         userLocation,
//         shipmentSummaries, // The calculated breakdown array is VITAL
//     } = req.body;

//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         if (!shipmentSummaries || shipmentSummaries.length === 0) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'No shipment summaries provided. Please calculate summary first.' });
//         }

//         // --- Step 1: Stock Check (Must check stock for ALL items across ALL shipments) ---
//         for (const summary of shipmentSummaries) {
//             for (const item of summary.items) {
//                 const product = await Product.findById(item.product).session(session);
//                 if (!product) {
//                     await session.abortTransaction();
//                     session.endSession();
//                     return res.status(404).json({ message: `Product not found: ${item.name}` });
//                 }
//                 if (product.stockQuantity < item.quantity) {
//                     await session.abortTransaction();
//                     session.endSession();
//                     return res.status(400).json({ message: `Insufficient stock for ${product.name}. Available: ${product.stockQuantity}` });
//                 }
//             }
//         }
        
//         // --- Step 2: Create the MainOrder document (The Receipt) ---
//         const mainOrder = new MainOrder({ // Use MainOrder model
//             user: req.user._id,
//             shippingAddress,
//             userLocation,
//             totalSubtotal,
//             totalPlatformFees,
//             totalShippingPrice,
//             totalTaxPrice: taxPrice || 0.0,
//             totalPrice,
//             paymentMethod,
//             isPaid: false, 
//             mainOrderStatus: 'pending_payment',
//             shipments: [], // Start empty, populate in next step
//         });

//         const createdMainOrder = await mainOrder.save({ session });
        
//         const shipmentIds = [];
        
//         // --- Step 3: Create Shipment documents for each vendor ---
//         for (const summary of shipmentSummaries) {
//             const newShipment = new Shipment({
//                 mainOrder: createdMainOrder._id,
//                 vendor: summary.vendor,
//                 vendorLocation: summary.vendorLocation,
//                 items: summary.items.map(item => ({
//                     product: item.product,
//                     name: item.name,
//                     image: item.image,
//                     quantity: item.quantity,
//                     price: item.price,
//                     selectedSize: item.selectedSize || null,
//                     category: item.category, // Store category
//                     commissionRate: item.commissionRate, // Store individual item commission rate
//                 })),
//                 subtotal: summary.subtotal,
//                 platformFee: summary.platformFee,
//                 shippingPrice: summary.shippingPrice,
//                 commissionRate: summary.commissionRate, // Store average commission rate for this shipment
//                 shipmentStatus: 'processing',
//                 isDelivered: false,
//             });

//             const createdShipment = await newShipment.save({ session });
//             shipmentIds.push(createdShipment._id);
//         }
//         // for (const summary of shipmentSummaries) {
//         //     console.log("Incoming Shipment Summary for debugging:", summary);
//         //     const newShipment = new Shipment({
//         //         mainOrder: createdMainOrder._id, // Link back to MainOrder
//         //         vendor: summary.vendor,
//         //         vendorLocation: summary.vendorLocation, 
//         //         // items: summary.items.map(item => ({ // Ensure item structure is correct for Shipment model
//         //         //     product: item.product,
//         //         //     name: item.name,
//         //         //     image: item.image,
//         //         //     quantity: item.quantity,
//         //         //     price: item.price,
//         //         // })),

//         //         items: summary.items.map(item => ({
//         //         product: item.product,
//         //         name: item.name,
//         //         image: item.image,
//         //         quantity: item.quantity,
//         //         price: item.price,
//         //         selectedSize: item.selectedSize || null, // NEW: Pass through selected size
//         //     })),
//         //         subtotal: summary.subtotal,
//         //         platformFee: summary.platformFee,
//         //         shippingPrice: summary.shippingPrice,
                
//         //         shipmentStatus: 'processing', // Use this status until payment is confirmed
//         //         isDelivered: false,
//         //     });

//         //     const createdShipment = await newShipment.save({ session });
//         //     shipmentIds.push(createdShipment._id);
//         // }
        
//         // --- Step 4: Link Shipments back to the MainOrder ---
//         createdMainOrder.shipments = shipmentIds;
//         await createdMainOrder.save({ session });

//         await session.commitTransaction();
//         session.endSession();

//         // Return the MainOrder (with populated shipment IDs)
//         res.status(201).json(createdMainOrder);

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error creating multi-vendor order:', error);
//         res.status(500).json({ message: 'Server Error during order creation.', error: error.message });
//     }
// });

// // ---

// // ## Status Update, User, and Vendor Routes

// // @desc    Update pending orders to processing after some time delay / server check
// // @route   POST /api/orders/update-pending-to-processing
// // @access  Private (called by client's polling timer)
// router.post('/update-pending-to-processing', protect, async (req, res) => {
//     try {
//         // Logic now uses MainOrder and updates associated Shipments
//         const mainOrdersResult = await MainOrder.updateMany(
//             { 
//                 mainOrderStatus: 'pending_payment', 
//                 isPaid: true 
//             },
//             { $set: { mainOrderStatus: 'processing' } }
//         );

//         // This route is deprecated by the immediate update in the payment routes, but kept for legacy/polling cleanup.
//         // It should update all associated Shipments to 'processing' as well.
//         const ordersToUpdate = await MainOrder.find({ mainOrderStatus: 'processing', isPaid: true, shipments: { $ne: [] } }).select('shipments');
//         const shipmentIds = ordersToUpdate.flatMap(order => order.shipments);

//         const shipmentsResult = await Shipment.updateMany(
//             { _id: { $in: shipmentIds }, shipmentStatus: 'awaiting_payment' },
//             { $set: { shipmentStatus: 'processing' } }
//         );

//         res.json({ 
//             message: `Successfully updated ${mainOrdersResult.modifiedCount} paid main orders to 'processing' and ${shipmentsResult.modifiedCount} shipments.`,
//             count: mainOrdersResult.modifiedCount 
//         });
//     } catch (error) {
//         console.error('Error updating pending orders:', error);
//         res.status(500).json({ message: 'Server Error during pending order update' });
//     }
// });


// // @desc    Get logged in user's orders (Now fetching MainOrders)
// // @route   GET /api/orders/my
// // @access  Private
// // router.get('/my', protect, async (req, res) => {
// //     try {
// //         // Fetch MainOrder and populate linked Shipments
// //         const orders = await MainOrder.find({ user: req.user.id })
// //             .populate({
// //                 path: 'shipments',
// //                 populate: [
// //                     { path: 'vendor', select: 'businessName' },
// //                     { path: 'items.product', select: 'name imageUrls price' }
// //                 ]
// //             })
// //             .sort({ createdAt: -1 });
// //         res.json(orders);
// //     } catch (error) {
// //         console.error('Error fetching user orders:', error);
// //         res.status(500).json({ message: 'Server Error' });
// //     }
// // });

// router.get('/my', protect, async (req, res) => {
//     try {
//         // Fetch MainOrder and populate linked Shipments
//         const orders = await MainOrder.find({ user: req.user.id })
//             .populate({
//                 path: 'shipments',
//                 populate: [
//                     { 
//                         path: 'vendor', 
//                         select: 'businessName businessLocation' 
//                     },
//                     { 
//                         path: 'items.product', 
//                         select: 'name imageUrls price category' 
//                     }
//                 ]
//             })
//             .sort({ createdAt: -1 });
        
//         // Add logging for debugging
//         console.log(`User ${req.user.id} fetched ${orders.length} orders`);
//         if (orders.length > 0 && orders[0].shipments && orders[0].shipments.length > 0) {
//             const firstShipment = orders[0].shipments[0];
//             if (firstShipment.items && firstShipment.items.length > 0) {
//                 console.log('First item in user order:', JSON.stringify(firstShipment.items[0], null, 2));
//             }
//         }
        
//         res.json(orders);
//     } catch (error) {
//         console.error('Error fetching user orders:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });




// // @desc    Update MainOrder status (Admin only)
// // @route   PUT /api/orders/:id/status
// // @access  Private/Admin
// router.put('/:id/status', protect, authorizeRoles('admin'), async (req, res) => {
//     const { status } = req.body;
//     const MAIN_ORDER_ID = req.params.id;

//     // 1. Basic validation: MUST match the Mongoose model's enum
//     const validStatuses = [
//         'pending_payment', 
//         'processing', 
//         'partially_shipped', 
//         'shipped', 
//         'delivered', 
//         'completed',
//         'cancelled'
//     ];

//     if (!validStatuses.includes(status)) {
//         return res.status(400).json({ message: `Invalid main order status: ${status}. Must be one of: ${validStatuses.join(', ')}` });
//     }

//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         const mainOrder = await MainOrder.findById(MAIN_ORDER_ID).session(session);

//         if (!mainOrder) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(404).json({ message: 'Main Order not found.' });
//         }

//         // 2. Update the status
//         mainOrder.mainOrderStatus = status;

//         if (status === 'delivered') {
//             mainOrder.isDelivered = true;
//             mainOrder.deliveredAt = Date.now();
//             mainOrder.shipmentStatus = 'delivered'; // Update shipmentStatus on MainOrder

//             // Credit logic only if order is paid
//             if (mainOrder.isPaid) {
//                 // Fetch all shipments for this order
//                 const shipments = await Shipment.find({ mainOrder: MAIN_ORDER_ID }).session(session);

//                 let totalRiderEarning = 0;

//                 for (const shipment of shipments) {
//                     // Vendor crediting per shipment
//                     const revenue = shipment.subtotal;
//                     const commission = shipment.platformFee;
//                     const vendorEarning = revenue - commission;

//                     await User.findByIdAndUpdate(
//                         shipment.vendor,
//                         {
//                             $inc: { vendorWalletBalance: vendorEarning },
//                             $push: {
//                                 notifications: {
//                                     $each: [{
//                                         type: 'delivery_payout',
//                                         message: `Payout of ₦${vendorEarning.toFixed(2)} received for delivered shipment ${shipment._id}. Platform Fee: ₦${commission.toFixed(2)}.`,
//                                         isRead: false,
//                                         relatedModel: 'Shipment',
//                                         relatedId: shipment._id,
//                                     }],
//                                     $position: 0,
//                                 },
//                             },
//                         },
//                         { new: true, session }
//                     );

//                     // Recalculate distance for rider earning
//                     const distanceKm = calculateDistance(
//                         shipment.vendorLocation.latitude,
//                         shipment.vendorLocation.longitude,
//                         mainOrder.userLocation.latitude,
//                         mainOrder.userLocation.longitude
//                     );

//                     // Rider gets 150/km
//                     const riderEarningPerShipment = distanceKm * 150;
//                     totalRiderEarning += riderEarningPerShipment;

//                     // Update shipment status
//                     shipment.shipmentStatus = 'delivered';
//                     shipment.isDelivered = true;
//                     shipment.deliveredAt = Date.now();
//                     await shipment.save({ session });
//                 }

//                 // Credit rider's wallet with total earning
//                 if (mainOrder.rider) {
//                     await Rider.findByIdAndUpdate(
//                         mainOrder.rider,
//                         { $inc: { walletBalance: totalRiderEarning, totalEarnings: totalRiderEarning } },
//                         { session }
//                     );
//                 }
//             }
//         }

//         const updatedMainOrder = await mainOrder.save({ session });
//         await session.commitTransaction();
//         session.endSession();

//         res.json({ 
//             message: `Main Order ${MAIN_ORDER_ID} status updated to ${status}.`, 
//             order: updatedMainOrder 
//         });

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error updating main order status:', error);
//         res.status(500).json({ message: 'Server Error during main order status update.', error: error.message });
//     }
// });



// // @desc    Get vendor-specific shipments (REPLACED monolithic order view with Shipments)
// // @route   GET /api/orders/vendor
// // @access  Private/Vendor


// // router.get('/vendor', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
// //     try {
// //         // Vendors now only care about their Shipments, not the entire MainOrder
// //         const shipments = await Shipment.find({ vendor: req.user.id })
// //             .populate('mainOrder', 'shippingAddress userLocation totalPrice paymentMethod') // Link to the main order info
// //             .populate('vendor', 'businessName')
// //             .populate('items.product', 'name imageUrls price stockQuantity')
// //             .sort({ createdAt: -1 });
        
// //         // Since we are finding by vendor ID, no need for the complex map filtering.
// //         res.json(shipments);
// //     } catch (error) {
// //         console.error('Error fetching vendor orders:', error);
// //         res.status(500).json({ message: 'Server Error' });
// //     }
// // });


// router.get('/vendor', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
//     try {
//         // Vendors now only care about their Shipments, not the entire MainOrder
//         const shipments = await Shipment.find({ vendor: req.user.id })
//             .populate({
//                 path: 'mainOrder',
//                 select: 'shippingAddress userLocation totalPrice paymentMethod createdAt',
//                 populate: {
//                     path: 'user',
//                     select: 'firstName lastName email phoneNumber'
//                 }
//             })
//             .populate('vendor', 'businessName phoneNumber')
//             .populate('items.product', 'name imageUrls price stockQuantity category')
//             .sort({ createdAt: -1 });
        
//         // Add logging to debug
//         console.log(`Vendor ${req.user.id} fetched ${shipments.length} shipments`);
//         if (shipments.length > 0 && shipments[0].items.length > 0) {
//             console.log('First item in first shipment:', JSON.stringify(shipments[0].items[0], null, 2));
//         }
        
//         res.json(shipments);
//     } catch (error) {
//         console.error('Error fetching vendor orders:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });


//     // @desc    Get commission rates for different categories
//     // @route   GET /api/orders/commission-rates
//     // @access  Public
//     router.get('/commission-rates', async (req, res) => {
//         try {
//             const commissionStructure = {};
            
//             // Transform the CATEGORY_COMMISSION_RATES for easier consumption
//             for (const [tier, data] of Object.entries(CATEGORY_COMMISSION_RATES)) {
//                 commissionStructure[tier] = {
//                     rate: data.rate * 100, // Convert to percentage
//                     rateDecimal: data.rate,
//                     description: getTierDescription(tier),
//                     exampleCategories: data.categories.slice(0, 5) // Show first 5 examples
//                 };
//             }
            
//             res.json({
//                 success: true,
//                 commissionStructure,
//                 note: 'Commission rates are applied per product based on category',
//                 defaultRate: 0.125 // Default if category not found
//             });
//         } catch (error) {
//             console.error('Error fetching commission rates:', error);
//             res.status(500).json({ 
//                 success: false, 
//                 message: 'Error fetching commission rates', 
//                 error: error.message 
//             });
//         }
//     });

//     // Helper function for tier descriptions
//     function getTierDescription(tier) {
//         switch(tier) {
//             case 'high':
//                 return 'Luxury & High-margin items (Electronics, Luxury Fashion, etc.)';
//             case 'medium':
//                 return 'Mid-range items (Regular Fashion, Home Goods, etc.)';
//             case 'low':
//                 return 'Essentials & Low-margin items (Groceries, Medicine, Animal Feed, etc.)';
//             default:
//                 return 'Standard items';
//         }
//     }


// // ## Wallet Payment Route (Escrow)

// // @desc     Update MainOrder/Shipments to paid + Debit User Wallet (NO IMMEDIATE VENDOR CREDIT)
// // @route    PUT /api/orders/:id/pay/wallet
// // @access   Private
// router.put('/:id/pay/wallet', protect, async (req, res) => {
//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         const mainOrder = await MainOrder.findById(req.params.id).session(session);

//         if (!mainOrder) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(404).json({ message: 'Main Order not found' });
//         }

//         if (mainOrder.isPaid) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'Order is already paid' });
//         }

//         // 1. Authorization check
//         if (mainOrder.user.toString() !== req.user.id.toString()) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(401).json({ message: 'Not authorized to modify this order' });
//         }
//         
//         // 2. Fetch the user (buyer) document within the transaction
//         const buyer = await User.findById(req.user.id).session(session);
//         if (!buyer) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(404).json({ message: 'Buyer user account not found.' });
//         }

//         // 3. Balance check
//         const orderTotal = mainOrder.totalPrice; // Total price user must pay
//         if (buyer.userWalletBalance < orderTotal) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ 
//                 message: `Insufficient wallet balance. Required: ₦${orderTotal.toFixed(2)}, Available: ₦${buyer.userWalletBalance.toFixed(2)}`
//             });
//         }
//         
//         // 4. Debit the buyer's wallet
//         const updatedBuyer = await User.findByIdAndUpdate(
//             req.user.id,
//             { $inc: { userWalletBalance: -orderTotal } },
//             { new: true, session }
//         );
        
//         // 5. Update MainOrder payment status (Funds are now HELD by the platform/Escrow)
//         mainOrder.isPaid = true;
//         mainOrder.paidAt = Date.now();
//         mainOrder.mainOrderStatus = 'processing'; // Transition to processing
//         mainOrder.paymentResult = {
//             id: 'WALLET-' + Date.now().toString(), 
//             status: 'successful',
//             payment_type: 'Wallet Balance',
//             amount: orderTotal,
//             currency: 'NGN',
//             email_address: buyer.email,
//         };

//         // 6. Process product stock updates and update Shipment status
//         const shipments = await Shipment.find({ mainOrder: mainOrder._id }).session(session);
//         const productUpdates = [];


//         for (const shipment of shipments) {
//             // Update Shipment status to processing
//             shipment.shipmentStatus = 'processing';
//             await shipment.save({ session });

//             const message = `New paid order! Shipment ${shipment._id} is ready for processing. Platform Fee deducted: ₦${shipment.platformFee.toFixed(2)} will be retained.`;

//             await User.findByIdAndUpdate(
//                 shipment.vendor,
//                 {
//                     $push: {
//                         notifications: {
//                             $each: [
//                                 {
//                                     type: 'new_order',
//                                     message: message,
//                                     isRead: false,
//                                     relatedModel: 'Shipment',
//                                     relatedId: shipment._id,
//                                 },
//                             ],
//                             $position: 0, 
//                         },
//                     },
//                 },
//                 { new: true, session }
//             );
//             // END: NEW VENDOR NOTIFICATION FOR PAID ORDER
            
//             // Queue product updates
//             for (const item of shipment.items) {
//                 const soldCount = item.quantity;
//                 productUpdates.push(
//                     Product.findByIdAndUpdate(
//                         item.product,
//                         { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
//                         { new: true, session }
//                     )
//                 );
//             }
//         }

//         await Promise.all(productUpdates);
        
//         // 7. VENDOR CREDITS (85%) ARE HELD UNTIL DELIVERY.

//         const updatedOrder = await mainOrder.save({ session });
//         await session.commitTransaction();
//         session.endSession();

//         // 8. Success response
//         res.json({
//             ...updatedOrder.toObject(),
//             newBuyerWalletBalance: updatedBuyer.userWalletBalance, 
//         });

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error processing wallet payment for order:', error.message);
//         res.status(500).json({ message: 'Server Error', error: error.message });
//     }
// });

// // ## Flutterwave Payment Route (Escrow)

// // @desc     Update MainOrder/Shipments to paid + verify Flutterwave (NO IMMEDIATE VENDOR CREDIT)
// // @route    PUT /api/orders/:id/pay
// // @access   Private
// router.put('/:id/pay', protect, async (req, res) => {
//   const session = await mongoose.startSession();
//   session.startTransaction();

//   try {
//     const mainOrder = await MainOrder.findById(req.params.id).session(session);

//     if (!mainOrder) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(404).json({ message: 'Main Order not found' });
//     }

//     if (mainOrder.isPaid) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(400).json({ message: 'Order is already paid' });
//     }

//     if (mainOrder.user.toString() !== req.user.id.toString()) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(401).json({ message: 'Not authorized to modify this order' });
//     }

//     const { transaction_id } = req.body;
//     if (!transaction_id) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(400).json({ message: 'Transaction ID is required' });
//     }

//     // ✅ Verify payment with Flutterwave
//     const flwResponse = await axios.get(
//       `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
//       {
//         headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` }
//       }
//     );

//     const flwData = flwResponse.data;

//     // ❌ If verification fails, remove order
//     if (flwData.status !== "success" || flwData.data.status !== "successful") {
//       await MainOrder.deleteOne({ _id: mainOrder._id }, { session });
//       // Also delete associated shipments to prevent orphaned documents
//       await Shipment.deleteMany({ mainOrder: mainOrder._id }, { session }); 
//       await session.commitTransaction();
//       session.endSession();
//       return res.status(400).json({
//         message: 'Payment verification failed and order has been removed.',
//         flutterwave: flwData
//       });
//     }

//     // ✅ Verified — update MainOrder payment and status
//     mainOrder.isPaid = true;
//     mainOrder.paidAt = Date.now();
//     mainOrder.mainOrderStatus = 'processing'; // Transition to processing
//     mainOrder.paymentResult = {
//       id: flwData.data.id,
//       status: flwData.data.status,
//       tx_ref: flwData.data.tx_ref,
//       flw_ref: flwData.data.flw_ref,
//       amount: flwData.data.amount,
//       currency: flwData.data.currency,
//       email_address: flwData.data.customer.email,
//     };

//     // Update Product Stock and Shipment status
//     const shipments = await Shipment.find({ mainOrder: mainOrder._id }).session(session);
//     const productUpdates = [];

//     for (const shipment of shipments) {
//         // Update Shipment status to processing
//         shipment.shipmentStatus = 'processing';
//         await shipment.save({ session });

//         for (const item of shipment.items) {
//             const soldCount = item.quantity;
//             productUpdates.push(
//                 Product.findByIdAndUpdate(
//                     item.product,
//                     { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
//                     { new: true, session }
//                 )
//             );
//         }
//     }

//     await Promise.all(productUpdates);

//     // ❌ VENDOR CREDITS (85%) ARE HELD UNTIL DELIVERY.

//     const updatedOrder = await mainOrder.save({ session });
//     await session.commitTransaction();
//     session.endSession();

//     res.json(updatedOrder);

//   } catch (error) {
//     await session.abortTransaction();
//     session.endSession();
//     console.error('Error verifying payment and updating order:', error.response?.data || error.message);
//     res.status(500).json({ message: 'Server Error', error: error.response?.data || error.message });
//   }
// });


// // ## Shipment Delivery and Vendor Payout Route (NEW!)

// // @desc     Mark a specific Shipment as delivered, update metrics, and credit vendor wallet
// // @route    PUT /api/orders/shipments/:id/deliver
// // @access   Private/Admin/Vendor (Vendor can only mark their own shipments as delivered)

// // @desc     Mark a specific Shipment as delivered, update metrics, and credit vendor wallet
// // @route    PUT /api/orders/shipments/:id/deliver
// // @access   Private/Admin/Vendor (Vendor can only mark their own shipments as delivered)
// router.put('/shipments/:id/deliver', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
//     const SHIPMENT_ID = req.params.id;

//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         // 1. Find the Shipment and ensure it's not already delivered
//         const shipment = await Shipment.findById(SHIPMENT_ID).session(session);

//         if (!shipment) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(404).json({ message: 'Shipment not found' });
//         }

//         if (shipment.isDelivered) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'Shipment is already marked as delivered' });
//         }
        
//         // 2. Authorization: Vendor can only update their own shipments unless they are an admin
//         if (req.user.role === 'vendor' && shipment.vendor.toString() !== req.user.id.toString()) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(401).json({ message: 'Not authorized to update this shipment' });
//         }
        
//         // 3. REMOVED VENDOR CREDITING HERE - Only mark as delivered
//         // Vendor will be credited when MainOrder is marked as 'completed' by admin
        
//         // 4. Update the Shipment status
//         shipment.isDelivered = true;
//         shipment.deliveredAt = Date.now();
//         shipment.shipmentStatus = 'delivered';

//         const updatedShipment = await shipment.save({ session });
        
//         // 5. Check if all Shipments in the MainOrder are now delivered
//         const mainOrder = await MainOrder.findById(shipment.mainOrder).session(session);
//         const pendingShipments = await Shipment.countDocuments({ 
//             mainOrder: mainOrder._id, 
//             isDelivered: false 
//         }).session(session);

//         if (pendingShipments === 0) {
//             // All shipments for this MainOrder are delivered
//             // Update status to 'delivered' but DON'T credit yet
//             mainOrder.isDelivered = true;
//             mainOrder.deliveredAt = Date.now();
//             mainOrder.mainOrderStatus = 'delivered'; // Changed from 'completed' to 'delivered'
//             await mainOrder.save({ session });
            
//             // Send notification to admin that order is ready for completion/verification
//             await User.findOneAndUpdate(
//                 { role: 'admin' },
//                 {
//                     $push: {
//                         notifications: {
//                             type: 'order_ready_for_completion',
//                             message: `Order ${mainOrder._id} has all shipments delivered and is ready for final verification and completion.`,
//                             isRead: false,
//                             relatedModel: 'MainOrder',
//                             relatedId: mainOrder._id,
//                         }
//                     }
//                 },
//                 { new: true, session }
//             );
//         }

//         await session.commitTransaction();
//         session.endSession();

//         res.json({
//             message: `Shipment ${SHIPMENT_ID} marked as delivered. Order will be completed after admin verification.`,
//             shipment: updatedShipment,
//         });

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error processing shipment delivery:', error.message);
//         res.status(500).json({ message: 'Server Error', error: error.message });
//     }
// });
// // router.put('/shipments/:id/deliver', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
// //     const SHIPMENT_ID = req.params.id;

// //     const session = await mongoose.startSession();
// //     session.startTransaction();

// //     try {
// //         // 1. Find the Shipment and ensure it's not already delivered
// //         const shipment = await Shipment.findById(SHIPMENT_ID).session(session);

// //         if (!shipment) {
// //             await session.abortTransaction();
// //             session.endSession();
// //             return res.status(404).json({ message: 'Shipment not found' });
// //         }

// //         if (shipment.isDelivered) {
// //             await session.abortTransaction();
// //             session.endSession();
// //             return res.status(400).json({ message: 'Shipment is already marked as delivered' });
// //         }
        
// //         // 2. Authorization: Vendor can only update their own shipments unless they are an admin
// //         if (req.user.role === 'vendor' && shipment.vendor.toString() !== req.user.id.toString()) {
// //             await session.abortTransaction();
// //             session.endSession();
// //             return res.status(401).json({ message: 'Not authorized to update this shipment' });
// //         }
        
// //         // 3. Calculation of vendor earnings (The Subtotal minus Platform Fee)
// //         const revenue = shipment.subtotal; // Subtotal for the items in this shipment
// //         const commission = shipment.platformFee; // Commission already stored on the shipment
// //         const vendorEarning = revenue - commission; // Vendor gets 85%

// //         // 4. Credit the Vendor's Wallet and update metrics
// //         const updatedVendor = await User.findByIdAndUpdate(
// //             shipment.vendor,
// //             {
// //                 $inc: { 
// //                     vendorWalletBalance: vendorEarning,
// //                     // NOTE: If you track total platform commission in User, you might want to credit it here or elsewhere.
// //                     // Assuming for now, the platform already has the funds and this is just a transfer to the vendor.
// //                 },
// //                 $push: {
// //                     notifications: {
// //                         $each: [
// //                             {
// //                                 type: 'delivery_payout',
// //                                 message: `Payout of ₦${vendorEarning.toFixed(2)} received for delivered shipment ${SHIPMENT_ID}. Platform Fee: ₦${commission.toFixed(2)}.`,
// //                                 isRead: false,
// //                                 relatedModel: 'Shipment',
// //                                 relatedId: shipment._id,
// //                             },
// //                         ],
// //                         $position: 0,
// //                     },
// //                 },
// //             },
// //             { new: true, session }
// //         );

// //         // 5. Update the Shipment status
// //         shipment.isDelivered = true;
// //         shipment.deliveredAt = Date.now();
// //         shipment.shipmentStatus = 'delivered';

// //         const updatedShipment = await shipment.save({ session });
        
// //         // 6. Check if all Shipments in the MainOrder are now delivered
// //         const mainOrder = await MainOrder.findById(shipment.mainOrder).session(session);
// //         const pendingShipments = await Shipment.countDocuments({ 
// //             mainOrder: mainOrder._id, 
// //             isDelivered: false 
// //         }).session(session);

// //         if (pendingShipments === 0) {
// //             // All shipments for this MainOrder are delivered
// //             mainOrder.isDelivered = true;
// //             mainOrder.deliveredAt = Date.now();
// //             mainOrder.mainOrderStatus = 'completed';
// //             await mainOrder.save({ session });
// //         }

// //         await session.commitTransaction();
// //         session.endSession();

// //         res.json({
// //             message: `Shipment ${SHIPMENT_ID} marked as delivered. Vendor credited ₦${vendorEarning.toFixed(2)}`,
// //             shipment: updatedShipment,
// //         });

// //     } catch (error) {
// //         await session.abortTransaction();
// //         session.endSession();
// //         console.error('Error processing shipment delivery:', error.message);
// //         res.status(500).json({ message: 'Server Error', error: error.message });
// //     }
// // });


// router.put('/shipments/:id/status-update', protect, authorizeRoles('admin'), async (req, res) => {
//     const { status } = req.body; // Expects a status like 'out_for_delivery'
//     const SHIPMENT_ID = req.params.id;

//     // Validate the incoming status against the Shipment enum values, excluding 'delivered' and 'awaiting_payment'
//     const validStatuses = ['processing', 'ready_for_pickup', 'out_for_delivery', 'returned', 'cancelled'];
    
//     if (!validStatuses.includes(status)) {
//         return res.status(400).json({ 
//             message: `Invalid or non-updatable shipment status provided. Must be one of: ${validStatuses.join(', ')}` 
//         });
//     }

//     try {
//         const shipment = await Shipment.findById(SHIPMENT_ID);

//         if (!shipment) {
//             return res.status(404).json({ message: 'Shipment not found' });
//         }
        
//         // Prevent accidental updates if already delivered
//         if (shipment.shipmentStatus === 'delivered') {
//             return res.status(400).json({ message: 'Cannot update status of an already delivered shipment.' });
//         }

//         // Update the status
//         shipment.shipmentStatus = status;
//         await shipment.save();

//         res.json({ message: `Shipment ${SHIPMENT_ID} status updated to ${status}.`, shipment });

//     } catch (error) {
//         console.error('Error during generic status update:', error);
//         res.status(500).json({ message: 'Server Error during status update.', error: error.message });
//     }
// });


// // @desc    Update order status by dispatch rider
// // @route   PUT /api/orders/:id/dispatch-status
// // @access  Private/Dispatch
// router.put('/:id/dispatch-status', protect, authorizeRoles('dispatch', 'admin'), async (req, res) => {
//     const { status } = req.body;
    
//     if (!['shipped', 'delivered'].includes(status)) {
//         return res.status(400).json({ message: 'Invalid status provided.' });
//     }

//     try {
//         const order = await Order.findById(req.params.id);

//         if (!order) {
//             return res.status(404).json({ message: 'Order not found' });
//         }

//         if (status === 'shipped' && (order.orderStatus === 'pending' || order.orderStatus === 'processing')) {
//             order.orderStatus = status;
//         } else if (status === 'delivered' && order.orderStatus === 'shipped') {
//             order.orderStatus = status;
//             order.isDelivered = true;
//             order.deliveredAt = Date.now();
//         } else {
//             return res.status(400).json({ message: 'Invalid status transition.' });
//         }

//         const updatedOrder = await order.save();
//         res.json(updatedOrder);
//     } catch (error) {
//         console.error('Error updating order status:', error);
//         if (error.kind === 'ObjectId') {
//             return res.status(400).json({ message: 'Invalid Order ID format' });
//         }
//         res.status(500).json({ message: 'Server Error' });
//     }
// });



// // @desc    Update MainOrder status (Admin only)
// // @route   PUT /api/orders/:id/status
// // @access  Private/Admin

// // @desc    Update MainOrder status (Admin only)
// // @route   PUT /api/orders/:id/status
// // @access  Private/Admin
// router.put('/:id/status', protect, authorizeRoles('admin'), async (req, res) => {
//     const { status } = req.body;
//     const MAIN_ORDER_ID = req.params.id;

//     // 1. Basic validation: MUST match the Mongoose model's enum
//     const validStatuses = [
//         'pending_payment', 
//         'processing', 
//         'partially_shipped', 
//         'shipped', 
//         'delivered', 
//         'completed',
//         'cancelled'
//     ];

//     if (!validStatuses.includes(status)) {
//         return res.status(400).json({ 
//             message: `Invalid main order status: ${status}. Must be one of: ${validStatuses.join(', ')}` 
//         });
//     }

//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         const mainOrder = await MainOrder.findById(MAIN_ORDER_ID).session(session);

//         if (!mainOrder) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(404).json({ message: 'Main Order not found.' });
//         }

//         // NEW: Prevent double-crediting / double-delivery
//         if (status === 'completed' && mainOrder.mainOrderStatus === 'completed') {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ 
//                 message: 'Order already marked as completed and credited. No further action allowed.' 
//             });
//         }

//         // 2. Update the status
//         mainOrder.mainOrderStatus = status;

//         // CREDIT LOGIC ONLY WHEN STATUS IS 'completed'
//         if (status === 'completed') {
//             mainOrder.isDelivered = true;
//             mainOrder.deliveredAt = Date.now();
//             mainOrder.shipmentStatus = 'delivered';

//             // Credit logic only if order is paid
//             if (mainOrder.isPaid) {
//                 // Fetch all shipments for this order
//                 const shipments = await Shipment.find({ mainOrder: MAIN_ORDER_ID }).session(session);

//                 let totalRiderEarning = 0;
//                 let totalVendorPayout = 0;

//                 for (const shipment of shipments) {
//                     // Vendor crediting per shipment - ONLY HAPPENS AT 'completed'
//                     const revenue = shipment.subtotal;
//                     const commission = shipment.platformFee;
//                     const vendorEarning = revenue - commission;
//                     totalVendorPayout += vendorEarning;

//                     await User.findByIdAndUpdate(
//                         shipment.vendor,
//                         {
//                             $inc: { vendorWalletBalance: vendorEarning },
//                             $push: {
//                                 notifications: {
//                                     $each: [{
//                                         type: 'delivery_payout',
//                                         message: `Payout of ₦${vendorEarning.toFixed(2)} received for completed order ${mainOrder._id}. Platform Fee: ₦${commission.toFixed(2)}.`,
//                                         isRead: false,
//                                         relatedModel: 'MainOrder',
//                                         relatedId: mainOrder._id,
//                                     }],
//                                     $position: 0,
//                                 },
//                             },
//                         },
//                         { new: true, session }
//                     );

//                     // Recalculate distance for rider earning
//                     const distanceKm = calculateDistance(
//                         shipment.vendorLocation.latitude,
//                         shipment.vendorLocation.longitude,
//                         mainOrder.userLocation.latitude,
//                         mainOrder.userLocation.longitude
//                     );

//                     // Rider gets 150/km
//                     const riderEarningPerShipment = distanceKm * 150;
//                     totalRiderEarning += riderEarningPerShipment;

//                     // Auto-update each shipment to delivered if not already
//                     if (!shipment.isDelivered) {
//                         shipment.shipmentStatus = 'delivered';
//                         shipment.isDelivered = true;
//                         shipment.deliveredAt = Date.now();
//                         await shipment.save({ session });
//                     }
//                 }

//                 // Credit rider's wallet with total earning - ONLY AT 'completed'
//                 if (mainOrder.rider) {
//                     await Rider.findByIdAndUpdate(
//                         mainOrder.rider,
//                         { 
//                             $inc: { 
//                                 walletBalance: totalRiderEarning, 
//                                 totalEarnings: totalRiderEarning,
//                                 completedDeliveries: 1 
//                             },
//                             $push: {
//                                 notifications: {
//                                     type: 'delivery_payout',
//                                     message: `₦${totalRiderEarning.toFixed(2)} credited for completing order ${mainOrder._id}.`,
//                                     isRead: false,
//                                     relatedModel: 'MainOrder',
//                                     relatedId: mainOrder._id,
//                                 }
//                             }
//                         },
//                         { session }
//                     );
//                 } else {
//                     console.warn(`No rider assigned for completed order ${MAIN_ORDER_ID} - skipping rider credit`);
//                 }

//                 // Log the payout for admin
//                 console.log(`Order ${MAIN_ORDER_ID} completed. Total payouts: Vendors: ₦${totalVendorPayout.toFixed(2)}, Rider: ₦${totalRiderEarning.toFixed(2)}`);
//             } else {
//                 console.warn(`Order ${MAIN_ORDER_ID} marked as completed but not paid - skipping payouts`);
//             }
//         }

//         const updatedMainOrder = await mainOrder.save({ session });
//         await session.commitTransaction();
//         session.endSession();

//         res.json({ 
//             message: `Main Order ${MAIN_ORDER_ID} status updated to ${status}.${status === 'completed' ? ' Vendors and rider credited.' : ''}`, 
//             order: updatedMainOrder 
//         });

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error updating main order status:', error);
//         res.status(500).json({ message: 'Server Error during main order status update.', error: error.message });
//     }
// });

// // router.put('/:id/status', protect, authorizeRoles('admin'), async (req, res) => {
// //     const { status } = req.body;
// //     const MAIN_ORDER_ID = req.params.id;

// //     // 1. Basic validation: MUST match the Mongoose model's enum
// //     const validStatuses = [
// //         'pending_payment', 
// //         'processing', 
// //         'partially_shipped', 
// //         'shipped', 
// //         'delivered', 
// //         'completed',
// //         'cancelled'
// //     ];

// //     if (!validStatuses.includes(status)) {
// //         return res.status(400).json({ 
// //             message: `Invalid main order status: ${status}. Must be one of: ${validStatuses.join(', ')}` 
// //         });
// //     }

// //     const session = await mongoose.startSession();
// //     session.startTransaction();

// //     try {
// //         const mainOrder = await MainOrder.findById(MAIN_ORDER_ID).session(session);

// //         if (!mainOrder) {
// //             await session.abortTransaction();
// //             session.endSession();
// //             return res.status(404).json({ message: 'Main Order not found.' });
// //         }

// //         // NEW: Prevent double-crediting / double-delivery
// //         if (status === 'delivered' && mainOrder.mainOrderStatus === 'delivered') {
// //             await session.abortTransaction();
// //             session.endSession();
// //             return res.status(400).json({ 
// //                 message: 'Order already marked as delivered and credited. No further action allowed.' 
// //             });
// //         }

// //         // 2. Update the status
// //         mainOrder.mainOrderStatus = status;

// //         if (status === 'delivered') {
// //             mainOrder.isDelivered = true;
// //             mainOrder.deliveredAt = Date.now();
// //             mainOrder.shipmentStatus = 'delivered'; // Update shipmentStatus on MainOrder

// //             // Credit logic only if order is paid
// //             if (mainOrder.isPaid) {
// //                 // Fetch all shipments for this order
// //                 const shipments = await Shipment.find({ mainOrder: MAIN_ORDER_ID }).session(session);

// //                 let totalRiderEarning = 0;

// //                 for (const shipment of shipments) {
// //                     // Vendor crediting per shipment
// //                     const revenue = shipment.subtotal;
// //                     const commission = shipment.platformFee;
// //                     const vendorEarning = revenue - commission;

// //                     await User.findByIdAndUpdate(
// //                         shipment.vendor,
// //                         {
// //                             $inc: { vendorWalletBalance: vendorEarning },
// //                             $push: {
// //                                 notifications: {
// //                                     $each: [{
// //                                         type: 'delivery_payout',
// //                                         message: `Payout of ₦${vendorEarning.toFixed(2)} received for delivered shipment ${shipment._id}. Platform Fee: ₦${commission.toFixed(2)}.`,
// //                                         isRead: false,
// //                                         relatedModel: 'Shipment',
// //                                         relatedId: shipment._id,
// //                                     }],
// //                                     $position: 0,
// //                                 },
// //                             },
// //                         },
// //                         { new: true, session }
// //                     );

// //                     // Recalculate distance for rider earning
// //                     const distanceKm = calculateDistance(
// //                         shipment.vendorLocation.latitude,
// //                         shipment.vendorLocation.longitude,
// //                         mainOrder.userLocation.latitude,
// //                         mainOrder.userLocation.longitude
// //                     );

// //                     // Rider gets 150/km
// //                     const riderEarningPerShipment = distanceKm * 150;
// //                     totalRiderEarning += riderEarningPerShipment;

// //                     // Auto-update each shipment to delivered
// //                     shipment.shipmentStatus = 'delivered';
// //                     shipment.isDelivered = true;
// //                     shipment.deliveredAt = Date.now();
// //                     await shipment.save({ session });
// //                 }

// //                 // Credit rider's wallet with total earning
// //                 if (mainOrder.rider) {
// //                     await Rider.findByIdAndUpdate(
// //                         mainOrder.rider,
// //                         { $inc: { walletBalance: totalRiderEarning, totalEarnings: totalRiderEarning } },
// //                         { session }
// //                     );
// //                 } else {
// //                     console.warn(`No rider assigned for delivered order ${MAIN_ORDER_ID} - skipping rider credit`);
// //                 }
// //             }
// //         }

// //         const updatedMainOrder = await mainOrder.save({ session });
// //         await session.commitTransaction();
// //         session.endSession();

// //         res.json({ 
// //             message: `Main Order ${MAIN_ORDER_ID} status updated to ${status}.`, 
// //             order: updatedMainOrder 
// //         });

// //     } catch (error) {
// //         await session.abortTransaction();
// //         session.endSession();
// //         console.error('Error updating main order status:', error);
// //         res.status(500).json({ message: 'Server Error during main order status update.', error: error.message });
// //     }
// // });


// // @desc    Get single order by ID
// // @route   GET /api/orders/:id
// // @access  Private
// router.get('/:id', protect, async (req, res) => {
//     try {
//         const order = await MainOrder.findById(req.params.id)
//             .populate('user', 'firstName lastName email phoneNumber')
//             .populate('orderItems.product', 'name imageUrls price stockQuantity')
//             .populate('orderItems.vendor', 'businessName');

//         if (!order) {
//             return res.status(404).json({ message: 'Order not found' });
//         }

//         const isOwner = order.user.toString() === req.user.id.toString();
//         const isAdmin = req.user.isAdmin;
//         const isDispatchRider = req.user.role === 'dispatch';
//         const isVendor = order.orderItems.some(item =>
//             item.vendor && item.vendor._id.toString() === req.user.id.toString()
//         );

//         if (!isOwner && !isAdmin && !isDispatchRider && !isVendor) {
//             return res.status(401).json({ message: 'Not authorized to view this order' });
//         }
        
//         res.json(order);
//     } catch (error) {
//         console.error('Error fetching single order:', error);
//         if (error.kind === 'ObjectId') {
//             return res.status(400).json({ message: 'Invalid Order ID format' });
//         }
//         res.status(500).json({ message: 'Server Error' });
//     }
// });


// // @desc    All orders for Admin
// // @route   GET /api/orders/admin
// // @access  Private/Admin
// router.get('/admin', protect, authorizeRoles('admin'), async (req, res) => {
//     try {
//         const orders = await MainOrder.find({})
//             .populate('user', 'firstName lastName email phoneNumber')
//             .populate('orderItems.product', 'name imageUrls price stockQuantity')
//             .populate('orderItems.vendor', 'businessName')
//             .sort({ createdAt: -1 });

//         res.json(orders);
//     } catch (error) {
//         console.error('Error fetching all orders for admin:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });



// module.exports = router;