// controllers/riderController.js
const Rider = require('../models/Rider');
const Shipment = require('../models/Shipment');
const MainOrder = require('../models/MainOrder');
const User = require('../models/User');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendVerificationEmail } = require('../utils/emailHelper');

// Helper to create JWT
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

const pushUserNotification = async ({
  userId,
  type = 'general',
  message,
  relatedId,
  relatedModel = 'MainOrder',
}) => {
  if (!userId || !message) return null;

  try {
    return await User.findByIdAndUpdate(
      userId,
      {
        $push: {
          notifications: {
            type,
            message,
            relatedId,
            relatedModel,
          },
        },
      },
      { new: true }
    ).select('notifications');
  } catch (error) {
    console.error('Failed to push user notification:', error.message);
    return null;
  }
};

/**
 * @desc Register a new rider
 */
exports.registerRider = async (req, res) => {
  try {
    const {
      fullName,
      email,
      password,
      plateNumber,
      vehicleType,
      phoneNumber,
      dateOfBirth,
      gender,
      homeAddress,
      state,
      city,
      deliveryZone,
      vehicleModel,
      licenseNumber,
      idType,
      idNumber,
      bankName,
      accountNumber,
      accountName,
      emergencyName,
      emergencyPhone,
      emergencyRelationship,
      documentUrls
    } = req.body;

    // Check if rider already exists
    const riderExists = await Rider.findOne({ $or: [{ email }, { plateNumber }] });
    if (riderExists) {
      return res.status(400).json({ 
        success: false,
        message: 'Rider with this email or plate number already exists' 
      });
    }

    // Validate required fields
    if (!fullName || !email || !password || !plateNumber || !phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }

    // Validate document URLs
    if (!documentUrls || !documentUrls.ninFront || !documentUrls.ninBack || !documentUrls.platePhoto || !documentUrls.selfie) {
      return res.status(400).json({
        success: false,
        message: 'All document URLs are required'
      });
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');

    const rider = await Rider.create({
      fullName,
      email,
      password,
      phoneNumber,
      plateNumber: plateNumber.toUpperCase().trim(),
      vehicleType: vehicleType || 'motorcycle',
      dateOfBirth,
      gender,
      homeAddress,
      state,
      city,
      deliveryZone,
      vehicleBrand: vehicleModel,
      licenseNumber,
      idType,
      idNumber,
      bankAccount: {
        bankName,
        accountNumber,
        accountName,
        verified: false
      },
      emergencyContact: {
        name: emergencyName,
        phone: emergencyPhone,
        relationship: emergencyRelationship
      },
      documents: {
        ninFront: documentUrls.ninFront,
        ninBack: documentUrls.ninBack,
        platePhoto: documentUrls.platePhoto,
        selfie: documentUrls.selfie,
      },
      emailVerificationToken: crypto
        .createHash('sha256')
        .update(verificationToken)
        .digest('hex'),
      emailVerificationExpires: Date.now() + 24 * 60 * 60 * 1000,
      // Auto-verify in development mode for testing
      isEmailVerified: process.env.NODE_ENV === 'development'
    });

    // Send verification email
    try {
      await sendVerificationEmail(rider.email, verificationToken, 'rider');
    } catch (emailError) {
      console.error('Failed to send verification email:', emailError);
      // Don't fail registration if email fails
      // You might want to implement retry logic or queue system here
    }

    res.status(201).json({
      success: true,
      _id: rider._id,
      fullName: rider.fullName,
      email: rider.email,
      status: rider.status,
      isEmailVerified: rider.isEmailVerified,
      token: generateToken(rider._id),
      message: process.env.NODE_ENV === 'development'
        ? "Registration successful! Email verification is disabled in development mode."
        : "Registration successful! Please check your email to verify your account."
    });
    
  } catch (error) {
    console.error('Rider registration error:', error);
    res.status(500).json({ 
      success: false,
      message: error.message || 'Registration failed. Please try again.' 
    });
  }
};

/**
 * @desc Verify rider email with token
 */
exports.verifyRiderEmail = async (req, res) => {
  try {
    const { token } = req.params;
    
    if (!token) {
      return res.status(400).json({ 
        success: false,
        message: 'Verification token is required' 
      });
    }

    // Hash the token to compare with stored hash
    const hashedToken = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    // Find rider with this token and check expiration
    const rider = await Rider.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpires: { $gt: Date.now() }
    });

    if (!rider) {
      return res.status(400).json({ 
        success: false,
        message: 'Invalid or expired verification token' 
      });
    }

    // Mark email as verified
    rider.isEmailVerified = true;
    rider.emailVerificationToken = undefined;
    rider.emailVerificationExpires = undefined;
    
    await rider.save();

    // Return success response
    res.json({
      success: true,
      message: 'Email verified successfully! You can now login.',
      rider: {
        id: rider._id,
        email: rider.email,
        fullName: rider.fullName,
        isEmailVerified: rider.isEmailVerified
      }
    });

  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error during email verification' 
    });
  }
};

