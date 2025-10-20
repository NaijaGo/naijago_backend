const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const axios = require("axios");

// 👇 START OF ADDITIONS 1: Distance Calculation Utility
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

// @desc    Get all orders (Admin access only)
// @route   GET /api/orders
// @access  Private/Admin
router.get('/', protect, async (req, res) => {
    try {
        const orders = await Order.find({})
            // NEW LINES START HERE
            .populate('user', 'firstName lastName email phoneNumber') 
            .populate('orderItems.vendor', 'businessName phoneNumber businessLocation') 
            // NEW LINES END HERE
            .sort({ createdAt: -1 });

        res.status(200).json(orders);
    } catch (error) {
        console.error('Error fetching all orders:', error);
        res.status(500).json({ message: 'Error fetching all orders.', error: error.message });
    }
});


// @desc    Create new order (pending payment)
// @route   POST /api/orders
// @access  Private
router.post('/', protect, async (req, res) => {
    // MODIFIED: Added userLocation. Removed shippingPrice and totalPrice as they are calculated on the server.
    const {
        orderItems,
        shippingAddress,
        paymentMethod,
        serviceFee, 
        taxPrice, 
        userLocation, // <-- NEW: User's location for delivery calculation
    } = req.body;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        if (!orderItems || orderItems.length === 0) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'No order items' });
        }

        const hasMissingVendor = orderItems.some(item => !item.vendor || item.vendor === '');
        if (hasMissingVendor) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'One or more order items are missing a vendor ID.' });
        }

        for (const item of orderItems) {
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

        // 👇 START OF ADDITIONS 2: Delivery/Price Calculation Logic
        if (!userLocation || typeof userLocation.latitude === 'undefined' || typeof userLocation.longitude === 'undefined') {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'User delivery location (latitude and longitude) is required.' });
        }

        // Get Vendor Location
        const vendorId = orderItems[0].vendor; // Assumes single-vendor checkout flow for now
        const vendor = await User.findById(vendorId).session(session);

        if (!vendor || !vendor.businessLocation) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Vendor or Vendor business location not found for delivery calculation.' });
        }
        
        // Calculate Distance (in KM)
        const distanceKm = calculateDistance(
            vendor.businessLocation.latitude,
            vendor.businessLocation.longitude,
            userLocation.latitude,
            userLocation.longitude
        );

        // Calculate Shipping Price (N100 per kilometer - Hardcoded business rule)
        const calculatedShippingPrice = distanceKm * 100;

        // Calculate Order Subtotal (Sum of all item prices * quantity)
        const itemsPrice = orderItems.reduce((acc, item) => acc + (item.price * item.quantity), 0);
        
        // Calculate Total Price (Subtotal + Shipping Price + Tax)
        const calculatedTotalPrice = itemsPrice + calculatedShippingPrice + (taxPrice || 0.0);

        // Ensure serviceFee (commission) is also present, assumed calculated based on itemsPrice * 0.15 (Hardcoded business rule)
        const finalServiceFee = serviceFee || (itemsPrice * 0.15); // Fallback if serviceFee is missing

        // 👆 END OF ADDITIONS 2
        
        const order = new Order({
            user: req.user._id,
            orderItems: orderItems.map(item => ({
                product: item.product,
                name: item.name,
                image: item.image,
                quantity: item.quantity,
                price: item.price,
                vendor: item.vendor,
            })),
            shippingAddress,
            // 👇 START OF ADDITIONS 3: Saving Calculated & Location Fields
            deliveryDistanceKm: distanceKm,
            userLocation,
            vendorLocation: vendor.businessLocation,
            // 👆 END OF ADDITIONS 3
            paymentMethod,
            serviceFee: finalServiceFee, // Use server-calculated or validated fee
            taxPrice,
            shippingPrice: calculatedShippingPrice, // Use server-calculated shipping price
            totalPrice: calculatedTotalPrice,      // Use server-calculated total price
            isPaid: false,
            isDelivered: false,
            orderStatus: 'pending',
        });

        const createdOrder = await order.save({ session });

        await session.commitTransaction();
        session.endSession();

        res.status(201).json(createdOrder);

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error creating order:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});


