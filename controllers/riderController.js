// controllers/riderController.js
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
    const { fullName, email, password, plateNumber, vehicleType, phoneNumber, documentUrls } = req.body;

    // Check if rider already exists
    const riderExists = await Rider.findOne({ $or: [{ email }, { plateNumber }] });
    if (riderExists) {
      return res.status(400).json({ 
        message: 'Rider with this email or plate number already exists' 
      });
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');

    const rider = await Rider.create({
      fullName,
      email,
      password,
      phoneNumber,
      plateNumber,
      vehicleType: vehicleType || 'motorcycle',
      documents: {
        ninFront: documentUrls?.ninFront,
        ninBack: documentUrls?.ninBack,
        platePhoto: documentUrls?.platePhoto,
        selfie: documentUrls?.selfie,
      },
      emailVerificationToken: verificationToken,
      emailVerificationExpires: Date.now() + 24 * 60 * 60 * 1000 
    });

    // Send verification email
    await sendVerificationEmail(rider.email, verificationToken, 'rider');

    res.status(201).json({
      success: true,
      _id: rider._id,
      fullName: rider.fullName,
      email: rider.email,
      status: rider.status,
      token: generateToken(rider._id),
      message: "Registration successful! Please check your email to verify your account."
    });
    
  } catch (error) {
    console.error('Rider registration error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Login rider
 */
exports.loginRider = async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const rider = await Rider.findOne({ email }).select('+password');
    
    if (!rider) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Compare password
    const isPasswordValid = await rider.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Check email verification
    if (!rider.isEmailVerified) {
      return res.status(401).json({ 
        message: 'Please verify your email address.', 
        requiresVerification: true 
      });
    }

    // Check application status
    if (rider.status === 'pending') {
      return res.status(401).json({ 
        message: 'Application is under review. Please wait for admin approval.' 
      });
    }

    if (rider.status === 'rejected') {
      return res.status(401).json({ 
        message: 'Application rejected.', 
        reason: rider.rejectionReason || 'Requirements not met.' 
      });
    }

    if (rider.status === 'suspended') {
      return res.status(401).json({ 
        message: 'Account suspended. Please contact support.' 
      });
    }

    // Update last active timestamp
    rider.lastActive = Date.now();
    await rider.save();

    res.json({
      _id: rider._id,
      fullName: rider.fullName,
      email: rider.email,
      plateNumber: rider.plateNumber,
      status: rider.status,
      isVerified: rider.isVerified,
      isActive: rider.isActive,
      walletBalance: rider.walletBalance,
      vehicleType: rider.vehicleType,
      currentLocation: rider.currentLocation,
      isAvailable: rider.isAvailable,
      token: generateToken(rider._id),
    });

  } catch (error) {
    console.error('Rider login error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Get rider profile
 */
exports.getRiderProfile = async (req, res) => {
  try {
    const rider = await Rider.findById(req.user._id)
      .select('-password -emailVerificationToken -passwordResetToken')
      .populate('withdrawalHistory', 'amount status createdAt completedAt')
      .lean();

    if (!rider) {
      return res.status(404).json({ message: 'Rider not found' });
    }

    // Calculate additional stats
    const stats = {
      totalDeliveries: rider.completedDeliveries || 0,
      activeDeliveries: rider.activeDeliveries || 0,
      cancellationRate: rider.cancellationRate || 0,
      averageRating: rider.totalRatings > 0 ? (rider.rating / rider.totalRatings).toFixed(1) : 0,
      totalEarnings: rider.totalEarnings || 0,
      pendingWithdrawals: rider.withdrawalHistory?.filter(w => w.status === 'pending').reduce((sum, w) => sum + w.amount, 0) || 0,
    };

    res.json({
      ...rider,
      stats,
      canWithdraw: rider.walletBalance >= 100, // Minimum withdrawal amount
    });
    
  } catch (error) {
    console.error('Get rider profile error:', error);
    res.status(500).json({ message: 'Server error while fetching profile' });
  }
};

/**
 * @desc Update rider profile
 */
exports.updateRiderProfile = async (req, res) => {
  try {
    const { fullName, phoneNumber, vehicleType, vehicleBrand, vehicleColor } = req.body;
    
    const updateData = {};
    if (fullName) updateData.fullName = fullName;
    if (phoneNumber) updateData.phoneNumber = phoneNumber;
    if (vehicleType) updateData.vehicleType = vehicleType;
    if (vehicleBrand) updateData.vehicleBrand = vehicleBrand;
    if (vehicleColor) updateData.vehicleColor = vehicleColor;

    const rider = await Rider.findByIdAndUpdate(
      req.user._id,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    res.json({
      message: 'Profile updated successfully',
      rider
    });
    
  } catch (error) {
    console.error('Update rider profile error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Update rider location (real-time tracking)
 */
exports.updateRiderLocation = async (req, res) => {
  try {
    const { lat, lng, address } = req.body;
    
    if (!lat || !lng) {
      return res.status(400).json({ message: 'Latitude and longitude are required' });
    }

    const rider = await Rider.findById(req.user._id);
    if (!rider) {
      return res.status(404).json({ message: 'Rider not found' });
    }

    // Update location
    rider.currentLocation = {
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      lastUpdated: Date.now(),
      address: address || ''
    };

    rider.lastActive = Date.now();
    await rider.save();

    // Emit real-time location update (for admin/dispatch tracking)
    const io = req.app.get('io');
    if (io) {
      io.emit('rider_location_update', {
        riderId: rider._id,
        location: rider.currentLocation,
        fullName: rider.fullName,
        plateNumber: rider.plateNumber
      });
    }

    res.json({
      message: 'Location updated successfully',
      location: rider.currentLocation
    });
    
  } catch (error) {
    console.error('Update rider location error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Update rider availability status
 */
exports.updateRiderStatus = async (req, res) => {
  try {
    const { isAvailable, isActive } = req.body;
    
    const updateData = {};
    if (isAvailable !== undefined) updateData.isAvailable = isAvailable;
    if (isActive !== undefined) updateData.isActive = isActive;

    // If rider is marking themselves as active, ensure they're approved
    if (isActive === true) {
      const rider = await Rider.findById(req.user._id);
      if (rider.status !== 'approved') {
        return res.status(400).json({ 
          message: 'Cannot activate account. Rider account must be approved by admin.' 
        });
      }
    }

    const updatedRider = await Rider.findByIdAndUpdate(
      req.user._id,
      updateData,
      { new: true }
    ).select('-password');

    res.json({
      message: 'Status updated successfully',
      isAvailable: updatedRider.isAvailable,
      isActive: updatedRider.isActive
    });
    
  } catch (error) {
    console.error('Update rider status error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Get available orders for rider (paid but not delivered)
 */
exports.getAvailableOrders = async (req, res) => {
  try {
    // Get rider's current location for distance calculation
    const rider = await Rider.findById(req.user._id);
    if (!rider.isAvailable || !rider.isActive) {
      return res.status(400).json({ 
        message: 'Please mark yourself as available and active to see orders' 
      });
    }

    // Find paid MainOrders that are not delivered/completed and not claimed
    const availableOrders = await MainOrder.find({
      isPaid: true,
      mainOrderStatus: { $nin: ['delivered', 'completed', 'cancelled'] },
      isClaimed: false,
      rider: { $exists: false }
    })
    .populate('user', 'firstName lastName phoneNumber')
    .populate({
      path: 'shipments',
      match: { 
        shipmentStatus: { $in: ['processing', 'ready_for_pickup'] },
        isClaimed: false 
      },
      populate: [
        { 
          path: 'vendor', 
          select: 'businessName phoneNumber businessLocation' 
        }
      ]
    })
    .sort({ createdAt: -1 });

    // Filter out orders with no available shipments
    const filteredOrders = availableOrders.filter(order => 
      order.shipments && order.shipments.length > 0
    );

    // Calculate distance for each order from rider's location
    const ordersWithDistance = filteredOrders.map(order => {
      // Get the first shipment's vendor location for distance calculation
      const firstShipment = order.shipments[0];
      let distance = null;
      
      if (rider.currentLocation && firstShipment?.vendor?.businessLocation) {
        const vendorLoc = firstShipment.vendor.businessLocation;
        distance = calculateDistance(
          rider.currentLocation.lat,
          rider.currentLocation.lng,
          vendorLoc.latitude,
          vendorLoc.longitude
        );
      }

      return {
        ...order.toObject(),
        estimatedDistance: distance,
        totalShipments: order.shipments.length,
        totalShippingPrice: order.totalShippingPrice
      };
    });

    res.json(ordersWithDistance);
    
  } catch (error) {
    console.error('Get available orders error:', error);
    res.status(500).json({ message: 'Error fetching available orders' });
  }
};

/**
 * @desc Claim an entire MainOrder (all shipments)
 */
exports.claimOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const orderId = req.params.id;
    const riderId = req.user._id;

    const mainOrder = await MainOrder.findById(orderId)
      .populate('shipments')
      .session(session);

    if (!mainOrder) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Order not found' });
    }

    // Validation checks
    if (!mainOrder.isPaid) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Order is not paid yet' });
    }

    if (mainOrder.isClaimed) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Order already claimed by another rider' });
    }

    if (mainOrder.rider) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Order already assigned to a rider' });
    }

    if (['delivered', 'completed', 'cancelled'].includes(mainOrder.mainOrderStatus)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Order is already delivered, completed, or cancelled' });
    }

    // Check rider availability
    const rider = await Rider.findById(riderId).session(session);
    if (!rider.isAvailable || !rider.isActive) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ 
        message: 'Please mark yourself as available and active to claim orders' 
      });
    }

    // Generate unique OTPs for pickup and delivery
    const pickupOTP = Math.floor(1000 + Math.random() * 9000).toString();
    const deliveryOTP = Math.floor(1000 + Math.random() * 9000).toString();

    // Assign rider to MainOrder
    mainOrder.rider = riderId;
    mainOrder.isClaimed = true;
    mainOrder.claimedAt = Date.now();
    mainOrder.pickupOTP = pickupOTP;
    mainOrder.deliveryOTP = deliveryOTP;
    mainOrder.shipmentStatus = 'out_for_delivery';

    // Update all shipments
    for (const shipment of mainOrder.shipments) {
      if (shipment.shipmentStatus === 'ready_for_pickup' && !shipment.isClaimed) {
        shipment.rider = riderId;
        shipment.isClaimed = true;
        shipment.claimedAt = Date.now();
        shipment.shipmentStatus = 'out_for_delivery';
        shipment.pickupOTP = pickupOTP;
        shipment.deliveryOTP = deliveryOTP;
        await shipment.save({ session });
      }
    }

    // Update rider's active deliveries count
    await Rider.findByIdAndUpdate(
      riderId,
      { $inc: { activeDeliveries: 1 } },
      { session }
    );

    await mainOrder.save({ session });
    await session.commitTransaction();
    session.endSession();

    // Send notification to vendor(s)
    const io = req.app.get('io');
    if (io) {
      mainOrder.shipments.forEach(shipment => {
        io.emit(`vendor_${shipment.vendor}`, {
          type: 'order_claimed',
          message: `Order ${mainOrder._id} has been claimed by rider ${rider.fullName}`,
          orderId: mainOrder._id,
          shipmentId: shipment._id,
          riderName: rider.fullName,
          riderPhone: rider.phoneNumber
        });
      });
    }

    res.json({ 
      success: true,
      message: 'Order claimed successfully!', 
      pickupOTP, 
      deliveryOTP,
      order: {
        id: mainOrder._id,
        shippingAddress: mainOrder.shippingAddress,
        userPhone: mainOrder.user?.phoneNumber
      }
    });
    
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Claim order error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Verify pickup OTP (at vendor location)
 */
exports.verifyPickupOTP = async (req, res) => {
  try {
    const { orderId, pickupOTP } = req.body;
    
    if (!orderId || !pickupOTP) {
      return res.status(400).json({ message: 'Order ID and pickup OTP are required' });
    }

    const mainOrder = await MainOrder.findById(orderId);
    if (!mainOrder) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Check if rider is assigned to this order
    if (mainOrder.rider.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized for this order' });
    }

    // Verify OTP
    if (mainOrder.pickupOTP !== pickupOTP) {
      return res.status(400).json({ message: 'Invalid pickup OTP' });
    }

    // Update shipment statuses to 'out_for_delivery'
    await Shipment.updateMany(
      { mainOrder: orderId, rider: req.user._id },
      { shipmentStatus: 'out_for_delivery' }
    );

    // Update MainOrder status
    mainOrder.shipmentStatus = 'out_for_delivery';
    await mainOrder.save();

    res.json({ 
      message: 'Pickup verified successfully! Proceed to delivery location.',
      deliveryAddress: mainOrder.shippingAddress,
      deliveryOTP: mainOrder.deliveryOTP
    });
    
  } catch (error) {
    console.error('Verify pickup OTP error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Verify delivery OTP (at customer location) and complete delivery
 */
exports.verifyDeliveryOTP = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { orderId, deliveryOTP } = req.body;
    
    if (!orderId || !deliveryOTP) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Order ID and delivery OTP are required' });
    }

    const mainOrder = await MainOrder.findById(orderId).session(session);
    if (!mainOrder) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Order not found' });
    }

    // Check if rider is assigned to this order
    if (mainOrder.rider.toString() !== req.user._id.toString()) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ message: 'Not authorized for this order' });
    }

    // Verify OTP
    if (mainOrder.deliveryOTP !== deliveryOTP) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Invalid delivery OTP' });
    }

    // Mark order as delivered (but not completed yet - admin will mark as completed for payout)
    mainOrder.shipmentStatus = 'delivered';
    mainOrder.isDelivered = true;
    mainOrder.deliveredAt = Date.now();
    mainOrder.mainOrderStatus = 'delivered'; // Admin needs to mark as 'completed' for payout

    // Update all shipments
    await Shipment.updateMany(
      { mainOrder: orderId },
      { 
        shipmentStatus: 'delivered',
        isDelivered: true,
        deliveredAt: Date.now()
      },
      { session }
    );

    // Update rider stats
    await Rider.findByIdAndUpdate(
      req.user._id,
      { 
        $inc: { 
          activeDeliveries: -1,
          completedDeliveries: 1 
        },
        lastActive: Date.now()
      },
      { session }
    );

    await mainOrder.save({ session });
    await session.commitTransaction();
    session.endSession();

    // Notify admin that order is ready for completion/payout
    const io = req.app.get('io');
    if (io) {
      io.emit('admin_notification', {
        type: 'order_ready_for_completion',
        message: `Order ${mainOrder._id} has been delivered and is ready for final verification and payout.`,
        orderId: mainOrder._id,
        riderId: req.user._id,
        timestamp: Date.now()
      });
    }

    res.json({ 
      success: true,
      message: 'Delivery verified successfully! Order marked as delivered. Payout will be processed after admin verification.'
    });
    
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Verify delivery OTP error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Get rider's active deliveries
 */
exports.getActiveDeliveries = async (req, res) => {
  try {
    const activeOrders = await MainOrder.find({
      rider: req.user._id,
      mainOrderStatus: { $nin: ['delivered', 'completed', 'cancelled'] }
    })
    .populate('user', 'firstName lastName phoneNumber')
    .populate({
      path: 'shipments',
      populate: [
        { 
          path: 'vendor', 
          select: 'businessName phoneNumber businessLocation' 
        }
      ]
    })
    .sort({ claimedAt: -1 });

    res.json(activeOrders);
    
  } catch (error) {
    console.error('Get active deliveries error:', error);
    res.status(500).json({ message: 'Error fetching active deliveries' });
  }
};

/**
 * @desc Get rider's completed deliveries
 */
exports.getCompletedDeliveries = async (req, res) => {
  try {
    const completedOrders = await MainOrder.find({
      rider: req.user._id,
      mainOrderStatus: { $in: ['delivered', 'completed'] }
    })
    .populate('user', 'firstName lastName')
    .populate({
      path: 'shipments',
      populate: [
        { 
          path: 'vendor', 
          select: 'businessName' 
        }
      ]
    })
    .sort({ deliveredAt: -1 })
    .limit(50);

    res.json(completedOrders);
    
  } catch (error) {
    console.error('Get completed deliveries error:', error);
    res.status(500).json({ message: 'Error fetching completed deliveries' });
  }
};

/**
 * @desc Get rider's earnings and wallet info
 */
exports.getEarnings = async (req, res) => {
  try {
    const rider = await Rider.findById(req.user._id)
      .select('walletBalance totalEarnings pendingEarnings totalWithdrawn withdrawalHistory')
      .populate('withdrawalHistory', 'amount status createdAt completedAt paymentMethod');

    if (!rider) {
      return res.status(404).json({ message: 'Rider not found' });
    }

    // Calculate weekly and monthly earnings
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // This would need to query completed shipments for detailed breakdown
    // For now, returning basic info
    res.json({
      walletBalance: rider.walletBalance || 0,
      totalEarnings: rider.totalEarnings || 0,
      pendingEarnings: rider.pendingEarnings || 0,
      totalWithdrawn: rider.totalWithdrawn || 0,
      availableForWithdrawal: rider.walletBalance,
      withdrawalHistory: rider.withdrawalHistory || [],
      canWithdraw: rider.walletBalance >= 100 // Minimum withdrawal amount
    });
    
  } catch (error) {
    console.error('Get earnings error:', error);
    res.status(500).json({ message: 'Error fetching earnings' });
  }
};

/**
 * @desc Request withdrawal from wallet
 */
exports.requestWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { amount, paymentMethod, accountDetails } = req.body;
    
    if (!amount || amount < 100) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Minimum withdrawal amount is ₦100' });
    }

    const rider = await Rider.findById(req.user._id).session(session);
    if (!rider) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Rider not found' });
    }

    // Check if rider can withdraw
    if (!rider.canWithdraw(amount)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ 
        message: `Insufficient balance or amount below minimum. Available: ₦${rider.walletBalance}, Minimum: ₦100` 
      });
    }

    // Generate unique reference
    const reference = `RWD${Date.now()}${Math.floor(Math.random() * 1000)}`;

    // Create withdrawal record
    const withdrawalRecord = {
      amount,
      status: 'pending',
      createdAt: Date.now(),
      reference,
      paymentMethod: paymentMethod || 'bank_transfer',
      accountDetails: accountDetails || {}
    };

    // Deduct from wallet and add to withdrawal history
    rider.walletBalance -= amount;
    rider.pendingEarnings += amount;
    rider.withdrawalHistory.push(withdrawalRecord);

    await rider.save({ session });
    await session.commitTransaction();
    session.endSession();

    // Notify admin of withdrawal request
    const io = req.app.get('io');
    if (io) {
      io.emit('admin_notification', {
        type: 'rider_withdrawal_request',
        message: `Rider ${rider.fullName} requested withdrawal of ₦${amount}`,
        riderId: rider._id,
        riderName: rider.fullName,
        amount,
        reference,
        timestamp: Date.now()
      });
    }

    res.json({
      success: true,
      message: 'Withdrawal request submitted successfully. Admin will process it shortly.',
      reference,
      newBalance: rider.walletBalance,
      pendingWithdrawal: amount
    });
    
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Withdrawal request error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Update bank account details
 */