/**
 * @desc Login rider
 */
exports.loginRider = async (req, res) => {
  const { email, password, oneSignalPlayerId } = req.body;
  
  try {
    // Validate input
    if (!email || !password) {
      return res.status(400).json({ 
        success: false,
        message: 'Please provide email and password' 
      });
    }

    const rider = await Rider.findOne({ email }).select('+password');
    
    if (!rider) {
      return res.status(401).json({ 
        success: false,
        message: 'Invalid email or password' 
      });
    }

    // Compare password
    const isPasswordValid = await rider.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({ 
        success: false,
        message: 'Invalid email or password' 
      });
    }

    // Check email verification
    if (!rider.isEmailVerified) {
      return res.status(401).json({ 
        success: false,
        message: 'Please verify your email address.', 
        requiresVerification: true 
      });
    }

    // Check application status
    if (rider.status === 'pending') {
      return res.status(401).json({ 
        success: false,
        message: 'Application is under review. Please wait for admin approval.' 
      });
    }

    if (rider.status === 'rejected') {
      return res.status(401).json({ 
        success: false,
        message: 'Application rejected.', 
        reason: rider.rejectionReason || 'Requirements not met.' 
      });
    }

    if (rider.status === 'suspended') {
      return res.status(401).json({ 
        success: false,
        message: 'Account suspended. Please contact support.' 
      });
    }

    // Update last active timestamp
    rider.lastActive = Date.now();
    rider.oneSignalUserId = rider._id.toString();
    if (oneSignalPlayerId && oneSignalPlayerId.trim() !== '') {
      rider.oneSignalPlayerId = oneSignalPlayerId.trim();
    }
    await rider.save();

    res.json({
      success: true,
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
    res.status(500).json({ 
      success: false,
      message: error.message || 'Login failed. Please try again.' 
    });
  }
};

/**
 * @desc Get rider profile
 */
exports.getRiderProfile = async (req, res) => {
  try {
    const rider = await Rider.findById(req.rider._id)
      .select('-password -emailVerificationToken -passwordResetToken')
      .populate('withdrawalHistory', 'amount status createdAt completedAt')
      .lean();

    if (!rider) {
      return res.status(404).json({ 
        success: false,
        message: 'Rider not found' 
      });
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
      success: true,
      ...rider,
      stats,
      canWithdraw: rider.walletBalance >= 100, // Minimum withdrawal amount
    });
    
  } catch (error) {
    console.error('Get rider profile error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error while fetching profile' 
    });
  }
};

/**
 * @desc Update rider profile
 */
exports.updateRiderProfile = async (req, res) => {
  try {
    const {
      fullName,
      phoneNumber,
      homeAddress,
      state,
      city,
      deliveryZone,
      vehicleType,
      vehicleBrand,
      vehicleColor,
      licenseNumber,
      idType,
      idNumber
    } = req.body;
    
    const updateData = {};
    if (fullName) updateData.fullName = fullName;
    if (phoneNumber) updateData.phoneNumber = phoneNumber;
    if (homeAddress) updateData.homeAddress = homeAddress;
    if (state) updateData.state = state;
    if (city) updateData.city = city;
    if (deliveryZone) updateData.deliveryZone = deliveryZone;
    if (vehicleType) updateData.vehicleType = vehicleType;
    if (vehicleBrand) updateData.vehicleBrand = vehicleBrand;
    if (vehicleColor) updateData.vehicleColor = vehicleColor;
    if (licenseNumber) updateData.licenseNumber = licenseNumber;
    if (idType) updateData.idType = idType;
    if (idNumber) updateData.idNumber = idNumber;

    // Validate at least one field is being updated
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    const rider = await Rider.findByIdAndUpdate(
      req.rider._id,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    res.json({
      success: true,
      message: 'Profile updated successfully',
      rider
    });
    
  } catch (error) {
    console.error('Update rider profile error:', error);
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
  }
};

/**
 * @desc Update rider location (real-time tracking)
 */
exports.updateRiderLocation = async (req, res) => {
  try {
    const { lat, lng, address } = req.body;
    
    if (!lat || !lng) {
      return res.status(400).json({ 
        success: false,
        message: 'Latitude and longitude are required' 
      });
    }

    const rider = await Rider.findById(req.rider._id);
    if (!rider) {
      return res.status(404).json({ 
        success: false,
        message: 'Rider not found' 
      });
    }

    // Validate coordinates
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    
    if (isNaN(latitude) || isNaN(longitude) || 
        latitude < -90 || latitude > 90 || 
        longitude < -180 || longitude > 180) {
      return res.status(400).json({
        success: false,
        message: 'Invalid coordinates'
      });
    }

    // Update location
    rider.currentLocation = {
      lat: latitude,
      lng: longitude,
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
      success: true,
      message: 'Location updated successfully',
      location: rider.currentLocation
    });
    
  } catch (error) {
    console.error('Update rider location error:', error);
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
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

    // Validate at least one field is being updated
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No status fields to update'
      });
    }

    // If rider is marking themselves as active, ensure they're approved
    if (isActive === true) {
      const rider = await Rider.findById(req.rider._id);
      if (rider.status !== 'approved') {
        return res.status(400).json({ 
          success: false,
          message: 'Cannot activate account. Rider account must be approved by admin.' 
        });
      }
    }

    const updatedRider = await Rider.findByIdAndUpdate(
      req.rider._id,
      updateData,
      { new: true }
    ).select('-password');

    res.json({
      success: true,
      message: 'Status updated successfully',
      isAvailable: updatedRider.isAvailable,
      isActive: updatedRider.isActive
    });
    
  } catch (error) {
    console.error('Update rider status error:', error);
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
  }
};

