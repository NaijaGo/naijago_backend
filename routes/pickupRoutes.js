const crypto = require('crypto');
const express = require('express');

const MainOrder = require('../models/MainOrder');
const Shipment = require('../models/Shipment');
const User = require('../models/User');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const notificationService = require('../services/notificationService');

const router = express.Router();

const pickupSecret = () =>
  process.env.PICKUP_CODE_SECRET ||
  process.env.JWT_SECRET ||
  'naijago-pickup-development-only';

const signatureFor = (value) =>
  crypto.createHmac('sha256', pickupSecret()).update(String(value)).digest('hex');

const pickupCodeFor = (shipmentId) => {
  const numeric = BigInt(`0x${signatureFor(`code:${shipmentId}`).slice(0, 12)}`);
  return `NG-${String(numeric % 100000n).padStart(5, '0')}`;
};

const pickupQrTokenFor = (shipmentId) =>
  signatureFor(`qr:${shipmentId}:${pickupCodeFor(shipmentId)}`);

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const customerNotification = async ({ userId, shipment, title, message, type }) => {
  const data = {
    type,
    shipmentId: String(shipment._id),
    orderId: String(shipment.mainOrder?._id || shipment.mainOrder),
    fulfillmentMethod: 'pickup',
  };
  await User.findByIdAndUpdate(userId, {
    $push: {
      notifications: {
        type,
        message,
        relatedId: shipment._id,
        read: false,
        createdAt: new Date(),
        data,
      },
    },
  }).catch((error) => {
    console.error('Unable to store pickup notification:', error.message);
  });
  notificationService.sendToUser(
    String(userId),
    { title, message, data },
    { audience: 'customer' },
  ).catch((error) => {
    console.error('Unable to push pickup notification:', error.message);
  });
};

const pickupCredentialPayload = (shipment) => ({
  pickupCode: pickupCodeFor(shipment._id),
  qrToken: pickupQrTokenFor(shipment._id),
  qrPayload: JSON.stringify({
    version: 1,
    type: 'naijago_pickup',
    shipmentId: String(shipment._id),
    token: pickupQrTokenFor(shipment._id),
  }),
});

router.get('/vendor/settings', protect, authorizeRoles('vendor'), async (req, res) => {
  const vendor = await User.findById(req.user._id)
    .select('businessName businessLocation phoneNumber businessSupportPhone pickupEnabled pickupSettings')
    .lean();
  return res.json({
    pickupEnabled: vendor?.pickupEnabled === true,
    businessName: vendor?.businessName || '',
    businessLocation: vendor?.businessLocation || null,
    phoneNumber: vendor?.businessSupportPhone || vendor?.phoneNumber || '',
    pickupSettings: vendor?.pickupSettings || {},
  });
});

router.put('/vendor/settings', protect, authorizeRoles('vendor'), async (req, res) => {
  const pickupEnabled = req.body.pickupEnabled === true;
  const settings = req.body.pickupSettings || {};
  const vendor = await User.findById(req.user._id);
  if (!vendor || vendor.vendorStatus !== 'approved') {
    return res.status(403).json({ message: 'Only approved vendors can configure pickup.' });
  }
  if (
    pickupEnabled &&
    (
      !vendor.businessLocation?.formattedAddress ||
      !Number.isFinite(Number(vendor.businessLocation?.latitude)) ||
      !Number.isFinite(Number(vendor.businessLocation?.longitude))
    )
  ) {
    return res.status(400).json({
      message: 'Add your complete shop address and map location before enabling pickup.',
    });
  }
  vendor.pickupEnabled = pickupEnabled;
  vendor.pickupSettings = {
    shopName: String(settings.shopName || vendor.businessName || '').trim(),
    phoneNumber: String(
      settings.phoneNumber ||
      vendor.businessSupportPhone ||
      vendor.phoneNumber ||
      '',
    ).trim(),
    instructions: String(settings.instructions || '').trim(),
    estimatedPreparationMinutes: Math.min(
      Math.max(Number(settings.estimatedPreparationMinutes) || 30, 0),
      1440,
    ),
    maximumConcurrentOrders: Math.min(
      Math.max(Number(settings.maximumConcurrentOrders) || 20, 1),
      1000,
    ),
    hours: Array.isArray(settings.hours) ? settings.hours : [],
  };
  await vendor.save();
  return res.json({
    message: pickupEnabled ? 'Customer pickup is enabled.' : 'Customer pickup is disabled.',
    pickupEnabled: vendor.pickupEnabled,
    pickupSettings: vendor.pickupSettings,
  });
});