exports.updateBankAccount = async (req, res) => {
  try {
    const { bankName, accountNumber, accountName, bankCode } = req.body;
    
    if (!bankName || !accountNumber || !accountName) {
      return res.status(400).json({ message: 'Bank name, account number, and account name are required' });
    }

    const rider = await Rider.findById(req.user._id);
    if (!rider) {
      return res.status(404).json({ message: 'Rider not found' });
    }

    rider.bankAccount = {
      bankName,
      accountNumber,
      accountName,
      bankCode: bankCode || '',
      verified: false // Admin needs to verify
    };

    await rider.save();

    res.json({
      success: true,
      message: 'Bank account details updated. Admin will verify the details.',
      bankAccount: rider.bankAccount
    });
    
  } catch (error) {
    console.error('Update bank account error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Get nearby riders (for admin/dispatch)
 */
exports.getNearbyRiders = async (req, res) => {
  try {
    const { lat, lng, maxDistance = 10000 } = req.query; // Default 10km
    
    if (!lat || !lng) {
      return res.status(400).json({ message: 'Latitude and longitude are required' });
    }

    const nearbyRiders = await Rider.findNearby(
      parseFloat(lat),
      parseFloat(lng),
      parseInt(maxDistance),
      20 // Limit to 20 riders
    );

    res.json(nearbyRiders);
    
  } catch (error) {
    console.error('Get nearby riders error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Cancel a claimed order (with valid reason)
 */
exports.cancelDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { orderId, reason } = req.body;
    
    if (!orderId || !reason) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Order ID and cancellation reason are required' });
    }

    const mainOrder = await MainOrder.findById(orderId).session(session);
    if (!mainOrder) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'Order not found' });
    }

    // Check if rider is assigned to this order
    if (mainOrder.rider.toString() !== req.user._id.toString()) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ message: 'Not authorized for this order' });
    }

    // Check if order can be cancelled (not already delivered/completed)
    if (['delivered', 'completed'].includes(mainOrder.mainOrderStatus)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'Cannot cancel already delivered order' });
    }

    // Update order status
    mainOrder.mainOrderStatus = 'cancelled';
    mainOrder.shipmentStatus = 'cancelled';
    mainOrder.isClaimed = false;
    mainOrder.rider = null;
    mainOrder.pickupOTP = null;
    mainOrder.deliveryOTP = null;

    // Update all shipments
    await Shipment.updateMany(
      { mainOrder: orderId },
      { 
        shipmentStatus: 'ready_for_pickup',
        isClaimed: false,
        rider: null,
        claimedAt: null,
        pickupOTP: null,
        deliveryOTP: null
      },
      { session }
    );

    // Update rider stats (increase cancellation rate)
    const rider = await Rider.findById(req.user._id).session(session);
    const totalDeliveries = (rider.completedDeliveries || 0) + (rider.activeDeliveries || 0);
    rider.activeDeliveries = Math.max(0, (rider.activeDeliveries || 0) - 1);
    
    if (totalDeliveries > 0) {
      rider.cancellationRate = ((rider.cancellationRate || 0) * totalDeliveries + 1) / (totalDeliveries + 1);
    }

    await rider.save({ session });
    await mainOrder.save({ session });
    await session.commitTransaction();
    session.endSession();

    // Notify admin and vendor about cancellation
    const io = req.app.get('io');
    if (io) {
      io.emit('admin_notification', {
        type: 'delivery_cancelled',
        message: `Rider ${rider.fullName} cancelled order ${orderId}. Reason: ${reason}`,
        orderId,
        riderId: rider._id,
        riderName: rider.fullName,
        reason,
        timestamp: Date.now()
      });

      // Notify vendor(s)
      const shipments = await Shipment.find({ mainOrder: orderId });
      shipments.forEach(shipment => {
        io.emit(`vendor_${shipment.vendor}`, {
          type: 'order_cancelled',
          message: `Order ${orderId} has been cancelled by rider. It is now available for pickup again.`,
          orderId,
          shipmentId: shipment._id
        });
      });
    }

    res.json({
      success: true,
      message: 'Delivery cancelled successfully. Order is now available for other riders.'
    });
    
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Cancel delivery error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Get vendor location for a shipment
 */