/**
 * @desc Get available orders for rider (paid but not delivered)
 */
exports.getAvailableOrders = async (req, res) => {
  try {
    // Get rider's current location for distance calculation
    const rider = await Rider.findById(req.rider._id);
    
    if (!rider.isAvailable || !rider.isActive) {
      return res.status(400).json({ 
        success: false,
        message: 'Please mark yourself as available and active to see orders' 
      });
    }

    // Check if rider is approved
    if (rider.status !== 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Your account is not yet approved by admin'
      });
    }

    // Find paid MainOrders that are ready for rider pickup and not claimed.
    // Vendor apps move shipments to ready_for_pickup; riders should not see
    // orders that vendors are still processing.
    const availableOrders = await MainOrder.find({
      isPaid: true,
      mainOrderStatus: { $nin: ['delivered', 'completed', 'cancelled'] },
      shipmentStatus: 'ready_for_pickup',
      isClaimed: false,
      $or: [{ rider: null }, { rider: { $exists: false } }]
    })
    .populate('user', 'firstName lastName phoneNumber')
    .populate({
      path: 'shipments',
      match: { 
        shipmentStatus: 'ready_for_pickup',
        isClaimed: false 
      },
      populate: [
        { 
          path: 'vendor', 
          select: 'businessName phoneNumber businessLocation' 
        }
      ]
    })
    .sort({ createdAt: -1 })
    .limit(50); // Limit results for performance

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
        totalShippingPrice: order.totalShippingPrice,
        estimatedEarnings: order.totalShippingPrice * 0.7 // Example: rider gets 70% of shipping fee
      };
    });

    res.json({
      success: true,
      count: ordersWithDistance.length,
      orders: ordersWithDistance
    });
    
  } catch (error) {
    console.error('Get available orders error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error fetching available orders' 
    });
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
    const riderId = req.rider._id;

    // Validate order ID
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ 
        success: false,
        message: 'Invalid order ID' 
      });
    }

    const mainOrder = await MainOrder.findById(orderId)
      .populate('shipments')
      .session(session);

    if (!mainOrder) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ 
        success: false,
        message: 'Order not found' 
      });
    }

    // Validation checks
    if (!mainOrder.isPaid) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ 
        success: false,
        message: 'Order is not paid yet' 
      });
    }

    if (mainOrder.isClaimed) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ 
        success: false,
        message: 'Order already claimed by another rider' 
      });
    }

    if (mainOrder.rider) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ 
        success: false,
        message: 'Order already assigned to a rider' 
      });
    }

    if (['delivered', 'completed', 'cancelled'].includes(mainOrder.mainOrderStatus)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ 
        success: false,
        message: 'Order is already delivered, completed, or cancelled' 
      });
    }

    // Check rider availability
    const rider = await Rider.findById(riderId).session(session);
    if (!rider.isAvailable || !rider.isActive) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ 
        success: false,
        message: 'Please mark yourself as available and active to claim orders' 
      });
    }

    // Check if rider has too many active deliveries (limit to 5)
    if (rider.activeDeliveries >= 5) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'You have reached the maximum limit of active deliveries (5). Complete some deliveries first.'
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
    mainOrder.shipmentStatus = 'ready_for_pickup';

    // Update all shipments
    const shipmentUpdates = [];
    for (const shipment of mainOrder.shipments) {
      if (shipment.shipmentStatus === 'ready_for_pickup' && !shipment.isClaimed) {
        shipment.rider = riderId;
        shipment.isClaimed = true;
        shipment.claimedAt = Date.now();
        shipment.shipmentStatus = 'ready_for_pickup';
        shipment.pickupOTP = pickupOTP;
        shipment.deliveryOTP = deliveryOTP;
        shipmentUpdates.push(shipment.save({ session }));
      }
    }

    // Wait for all shipment updates
    await Promise.all(shipmentUpdates);

    // Update rider's active deliveries count
    await Rider.findByIdAndUpdate(
      riderId,
      { $inc: { activeDeliveries: 1 } },
      { session }
    );

    await mainOrder.save({ session });
    await session.commitTransaction();
    session.endSession();

    const vendorIds = [
      ...new Set(
        mainOrder.shipments
          .map((shipment) => shipment.vendor?.toString())
          .filter(Boolean)
      ),
    ];

    await Promise.all([
      pushUserNotification({
        userId: mainOrder.user,
        type: 'order_update',
        message: `Delivery OTP for order ${mainOrder._id}: ${deliveryOTP}. Share this code only after receiving your order.`,
        relatedId: mainOrder._id,
      }),
      ...vendorIds.map((vendorId) =>
        pushUserNotification({
          userId: vendorId,
          type: 'order_update',
          message: `Pickup OTP for order ${mainOrder._id}: ${pickupOTP}. Share this code with the rider at pickup.`,
          relatedId: mainOrder._id,
        })
      ),
    ]);

    // Send notification to vendor(s)
    const io = req.app.get('io');
    if (io) {
      mainOrder.shipments.forEach(shipment => {
        const payload = {
          type: 'order_claimed',
          message: `Order ${mainOrder._id} has been claimed by rider ${rider.fullName}. Pickup OTP: ${pickupOTP}`,
          orderId: mainOrder._id,
          shipmentId: shipment._id,
          riderName: rider.fullName,
          riderPhone: rider.phoneNumber,
          pickupOTP: pickupOTP
        };
        io.emit(`vendor_${shipment.vendor}`, payload);
        req.app.get('notifyVendor')?.(shipment.vendor.toString(), {
          title: 'Rider assigned',
          message: payload.message,
          data: payload
        });
      });

      // Notify customer
      io.emit(`user_${mainOrder.user}`, {
        type: 'order_claimed',
        message: `A rider has been assigned to your order. Delivery OTP: ${deliveryOTP}`,
        orderId: mainOrder._id,
        riderName: rider.fullName,
        riderPhone: rider.phoneNumber,
        deliveryOTP
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
        userPhone: mainOrder.user?.phoneNumber,
        totalShipments: mainOrder.shipments.length
      }
    });
    
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Claim order error:', error);
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
  }
};

