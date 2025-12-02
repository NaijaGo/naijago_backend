const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const MainOrder = require('../models/MainOrder'); // Renamed Order to MainOrder
const Shipment = require('../models/Shipment'); // NEW: Import Shipment model
const Product = require('../models/Product');
const User = require('../models/User');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const axios = require("axios");

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

// --- Helper Function: Shipping Cost (Based on your N100/km rule) ---
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

// @desc    Get all orders (Admin access only)
// @route   GET /api/orders
// @access  Private/Admin
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
router.post('/summary', protect, async (req, res) => {
    const { cartItems, shippingAddress, userLocation } = req.body;
    const PLATFORM_COMMISSION_RATE = 0.15; // 15% rate

    if (!cartItems || cartItems.length === 0) {
        return res.status(400).json({ message: 'No items in cart for summary calculation' });
    }
    if (!shippingAddress || !userLocation) {
        return res.status(400).json({ message: 'Shipping address and location are required' });
    }
    
    try {
        const vendorCartMap = new Map();
        let totalSubtotal = 0;

        // 1. Group items by vendor and calculate subtotal for each vendor
        for (const item of cartItems) {
            // Fetch product and vendor data in parallel for efficiency
            const [product, vendorUser] = await Promise.all([
                Product.findById(item.product, 'price imageUrls vendor'),
                User.findById(item.vendor, 'businessName businessLocation')
            ]);
            
            if (!product) {
                return res.status(404).json({ message: `Product not found: ${item.name}` });
            }
            // Use the vendor ID from the Product schema for consistency
            const vendorId = product.vendor.toString(); 

            if (!vendorUser || !vendorUser.businessLocation) {
                 return res.status(404).json({ message: `Vendor or location not found for product: ${item.name}` });
            }

            const itemPrice = product.price * item.quantity;
            totalSubtotal += itemPrice;

            if (!vendorCartMap.has(vendorId)) {
                vendorCartMap.set(vendorId, {
                    vendorId: vendorId,
                    vendorName: vendorUser.businessName,
                    vendorLocation: vendorUser.businessLocation,
                    items: [],
                    subtotal: 0,
                });
            }
            
            vendorCartMap.get(vendorId).items.push({
                product: item.product,
                name: item.name, // Use name from cart for frontend display
                image: product.imageUrls[0], // Use product data for image
                quantity: item.quantity,
                price: product.price, // Use product data for price verification
            });
            
            vendorCartMap.get(vendorId).subtotal += itemPrice;
        }

        // 2. Calculate fees for each shipment
        const shipmentSummaries = [];
        let totalShippingPrice = 0;
        let totalPlatformFees = 0;

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
            
            // Calculate Platform Commission
            const platformFee = data.subtotal * PLATFORM_COMMISSION_RATE;

            totalShippingPrice += shippingPrice;
            totalPlatformFees += platformFee;

            shipmentSummaries.push({
                vendorId: data.vendorId,
                vendorName: data.vendorName,
                vendorLocation: vendorLocation, 
                subtotal: parseFloat(data.subtotal.toFixed(2)),
                shippingPrice: shippingPrice,
                platformFee: parseFloat(platformFee.toFixed(2)),
                // Total cost for the items and delivery from this specific vendor
                totalShipmentCost: parseFloat((data.subtotal + shippingPrice).toFixed(2)), 
                items: data.items,
            });
        }
        
        const totalPrice = totalSubtotal + totalShippingPrice + (req.body.taxPrice || 0.0);

        // 3. Respond to Flutter
        res.json({
            totalSubtotal: parseFloat(totalSubtotal.toFixed(2)),
            totalShippingPrice: parseFloat(totalShippingPrice.toFixed(2)),
            totalPlatformFees: parseFloat(totalPlatformFees.toFixed(2)),
            totalPrice: parseFloat(totalPrice.toFixed(2)), // User-facing total
            taxPrice: req.body.taxPrice || 0.0,
            shipmentSummaries, // Detailed breakdown
            userLocation, 
            shippingAddress,
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
            console.log("Incoming Shipment Summary for debugging:", summary);
            const newShipment = new Shipment({
                mainOrder: createdMainOrder._id, // Link back to MainOrder
                vendor: summary.vendor,
                vendorLocation: summary.vendorLocation, 
                items: summary.items.map(item => ({ // Ensure item structure is correct for Shipment model
                    product: item.product,
                    name: item.name,
                    image: item.image,
                    quantity: item.quantity,
                    price: item.price,
                })),
                subtotal: summary.subtotal,
                platformFee: summary.platformFee,
                shippingPrice: summary.shippingPrice,
                
                shipmentStatus: 'processing', // Use this status until payment is confirmed
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

// @desc    Update pending orders to processing after some time delay / server check
// @route   POST /api/orders/update-pending-to-processing
// @access  Private (called by client's polling timer)
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


// @desc    Get logged in user's orders (Now fetching MainOrders)
// @route   GET /api/orders/my
// @access  Private
router.get('/my', protect, async (req, res) => {
    try {
        // Fetch MainOrder and populate linked Shipments
        const orders = await MainOrder.find({ user: req.user.id })
            .populate({
                path: 'shipments',
                populate: [
                    { path: 'vendor', select: 'businessName' },
                    { path: 'items.product', select: 'name imageUrls price' }
                ]
            })
            .sort({ createdAt: -1 });
        res.json(orders);
    } catch (error) {
        console.error('Error fetching user orders:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});


// @desc    Update MainOrder status (Admin only)
// @route   PUT /api/orders/:id/status
// @access   Private/Admin
router.put('/:id/status', protect, authorizeRoles('admin'), async (req, res) => {
    const { status } = req.body;
    const MAIN_ORDER_ID = req.params.id;
    
    // 1. Basic validation
    const validStatuses = ['shipped', 'delivered', 'processing', 'cancelled', 'returned'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: `Invalid main order status: ${status}` });
    }

    try {
        const mainOrder = await MainOrder.findById(MAIN_ORDER_ID);

        if (!mainOrder) {
            return res.status(404).json({ message: 'Main Order not found.' });
        }

        // 2. Update the status
        mainOrder.mainOrderStatus = status;

        // Optionally, update the isDelivered flag if the status is 'delivered'
        if (status === 'delivered') {
            mainOrder.isDelivered = true;
            mainOrder.deliveredAt = Date.now();
        }

        await mainOrder.save();
        
        // NOTE: The frontend explicitly states this button only updates the Main Order Status,
        // so no need to update individual Shipments here unless required by business logic.

        res.json({ 
            message: `Main Order ${MAIN_ORDER_ID} status updated to ${status}.`, 
            order: mainOrder 
        });

    } catch (error) {
        console.error('Error updating main order status:', error);
        res.status(500).json({ message: 'Server Error during main order status update.', error: error.message });
    }
});


// @desc    Get vendor-specific shipments (REPLACED monolithic order view with Shipments)
// @route   GET /api/orders/vendor
// @access  Private/Vendor
router.get('/vendor', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
    try {
        // Vendors now only care about their Shipments, not the entire MainOrder
        const shipments = await Shipment.find({ vendor: req.user.id })
            .populate('mainOrder', 'shippingAddress userLocation totalPrice paymentMethod') // Link to the main order info
            .populate('vendor', 'businessName')
            .populate('items.product', 'name imageUrls price stockQuantity')
            .sort({ createdAt: -1 });
        
        // Since we are finding by vendor ID, no need for the complex map filtering.
        res.json(shipments);
    } catch (error) {
        console.error('Error fetching vendor orders:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});


// ## Wallet Payment Route (Escrow)

// @desc     Update MainOrder/Shipments to paid + Debit User Wallet (NO IMMEDIATE VENDOR CREDIT)
// @route    PUT /api/orders/:id/pay/wallet
// @access   Private
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

        // 6. Process product stock updates and update Shipment status
        const shipments = await Shipment.find({ mainOrder: mainOrder._id }).session(session);
        const productUpdates = [];


        for (const shipment of shipments) {
            // Update Shipment status to processing
            shipment.shipmentStatus = 'processing';
            await shipment.save({ session });

            const message = `New paid order! Shipment ${shipment._id} is ready for processing. Platform Fee deducted: ₦${shipment.platformFee.toFixed(2)} will be retained.`;

            await User.findByIdAndUpdate(
                shipment.vendor,
                {
                    $push: {
                        notifications: {
                            $each: [
                                {
                                    type: 'new_order',
                                    message: message,
                                    isRead: false,
                                    relatedModel: 'Shipment',
                                    relatedId: shipment._id,
                                },
                            ],
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
        
        // 7. VENDOR CREDITS (85%) ARE HELD UNTIL DELIVERY.

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

// @desc     Update MainOrder/Shipments to paid + verify Flutterwave (NO IMMEDIATE VENDOR CREDIT)
// @route    PUT /api/orders/:id/pay
// @access   Private
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

    // ❌ VENDOR CREDITS (85%) ARE HELD UNTIL DELIVERY.

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


// ## Shipment Delivery and Vendor Payout Route (NEW!)

// @desc     Mark a specific Shipment as delivered, update metrics, and credit vendor wallet
// @route    PUT /api/orders/shipments/:id/deliver
// @access   Private/Admin/Vendor (Vendor can only mark their own shipments as delivered)
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
        
        // 3. Calculation of vendor earnings (The Subtotal minus Platform Fee)
        const revenue = shipment.subtotal; // Subtotal for the items in this shipment
        const commission = shipment.platformFee; // Commission already stored on the shipment
        const vendorEarning = revenue - commission; // Vendor gets 85%

        // 4. Credit the Vendor's Wallet and update metrics
        const updatedVendor = await User.findByIdAndUpdate(
            shipment.vendor,
            {
                $inc: { 
                    vendorWalletBalance: vendorEarning,
                    // NOTE: If you track total platform commission in User, you might want to credit it here or elsewhere.
                    // Assuming for now, the platform already has the funds and this is just a transfer to the vendor.
                },
                $push: {
                    notifications: {
                        $each: [
                            {
                                type: 'delivery_payout',
                                message: `Payout of ₦${vendorEarning.toFixed(2)} received for delivered shipment ${SHIPMENT_ID}. Platform Fee: ₦${commission.toFixed(2)}.`,
                                isRead: false,
                                relatedModel: 'Shipment',
                                relatedId: shipment._id,
                            },
                        ],
                        $position: 0,
                    },
                },
            },
            { new: true, session }
        );

        // 5. Update the Shipment status
        shipment.isDelivered = true;
        shipment.deliveredAt = Date.now();
        shipment.shipmentStatus = 'delivered';

        const updatedShipment = await shipment.save({ session });
        
        // 6. Check if all Shipments in the MainOrder are now delivered
        const mainOrder = await MainOrder.findById(shipment.mainOrder).session(session);
        const pendingShipments = await Shipment.countDocuments({ 
            mainOrder: mainOrder._id, 
            isDelivered: false 
        }).session(session);

        if (pendingShipments === 0) {
            // All shipments for this MainOrder are delivered
            mainOrder.isDelivered = true;
            mainOrder.deliveredAt = Date.now();
            mainOrder.mainOrderStatus = 'completed';
            await mainOrder.save({ session });
        }

        await session.commitTransaction();
        session.endSession();

        res.json({
            message: `Shipment ${SHIPMENT_ID} marked as delivered. Vendor credited ₦${vendorEarning.toFixed(2)}`,
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


module.exports = router;





// const express = require('express');
// const mongoose = require('mongoose');
// const router = express.Router();
// const Order = require('../models/MainOrder');
// const Product = require('../models/Product');
// const User = require('../models/User');
// const { protect, authorizeRoles } = require('../middleware/authMiddleware');
// const axios = require("axios");

// // 👇 START OF ADDITIONS 1: Distance Calculation Utility
// /**
//  * Calculates the distance between two geographical coordinates using the Haversine formula.
//  * @param {number} lat1 Latitude of point 1
//  * @param {number} lon1 Longitude of point 1
//  * @param {number} lat2 Latitude of point 2
//  * @param {number} lon2 Longitude of point 2
//  * @returns {number} Distance in Kilometers
//  */
// function calculateDistance(lat1, lon1, lat2, lon2) {
//     const R = 6371; // Radius of the Earth in kilometers
//     const dLat = (lat2 - lat1) * (Math.PI / 180);
//     const dLon = (lon2 - lon1) * (Math.PI / 180);
//     const a =
//         Math.sin(dLat / 2) * Math.sin(dLat / 2) +
//         Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
//         Math.sin(dLon / 2) * Math.sin(dLon / 2);
//     const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
//     const distance = R * c; // Distance in km
//     return parseFloat(distance.toFixed(2)); // Round to 2 decimal places
// }
// // 👆 END OF ADDITIONS 1

// // @desc    Get all orders (Admin access only)
// // @route   GET /api/orders
// // @access  Private/Admin
// router.get('/', protect, async (req, res) => {
//     try {
//         const orders = await Order.find({})
//             // NEW LINES START HERE
//             .populate('user', 'firstName lastName email phoneNumber') 
//             .populate('orderItems.vendor', 'businessName phoneNumber businessLocation') 
//             // NEW LINES END HERE
//             .sort({ createdAt: -1 });

//         res.status(200).json(orders);
//     } catch (error) {
//         console.error('Error fetching all orders:', error);
//         res.status(500).json({ message: 'Error fetching all orders.', error: error.message });
//     }
// });


// // @desc    Create new order (pending payment)
// // @route   POST /api/orders
// // @access  Private
// router.post('/', protect, async (req, res) => {
//     // MODIFIED: Added userLocation. Removed shippingPrice and totalPrice as they are calculated on the server.
//     const {
//         orderItems,
//         shippingAddress,
//         paymentMethod,
//         serviceFee, 
//         taxPrice, 
//         userLocation, // <-- NEW: User's location for delivery calculation
//     } = req.body;

//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         if (!orderItems || orderItems.length === 0) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'No order items' });
//         }

//         const hasMissingVendor = orderItems.some(item => !item.vendor || item.vendor === '');
//         if (hasMissingVendor) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'One or more order items are missing a vendor ID.' });
//         }

//         for (const item of orderItems) {
//             const product = await Product.findById(item.product).session(session);
//             if (!product) {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(404).json({ message: `Product not found: ${item.name}` });
//             }
//             if (product.stockQuantity < item.quantity) {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(400).json({ message: `Insufficient stock for ${product.name}. Available: ${product.stockQuantity}` });
//             }
//         }

//         // 👇 START OF ADDITIONS 2: Delivery/Price Calculation Logic
//         if (!userLocation || typeof userLocation.latitude === 'undefined' || typeof userLocation.longitude === 'undefined') {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'User delivery location (latitude and longitude) is required.' });
//         }

//         // Get Vendor Location
//         const vendorId = orderItems[0].vendor; // Assumes single-vendor checkout flow for now
//         const vendor = await User.findById(vendorId).session(session);

//         if (!vendor || !vendor.businessLocation) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(404).json({ message: 'Vendor or Vendor business location not found for delivery calculation.' });
//         }
        
//         // Calculate Distance (in KM)
//         const distanceKm = calculateDistance(
//             vendor.businessLocation.latitude,
//             vendor.businessLocation.longitude,
//             userLocation.latitude,
//             userLocation.longitude
//         );

//         // Calculate Shipping Price (N100 per kilometer - Hardcoded business rule)
//         const calculatedShippingPrice = distanceKm * 100;

//         // Calculate Order Subtotal (Sum of all item prices * quantity)
//         const itemsPrice = orderItems.reduce((acc, item) => acc + (item.price * item.quantity), 0);
        
//         // Calculate Total Price (Subtotal + Shipping Price + Tax)
//         const calculatedTotalPrice = itemsPrice + calculatedShippingPrice + (taxPrice || 0.0);

//         // Ensure serviceFee (commission) is also present, assumed calculated based on itemsPrice * 0.15 (Hardcoded business rule)
//         const finalServiceFee = serviceFee || (itemsPrice * 0.15); // Fallback if serviceFee is missing

//         // 👆 END OF ADDITIONS 2
        
//         const order = new Order({
//             user: req.user._id,
//             orderItems: orderItems.map(item => ({
//                 product: item.product,
//                 name: item.name,
//                 image: item.image,
//                 quantity: item.quantity,
//                 price: item.price,
//                 vendor: item.vendor,
//             })),
//             shippingAddress,
//             // 👇 START OF ADDITIONS 3: Saving Calculated & Location Fields
//             deliveryDistanceKm: distanceKm,
//             userLocation,
//             vendorLocation: vendor.businessLocation,
//             // 👆 END OF ADDITIONS 3
//             paymentMethod,
//             serviceFee: finalServiceFee, // Use server-calculated or validated fee
//             taxPrice,
//             shippingPrice: calculatedShippingPrice, // Use server-calculated shipping price
//             totalPrice: calculatedTotalPrice,      // Use server-calculated total price
//             isPaid: false,
//             isDelivered: false,
//             orderStatus: 'pending',
//         });

//         const createdOrder = await order.save({ session });

//         await session.commitTransaction();
//         session.endSession();

//         res.status(201).json(createdOrder);

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error creating order:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });


// // @desc    Update pending orders to processing after some time delay / server check
// // @route   POST /api/orders/update-pending-to-processing
// // @access  Private (called by client's polling timer)
// router.post('/update-pending-to-processing', protect, async (req, res) => {
//     try {
//         // Logic: Find orders that are 'pending', are paid (isPaid: true), 
//         // and where paidAt is older than a set threshold (e.g., 30 minutes for safety, or just transition paid to processing)
        
//         // For simplicity, we transition any 'pending' order that has been successfully paid (isPaid: true)
//         // The client's polling ensures this check happens regularly after the payment might have been verified.
//         const result = await Order.updateMany(
//             { 
//                 orderStatus: 'pending', 
//                 isPaid: true 
//             },
//             { $set: { orderStatus: 'processing' } }
//         );

//         res.json({ 
//             message: `Successfully updated ${result.modifiedCount} paid 'pending' orders to 'processing'.`,
//             count: result.modifiedCount 
//         });
//     } catch (error) {
//         console.error('Error updating pending orders:', error);
//         res.status(500).json({ message: 'Server Error during pending order update' });
//     }
// });


// // @desc    Get logged in user's orders
// // @route   GET /api/orders/my
// // @access  Private
// router.get('/my', protect, async (req, res) => {
//     try {
//         const orders = await Order.find({ user: req.user.id })
//             .populate({
//                 path: 'orderItems.product',
//                 select: 'name imageUrls price stockQuantity vendor',
//                 populate: {
//                     path: 'vendor',
//                     select: 'businessName',
//                 },
//             })
//             .sort({ createdAt: -1 });
//         res.json(orders);
//     } catch (error) {
//         console.error('Error fetching user orders:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });


// // @desc    Get vendor-specific orders
// // @route   GET /api/orders/vendor
// // @access  Private/Vendor
// router.get('/vendor', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
//     try {
//         const orders = await Order.find({ 'orderItems.vendor': req.user.id })
//             .populate('user', 'firstName lastName email phoneNumber')
//             .populate('orderItems.product', 'name imageUrls price stockQuantity')
//             .populate('orderItems.vendor', 'businessName')
//             .sort({ createdAt: -1 });

//         const filteredOrders = orders.map(order => {
//             const vendorSpecificItems = order.orderItems.filter(item =>
//                 item.vendor && item.vendor._id.toString() === req.user.id.toString()
//             );
//             return {
//                 ...order.toObject(),
//                 orderItems: vendorSpecificItems,
//             };
//         });

//         res.json(filteredOrders);
//     } catch (error) {
//         console.error('Error fetching vendor orders:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });

// // ----------------------------------------------------------------------
// //                               WALLET PAYMENT ROUTE 
// // ----------------------------------------------------------------------

// // @desc     Update order to paid + Debit User Wallet + credit vendor (85%) + update metrics
// // @route    PUT /api/orders/:id/pay/wallet
// // @access   Private
// router.put('/:id/pay/wallet', protect, async (req, res) => {
//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         const order = await Order.findById(req.params.id)
//             .populate({
//                 path: 'orderItems.vendor',
//                 select: 'businessName'
//             })
//             .session(session);

//         if (!order) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(404).json({ message: 'Order not found' });
//         }

//         if (order.isPaid) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'Order is already paid' });
//         }

//         // 1. Authorization check
//         if (order.user.toString() !== req.user.id.toString()) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(401).json({ message: 'Not authorized to modify this order' });
//         }
        
//         // 2. Fetch the user (buyer) document within the transaction
//         const buyer = await User.findById(req.user.id).session(session);
//         if (!buyer) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(404).json({ message: 'Buyer user account not found.' });
//         }

//         // 3. Balance check
//         const orderTotal = order.totalPrice; // Total price user must pay
//         if (buyer.userWalletBalance < orderTotal) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ 
//                 message: `Insufficient wallet balance. Required: ₦${orderTotal.toFixed(2)}, Available: ₦${buyer.userWalletBalance.toFixed(2)}`
//             });
//         }
        
//         // 4. Debit the buyer's wallet
//         const updatedBuyer = await User.findByIdAndUpdate(
//             req.user.id,
//             { 
//                 $inc: { userWalletBalance: -orderTotal },
//                 $push: { 
//                     notifications: { 
//                         $each: [{
//                             type: 'wallet_withdrawal',
//                             message: `Order payment of ₦${orderTotal.toFixed(2)} was successfully processed from your wallet.`,
//                             relatedModel: 'Order',
//                             relatedId: order._id,
//                         }],
//                         $position: 0,
//                     },
//                 },
//             },
//             { new: true, session }
//         );

//         // 5. Update order payment status
//         order.isPaid = true;
//         order.paidAt = Date.now();
//         order.paymentResult = {
//             id: 'WALLET-' + Date.now().toString(), // Simple custom ID
//             status: 'successful',
//             payment_type: 'Wallet Balance',
//             amount: orderTotal,
//             currency: 'NGN',
//             email_address: buyer.email,
//         };

//         // 6. Process vendor credits and product updates (Same logic as Flutterwave)
//         const vendorUpdates = new Map();
//         const productUpdates = [];

//         for (const item of order.orderItems) {
//             if (!item.vendor) continue;

//             const vendorId = item.vendor._id.toString();
//             const revenue = item.price * item.quantity; 
//             const vendorEarning = revenue * 0.85;  // 💰 Vendor gets 85% of item subtotal (Hardcoded business rule)
            
//             const soldCount = item.quantity;

//             if (!vendorUpdates.has(vendorId)) {
//                 vendorUpdates.set(vendorId, { revenue: 0, soldCount: 0 });
//             }

//             vendorUpdates.get(vendorId).revenue += vendorEarning;
//             vendorUpdates.get(vendorId).soldCount += soldCount;

//             productUpdates.push(
//                 Product.findByIdAndUpdate(
//                     item.product,
//                     { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
//                     { new: true, session }
//                 )
//             );
//         }

//         await Promise.all(productUpdates);

//         // Apply vendor wallet credits
//         const userUpdatePromises = [];
//         for (const [vendorId, updates] of vendorUpdates.entries()) {
//             userUpdatePromises.push(
//                 User.findByIdAndUpdate(
//                     vendorId,
//                     {
//                         $inc: {
//                             vendorWalletBalance: updates.revenue,
//                             productsSold: updates.soldCount,
//                             productsUnsold: -updates.soldCount, 
//                         },
//                         $push: {
//                             notifications: {
//                                 $each: [
//                                     {
//                                         type: 'payment_received',
//                                         message: `You have received ₦${updates.revenue.toFixed(2)} (after 15% commission) for a new order.`,
//                                         isRead: false,
//                                         createdAt: new Date(),
//                                     },
//                                 ],
//                                 $position: 0,
//                             },
//                         },
//                     },
//                     { new: true, session }
//                 )
//             );
//         }

//         await Promise.all(userUpdatePromises);

//         const updatedOrder = await order.save({ session });
//         await session.commitTransaction();
//         session.endSession();

//         // 7. Success response
//         res.json({
//             ...updatedOrder.toObject(),
//             // Optionally include the new buyer balance for immediate frontend update
//             newBuyerWalletBalance: updatedBuyer.userWalletBalance, 
//         });

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error processing wallet payment for order:', error.message);
//         res.status(500).json({ message: 'Server Error', error: error.message });
//     }
// });


// // @desc     Update order to paid + verify Flutterwave + credit vendor (85%) + update metrics
// // @route    PUT /api/orders/:id/pay
// // @access   Private
// // Note: This route remains dedicated to Card/Bank payments (non-Wallet)
// router.put('/:id/pay', protect, async (req, res) => {
//   const session = await mongoose.startSession();
//   session.startTransaction();

//   try {
//     const order = await Order.findById(req.params.id)
//       .populate({
//         path: 'orderItems.vendor',
//         select: 'businessName'
//       })
//       .session(session);

//     if (!order) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(404).json({ message: 'Order not found' });
//     }

//     if (order.isPaid) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(400).json({ message: 'Order is already paid' });
//     }

//     if (order.user.toString() !== req.user.id.toString()) {
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
//       await Order.deleteOne({ _id: order._id }, { session });
//       await session.commitTransaction();
//       session.endSession();
//       return res.status(400).json({
//         message: 'Payment verification failed and order has been removed.',
//         flutterwave: flwData
//       });
//     }

//     // ✅ Verified — update payment and metrics
//     order.isPaid = true;
//     order.paidAt = Date.now();
//     order.paymentResult = {
//       id: flwData.data.id,
//       status: flwData.data.status,
//       tx_ref: flwData.data.tx_ref,
//       flw_ref: flwData.data.flw_ref,
//       amount: flwData.data.amount,
//       currency: flwData.data.currency,
//       email_address: flwData.data.customer.email,
//     };

//     const vendorUpdates = new Map();
//     const productUpdates = [];

//     // Loop through order items
//     for (const item of order.orderItems) {
//       if (!item.vendor) continue;

//       const vendorId = item.vendor._id.toString();
//       const revenue = item.price * item.quantity;
//       const vendorEarning = revenue * 0.85;   // 💰 Vendor gets 85% (Hardcoded business rule)
//       const commission = revenue * 0.15;      // 💼 Platform keeps 15% (Hardcoded business rule)

//       // TODO: track commission here later (e.g., save to Commission collection)

//       const soldCount = item.quantity;

//       if (!vendorUpdates.has(vendorId)) {
//         vendorUpdates.set(vendorId, { revenue: 0, soldCount: 0 });
//       }

//       vendorUpdates.get(vendorId).revenue += vendorEarning;
//       vendorUpdates.get(vendorId).soldCount += soldCount;

//       productUpdates.push(
//         Product.findByIdAndUpdate(
//           item.product,
//           { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
//           { new: true, session }
//         )
//       );
//     }

//     await Promise.all(productUpdates);

//     // Apply vendor wallet credits
//     const userUpdatePromises = [];
//     for (const [vendorId, updates] of vendorUpdates.entries()) {
//       userUpdatePromises.push(
//         User.findByIdAndUpdate(
//           vendorId,
//           {
//             $inc: {
//               vendorWalletBalance: updates.revenue,
//               productsSold: updates.soldCount,
//               productsUnsold: -updates.soldCount,
//             },
//             $push: {
//               notifications: {
//                 $each: [
//                   {
//                     type: 'payment_received',
//                     message: `You have received ₦${updates.revenue.toFixed(2)} (after 15% commission) for a new order.`,
//                     isRead: false,
//                     createdAt: new Date(),
//                   },
//                 ],
//                 $position: 0,
//               },
//             },
//           },
//           { new: true, session }
//         )
//       );
//     }

//     await Promise.all(userUpdatePromises);

//     const updatedOrder = await order.save({ session });
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


// module.exports = router;
















// const express = require('express');
// const mongoose = require('mongoose');
// const router = express.Router();
// const Order = require('../models/Order');
// const Product = require('../models/Product');
// const User = require('../models/User');
// const { protect, authorizeRoles } = require('../middleware/authMiddleware');
// const axios = require("axios");

// // 👇 START OF ADDITIONS 1: Distance Calculation Utility
// /**
//  * Calculates the distance between two geographical coordinates using the Haversine formula.
//  * @param {number} lat1 Latitude of point 1
//  * @param {number} lon1 Longitude of point 1
//  * @param {number} lat2 Latitude of point 2
//  * @param {number} lon2 Longitude of point 2
//  * @returns {number} Distance in Kilometers
//  */
// function calculateDistance(lat1, lon1, lat2, lon2) {
//     const R = 6371; // Radius of the Earth in kilometers
//     const dLat = (lat2 - lat1) * (Math.PI / 180);
//     const dLon = (lon2 - lon1) * (Math.PI / 180);
//     const a =
//         Math.sin(dLat / 2) * Math.sin(dLat / 2) +
//         Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
//         Math.sin(dLon / 2) * Math.sin(dLon / 2);
//     const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
//     const distance = R * c; // Distance in km
//     return parseFloat(distance.toFixed(2)); // Round to 2 decimal places
// }
// // 👆 END OF ADDITIONS 1

// // @desc    Get all orders (Admin access only)
// // @route   GET /api/orders
// // @access  Private/Admin
// router.get('/', protect, async (req, res) => {
//     try {
//         const orders = await Order.find({})
//             // NEW LINES START HERE
//             .populate('user', 'firstName lastName email phoneNumber') 
//             .populate('orderItems.vendor', 'businessName phoneNumber businessLocation') 
//             // NEW LINES END HERE
//             .sort({ createdAt: -1 });

//         res.status(200).json(orders);
//     } catch (error) {
//         console.error('Error fetching all orders:', error);
//         res.status(500).json({ message: 'Error fetching all orders.', error: error.message });
//     }
// });


// // @desc    Create new order (pending payment)
// // @route   POST /api/orders
// // @access  Private
// router.post('/', protect, async (req, res) => {
//     // MODIFIED: Added userLocation. Removed shippingPrice and totalPrice as they are calculated on the server.
//     const {
//         orderItems,
//         shippingAddress,
//         paymentMethod,
//         serviceFee, 
//         taxPrice, 
//         userLocation, // <-- NEW: User's location for delivery calculation
//     } = req.body;

//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         if (!orderItems || orderItems.length === 0) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'No order items' });
//         }

//         const hasMissingVendor = orderItems.some(item => !item.vendor || item.vendor === '');
//         if (hasMissingVendor) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'One or more order items are missing a vendor ID.' });
//         }

//         for (const item of orderItems) {
//             const product = await Product.findById(item.product).session(session);
//             if (!product) {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(404).json({ message: `Product not found: ${item.name}` });
//             }
//             if (product.stockQuantity < item.quantity) {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(400).json({ message: `Insufficient stock for ${product.name}. Available: ${product.stockQuantity}` });
//             }
//         }

//         // 👇 START OF ADDITIONS 2: Delivery/Price Calculation Logic
//         if (!userLocation || typeof userLocation.latitude === 'undefined' || typeof userLocation.longitude === 'undefined') {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'User delivery location (latitude and longitude) is required.' });
//         }

//         // Get Vendor Location
//         const vendorId = orderItems[0].vendor; // Assumes single-vendor checkout flow for now
//         const vendor = await User.findById(vendorId).session(session);

//         if (!vendor || !vendor.businessLocation) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(404).json({ message: 'Vendor or Vendor business location not found for delivery calculation.' });
//         }
//         
//         // Calculate Distance (in KM)
//         const distanceKm = calculateDistance(
//             vendor.businessLocation.latitude,
//             vendor.businessLocation.longitude,
//             userLocation.latitude,
//             userLocation.longitude
//         );

//         // Calculate Shipping Price (N100 per kilometer)
//         const calculatedShippingPrice = distanceKm * 100;

//         // Calculate Order Subtotal (Sum of all item prices * quantity)
//         const itemsPrice = orderItems.reduce((acc, item) => acc + (item.price * item.quantity), 0);
//         
//         // Calculate Total Price (Subtotal + Shipping Price + Tax)
//         const calculatedTotalPrice = itemsPrice + calculatedShippingPrice + (taxPrice || 0.0);

//         // Ensure serviceFee (commission) is also present, assumed calculated based on itemsPrice * 0.15
//         const finalServiceFee = serviceFee || (itemsPrice * 0.15); // Fallback if serviceFee is missing

//         // 👆 END OF ADDITIONS 2
//         
//         const order = new Order({
//             user: req.user._id,
//             orderItems: orderItems.map(item => ({
//                 product: item.product,
//                 name: item.name,
//                 image: item.image,
//                 quantity: item.quantity,
//                 price: item.price,
//                 vendor: item.vendor,
//             })),
//             shippingAddress,
//             // 👇 START OF ADDITIONS 3: Saving Calculated & Location Fields
//             deliveryDistanceKm: distanceKm,
//             userLocation,
//             vendorLocation: vendor.businessLocation,
//             // 👆 END OF ADDITIONS 3
//             paymentMethod,
//             serviceFee: finalServiceFee, // Use server-calculated or validated fee
//             taxPrice,
//             shippingPrice: calculatedShippingPrice, // Use server-calculated shipping price
//             totalPrice: calculatedTotalPrice,      // Use server-calculated total price
//             isPaid: false,
//             isDelivered: false,
//             orderStatus: 'pending',
//         });

//         const createdOrder = await order.save({ session });

//         await session.commitTransaction();
//         session.endSession();

//         res.status(201).json(createdOrder);

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error creating order:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });


// // @desc    Get logged in user's orders
// // @route   GET /api/orders/my
// // @access  Private
// router.get('/my', protect, async (req, res) => {
//     try {
//         const orders = await Order.find({ user: req.user.id })
//             .populate({
//                 path: 'orderItems.product',
//                 select: 'name imageUrls price stockQuantity vendor',
//                 populate: {
//                     path: 'vendor',
//                     select: 'businessName',
//                 },
//             })
//             .sort({ createdAt: -1 });
//         res.json(orders);
//     } catch (error) {
//         console.error('Error fetching user orders:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });


// // @desc    Get vendor-specific orders
// // @route   GET /api/orders/vendor
// // @access  Private/Vendor
// router.get('/vendor', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
//     try {
//         const orders = await Order.find({ 'orderItems.vendor': req.user.id })
//             .populate('user', 'firstName lastName email phoneNumber')
//             .populate('orderItems.product', 'name imageUrls price stockQuantity')
//             .populate('orderItems.vendor', 'businessName')
//             .sort({ createdAt: -1 });

//         const filteredOrders = orders.map(order => {
//             const vendorSpecificItems = order.orderItems.filter(item =>
//                 item.vendor && item.vendor._id.toString() === req.user.id.toString()
//             );
//             return {
//                 ...order.toObject(),
//                 orderItems: vendorSpecificItems,
//             };
//         });

//         res.json(filteredOrders);
//     } catch (error) {
//         console.error('Error fetching vendor orders:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });

// // ----------------------------------------------------------------------
// //                               WALLET PAYMENT ROUTE 
// // ----------------------------------------------------------------------

// // @desc     Update order to paid + Debit User Wallet + credit vendor (85%) + update metrics
// // @route    PUT /api/orders/:id/pay/wallet
// // @access   Private
// router.put('/:id/pay/wallet', protect, async (req, res) => {
//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         const order = await Order.findById(req.params.id)
//             .populate({
//                 path: 'orderItems.vendor',
//                 select: 'businessName'
//             })
//             .session(session);

//         if (!order) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(404).json({ message: 'Order not found' });
//         }

//         if (order.isPaid) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'Order is already paid' });
//         }

//         // 1. Authorization check
//         if (order.user.toString() !== req.user.id.toString()) {
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
//         const orderTotal = order.totalPrice; // Total price user must pay
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
//             { 
//                 $inc: { userWalletBalance: -orderTotal },
//                 $push: { 
//                     notifications: { 
//                         $each: [{
//                             type: 'wallet_withdrawal',
//                             message: `Order payment of ₦${orderTotal.toFixed(2)} was successfully processed from your wallet.`,
//                             relatedModel: 'Order',
//                             relatedId: order._id,
//                         }],
//                         $position: 0,
//                     },
//                 },
//             },
//             { new: true, session }
//         );

//         // 5. Update order payment status
//         order.isPaid = true;
//         order.paidAt = Date.now();
//         order.paymentResult = {
//             id: 'WALLET-' + Date.now().toString(), // Simple custom ID
//             status: 'successful',
//             payment_type: 'Wallet Balance',
//             amount: orderTotal,
//             currency: 'NGN',
//             email_address: buyer.email,
//         };

//         // 6. Process vendor credits and product updates (Same logic as Flutterwave)
//         const vendorUpdates = new Map();
//         const productUpdates = [];

//         for (const item of order.orderItems) {
//             if (!item.vendor) continue;

//             const vendorId = item.vendor._id.toString();
//             const revenue = item.price * item.quantity; 
//             const vendorEarning = revenue * 0.85;  // 💰 Vendor gets 85% of item subtotal
//             
//             const soldCount = item.quantity;

//             if (!vendorUpdates.has(vendorId)) {
//                 vendorUpdates.set(vendorId, { revenue: 0, soldCount: 0 });
//             }

//             vendorUpdates.get(vendorId).revenue += vendorEarning;
//             vendorUpdates.get(vendorId).soldCount += soldCount;

//             productUpdates.push(
//                 Product.findByIdAndUpdate(
//                     item.product,
//                     { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
//                     { new: true, session }
//                 )
//             );
//         }

//         await Promise.all(productUpdates);

//         // Apply vendor wallet credits
//         const userUpdatePromises = [];
//         for (const [vendorId, updates] of vendorUpdates.entries()) {
//             userUpdatePromises.push(
//                 User.findByIdAndUpdate(
//                     vendorId,
//                     {
//                         $inc: {
//                             vendorWalletBalance: updates.revenue,
//                             productsSold: updates.soldCount,
//                             productsUnsold: -updates.soldCount, 
//                         },
//                         $push: {
//                             notifications: {
//                                 $each: [
//                                     {
//                                         type: 'payment_received',
//                                         message: `You have received ₦${updates.revenue.toFixed(2)} (after 15% commission) for a new order.`,
//                                         isRead: false,
//                                         createdAt: new Date(),
//                                     },
//                                 ],
//                                 $position: 0,
//                             },
//                         },
//                     },
//                     { new: true, session }
//                 )
//             );
//         }

//         await Promise.all(userUpdatePromises);

//         const updatedOrder = await order.save({ session });
//         await session.commitTransaction();
//         session.endSession();

//         // 7. Success response
//         res.json({
//             ...updatedOrder.toObject(),
//             // Optionally include the new buyer balance for immediate frontend update
//             newBuyerWalletBalance: updatedBuyer.userWalletBalance, 
//         });

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error processing wallet payment for order:', error.message);
//         res.status(500).json({ message: 'Server Error', error: error.message });
//     }
// });


// // @desc     Update order to paid + verify Flutterwave + credit vendor (85%) + update metrics
// // @route    PUT /api/orders/:id/pay
// // @access   Private
// // Note: This route remains dedicated to Card/Bank payments (non-Wallet)
// router.put('/:id/pay', protect, async (req, res) => {
//   const session = await mongoose.startSession();
//   session.startTransaction();

//   try {
//     const order = await Order.findById(req.params.id)
//       .populate({
//         path: 'orderItems.vendor',
//         select: 'businessName'
//       })
//       .session(session);

//     if (!order) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(404).json({ message: 'Order not found' });
//     }

//     if (order.isPaid) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(400).json({ message: 'Order is already paid' });
//     }

//     if (order.user.toString() !== req.user.id.toString()) {
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
//       await Order.deleteOne({ _id: order._id }, { session });
//       await session.commitTransaction();
//       session.endSession();
//       return res.status(400).json({
//         message: 'Payment verification failed and order has been removed.',
//         flutterwave: flwData
//       });
//     }

//     // ✅ Verified — update payment and metrics
//     order.isPaid = true;
//     order.paidAt = Date.now();
//     order.paymentResult = {
//       id: flwData.data.id,
//       status: flwData.data.status,
//       tx_ref: flwData.data.tx_ref,
//       flw_ref: flwData.data.flw_ref,
//       amount: flwData.data.amount,
//       currency: flwData.data.currency,
//       email_address: flwData.data.customer.email,
//     };

//     const vendorUpdates = new Map();
//     const productUpdates = [];

//     // Loop through order items
//     for (const item of order.orderItems) {
//       if (!item.vendor) continue;

//       const vendorId = item.vendor._id.toString();
//       const revenue = item.price * item.quantity;
//       const vendorEarning = revenue * 0.85;   // 💰 Vendor gets 85%
//       const commission = revenue * 0.15;      // 💼 Platform keeps 15%

//       // TODO: track commission here later (e.g., save to Commission collection)

//       const soldCount = item.quantity;

//       if (!vendorUpdates.has(vendorId)) {
//         vendorUpdates.set(vendorId, { revenue: 0, soldCount: 0 });
//       }

//       vendorUpdates.get(vendorId).revenue += vendorEarning;
//       vendorUpdates.get(vendorId).soldCount += soldCount;

//       productUpdates.push(
//         Product.findByIdAndUpdate(
//           item.product,
//           { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
//           { new: true, session }
//         )
//       );
//     }

//     await Promise.all(productUpdates);

//     // Apply vendor wallet credits
//     const userUpdatePromises = [];
//     for (const [vendorId, updates] of vendorUpdates.entries()) {
//       userUpdatePromises.push(
//         User.findByIdAndUpdate(
//           vendorId,
//           {
//             $inc: {
//               vendorWalletBalance: updates.revenue,
//               productsSold: updates.soldCount,
//               productsUnsold: -updates.soldCount,
//             },
//             $push: {
//               notifications: {
//                 $each: [
//                   {
//                     type: 'payment_received',
//                     message: `You have received ₦${updates.revenue.toFixed(2)} (after 15% commission) for a new order.`,
//                     isRead: false,
//                     createdAt: new Date(),
//                   },
//                 ],
//                 $position: 0,
//               },
//             },
//           },
//           { new: true, session }
//         )
//       );
//     }

//     await Promise.all(userUpdatePromises);

//     const updatedOrder = await order.save({ session });
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


// module.exports = router;


// const express = require('express');
// const mongoose = require('mongoose');
// const router = express.Router();
// const Order = require('../models/Order');
// const Product = require('../models/Product');
// const User = require('../models/User');
// const { protect, authorizeRoles } = require('../middleware/authMiddleware');
// const axios = require("axios");

// // @desc    Get all orders (Admin access only)
// // @route   GET /api/orders
// // @access  Private/Admin
// router.get('/', protect, async (req, res) => {
//     try {
//         const orders = await Order.find({})
//             // NEW LINES START HERE
//             .populate('user', 'firstName lastName email phoneNumber') 
//             .populate('orderItems.vendor', 'businessName phoneNumber businessLocation') 
//             // NEW LINES END HERE
//             .sort({ createdAt: -1 });

//         res.status(200).json(orders);
//     } catch (error) {
//         console.error('Error fetching all orders:', error);
//         res.status(500).json({ message: 'Error fetching all orders.', error: error.message });
//     }
// });


// // @desc    Create new order (pending payment)
// // @route   POST /api/orders
// // @access  Private
// router.post('/', protect, async (req, res) => {
//     // MODIFIED: Added serviceFee to destructuring
//     const {
//         orderItems,
//         shippingAddress,
//         paymentMethod,
//         serviceFee, // <-- NEW: Added serviceFee
//         taxPrice, // Note: taxPrice seems unused in frontend/logic, kept for compatibility
//         shippingPrice,
//         totalPrice,
//     } = req.body;

//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         if (!orderItems || orderItems.length === 0) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'No order items' });
//         }

//         const hasMissingVendor = orderItems.some(item => !item.vendor || item.vendor === '');
//         if (hasMissingVendor) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'One or more order items are missing a vendor ID.' });
//         }

//         for (const item of orderItems) {
//             const product = await Product.findById(item.product).session(session);
//             if (!product) {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(404).json({ message: `Product not found: ${item.name}` });
//             }
//             if (product.stockQuantity < item.quantity) {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(400).json({ message: `Insufficient stock for ${product.name}. Available: ${product.stockQuantity}` });
//             }
//         }

//         const order = new Order({
//             user: req.user._id,
//             orderItems: orderItems.map(item => ({
//                 product: item.product,
//                 name: item.name,
//                 image: item.image,
//                 quantity: item.quantity,
//                 price: item.price,
//                 vendor: item.vendor,
//             })),
//             shippingAddress,
//             paymentMethod,
//             serviceFee, // <-- NEW: Save serviceFee to the order
//             taxPrice,
//             shippingPrice,
//             totalPrice,
//             isPaid: false,
//             isDelivered: false,
//             orderStatus: 'pending',
//         });

//         const createdOrder = await order.save({ session });

//         await session.commitTransaction();
//         session.endSession();

//         res.status(201).json(createdOrder);

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error creating order:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });


// // @desc    Get logged in user's orders
// // @route   GET /api/orders/my
// // @access  Private
// router.get('/my', protect, async (req, res) => {
//     try {
//         const orders = await Order.find({ user: req.user.id })
//             .populate({
//                 path: 'orderItems.product',
//                 select: 'name imageUrls price stockQuantity vendor',
//                 populate: {
//                     path: 'vendor',
//                     select: 'businessName',
//                 },
//             })
//             .sort({ createdAt: -1 });
//         res.json(orders);
//     } catch (error) {
//         console.error('Error fetching user orders:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });


// // @desc    Get vendor-specific orders
// // @route   GET /api/orders/vendor
// // @access  Private/Vendor
// router.get('/vendor', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
//     try {
//         const orders = await Order.find({ 'orderItems.vendor': req.user.id })
//             .populate('user', 'firstName lastName email phoneNumber')
//             .populate('orderItems.product', 'name imageUrls price stockQuantity')
//             .populate('orderItems.vendor', 'businessName')
//             .sort({ createdAt: -1 });

//         const filteredOrders = orders.map(order => {
//             const vendorSpecificItems = order.orderItems.filter(item =>
//                 item.vendor && item.vendor._id.toString() === req.user.id.toString()
//             );
//             return {
//                 ...order.toObject(),
//                 orderItems: vendorSpecificItems,
//             };
//         });

//         res.json(filteredOrders);
//     } catch (error) {
//         console.error('Error fetching vendor orders:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });

// // ----------------------------------------------------------------------
// //                               NEW WALLET PAYMENT ROUTE 
// // ----------------------------------------------------------------------

// // @desc     Update order to paid + Debit User Wallet + credit vendor (85%) + update metrics
// // @route    PUT /api/orders/:id/pay/wallet
// // @access   Private
// router.put('/:id/pay/wallet', protect, async (req, res) => {
//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         const order = await Order.findById(req.params.id)
//             .populate({
//                 path: 'orderItems.vendor',
//                 select: 'businessName'
//             })
//             .session(session);

//         if (!order) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(404).json({ message: 'Order not found' });
//         }

//         if (order.isPaid) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'Order is already paid' });
//         }

//         // 1. Authorization check
//         if (order.user.toString() !== req.user.id.toString()) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(401).json({ message: 'Not authorized to modify this order' });
//         }
        
//         // 2. Fetch the user (buyer) document within the transaction
//         const buyer = await User.findById(req.user.id).session(session);
//         if (!buyer) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(404).json({ message: 'Buyer user account not found.' });
//         }

//         // 3. Balance check
//         const orderTotal = order.totalPrice; // Total price user must pay
//         if (buyer.userWalletBalance < orderTotal) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ 
//                 message: `Insufficient wallet balance. Required: ₦${orderTotal.toFixed(2)}, Available: ₦${buyer.userWalletBalance.toFixed(2)}`
//             });
//         }
        
//         // 4. Debit the buyer's wallet
//         const updatedBuyer = await User.findByIdAndUpdate(
//             req.user.id,
//             { 
//                 $inc: { userWalletBalance: -orderTotal },
//                 $push: { 
//                     notifications: { 
//                         $each: [{
//                             type: 'wallet_withdrawal',
//                             message: `Order payment of ₦${orderTotal.toFixed(2)} was successfully processed from your wallet.`,
//                             relatedModel: 'Order',
//                             relatedId: order._id,
//                         }],
//                         $position: 0,
//                     },
//                 },
//             },
//             { new: true, session }
//         );

//         // 5. Update order payment status
//         order.isPaid = true;
//         order.paidAt = Date.now();
//         order.paymentResult = {
//             id: 'WALLET-' + Date.now().toString(), // Simple custom ID
//             status: 'successful',
//             payment_type: 'Wallet Balance',
//             amount: orderTotal,
//             currency: 'NGN',
//             email_address: buyer.email,
//         };

//         // 6. Process vendor credits and product updates (Same logic as Flutterwave)
//         const vendorUpdates = new Map();
//         const productUpdates = [];

//         for (const item of order.orderItems) {
//             if (!item.vendor) continue;

//             const vendorId = item.vendor._id.toString();
//             // Note: serviceFee is now captured in order object but not used for commission base here
//             // Commission should be based on the product price * quantity (the subtotal part)
//             const revenue = item.price * item.quantity; 
//             const vendorEarning = revenue * 0.85;  // 💰 Vendor gets 85% of item subtotal
//             // const commission = revenue * 0.15; // Platform keeps 15% (This is tracked via the serviceFee logic)

//             const soldCount = item.quantity;

//             if (!vendorUpdates.has(vendorId)) {
//                 vendorUpdates.set(vendorId, { revenue: 0, soldCount: 0 });
//             }

//             vendorUpdates.get(vendorId).revenue += vendorEarning;
//             vendorUpdates.get(vendorId).soldCount += soldCount;

//             productUpdates.push(
//                 Product.findByIdAndUpdate(
//                     item.product,
//                     { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
//                     { new: true, session }
//                 )
//             );
//         }

//         await Promise.all(productUpdates);

//         // Apply vendor wallet credits
//         const userUpdatePromises = [];
//         for (const [vendorId, updates] of vendorUpdates.entries()) {
//             userUpdatePromises.push(
//                 User.findByIdAndUpdate(
//                     vendorId,
//                     {
//                         $inc: {
//                             vendorWalletBalance: updates.revenue,
//                             productsSold: updates.soldCount,
//                             // Note: productsUnsold should be decremented when the product is sold
//                             // Assuming productsUnsold tracks active inventory
//                             productsUnsold: -updates.soldCount, 
//                         },
//                         $push: {
//                             notifications: {
//                                 $each: [
//                                     {
//                                         type: 'payment_received',
//                                         message: `You have received ₦${updates.revenue.toFixed(2)} (after 15% commission) for a new order.`,
//                                         isRead: false,
//                                         createdAt: new Date(),
//                                     },
//                                 ],
//                                 $position: 0,
//                             },
//                         },
//                     },
//                     { new: true, session }
//                 )
//             );
//         }

//         await Promise.all(userUpdatePromises);

//         const updatedOrder = await order.save({ session });
//         await session.commitTransaction();
//         session.endSession();

//         // 7. Success response
//         res.json({
//             ...updatedOrder.toObject(),
//             // Optionally include the new buyer balance for immediate frontend update
//             newBuyerWalletBalance: updatedBuyer.userWalletBalance, 
//         });

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error processing wallet payment for order:', error.message);
//         res.status(500).json({ message: 'Server Error', error: error.message });
//     }
// });


// // @desc     Update order to paid + verify Flutterwave + credit vendor (85%) + update metrics
// // @route    PUT /api/orders/:id/pay
// // @access   Private
// // Note: This route remains unchanged, but is now dedicated to Card/Bank payments (non-Wallet)
// router.put('/:id/pay', protect, async (req, res) => {
//   const session = await mongoose.startSession();
//   session.startTransaction();

//   try {
//     const order = await Order.findById(req.params.id)
//       .populate({
//         path: 'orderItems.vendor',
//         select: 'businessName'
//       })
//       .session(session);

//     if (!order) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(404).json({ message: 'Order not found' });
//     }

//     if (order.isPaid) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(400).json({ message: 'Order is already paid' });
//     }

//     if (order.user.toString() !== req.user.id.toString()) {
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
//       await Order.deleteOne({ _id: order._id }, { session });
//       await session.commitTransaction();
//       session.endSession();
//       return res.status(400).json({
//         message: 'Payment verification failed and order has been removed.',
//         flutterwave: flwData
//       });
//     }

//     // ✅ Verified — update payment and metrics
//     order.isPaid = true;
//     order.paidAt = Date.now();
//     order.paymentResult = {
//       id: flwData.data.id,
//       status: flwData.data.status,
//       tx_ref: flwData.data.tx_ref,
//       flw_ref: flwData.data.flw_ref,
//       amount: flwData.data.amount,
//       currency: flwData.data.currency,
//       email_address: flwData.data.customer.email,
//     };

//     const vendorUpdates = new Map();
//     const productUpdates = [];

//     // Loop through order items
//     for (const item of order.orderItems) {
//       if (!item.vendor) continue;

//       const vendorId = item.vendor._id.toString();
//       const revenue = item.price * item.quantity;
//       const vendorEarning = revenue * 0.85;   // 💰 Vendor gets 85%
//       const commission = revenue * 0.15;      // 💼 Platform keeps 15%

//       // TODO: track commission here later (e.g., save to Commission collection)

//       const soldCount = item.quantity;

//       if (!vendorUpdates.has(vendorId)) {
//         vendorUpdates.set(vendorId, { revenue: 0, soldCount: 0 });
//       }

//       vendorUpdates.get(vendorId).revenue += vendorEarning;
//       vendorUpdates.get(vendorId).soldCount += soldCount;

//       productUpdates.push(
//         Product.findByIdAndUpdate(
//           item.product,
//           { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
//           { new: true, session }
//         )
//       );
//     }

//     await Promise.all(productUpdates);

//     // Apply vendor wallet credits
//     const userUpdatePromises = [];
//     for (const [vendorId, updates] of vendorUpdates.entries()) {
//       userUpdatePromises.push(
//         User.findByIdAndUpdate(
//           vendorId,
//           {
//             $inc: {
//               vendorWalletBalance: updates.revenue,
//               productsSold: updates.soldCount,
//               productsUnsold: -updates.soldCount,
//             },
//             $push: {
//               notifications: {
//                 $each: [
//                   {
//                     type: 'payment_received',
//                     message: `You have received ₦${updates.revenue.toFixed(2)} (after 15% commission) for a new order.`,
//                     isRead: false,
//                     createdAt: new Date(),
//                   },
//                 ],
//                 $position: 0,
//               },
//             },
//           },
//           { new: true, session }
//         )
//       );
//     }

//     await Promise.all(userUpdatePromises);

//     const updatedOrder = await order.save({ session });
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


// module.exports = router;




// const express = require('express');
// const mongoose = require('mongoose');
// const router = express.Router();
// const Order = require('../models/Order');
// const Product = require('../models/Product');
// const User = require('../models/User');
// const { protect, authorizeRoles } = require('../middleware/authMiddleware');
// const axios = require("axios");

// // @desc    Get all orders (Admin access only)
// // @route   GET /api/orders
// // @access  Private/Admin
// router.get('/', protect, async (req, res) => {
//     try {
//          const orders = await Order.find({})
//             // NEW LINES START HERE
//             .populate('user', 'firstName lastName email phoneNumber') 
//             .populate('orderItems.vendor', 'businessName phoneNumber businessLocation') 
//             // NEW LINES END HERE
//             .sort({ createdAt: -1 });

//         res.status(200).json(orders);
//         // const orders = await Order.find({})
//         //     .populate('user', 'firstName lastName email');
//         // res.status(200).json(orders);
//     } catch (error) {
//         console.error('Error fetching all orders:', error);
//         res.status(500).json({ message: 'Error fetching all orders.', error: error.message });
//     }
// });


// // @desc    Create new order (pending payment)
// // @route   POST /api/orders
// // @access  Private
// router.post('/', protect, async (req, res) => {
//     const {
//         orderItems,
//         shippingAddress,
//         paymentMethod,
//         taxPrice,
//         shippingPrice,
//         totalPrice,
//     } = req.body;

//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         if (!orderItems || orderItems.length === 0) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'No order items' });
//         }

//         const hasMissingVendor = orderItems.some(item => !item.vendor || item.vendor === '');
//         if (hasMissingVendor) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'One or more order items are missing a vendor ID.' });
//         }

//         for (const item of orderItems) {
//             const product = await Product.findById(item.product).session(session);
//             if (!product) {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(404).json({ message: `Product not found: ${item.name}` });
//             }
//             if (product.stockQuantity < item.quantity) {
//                 await session.abortTransaction();
//                 session.endSession();
//                 return res.status(400).json({ message: `Insufficient stock for ${product.name}. Available: ${product.stockQuantity}` });
//             }
//         }

//         const order = new Order({
//             user: req.user._id,
//             orderItems: orderItems.map(item => ({
//                 product: item.product,
//                 name: item.name,
//                 image: item.image,
//                 quantity: item.quantity,
//                 price: item.price,
//                 vendor: item.vendor,
//             })),
//             shippingAddress,
//             paymentMethod,
//             taxPrice,
//             shippingPrice,
//             totalPrice,
//             isPaid: false,
//             isDelivered: false,
//             orderStatus: 'pending',
//         });

//         const createdOrder = await order.save({ session });

//         await session.commitTransaction();
//         session.endSession();

//         res.status(201).json(createdOrder);

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error creating order:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });


// // @desc    Get logged in user's orders
// // @route   GET /api/orders/my
// // @access  Private
// router.get('/my', protect, async (req, res) => {
//     try {
//         const orders = await Order.find({ user: req.user.id })
//             .populate({
//                 path: 'orderItems.product',
//                 select: 'name imageUrls price stockQuantity vendor',
//                 populate: {
//                     path: 'vendor',
//                     select: 'businessName',
//                 },
//             })
//             .sort({ createdAt: -1 });
//         res.json(orders);
//     } catch (error) {
//         console.error('Error fetching user orders:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });


// // @desc    Get vendor-specific orders
// // @route   GET /api/orders/vendor
// // @access  Private/Vendor
// router.get('/vendor', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
//     try {
//         const orders = await Order.find({ 'orderItems.vendor': req.user.id })
//             .populate('user', 'firstName lastName email phoneNumber')
//             .populate('orderItems.product', 'name imageUrls price stockQuantity')
//             .populate('orderItems.vendor', 'businessName')
//             .sort({ createdAt: -1 });

//         const filteredOrders = orders.map(order => {
//             const vendorSpecificItems = order.orderItems.filter(item =>
//                 item.vendor && item.vendor._id.toString() === req.user.id.toString()
//             );
//             return {
//                 ...order.toObject(),
//                 orderItems: vendorSpecificItems,
//             };
//         });

//         res.json(filteredOrders);
//     } catch (error) {
//         console.error('Error fetching vendor orders:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });


// // @desc     Update order to paid + verify Flutterwave + credit vendor (85%) + update metrics
// // @route    PUT /api/orders/:id/pay
// // @access   Private
// router.put('/:id/pay', protect, async (req, res) => {
//   const session = await mongoose.startSession();
//   session.startTransaction();

//   try {
//     const order = await Order.findById(req.params.id)
//       .populate({
//         path: 'orderItems.vendor',
//         select: 'businessName'
//       })
//       .session(session);

//     if (!order) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(404).json({ message: 'Order not found' });
//     }

//     if (order.isPaid) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(400).json({ message: 'Order is already paid' });
//     }

//     if (order.user.toString() !== req.user.id.toString()) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(401).json({ message: 'Not authorized to modify this order' });
//     }

//     const { transaction_id } = req.body;
//     if (!transaction_id) {
//       await session.abortTransaction();
//       session.endSession();
//       return res.status(400).json({ message: 'Transaction ID is required' });
//     }

//     // ✅ Verify payment with Flutterwave
//     const flwResponse = await axios.get(
//       `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
//       {
//         headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` }
//       }
//     );

//     const flwData = flwResponse.data;

//     // ❌ If verification fails, remove order
//     if (flwData.status !== "success" || flwData.data.status !== "successful") {
//       await Order.deleteOne({ _id: order._id }, { session });
//       await session.commitTransaction();
//       session.endSession();
//       return res.status(400).json({
//         message: 'Payment verification failed and order has been removed.',
//         flutterwave: flwData
//       });
//     }

//     // ✅ Verified — update payment and metrics
//     order.isPaid = true;
//     order.paidAt = Date.now();
//     order.paymentResult = {
//       id: flwData.data.id,
//       status: flwData.data.status,
//       tx_ref: flwData.data.tx_ref,
//       flw_ref: flwData.data.flw_ref,
//       amount: flwData.data.amount,
//       currency: flwData.data.currency,
//       email_address: flwData.data.customer.email,
//     };

//     const vendorUpdates = new Map();
//     const productUpdates = [];

//     // Loop through order items
//     for (const item of order.orderItems) {
//       if (!item.vendor) continue;

//       const vendorId = item.vendor._id.toString();
//       const revenue = item.price * item.quantity;
//       const vendorEarning = revenue * 0.85;   // 💰 Vendor gets 85%
//       const commission = revenue * 0.15;      // 💼 Platform keeps 15%

//       // TODO: track commission here later (e.g., save to Commission collection)

//       const soldCount = item.quantity;

//       if (!vendorUpdates.has(vendorId)) {
//         vendorUpdates.set(vendorId, { revenue: 0, soldCount: 0 });
//       }

//       vendorUpdates.get(vendorId).revenue += vendorEarning;
//       vendorUpdates.get(vendorId).soldCount += soldCount;

//       productUpdates.push(
//         Product.findByIdAndUpdate(
//           item.product,
//           { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
//           { new: true, session }
//         )
//       );
//     }

//     await Promise.all(productUpdates);

//     // Apply vendor wallet credits
//     const userUpdatePromises = [];
//     for (const [vendorId, updates] of vendorUpdates.entries()) {
//       userUpdatePromises.push(
//         User.findByIdAndUpdate(
//           vendorId,
//           {
//             $inc: {
//               vendorWalletBalance: updates.revenue,
//               productsSold: updates.soldCount,
//               productsUnsold: -updates.soldCount,
//             },
//             $push: {
//               notifications: {
//                 $each: [
//                   {
//                     type: 'payment_received',
//                     message: `You have received ₦${updates.revenue.toFixed(2)} (after 15% commission) for a new order.`,
//                     isRead: false,
//                     createdAt: new Date(),
//                   },
//                 ],
//                 $position: 0,
//               },
//             },
//           },
//           { new: true, session }
//         )
//       );
//     }

//     await Promise.all(userUpdatePromises);

//     const updatedOrder = await order.save({ session });
//     await session.commitTransaction();
//     session.endSession();

//     res.json(updatedOrder);

//   } catch (error) {
//     await session.abortTransaction();
//     session.endSession();
//     console.error('Error verifying payment and updating order:', error.response?.data || error.message);
//     res.status(500).json({ message: 'Server Error', error: error.response?.data || error.message });
//   }
// });





// @desc    Update order to paid + verify Flutterwave + credit vendor + update metrics
// @route   PUT /api/orders/:id/pay
// @access  Private
// router.put('/:id/pay', protect, async (req, res) => {
//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         const order = await Order.findById(req.params.id)
//             .populate({
//                 path: 'orderItems.vendor',
//                 select: 'businessName'
//             })
//             .session(session);

//         if (!order) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(404).json({ message: 'Order not found' });
//         }

//         if (order.isPaid) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'Order is already paid' });
//         }

//         if (order.user.toString() !== req.user.id.toString()) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(401).json({ message: 'Not authorized to modify this order' });
//         }

//         const { transaction_id } = req.body;
//         if (!transaction_id) {
//             await session.abortTransaction();
//             session.endSession();
//             return res.status(400).json({ message: 'Transaction ID is required' });
//         }

//         const flwResponse = await axios.get(
//             `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
//             {
//                 headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` }
//             }
//         );

//         const flwData = flwResponse.data;

//         // ✅ IMPORTANT: If verification fails, delete the order to prevent orphaned data.
//         if (flwData.status !== "success" || flwData.data.status !== "successful") {
//             // Delete the order record because the payment failed
//             await Order.deleteOne({ _id: order._id }, { session });
//             await session.commitTransaction();
//             session.endSession();
//             return res.status(400).json({
//                 message: 'Payment verification failed and order has been removed.',
//                 flutterwave: flwData
//             });
//         }

//         // If verified, proceed with updating the order and user/product data
//         order.isPaid = true;
//         order.paidAt = Date.now();
//         order.paymentResult = {
//             id: flwData.data.id,
//             status: flwData.data.status,
//             tx_ref: flwData.data.tx_ref,
//             flw_ref: flwData.data.flw_ref,
//             amount: flwData.data.amount,
//             currency: flwData.data.currency,
//             email_address: flwData.data.customer.email,
//         };

//         const vendorUpdates = new Map();
//         const productUpdates = [];

//         for (const item of order.orderItems) {
//             if (!item.vendor) continue;

//             const vendorId = item.vendor._id.toString();
//             const revenue = item.price * item.quantity;
//             const soldCount = item.quantity;

//             if (!vendorUpdates.has(vendorId)) {
//                 vendorUpdates.set(vendorId, { revenue: 0, soldCount: 0 });
//             }
//             vendorUpdates.get(vendorId).revenue += revenue;
//             vendorUpdates.get(vendorId).soldCount += soldCount;

//             productUpdates.push(
//                 Product.findByIdAndUpdate(
//                     item.product,
//                     { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
//                     { new: true, session }
//                 )
//             );
//         }

//         await Promise.all(productUpdates);

//         const userUpdatePromises = [];
//         for (const [vendorId, updates] of vendorUpdates.entries()) {
//             userUpdatePromises.push(
//                 User.findByIdAndUpdate(
//                     vendorId,
//                     {
//                         $inc: {
//                             vendorWalletBalance: updates.revenue,
//                             productsSold: updates.soldCount,
//                             productsUnsold: -updates.soldCount,
//                         },
//                         $push: {
//                             notifications: {
//                                 $each: [{
//                                     type: 'payment_received',
//                                     message: `You have received ₦${updates.revenue.toFixed(2)} for a new order.`,
//                                     isRead: false,
//                                     createdAt: new Date(),
//                                 }],
//                                 $position: 0,
//                             },
//                         },
//                     },
//                     { new: true, session }
//                 )
//             );
//         }

//         await Promise.all(userUpdatePromises);

//         const updatedOrder = await order.save({ session });
//         await session.commitTransaction();
//         session.endSession();

//         res.json(updatedOrder);

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error verifying payment and updating order:', error.response?.data || error.message);
//         res.status(500).json({ message: 'Server Error', error: error.response?.data || error.message });
//     }
// });

// @desc    Update order status by dispatch rider
// @route   PUT /api/orders/:id/dispatch-status
// @access  Private/Dispatch
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


// @desc    Update order status (Vendor/Admin)
// @route   PUT /api/orders/:id/status
// @access  Private/Vendor/Admin
router.put('/:id/status', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
    const { status } = req.body;
    
    if (!['pending', 'processing', 'shipped', 'delivered', 'cancelled'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status provided.' });
    }

    try {
        const order = await Order.findById(req.params.id);

        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        const isAuthorizedVendor = order.orderItems.some(item =>
            item.vendor && item.vendor._id.toString() === req.user.id.toString()
        );

        if (!req.user.isAdmin && !isAuthorizedVendor) {
            return res.status(403).json({ message: 'Not authorized to update this order status' });
        }
        
        switch (status) {
            case 'processing':
                if (order.orderStatus === 'pending' || order.orderStatus === 'processing') {
                    order.orderStatus = 'processing';
                } else {
                    return res.status(400).json({ message: `Invalid status transition from '${order.orderStatus}' to 'processing'` });
                }
                break;
            case 'shipped':
                if (order.orderStatus === 'pending' || order.orderStatus === 'processing' || req.user.isAdmin) {
                    order.orderStatus = 'shipped';
                } else {
                    return res.status(400).json({ message: `Invalid status transition from '${order.orderStatus}' to 'shipped'` });
                }
                break;
            case 'delivered':
                if (order.orderStatus === 'shipped' || req.user.isAdmin) {
                    order.orderStatus = 'delivered';
                    order.isDelivered = true;
                    order.deliveredAt = Date.now();
                } else {
                    return res.status(400).json({ message: `Invalid status transition from '${order.orderStatus}' to 'delivered'` });
                }
                break;
            case 'cancelled':
                if (order.orderStatus !== 'delivered') {
                    order.orderStatus = 'cancelled';
                } else {
                    return res.status(400).json({ message: `Cannot cancel a '${order.orderStatus}' order.` });
                }
                break;
            default:
                if (req.user.isAdmin) {
                    order.orderStatus = status;
                } else {
                    return res.status(400).json({ message: `Invalid status transition or insufficient permissions` });
                }
                break;
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


// @desc    Get single order by ID
// @route   GET /api/orders/:id
// @access  Private
router.get('/:id', protect, async (req, res) => {
    try {
        const order = await Order.findById(req.params.id)
            .populate('user', 'firstName lastName email phoneNumber')
            .populate('orderItems.product', 'name imageUrls price stockQuantity')
            .populate('orderItems.vendor', 'businessName');

        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        const isOwner = order.user.toString() === req.user.id.toString();
        const isAdmin = req.user.isAdmin;
        const isDispatchRider = req.user.role === 'dispatch';
        const isVendor = order.orderItems.some(item =>
            item.vendor && item.vendor._id.toString() === req.user.id.toString()
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


// @desc    All orders for Admin
// @route   GET /api/orders/admin
// @access  Private/Admin
router.get('/admin', protect, authorizeRoles('admin'), async (req, res) => {
    try {
        const orders = await Order.find({})
            .populate('user', 'firstName lastName email phoneNumber')
            .populate('orderItems.product', 'name imageUrls price stockQuantity')
            .populate('orderItems.vendor', 'businessName')
            .sort({ createdAt: -1 });

        res.json(orders);
    } catch (error) {
        console.error('Error fetching all orders for admin:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});


module.exports = router;