exports.getVendorLocation = async (req, res) => {
  try {
    const { shipmentId } = req.params;
    
    const shipment = await Shipment.findById(shipmentId)
      .populate('vendor', 'businessName businessLocation phoneNumber');
    
    if (!shipment) {
      return res.status(404).json({ message: 'Shipment not found' });
    }

    // Check if rider is assigned to this shipment
    if (shipment.rider?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized for this shipment' });
    }

    res.json({
      vendor: {
        name: shipment.vendor.businessName,
        phone: shipment.vendor.phoneNumber,
        location: shipment.vendor.businessLocation
      },
      shipmentId: shipment._id
    });
    
  } catch (error) {
    console.error('Get vendor location error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Get delivery location for an order
 */
exports.getDeliveryLocation = async (req, res) => {
  try {
    const { orderId } = req.params;
    
    const mainOrder = await MainOrder.findById(orderId)
      .select('shippingAddress userLocation user')
      .populate('user', 'firstName lastName phoneNumber');
    
    if (!mainOrder) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Check if rider is assigned to this order
    if (mainOrder.rider?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized for this order' });
    }

    res.json({
      customer: {
        name: `${mainOrder.user.firstName} ${mainOrder.user.lastName}`,
        phone: mainOrder.user.phoneNumber
      },
      deliveryAddress: mainOrder.shippingAddress,
      coordinates: mainOrder.userLocation
    });
    
  } catch (error) {
    console.error('Get delivery location error:', error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * @desc Get rider dashboard stats
 */
exports.getDashboardStats = async (req, res) => {
  try {
    const rider = await Rider.findById(req.user._id)
      .select('walletBalance totalEarnings completedDeliveries activeDeliveries rating totalRatings');
    
    if (!rider) {
      return res.status(404).json({ message: 'Rider not found' });
    }

    // Calculate recent earnings (last 7 days)
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    
    // Get completed shipments in last 7 days
    const recentShipments = await Shipment.find({
      rider: req.user._id,
      isDelivered: true,
      deliveredAt: { $gte: oneWeekAgo }
    }).select('shippingPrice');

    const weeklyEarnings = recentShipments.reduce((sum, shipment) => sum + (shipment.shippingPrice || 0), 0);

    // Get today's earnings
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayShipments = await Shipment.find({
      rider: req.user._id,
      isDelivered: true,
      deliveredAt: { $gte: today }
    }).select('shippingPrice');

    const todayEarnings = todayShipments.reduce((sum, shipment) => sum + (shipment.shippingPrice || 0), 0);

    res.json({
      walletBalance: rider.walletBalance || 0,
      totalEarnings: rider.totalEarnings || 0,
      weeklyEarnings,
      todayEarnings,
      completedDeliveries: rider.completedDeliveries || 0,
      activeDeliveries: rider.activeDeliveries || 0,
      averageRating: rider.totalRatings > 0 ? (rider.rating / rider.totalRatings).toFixed(1) : 0,
      totalRatings: rider.totalRatings || 0,
      performance: {
        cancellationRate: rider.cancellationRate || 0,
        onTimeRate: 95, // This would need actual calculation from delivery times
        satisfactionRate: 98 // This would need actual customer ratings
      }
    });
    
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ message: error.message });
  }
};

// Helper function to calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c; // Distance in km
  return parseFloat(distance.toFixed(2));
}