/**
 * @desc Verify pickup OTP (at vendor location)
 */
exports.verifyPickupOTP = async (req, res) => {
  try {
    const { orderId, pickupOTP } = req.body;
    
    if (!orderId || !pickupOTP) {
      return res.status(400).json({ 
        success: false,
        message: 'Order ID and pickup OTP are required' 
      });
    }

    // Validate order ID
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID'
      });
    }

    const mainOrder = await MainOrder.findById(orderId);
    if (!mainOrder) {
      return res.status(404).json({ 
        success: false,
        message: 'Order not found' 
      });
    }

    // Check if rider is assigned to this order
    if (mainOrder.rider.toString() !== req.rider._id.toString()) {
      return res.status(403).json({ 
        success: false,
        message: 'Not authorized for this order' 
      });
    }

    // Verify OTP
    if (mainOrder.pickupOTP !== pickupOTP) {
      return res.status(400).json({ 
        success: false,
        message: 'Invalid pickup OTP' 
      });
    }

    // Check if already picked up
    if (mainOrder.shipmentStatus === 'out_for_delivery' || mainOrder.pickedUpAt) {
      return res.status(400).json({
        success: false,
        message: 'Order already picked up'
      });
    }

    // Update shipment statuses to 'out_for_delivery'
    await Shipment.updateMany(
      { mainOrder: orderId, rider: req.rider._id },
      { 
        shipmentStatus: 'out_for_delivery',
        pickedUpAt: Date.now()
      }
    );

    // Update MainOrder status
    mainOrder.shipmentStatus = 'out_for_delivery';
    mainOrder.pickedUpAt = Date.now();
    await mainOrder.save();

    const shipments = await Shipment.find({ mainOrder: orderId });
    const vendorIds = [
      ...new Set(shipments.map((shipment) => shipment.vendor?.toString()).filter(Boolean)),
    ];

    await Promise.all([
      pushUserNotification({
        userId: mainOrder.user,
        type: 'order_shipped',
        message: `Your order ${mainOrder._id} has been picked up and is on the way.`,
        relatedId: mainOrder._id,
      }),
      ...vendorIds.map((vendorId) =>
        pushUserNotification({
          userId: vendorId,
          type: 'order_shipped',
          message: `Order ${mainOrder._id} has been picked up by rider ${req.rider.fullName}.`,
          relatedId: mainOrder._id,
        })
      ),
    ]);

    // Send notification
    const io = req.app.get('io');
    if (io) {
      io.emit(`user_${mainOrder.user}`, {
        type: 'order_picked_up',
        message: `Your order has been picked up and is on the way`,
        orderId: mainOrder._id,
        riderName: req.rider.fullName
      });

      shipments.forEach(shipment => {
        const payload = {
          type: 'order_picked_up',
          message: `Order ${mainOrder._id} has been picked up by rider ${req.rider.fullName}`,
          orderId: mainOrder._id,
          shipmentId: shipment._id,
          riderName: req.rider.fullName
        };
        io.emit(`vendor_${shipment.vendor}`, payload);
        req.app.get('notifyVendor')?.(shipment.vendor.toString(), {
          title: 'Order picked up',
          message: payload.message,
          data: payload
        });
      });
    }

    res.json({ 
      success: true,
      message: 'Pickup verified successfully! Proceed to delivery location.',
      deliveryAddress: mainOrder.shippingAddress,
      deliveryOTP: mainOrder.deliveryOTP
    });
    
  } catch (error) {
    console.error('Verify pickup OTP error:', error);
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
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
      return res.status(400).json({ 
        success: false,
        message: 'Order ID and delivery OTP are required' 
      });
    }

    // Validate order ID
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID'
      });
    }

    const mainOrder = await MainOrder.findById(orderId).session(session);
    if (!mainOrder) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ 
        success: false,
        message: 'Order not found' 
      });
    }

    // Check if rider is assigned to this order
    if (mainOrder.rider.toString() !== req.rider._id.toString()) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ 
        success: false,
        message: 'Not authorized for this order' 
      });
    }

    // Verify OTP
    if (mainOrder.deliveryOTP !== deliveryOTP) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ 
        success: false,
        message: 'Invalid delivery OTP' 
      });
    }

    // Check if already delivered
    if (mainOrder.mainOrderStatus === 'delivered') {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Order already delivered'
      });
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
      req.rider._id,
      { 
        $inc: { 
          activeDeliveries: -1,
          completedDeliveries: 1 
        },
        lastActive: Date.now()
      },
      { session }
    );

    // Calculate rider earnings (70% of total shipping price)
    const riderEarnings = mainOrder.totalShippingPrice * 0.7;
    await Rider.findByIdAndUpdate(
      req.rider._id,
      { 
        $inc: { 
          walletBalance: riderEarnings,
          totalEarnings: riderEarnings
        }
      },
      { session }
    );

    await mainOrder.save({ session });
    await session.commitTransaction();
    session.endSession();

    const deliveredShipments = await Shipment.find({ mainOrder: orderId });
    const vendorIds = [
      ...new Set(
        deliveredShipments.map((shipment) => shipment.vendor?.toString()).filter(Boolean)
      ),
    ];

    await Promise.all([
      pushUserNotification({
        userId: mainOrder.user,
        type: 'order_delivered',
        message: `Your order ${mainOrder._id} has been delivered successfully.`,
        relatedId: mainOrder._id,
      }),
      ...vendorIds.map((vendorId) =>
        pushUserNotification({
          userId: vendorId,
          type: 'order_delivered',
          message: `Order ${mainOrder._id} has been delivered to the customer.`,
          relatedId: mainOrder._id,
        })
      ),
    ]);

    // Notify admin that order is ready for completion/payout
    const io = req.app.get('io');
    if (io) {
      io.emit('admin_notification', {
        type: 'order_delivered',
        message: `Order ${mainOrder._id} has been delivered by rider ${req.rider.fullName}`,
        orderId: mainOrder._id,
        riderId: req.rider._id,
        riderName: req.rider.fullName,
        timestamp: Date.now()
      });

      // Notify customer
      io.emit(`user_${mainOrder.user}`, {
        type: 'order_delivered',
        message: `Your order has been delivered successfully!`,
        orderId: mainOrder._id,
        riderName: req.rider.fullName
      });

      // Notify vendor(s)
      deliveredShipments.forEach(shipment => {
        const payload = {
          type: 'order_delivered',
          message: `Order ${mainOrder._id} has been delivered to customer`,
          orderId: mainOrder._id,
          shipmentId: shipment._id
        };
        io.emit(`vendor_${shipment.vendor}`, payload);
        req.app.get('notifyVendor')?.(shipment.vendor.toString(), {
          title: 'Order delivered',
          message: payload.message,
          data: payload
        });
      });
    }

    res.json({ 
      success: true,
      message: 'Delivery verified successfully! Order marked as delivered.',
      earnings: riderEarnings
    });
    
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Verify delivery OTP error:', error);
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
  }
};

