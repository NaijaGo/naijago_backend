// routes/orderRoutes.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const axios = require("axios");

// @desc    Get all orders (Admin access only)
// @route   GET /api/orders
// @access  Private/Admin
router.get('/', protect, async (req, res) => {
    try {
        const orders = await Order.find({})
            .populate('user', 'firstName lastName email');
        res.status(200).json(orders);
    } catch (error) {
        console.error('Error fetching all orders:', error);
        res.status(500).json({ message: 'Error fetching all orders.', error: error.message });
    }
});


// @desc    Create new order (pending payment)
// @route   POST /api/orders
// @access  Private
router.post('/', protect, async (req, res) => {
    const {
        orderItems,
        shippingAddress,
        paymentMethod,
        taxPrice,
        shippingPrice,
        totalPrice,
    } = req.body;

    // Use a transaction for a robust, all-or-nothing operation
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        if (!orderItems || orderItems.length === 0) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'No order items' });
        }

        // Validate stock before creating the order
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

        // Create the order with isPaid set to false
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
            paymentMethod,
            taxPrice,
            shippingPrice,
            totalPrice,
            isPaid: false, // Order starts as unpaid
            isDelivered: false,
            orderStatus: 'pending',
        });

        const createdOrder = await order.save({ session });

        // Commit the transaction to save the pending order.
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


// @desc    Get logged in user's orders
// @route   GET /api/orders/my
// @access  Private
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


// @desc    Get vendor-specific orders
// @route   GET /api/orders/vendor
// @access  Private/Vendor
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


// @desc    Update order to paid + credit vendor + update metrics
// @route   PUT /api/orders/:id/pay
// @access  Private
// @desc    Update order to paid + verify Flutterwave + credit vendor + update metrics
// @route   PUT /api/orders/:id/pay
// @access  Private
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

        // ✅ Require transaction_id from frontend (sent after Flutterwave charge)
        const { transaction_id } = req.body;
        if (!transaction_id) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Transaction ID is required' });
        }

        // ✅ Verify payment with Flutterwave using secret key
        const flwResponse = await axios.get(
            `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
            {
                headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` }
            }
        );

        const flwData = flwResponse.data;

        if (flwData.status !== "success" || flwData.data.status !== "successful") {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({
                message: 'Payment verification failed',
                flutterwave: flwData
            });
        }

        // ✅ If verified, update order
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

        for (const item of order.orderItems) {
            if (!item.vendor) continue;

            const vendorId = item.vendor._id.toString();
            const revenue = item.price * item.quantity;
            const soldCount = item.quantity;

            if (!vendorUpdates.has(vendorId)) {
                vendorUpdates.set(vendorId, { revenue: 0, soldCount: 0 });
            }
            vendorUpdates.get(vendorId).revenue += revenue;
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
                                $each: [{
                                    type: 'payment_received',
                                    message: `You have received ₦${updates.revenue.toFixed(2)} for a new order.`,
                                    isRead: false,
                                    createdAt: new Date(),
                                }],
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

// ====================================================================
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

//         // Update the order's payment details and status
//         order.isPaid = true;
//         order.paidAt = Date.now();
//         order.paymentResult = {
//             id: req.body.id,
//             status: req.body.status,
//             update_time: req.body.update_time,
//             email_address: req.body.email_address,
//         };

//         const vendorUpdates = new Map();
//         const productUpdates = [];

//         for (const item of order.orderItems) {
//             if (!item.vendor) {
//                 console.warn(`Vendor not found for product ID: ${item.product}. Skipping wallet update.`);
//                 continue;
//             }

//             const vendorId = item.vendor._id.toString();
//             const revenue = item.price * item.quantity;
//             const soldCount = item.quantity;

//             // Group revenue and sold count by vendor
//             if (!vendorUpdates.has(vendorId)) {
//                 vendorUpdates.set(vendorId, { revenue: 0, soldCount: 0 });
//             }
//             vendorUpdates.get(vendorId).revenue += revenue;
//             vendorUpdates.get(vendorId).soldCount += soldCount;
            
//             // Collect all product updates
//             productUpdates.push(
//                 Product.findByIdAndUpdate(
//                     item.product,
//                     { $inc: { salesCount: soldCount, stockQuantity: -soldCount } },
//                     { new: true, session }
//                 )
//             );
//         }

//         // Execute all product updates in parallel
//         await Promise.all(productUpdates);
        
//         const userUpdatePromises = [];
//         for (const [vendorId, updates] of vendorUpdates.entries()) {
//             const userUpdatePromise = User.findByIdAndUpdate(
//                 vendorId,
//                 {
//                     $inc: {
//                         vendorWalletBalance: updates.revenue,
//                         productsSold: updates.soldCount,
//                         productsUnsold: -updates.soldCount, // Now update productsUnsold here
//                     },
//                     $push: {
//                         notifications: {
//                             $each: [{
//                                 type: 'payment_received',
//                                 message: `You have received ₦${updates.revenue.toFixed(2)} for a new order.`,
//                                 isRead: false,
//                                 createdAt: new Date(),
//                             }],
//                             $position: 0,
//                         },
//                     },
//                 },
//                 { new: true, session }
//             );
//             userUpdatePromises.push(userUpdatePromise);
//         }

//         await Promise.all(userUpdatePromises);
        
//         const updatedOrder = await order.save({ session });

//         await session.commitTransaction();
//         session.endSession();

//         res.json(updatedOrder);

//     } catch (error) {
//         await session.abortTransaction();
//         session.endSession();
//         console.error('Error updating order to paid and crediting vendors:', error);
//         res.status(500).json({ message: 'Server Error' });
//     }
// });


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


// @desc    Update order status (Vendor/Admin)
// @route   PUT /api/orders/:id/status
// @access  Private/Vendor/Admin
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


// @desc    Get single order by ID
// @route   GET /api/orders/:id
// @access  Private
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


// @desc    All orders for Admin
// @route   GET /api/orders/admin
// @access  Private/Admin
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
