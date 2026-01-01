const Rider = require('../models/Rider');
const Shipment = require('../models/Shipment');
const MainOrder = require('../models/MainOrder');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendVerificationEmail } = require('../utils/emailHelper');

// Helper to create JWT
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

/**
 * @desc Register a new rider
 */
exports.registerRider = async (req, res) => {
  try {
    const { fullName, email, password, plateNumber, documentUrls } = req.body;

    const riderExists = await Rider.findOne({ email });
    if (riderExists) return res.status(400).json({ message: 'Rider already exists' });

    const verificationToken = crypto.randomBytes(32).toString('hex');

    const rider = await Rider.create({
      fullName,
      email,
      password,
      plateNumber,
      documents: {
        ninFront: documentUrls?.ninFront,
        ninBack: documentUrls?.ninBack,
        platePhoto: documentUrls?.platePhoto,
        selfie: documentUrls?.selfie,
      },
      emailVerificationToken: verificationToken,
      emailVerificationExpires: Date.now() + 24 * 60 * 60 * 1000 
    });

    await sendVerificationEmail(rider.email, verificationToken, 'email');

    res.status(201).json({
      success: true,
      _id: rider._id,
      fullName: rider.fullName,
      token: generateToken(rider._id), 
      message: "Registration successful! Please check your email to verify your account."
    });
    
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Login rider
 */
exports.loginRider = async (req, res) => {
  const { email, password } = req.body;
  try {
    const rider = await Rider.findOne({ email });
    const bcrypt = require('bcryptjs');

    if (rider && (await bcrypt.compare(password, rider.password))) {
      if (!rider.isEmailVerified) {
        return res.status(401).json({ message: 'Please verify your email address.' });
      }
      if (rider.status === 'pending') {
        return res.status(401).json({ message: 'Application is under review.' });
      }
      if (rider.status === 'rejected') {
        return res.status(401).json({ 
          message: 'Application rejected.', 
          reason: rider.rejectionReason || 'Requirements not met.' 
        });
      }

      res.json({
        _id: rider._id,
        fullName: rider.fullName,
        email: rider.email,
        isVerified: rider.isVerified,
        status: rider.status,
        walletBalance: rider.walletBalance,
        token: generateToken(rider._id),
      });

    } else {
      res.status(401).json({ message: 'Invalid email or password' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// --- LOGISTICS & PAYOUT LOGIC ---

/**
 * @desc Get available shipments (ready_for_pickup)
 * @route GET /api/riders/available
 */
exports.getAvailableShipments = async (req, res) => {
  try {
    // Only show shipments marked 'ready_for_pickup' by Admin/Vendor
    const shipments = await Shipment.find({
      shipmentStatus: 'ready_for_pickup',
      isClaimed: false
    })
    .populate('vendor', 'businessName businessLocation latitude longitude phoneNumber')
    .populate({
      path: 'mainOrder',
      select: 'shippingAddress userLocation'
    });

    res.json(shipments);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching available orders' });
  }
};

/**
 * @desc Rider claims a shipment
 * @route PUT /api/riders/claim/:id
 */
exports.claimShipment = async (req, res) => {
  try {
    const shipment = await Shipment.findById(req.params.id);

    if (!shipment || shipment.isClaimed || shipment.shipmentStatus !== 'ready_for_pickup') {
      return res.status(400).json({ message: 'Shipment is no longer available' });
    }

    // Generate unique 4-digit OTPs
    const pOTP = Math.floor(1000 + Math.random() * 9000).toString();
    const dOTP = Math.floor(1000 + Math.random() * 9000).toString();

    shipment.rider = req.user._id;
    shipment.isClaimed = true;
    shipment.claimedAt = Date.now();
    shipment.pickupOTP = pOTP;    
    shipment.deliveryOTP = dOTP;  
    shipment.shipmentStatus = 'out_for_delivery'; 

    await shipment.save();
    res.json({ 
      message: 'Shipment claimed!', 
      pickupOTP: pOTP, // Rider shows this to the Vendor
      deliveryOTP: dOTP // Rider uses this to verify with Customer
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Verify Customer OTP and pay Rider
 * @route PUT /api/riders/verify-delivery/:id
 */
exports.finalizeRiderDelivery = async (req, res) => {
  const { customerOTP } = req.body;
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const shipment = await Shipment.findById(req.params.id).session(session);

    if (!shipment || shipment.deliveryOTP !== customerOTP) {
      return res.status(400).json({ message: 'Invalid Delivery OTP' });
    }

    // 1. Update Shipment Status
    shipment.isDelivered = true;
    shipment.deliveredAt = Date.now();
    shipment.shipmentStatus = 'delivered';
    await shipment.save({ session });

    // 2. CREDIT RIDER WALLET ONLY
    // We increment the rider's wallet by the shippingPrice field
    await Rider.findByIdAndUpdate(
      req.user._id,
      { 
        $inc: { 
          walletBalance: shipment.shippingPrice, 
          totalEarnings: shipment.shippingPrice 
        } 
      },
      { session }
    );

    await session.commitTransaction();
    res.json({ message: `Delivery verified. ₦${shipment.shippingPrice} added to your wallet.` });
  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ message: 'Payment processing failed' });
  } finally {
    session.endSession();
  }
};


/**
 * @desc Get current rider profile
 * @route GET /api/riders/profile
 * @access Private (rider only)
 */
exports.getRiderProfile = async (req, res) => {
  try {
    // req.user comes from protect middleware (already has rider _id)
    const rider = await Rider.findById(req.user._id)
      .select(
        'fullName email plateNumber status walletBalance totalEarnings activeDeliveries createdAt'
      );

    if (!rider) {
      return res.status(404).json({ message: 'Rider not found' });
    }

    res.json({
      fullName: rider.fullName,
      email: rider.email,
      plateNumber: rider.plateNumber,
      status: rider.status,
      walletBalance: rider.walletBalance || 0,
      totalEarnings: rider.totalEarnings || 0,
      activeDeliveries: rider.activeDeliveries || 0,
      // Add more fields if you need them in dashboard
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error while fetching profile' });
  }
};


exports.getCompletedShipments = async (req, res) => {
  try {
    const shipments = await Shipment.find({
      rider: req.user._id,
      shipmentStatus: 'delivered'
    })
      .sort({ deliveredAt: -1 })
      .limit(50);
    res.json(shipments);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching completed shipments' });
  }
};


/**
 * @desc Get all paid MainOrders that may have claimable shipments
 * @route GET /api/riders/orders/available
 * @access Private (dispatch)
 */
exports.getAvailableOrdersForRider = async (req, res) => {
  try {
    const orders = await MainOrder.find({
      isPaid: true,  // ← Only this filter — show every paid order
    })
      .populate('user', 'firstName lastName email phoneNumber')
      .populate({
        path: 'shipments',
        populate: [
          { path: 'vendor', select: 'businessName phoneNumber businessLocation' },
          { path: 'items.product', select: 'name price' }
        ]
      })
      .sort({ createdAt: -1 });

    res.json(orders);
  } catch (err) {
    console.error('Error fetching available orders for rider:', err);
    res.status(500).json({ message: 'Server error' });
  }
};


/**
 * @desc Rider claims an entire MainOrder (all shipments)
 * @route PUT /api/riders/claim-order/:id
 */
exports.claimOrder = async (req, res) => {
  try {
    const orderId = req.params.id;
    const riderId = req.user._id;

    const mainOrder = await MainOrder.findById(orderId)
      .populate('shipments');

    if (!mainOrder) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (!mainOrder.isPaid) {
      return res.status(400).json({ message: 'Order is not paid' });
    }

    if (mainOrder.isClaimed) {
      return res.status(400).json({ message: 'Order already claimed' });
    }

    // Optional: Check if order is in a claimable status
    if (['delivered', 'completed', 'cancelled'].includes(mainOrder.mainOrderStatus)) {
      return res.status(400).json({ message: 'Order is already delivered, completed, or cancelled' });
    }

    // Assign rider to the MainOrder
    mainOrder.rider = riderId;
    mainOrder.isClaimed = true;
    mainOrder.claimedAt = Date.now();

    // Optional: Generate OTPs for pickup/delivery (you can keep per-shipment or one per order)
    // Example: one set for the whole order
    const pickupOTP = Math.floor(1000 + Math.random() * 9000).toString();
    const deliveryOTP = Math.floor(1000 + Math.random() * 9000).toString();

    mainOrder.pickupOTP = pickupOTP;
    mainOrder.deliveryOTP = deliveryOTP;

    // Optional: Update all shipments' status to 'out_for_delivery'
    for (const shipment of mainOrder.shipments) {
      if (shipment.shipmentStatus === 'ready_for_pickup' && !shipment.isClaimed) {
        shipment.rider = riderId;
        shipment.isClaimed = true;
        shipment.claimedAt = Date.now();
        shipment.shipmentStatus = 'out_for_delivery';
        await shipment.save();
      }
    }

    await mainOrder.save();

    res.json({ 
      message: 'Order claimed successfully!', 
      pickupOTP, 
      deliveryOTP 
    });
  } catch (error) {
    console.error('Error claiming order:', error);
    res.status(500).json({ message: error.message });
  }
};