/**
 * @desc Get rider's active deliveries
 */
exports.getActiveDeliveries = async (req, res) => {
  try {
    const activeOrders = await MainOrder.find({
      rider: req.rider._id,
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
    .sort({ claimedAt: -1 })
    .limit(20);

    res.json({
      success: true,
      count: activeOrders.length,
      orders: activeOrders
    });
    
  } catch (error) {
    console.error('Get active deliveries error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error fetching active deliveries' 
    });
  }
};

/**
 * @desc Get rider's completed deliveries
 */
exports.getCompletedDeliveries = async (req, res) => {
  try {
    const completedOrders = await MainOrder.find({
      rider: req.rider._id,
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

    res.json({
      success: true,
      count: completedOrders.length,
      orders: completedOrders
    });
    
  } catch (error) {
    console.error('Get completed deliveries error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error fetching completed deliveries' 
    });
  }
};

/**
 * @desc Get rider's earnings and wallet info
 */
exports.getEarnings = async (req, res) => {
  try {
    const rider = await Rider.findById(req.rider._id)
      .select('walletBalance totalEarnings pendingEarnings totalWithdrawn withdrawalHistory')
      .populate('withdrawalHistory', 'amount status createdAt completedAt paymentMethod reference');

    if (!rider) {
      return res.status(404).json({ 
        success: false,
        message: 'Rider not found' 
      });
    }

    // Calculate weekly and monthly earnings
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Get recent completed shipments for detailed breakdown
    const weeklyShipments = await Shipment.find({
      rider: req.rider._id,
      isDelivered: true,
      deliveredAt: { $gte: oneWeekAgo }
    }).select('shippingPrice deliveredAt');

    const monthlyShipments = await Shipment.find({
      rider: req.rider._id,
      isDelivered: true,
      deliveredAt: { $gte: oneMonthAgo }
    }).select('shippingPrice deliveredAt');

    const weeklyEarnings = weeklyShipments.reduce((sum, shipment) => sum + (shipment.shippingPrice || 0), 0);
    const monthlyEarnings = monthlyShipments.reduce((sum, shipment) => sum + (shipment.shippingPrice || 0), 0);

    // Get pending withdrawals
    const pendingWithdrawals = rider.withdrawalHistory?.filter(w => w.status === 'pending') || [];

    res.json({
      success: true,
      walletBalance: rider.walletBalance || 0,
      totalEarnings: rider.totalEarnings || 0,
      pendingEarnings: rider.pendingEarnings || 0,
      totalWithdrawn: rider.totalWithdrawn || 0,
      weeklyEarnings,
      monthlyEarnings,
      availableForWithdrawal: rider.walletBalance,
      withdrawalHistory: rider.withdrawalHistory || [],
      pendingWithdrawals: pendingWithdrawals.map(w => ({
        amount: w.amount,
        reference: w.reference,
        createdAt: w.createdAt
      })),
      canWithdraw: rider.walletBalance >= 100 // Minimum withdrawal amount
    });
    
  } catch (error) {
    console.error('Get earnings error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error fetching earnings' 
    });
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
      return res.status(400).json({ 
        success: false,
        message: 'Minimum withdrawal amount is ₦100' 
      });
    }

    const rider = await Rider.findById(req.rider._id).session(session);
    if (!rider) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ 
        success: false,
        message: 'Rider not found' 
      });
    }

    // Check if rider can withdraw
    if (!rider.canWithdraw(amount)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ 
        success: false,
        message: `Insufficient balance or amount below minimum. Available: ₦${rider.walletBalance}, Minimum: ₦100` 
      });
    }

    const requestedPaymentMethod = paymentMethod || 'bank_transfer';
    const submittedAccount = accountDetails || {};
    const withdrawalAccountDetails = {
      bankName: submittedAccount.bankName || rider.bankAccount?.bankName || '',
      accountNumber:
        submittedAccount.accountNumber || rider.bankAccount?.accountNumber || '',
      accountName:
        submittedAccount.accountName || rider.bankAccount?.accountName || '',
      bankCode: submittedAccount.bankCode || rider.bankAccount?.bankCode || ''
    };

    // Admin verifies/processes the pending payout; the rider only needs saved bank details.
    if (
      requestedPaymentMethod === 'bank_transfer' &&
      (!withdrawalAccountDetails.bankName ||
        !withdrawalAccountDetails.accountNumber ||
        !withdrawalAccountDetails.accountName)
    ) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Please update your bank account details first'
      });
    }

    // Generate unique reference
    const reference = `RWD${Date.now()}${Math.floor(Math.random() * 1000)}`;

    // Create withdrawal record
    const withdrawalRecord = {
      amount: parseFloat(amount),
      status: 'pending',
      createdAt: Date.now(),
      reference,
      paymentMethod: requestedPaymentMethod,
      accountDetails: withdrawalAccountDetails
    };

    // Deduct from wallet and add to withdrawal history
    rider.walletBalance -= parseFloat(amount);
    rider.pendingEarnings += parseFloat(amount);
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
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
  }
};