// @desc    Update pending orders to processing after some time delay / server check
// @route   POST /api/orders/update-pending-to-processing
// @access  Private (called by client's polling timer)
router.post('/update-pending-to-processing', protect, async (req, res) => {
    try {
        // Logic: Find orders that are 'pending', are paid (isPaid: true), 
        // and where paidAt is older than a set threshold (e.g., 30 minutes for safety, or just transition paid to processing)
        
        // For simplicity, we transition any 'pending' order that has been successfully paid (isPaid: true)
        // The client's polling ensures this check happens regularly after the payment might have been verified.
        const result = await Order.updateMany(
            { 
                orderStatus: 'pending', 
                isPaid: true 
            },
            { $set: { orderStatus: 'processing' } }
        );

        res.json({ 
            message: `Successfully updated ${result.modifiedCount} paid 'pending' orders to 'processing'.`,
            count: result.modifiedCount 
        });
    } catch (error) {
        console.error('Error updating pending orders:', error);
        res.status(500).json({ message: 'Server Error during pending order update' });
    }
});


// @desc    Get logged in user's orders
// @route   GET /api/orders/my
// @access  Private
router.get('/my', protect, async (req, res) => {
    try {
        const orders = await Order.find({ user: req.user.id })
            .populate({
                path: 'orderItems.product',
                select: 'name imageUrls price stockQuantity vendor',
                populate: {
                    path: 'vendor',
                    select: 'businessName',
                },
            })
            .sort({ createdAt: -1 });
        res.json(orders);
    } catch (error) {
        console.error('Error fetching user orders:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});


// @desc    Get vendor-specific orders
// @route   GET /api/orders/vendor
// @access  Private/Vendor
router.get('/vendor', protect, authorizeRoles('vendor', 'admin'), async (req, res) => {
    try {
        const orders = await Order.find({ 'orderItems.vendor': req.user.id })
            .populate('user', 'firstName lastName email phoneNumber')
            .populate('orderItems.product', 'name imageUrls price stockQuantity')
            .populate('orderItems.vendor', 'businessName')
            .sort({ createdAt: -1 });

        const filteredOrders = orders.map(order => {
            const vendorSpecificItems = order.orderItems.filter(item =>
                item.vendor && item.vendor._id.toString() === req.user.id.toString()
            );
            return {
                ...order.toObject(),
                orderItems: vendorSpecificItems,
            };
        });

        res.json(filteredOrders);
    } catch (error) {
        console.error('Error fetching vendor orders:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ----------------------------------------------------------------------
//                               WALLET PAYMENT ROUTE 
// ----------------------------------------------------------------------

// @desc     Update order to paid + Debit User Wallet + credit vendor (85%) + update metrics
// @route    PUT /api/orders/:id/pay/wallet
// @access   Private
router.put('/:id/pay/wallet', protect, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const order = await Order.findById(req.params.id)
            .populate({
                path: 'orderItems.vendor',
                select: 'businessName'
            })
            .session(session);

        if (!order) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Order not found' });
        }

        if (order.isPaid) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Order is already paid' });
        }

        // 1. Authorization check
        if (order.user.toString() !== req.user.id.toString()) {
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
        const orderTotal = order.totalPrice; // Total price user must pay
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
            { 
                $inc: { userWalletBalance: -orderTotal },
                $push: { 
                    notifications: { 
                        $each: [{
                            type: 'wallet_withdrawal',
                            message: `Order payment of ₦${orderTotal.toFixed(2)} was successfully processed from your wallet.`,
                            relatedModel: 'Order',
                            relatedId: order._id,
                        }],
                        $position: 0,
                    },
                },
            },
            { new: true, session }
        );

        // 5. Update order payment status
        order.isPaid = true;
        order.paidAt = Date.now();
        order.paymentResult = {
            id: 'WALLET-' + Date.now().toString(), // Simple custom ID
            status: 'successful',
            payment_type: 'Wallet Balance',
            amount: orderTotal,
            currency: 'NGN',
            email_address: buyer.email,
        };

        // 6. Process vendor credits and product updates (Same logic as Flutterwave)
        const vendorUpdates = new Map();
        const productUpdates = [];

        for (const item of order.orderItems) {
            if (!item.vendor) continue;

            const vendorId = item.vendor._id.toString();
            const revenue = item.price * item.quantity; 
            const vendorEarning = revenue * 0.85;  // 💰 Vendor gets 85% of item subtotal (Hardcoded business rule)
            
            const soldCount = item.quantity;

            if (!vendorUpdates.has(vendorId)) {
                vendorUpdates.set(vendorId, { revenue: 0, soldCount: 0 });
            }

            vendorUpdates.get(vendorId).revenue += vendorEarning;
            vendorUpdates.get(vendorId).soldCount += soldCount;

            productUpdates.push(
                Product.findByIdAndUpdate(
                    item.product,
                    { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
                    { new: true, session }
                )
            );
        }

        await Promise.all(productUpdates);

        // Apply vendor wallet credits
        const userUpdatePromises = [];
        for (const [vendorId, updates] of vendorUpdates.entries()) {
            userUpdatePromises.push(
                User.findByIdAndUpdate(
                    vendorId,
                    {
                        $inc: {
                            vendorWalletBalance: updates.revenue,
                            productsSold: updates.soldCount,
                            productsUnsold: -updates.soldCount, 
                        },
                        $push: {
                            notifications: {
                                $each: [
                                    {
                                        type: 'payment_received',
                                        message: `You have received ₦${updates.revenue.toFixed(2)} (after 15% commission) for a new order.`,
                                        isRead: false,
                                        createdAt: new Date(),
                                    },
                                ],
                                $position: 0,
                            },
                        },
                    },
                    { new: true, session }
                )
            );
        }

        await Promise.all(userUpdatePromises);

        const updatedOrder = await order.save({ session });
        await session.commitTransaction();
        session.endSession();

        // 7. Success response
        res.json({
            ...updatedOrder.toObject(),
            // Optionally include the new buyer balance for immediate frontend update
            newBuyerWalletBalance: updatedBuyer.userWalletBalance, 
        });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Error processing wallet payment for order:', error.message);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
});


// @desc     Update order to paid + verify Flutterwave + credit vendor (85%) + update metrics
// @route    PUT /api/orders/:id/pay
// @access   Private
// Note: This route remains dedicated to Card/Bank payments (non-Wallet)
router.put('/:id/pay', protect, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findById(req.params.id)
      .populate({
        path: 'orderItems.vendor',
        select: 'businessName'
      })
      .session(session);

    if (!order) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Order not found' });
    }

    if (order.isPaid) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Order is already paid' });
    }

    if (order.user.toString() !== req.user.id.toString()) {
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
      await Order.deleteOne({ _id: order._id }, { session });
      await session.commitTransaction();
      session.endSession();
      return res.status(400).json({
        message: 'Payment verification failed and order has been removed.',
        flutterwave: flwData
      });
    }

    // ✅ Verified — update payment and metrics
    order.isPaid = true;
    order.paidAt = Date.now();
    order.paymentResult = {
      id: flwData.data.id,
      status: flwData.data.status,
      tx_ref: flwData.data.tx_ref,
      flw_ref: flwData.data.flw_ref,
      amount: flwData.data.amount,
      currency: flwData.data.currency,
      email_address: flwData.data.customer.email,
    };

    const vendorUpdates = new Map();
    const productUpdates = [];

    // Loop through order items
    for (const item of order.orderItems) {
      if (!item.vendor) continue;

      const vendorId = item.vendor._id.toString();
      const revenue = item.price * item.quantity;
      const vendorEarning = revenue * 0.85;   // 💰 Vendor gets 85% (Hardcoded business rule)
      const commission = revenue * 0.15;      // 💼 Platform keeps 15% (Hardcoded business rule)

      // TODO: track commission here later (e.g., save to Commission collection)

      const soldCount = item.quantity;

      if (!vendorUpdates.has(vendorId)) {
        vendorUpdates.set(vendorId, { revenue: 0, soldCount: 0 });
      }

      vendorUpdates.get(vendorId).revenue += vendorEarning;
      vendorUpdates.get(vendorId).soldCount += soldCount;

      productUpdates.push(
        Product.findByIdAndUpdate(
          item.product,
          { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
          { new: true, session }
        )
      );
    }

    await Promise.all(productUpdates);

    // Apply vendor wallet credits
    const userUpdatePromises = [];
    for (const [vendorId, updates] of vendorUpdates.entries()) {
      userUpdatePromises.push(
        User.findByIdAndUpdate(
          vendorId,
          {
            $inc: {
              vendorWalletBalance: updates.revenue,
              productsSold: updates.soldCount,
              productsUnsold: -updates.soldCount,
            },
            $push: {
              notifications: {
                $each: [
                  {
                    type: 'payment_received',
                    message: `You have received ₦${updates.revenue.toFixed(2)} (after 15% commission) for a new order.`,
                    isRead: false,
                    createdAt: new Date(),
                  },
                ],
                $position: 0,
              },
            },
          },
          { new: true, session }
        )
      );
    }

    await Promise.all(userUpdatePromises);

    const updatedOrder = await order.save({ session });
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


module.exports = router;



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