router.get('/vendor/orders', protect, authorizeRoles('vendor'), async (req, res) => {
  const statuses = String(req.query.status || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const filter = {
    vendor: req.user._id,
    fulfillmentMethod: 'pickup',
    ...(statuses.length ? { shipmentStatus: { $in: statuses } } : {}),
  };
  const shipments = await Shipment.find(filter)
    .populate('mainOrder', 'user isPaid paidAt createdAt totalPrice mainOrderStatus')
    .populate({
      path: 'mainOrder',
      populate: { path: 'user', select: 'firstName lastName phoneNumber' },
    })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  return res.json(shipments);
});

router.patch(
  '/vendor/orders/:shipmentId/status',
  protect,
  authorizeRoles('vendor'),
  async (req, res) => {
    const requested = String(req.body.status || '').toLowerCase();
    const transitions = {
      processing: ['accepted'],
      accepted: ['preparing', 'ready_for_customer_pickup'],
      preparing: ['ready_for_customer_pickup'],
    };
    const shipment = await Shipment.findOne({
      _id: req.params.shipmentId,
      vendor: req.user._id,
      fulfillmentMethod: 'pickup',
    }).populate('mainOrder', 'user isPaid');
    if (!shipment) {
      return res.status(404).json({ message: 'Pickup order not found.' });
    }
    if (!shipment.mainOrder?.isPaid) {
      return res.status(409).json({ message: 'Payment has not been confirmed for this order.' });
    }
    if (!(transitions[shipment.shipmentStatus] || []).includes(requested)) {
      return res.status(409).json({
        message: `Cannot change a pickup order from ${shipment.shipmentStatus} to ${requested}.`,
      });
    }

    shipment.shipmentStatus = requested;
    if (requested === 'accepted') shipment.acceptedAt = new Date();
    if (requested === 'ready_for_customer_pickup') {
      shipment.pickupDetails.readyAt = new Date();
    }
    await shipment.save();

    const notificationCopy = requested === 'accepted'
      ? {
          title: 'Pickup order accepted',
          message: `Your order from ${shipment.sellerName} has been accepted.`,
          type: 'pickup_accepted',
        }
      : requested === 'preparing'
      ? {
          title: 'Your order is being prepared',
          message: `${shipment.sellerName} has started preparing your pickup order.`,
          type: 'pickup_preparing',
        }
      : {
          title: 'Your order is ready!',
          message: `You can now pick up your order from ${shipment.sellerName}.`,
          type: 'pickup_ready',
        };
    await customerNotification({
      userId: shipment.mainOrder.user,
      shipment,
      ...notificationCopy,
    });
    return res.json({ message: 'Pickup status updated.', shipment });
  },
);

router.post(
  '/vendor/orders/:shipmentId/verify',
  protect,
  authorizeRoles('vendor'),
  async (req, res) => {
    const shipment = await Shipment.findOne({
      _id: req.params.shipmentId,
      vendor: req.user._id,
      fulfillmentMethod: 'pickup',
    }).populate('mainOrder', 'user isPaid');
    if (!shipment) {
      return res.status(404).json({ message: 'Pickup order not found.' });
    }
    if (!shipment.mainOrder?.isPaid) {
      return res.status(409).json({ message: 'Payment has not been confirmed.' });
    }
    if (shipment.shipmentStatus !== 'ready_for_customer_pickup') {
      return res.status(409).json({ message: 'This order is not ready for pickup verification.' });
    }
    if (shipment.pickupDetails?.verifiedAt) {
      return res.status(409).json({ message: 'This pickup credential has already been used.' });
    }

    const submittedCode = String(req.body.pickupCode || '').trim().toUpperCase();
    const submittedQr = String(req.body.qrToken || '').trim();
    const codeMatches =
      submittedCode && safeEqual(submittedCode, pickupCodeFor(shipment._id));
    const qrMatches =
      submittedQr && safeEqual(submittedQr, pickupQrTokenFor(shipment._id));
    if (!codeMatches && !qrMatches) {
      await Shipment.updateOne(
        { _id: shipment._id },
        { $inc: { 'pickupDetails.failedVerificationAttempts': 1 } },
      );
      return res.status(400).json({ message: 'Invalid pickup code or QR code.' });
    }

    const verifiedAt = new Date();
    const updated = await Shipment.findOneAndUpdate(
      {
        _id: shipment._id,
        shipmentStatus: 'ready_for_customer_pickup',
        'pickupDetails.verifiedAt': null,
      },
      {
        $set: {
          shipmentStatus: 'picked_up',
          isDelivered: true,
          deliveredAt: verifiedAt,
          'pickupDetails.verifiedAt': verifiedAt,
          'pickupDetails.verificationMethod': qrMatches ? 'qr' : 'code',
          'pickupDetails.verifiedBy': req.user._id,
        },
      },
      { new: true },
    );
    if (!updated) {
      return res.status(409).json({ message: 'This pickup was already verified.' });
    }

    const unfinishedShipments = await Shipment.countDocuments({
      mainOrder: shipment.mainOrder._id,
      shipmentStatus: { $nin: ['picked_up', 'delivered', 'cancelled', 'returned'] },
    });
    if (unfinishedShipments === 0) {
      await MainOrder.findByIdAndUpdate(shipment.mainOrder._id, {
        $set: {
          mainOrderStatus: 'delivered',
          shipmentStatus: 'delivered',
          isDelivered: true,
          deliveredAt: verifiedAt,
        },
      });
    }

    await customerNotification({
      userId: shipment.mainOrder.user,
      shipment: updated,
      title: 'Pickup completed',
      message: `Your order from ${shipment.sellerName} was collected successfully.`,
      type: 'pickup_completed',
    });
    return res.json({
      message: 'Pickup Verified',
      shipment: updated,
    });
  },
);

router.get('/my-orders', protect, async (req, res) => {
  const mainOrders = await MainOrder.find({ user: req.user._id })
    .select('_id')
    .lean();
  const orderIds = mainOrders.map((order) => order._id);
  const shipments = await Shipment.find({
    mainOrder: { $in: orderIds },
    fulfillmentMethod: 'pickup',
  })
    .populate('vendor', 'businessName businessLocation phoneNumber businessSupportPhone pickupSettings')
    .sort({ createdAt: -1 })
    .lean();
  return res.json(shipments);
});

router.get('/my-orders/:shipmentId', protect, async (req, res) => {
  const shipment = await Shipment.findOne({
    _id: req.params.shipmentId,
    fulfillmentMethod: 'pickup',
  })
    .populate('mainOrder', 'user isPaid paidAt createdAt totalPrice mainOrderStatus')
    .populate('vendor', 'businessName businessLocation phoneNumber businessSupportPhone pickupSettings')
    .lean();
  if (!shipment || String(shipment.mainOrder?.user) !== String(req.user._id)) {
    return res.status(404).json({ message: 'Pickup order not found.' });
  }
  return res.json({
    ...shipment,
    pickupCredential: shipment.mainOrder?.isPaid
      ? pickupCredentialPayload(shipment)
      : null,
  });
});

router.get('/admin/orders', protect, authorizeRoles('admin'), async (req, res) => {
  const status = String(req.query.status || '').trim();
  const filter = {
    fulfillmentMethod: 'pickup',
    ...(status ? { shipmentStatus: status } : {}),
  };
  const orders = await Shipment.find(filter)
    .populate('vendor', 'businessName businessLocation pickupSettings')
    .populate({
      path: 'mainOrder',
      select: 'user isPaid paidAt totalPrice createdAt mainOrderStatus',
      populate: { path: 'user', select: 'firstName lastName phoneNumber email' },
    })
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  return res.json(orders);
});

router.get('/admin/analytics', protect, authorizeRoles('admin'), async (_req, res) => {
  const [totals, byVendor] = await Promise.all([
    Shipment.aggregate([
      { $match: { fulfillmentMethod: 'pickup' } },
      { $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        pickupRevenue: { $sum: '$subtotal' },
        completed: { $sum: { $cond: [{ $eq: ['$shipmentStatus', 'picked_up'] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ['$shipmentStatus', 'cancelled'] }, 1, 0] } },
        averagePreparationMinutes: { $avg: {
          $cond: [
            { $and: ['$acceptedAt', '$pickupDetails.readyAt'] },
            { $divide: [{ $subtract: ['$pickupDetails.readyAt', '$acceptedAt'] }, 60000] },
            null,
          ],
        } },
        averagePickupMinutes: { $avg: {
          $cond: [
            { $and: ['$pickupDetails.readyAt', '$pickupDetails.verifiedAt'] },
            { $divide: [{ $subtract: ['$pickupDetails.verifiedAt', '$pickupDetails.readyAt'] }, 60000] },
            null,
          ],
        } },
      } },
    ]),
    Shipment.aggregate([
      { $match: { fulfillmentMethod: 'pickup' } },
      { $group: { _id: '$vendor', orders: { $sum: 1 }, revenue: { $sum: '$subtotal' }, completed: { $sum: { $cond: [{ $eq: ['$shipmentStatus', 'picked_up'] }, 1, 0] } } } },
      { $sort: { orders: -1 } },
      { $limit: 100 },
    ]),
  ]);
  const summary = totals[0] || { totalOrders: 0, pickupRevenue: 0, completed: 0, cancelled: 0, averagePreparationMinutes: 0, averagePickupMinutes: 0 };
  summary.pending = Math.max(summary.totalOrders - summary.completed - summary.cancelled, 0);
  return res.json({ summary, byVendor });
});

module.exports = router;