/**
 * @desc Update bank account details
 */
exports.updateBankAccount = async (req, res) => {
  try {
    const { bankName, accountNumber, accountName, bankCode } = req.body;
    
    if (!bankName || !accountNumber || !accountName) {
      return res.status(400).json({ 
        success: false,
        message: 'Bank name, account number, and account name are required' 
      });
    }

    // Validate account number (Nigerian account numbers are 10 digits)
    if (!/^\d{10}$/.test(accountNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Account number must be 10 digits'
      });
    }

    const rider = await Rider.findById(req.rider._id);
    if (!rider) {
      return res.status(404).json({ 
        success: false,
        message: 'Rider not found' 
      });
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
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
  }
};

/**
 * @desc Get nearby riders (for admin/dispatch)
 */
exports.getNearbyRiders = async (req, res) => {
  try {
    const { lat, lng, maxDistance = 10000 } = req.query; // Default 10km
    
    if (!lat || !lng) {
      return res.status(400).json({ 
        success: false,
        message: 'Latitude and longitude are required' 
      });
    }

    const nearbyRiders = await Rider.findNearby(
      parseFloat(lat),
      parseFloat(lng),
      parseInt(maxDistance),
      20 // Limit to 20 riders
    );

    res.json({
      success: true,
      count: nearbyRiders.length,
      riders: nearbyRiders
    });
    
  } catch (error) {
    console.error('Get nearby riders error:', error);
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
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
      return res.status(400).json({ 
        success: false,
        message: 'Order ID and cancellation reason are required' 
      });
    }

    // Validate reason length
    if (reason.length < 10) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Please provide a detailed cancellation reason (minimum 10 characters)'
      });
    }

    // Validate order ID
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID'
      });
    }

    const mainOrder = await MainOrder.findById(orderId).session(session);
    if (!mainOrder) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ 
        success: false,
        message: 'Order not found' 
      });
    }

    // Check if rider is assigned to this order
    if (mainOrder.rider.toString() !== req.rider._id.toString()) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ 
        success: false,
        message: 'Not authorized for this order' 
      });
    }

    // Check if order can be cancelled (not already delivered/completed)
    if (['delivered', 'completed'].includes(mainOrder.mainOrderStatus)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ 
        success: false,
        message: 'Cannot cancel already delivered order' 
      });
    }

    // Check if order was picked up recently (within 30 minutes)
    if (mainOrder.pickedUpAt && (Date.now() - new Date(mainOrder.pickedUpAt).getTime()) < 30 * 60 * 1000) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel order that was picked up less than 30 minutes ago'
      });
    }

    // Update order status
    mainOrder.mainOrderStatus = 'cancelled';
    mainOrder.shipmentStatus = 'cancelled';
    mainOrder.isClaimed = false;
    mainOrder.rider = null;
    mainOrder.pickupOTP = null;
    mainOrder.deliveryOTP = null;
    mainOrder.cancelledAt = Date.now();
    mainOrder.cancellationReason = reason;

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
    const rider = await Rider.findById(req.rider._id).session(session);
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

      // Notify customer
      io.emit(`user_${mainOrder.user}`, {
        type: 'order_cancelled',
        message: `Your order has been cancelled by the rider. A new rider will be assigned shortly.`,
        orderId,
        reason: 'Rider cancellation'
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
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
  }
};

/**
 * @desc Get vendor location for a shipment
 */
exports.getVendorLocation = async (req, res) => {
  try {
    const { shipmentId } = req.params;
    
    // Validate shipment ID
    if (!mongoose.Types.ObjectId.isValid(shipmentId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid shipment ID'
      });
    }

    const shipment = await Shipment.findById(shipmentId)
      .populate('vendor', 'businessName businessLocation phoneNumber');
    
    if (!shipment) {
      return res.status(404).json({ 
        success: false,
        message: 'Shipment not found' 
      });
    }

    // Check if rider is assigned to this shipment
    if (shipment.rider?.toString() !== req.rider._id.toString()) {
      return res.status(403).json({ 
        success: false,
        message: 'Not authorized for this shipment' 
      });
    }

    res.json({
      success: true,
      vendor: {
        name: shipment.vendor.businessName,
        phone: shipment.vendor.phoneNumber,
        location: shipment.vendor.businessLocation
      },
      shipmentId: shipment._id,
      shipmentStatus: shipment.shipmentStatus
    });
    
  } catch (error) {
    console.error('Get vendor location error:', error);
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
  }
};

/**
 * @desc Get delivery location for an order
 */
exports.getDeliveryLocation = async (req, res) => {
  try {
    const { orderId } = req.params;
    
    // Validate order ID
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID'
      });
    }

    const mainOrder = await MainOrder.findById(orderId)
      .select('shippingAddress userLocation user')
      .populate('user', 'firstName lastName phoneNumber');
    
    if (!mainOrder) {
      return res.status(404).json({ 
        success: false,
        message: 'Order not found' 
      });
    }

    // Check if rider is assigned to this order
    if (mainOrder.rider?.toString() !== req.rider._id.toString()) {
      return res.status(403).json({ 
        success: false,
        message: 'Not authorized for this order' 
      });
    }

    res.json({
      success: true,
      customer: {
        name: `${mainOrder.user.firstName} ${mainOrder.user.lastName}`,
        phone: mainOrder.user.phoneNumber
      },
      deliveryAddress: mainOrder.shippingAddress,
      coordinates: mainOrder.userLocation,
      orderStatus: mainOrder.mainOrderStatus
    });
    
  } catch (error) {
    console.error('Get delivery location error:', error);
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
  }
};

/**
 * @desc Get rider dashboard stats
 */
exports.getDashboardStats = async (req, res) => {
  try {
    const rider = await Rider.findById(req.rider._id)
      .select('walletBalance totalEarnings completedDeliveries activeDeliveries rating totalRatings');
    
    if (!rider) {
      return res.status(404).json({ 
        success: false,
        message: 'Rider not found' 
      });
    }

    // Calculate recent earnings (last 7 days)
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Get completed shipments in last 7 days
    const weeklyShipments = await Shipment.find({
      rider: req.rider._id,
      isDelivered: true,
      deliveredAt: { $gte: oneWeekAgo }
    }).select('shippingPrice deliveredAt');

    const monthlyShipments = await Shipment.find({
      rider: req.rider._id,
      isDelivered: true,
      deliveredAt: { $gte: oneMonthAgo }
    }).select('shippingPrice deliveredAt');

    const todayShipments = await Shipment.find({
      rider: req.rider._id,
      isDelivered: true,
      deliveredAt: { $gte: today }
    }).select('shippingPrice deliveredAt');

    const weeklyEarnings = weeklyShipments.reduce((sum, shipment) => sum + (shipment.shippingPrice || 0), 0);
    const monthlyEarnings = monthlyShipments.reduce((sum, shipment) => sum + (shipment.shippingPrice || 0), 0);
    const todayEarnings = todayShipments.reduce((sum, shipment) => sum + (shipment.shippingPrice || 0), 0);

    // Calculate on-time delivery rate (example: deliveries within 2 hours of estimated time)
    const recentDeliveries = await Shipment.find({
      rider: req.rider._id,
      isDelivered: true,
      deliveredAt: { $gte: oneMonthAgo }
    }).select('estimatedDeliveryTime deliveredAt');

    let onTimeDeliveries = 0;
    recentDeliveries.forEach(delivery => {
      if (delivery.estimatedDeliveryTime && delivery.deliveredAt) {
        const deliveryTime = new Date(delivery.deliveredAt).getTime();
        const estimatedTime = new Date(delivery.estimatedDeliveryTime).getTime();
        if (deliveryTime <= estimatedTime + (2 * 60 * 60 * 1000)) { // Within 2 hours
          onTimeDeliveries++;
        }
      }
    });

    const onTimeRate = recentDeliveries.length > 0 ? (onTimeDeliveries / recentDeliveries.length) * 100 : 100;

    res.json({
      success: true,
      walletBalance: rider.walletBalance || 0,
      totalEarnings: rider.totalEarnings || 0,
      weeklyEarnings,
      monthlyEarnings,
      todayEarnings,
      completedDeliveries: rider.completedDeliveries || 0,
      activeDeliveries: rider.activeDeliveries || 0,
      averageRating: rider.totalRatings > 0 ? (rider.rating / rider.totalRatings).toFixed(1) : 0,
      totalRatings: rider.totalRatings || 0,
      performance: {
        cancellationRate: (rider.cancellationRate || 0) * 100, // Convert to percentage
        onTimeRate: Math.round(onTimeRate),
        satisfactionRate: rider.totalRatings > 0 ? Math.round((rider.rating / rider.totalRatings) * 20) : 100 // Convert 5-star to percentage
      },
      recentActivity: {
        lastWeekCount: weeklyShipments.length,
        lastMonthCount: monthlyShipments.length,
        todayCount: todayShipments.length
      }
    });
    
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
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
