const Rider = require('../models/Rider');
const MainOrder = require('../models/MainOrder');
const Shipment = require('../models/Shipment');
const notificationService = require('./notificationService');
const { calculateDistance } = require('../utils/distanceCalculator');
const { calculateOrderRiderEarningsBreakdown } = require('./riderEarningsService');

const MAX_ACTIVE_DELIVERIES = 5;
const DEFAULT_OFFER_LIMIT = 1;
const DEFAULT_RADIUS_KM = 25;
const DEFAULT_LOCATION_MAX_AGE_MINUTES = 10;
const DEFAULT_ASSIGNMENT_TIMEOUT_SECONDS = 600;

const riderNotification = ({ message, relatedId }) => ({
  type: 'order_update',
  message,
  relatedId,
  relatedModel: 'MainOrder',
});

const formatLastSeen = (date) => {
  if (!date) return 'never';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} day(s) ago`;
};

const distanceFromPickup = (rider, pickupLocation) => {
  if (!pickupLocation?.latitude || !pickupLocation?.longitude) return null;
  if (!rider.currentLocation?.lat || !rider.currentLocation?.lng) return null;

  return calculateDistance(
    rider.currentLocation.lat,
    rider.currentLocation.lng,
    pickupLocation.latitude,
    pickupLocation.longitude,
  );
};

const findEligibleRiders = async ({
  pickupLocation,
  radiusKm = DEFAULT_RADIUS_KM,
  limit = DEFAULT_OFFER_LIMIT,
  locationMaxAgeMinutes = DEFAULT_LOCATION_MAX_AGE_MINUTES,
  excludeRiderIds = [],
} = {}) => {
  const locationCutoff = new Date(
    Date.now() - Number(locationMaxAgeMinutes || DEFAULT_LOCATION_MAX_AGE_MINUTES) * 60 * 1000,
  );

  const excludedIds = excludeRiderIds.filter(Boolean);
  const riders = await Rider.find({
    status: 'approved',
    isAvailable: true,
    isActive: true,
    activeDeliveries: { $lt: MAX_ACTIVE_DELIVERIES },
    'currentLocation.lat': { $exists: true, $ne: null },
    'currentLocation.lng': { $exists: true, $ne: null },
    'currentLocation.lastUpdated': { $gte: locationCutoff },
    ...(excludedIds.length > 0 ? { _id: { $nin: excludedIds } } : {}),
  })
    .select('fullName phoneNumber plateNumber vehicleType currentLocation activeDeliveries rating totalRatings')
    .lean();

  return riders
    .map((rider) => ({
      ...rider,
      distanceKm: distanceFromPickup(rider, pickupLocation),
      lastSeenAt: rider.currentLocation?.lastUpdated || null,
      lastSeenLabel: formatLastSeen(rider.currentLocation?.lastUpdated),
    }))
    .filter((rider) => rider.distanceKm != null && rider.distanceKm <= radiusKm)
    .sort((a, b) => {
      const aDistance = a.distanceKm ?? Number.MAX_SAFE_INTEGER;
      const bDistance = b.distanceKm ?? Number.MAX_SAFE_INTEGER;
      if (aDistance !== bDistance) return aDistance - bDistance;
      return (a.activeDeliveries || 0) - (b.activeDeliveries || 0);
    })
    .slice(0, limit);
};

const notifyEligibleRidersForShipment = async ({
  app,
  shipment,
  mainOrder,
  radiusKm,
  limit,
  markReady = true,
}) => {
  if (!shipment || !mainOrder) return [];

  const riders = await findEligibleRiders({
    pickupLocation: shipment.vendorLocation,
    radiusKm,
    limit: limit || 1,
    excludeRiderIds: mainOrder.assignmentRejectedBy || [],
  });

  if (riders.length === 0) {
    app?.get('notifyAdmin')?.({
      type: 'no_online_rider_near_pickup',
      message: `No online rider with a fresh GPS location was found near order ${mainOrder._id}.`,
      orderId: mainOrder._id,
      shipmentId: shipment._id,
    });
    return [];
  }

  const nearestRider = riders[0];
  const payoutBreakdown = calculateOrderRiderEarningsBreakdown({
    mainOrder,
    shipments: [shipment],
  });
  const message = `New pickup available for order ${mainOrder._id}. Estimated earning: ₦${Number(
    payoutBreakdown.amount || 0,
  ).toFixed(0)}.`;

  const mainOrderSet = {
    assignedRider: nearestRider._id,
    assignedAt: new Date(),
  };
  if (markReady) {
    mainOrderSet.shipmentStatus = 'ready_for_pickup';
  }

  const assignedOrder = await MainOrder.findOneAndUpdate(
    {
      _id: mainOrder._id,
      isClaimed: false,
      mainOrderStatus: { $nin: ['delivered', 'completed', 'cancelled'] },
      $or: [{ assignedRider: null }, { assignedRider: { $exists: false } }],
      assignmentRejectedBy: { $ne: nearestRider._id },
    },
    {
      $set: mainOrderSet,
    },
    { new: true },
  );

  if (!assignedOrder) return [];

  await Shipment.findOneAndUpdate(
    {
      _id: shipment._id,
      isClaimed: false,
      $or: [{ assignedRider: null }, { assignedRider: { $exists: false } }],
      assignmentRejectedBy: { $ne: nearestRider._id },
    },
    {
      $set: {
        assignedRider: nearestRider._id,
        assignedAt: new Date(),
      },
    },
  );

  await notifyRiderAssignmentOffer({
    app,
    riderId: nearestRider._id,
    mainOrder: assignedOrder,
    message,
    type: 'delivery_offer',
    title: 'New delivery available',
  });

  app?.get('notifyAdmin')?.({
    type: 'nearest_rider_assignment_sent',
    message: `Assigned order ${mainOrder._id} to nearest online rider ${nearestRider.fullName}.`,
    orderId: mainOrder._id,
    shipmentId: shipment._id,
    riderId: nearestRider._id,
    distanceKm: nearestRider.distanceKm,
  });

  return riders;
};

const releaseExpiredRiderAssignments = async ({
  app,
  timeoutSeconds = Number(process.env.RIDER_ASSIGNMENT_TIMEOUT_SECONDS || DEFAULT_ASSIGNMENT_TIMEOUT_SECONDS),
  limit = 20,
} = {}) => {
  const timeoutMs = Math.max(60, Number(timeoutSeconds || DEFAULT_ASSIGNMENT_TIMEOUT_SECONDS)) * 1000;
  const cutoff = new Date(Date.now() - timeoutMs);
  const expiredOrders = await MainOrder.find({
    isClaimed: false,
    assignedRider: { $ne: null },
    assignedAt: { $lte: cutoff },
    mainOrderStatus: { $nin: ['delivered', 'completed', 'cancelled'] },
  })
    .select('_id assignedRider assignedAt assignmentRejectedBy totalShippingPrice')
    .sort({ assignedAt: 1 })
    .limit(limit);

  for (const order of expiredOrders) {
    const expiredRiderId = order.assignedRider;
    if (!expiredRiderId) continue;

    const releasedOrder = await MainOrder.findOneAndUpdate(
      {
        _id: order._id,
        assignedRider: expiredRiderId,
        isClaimed: false,
      },
      {
        $unset: {
          assignedRider: '',
          assignedAt: '',
        },
        $addToSet: {
          assignmentRejectedBy: expiredRiderId,
        },
      },
      { new: true },
    );

    if (!releasedOrder) continue;

    await Shipment.updateMany(
      {
        mainOrder: order._id,
        assignedRider: expiredRiderId,
        isClaimed: false,
      },
      {
        $unset: {
          assignedRider: '',
          assignedAt: '',
        },
        $addToSet: {
          assignmentRejectedBy: expiredRiderId,
        },
      },
    );

    app?.get('notifyRider')?.(expiredRiderId.toString(), {
      type: 'rider_assignment_expired',
      title: 'Delivery offer expired',
      message: 'This delivery offer expired because it was not accepted in time.',
      orderId: order._id,
    });

    app?.get('notifyAdmin')?.({
      type: 'rider_assignment_expired',
      message: `Rider assignment for order ${order._id} expired after ${Math.round(timeoutMs / 1000)} seconds.`,
      orderId: order._id,
      riderId: expiredRiderId,
    });

    const nextShipment = await Shipment.findOne({
      mainOrder: order._id,
      shipmentStatus: 'ready_for_pickup',
      isClaimed: false,
    });

    if (nextShipment) {
      await notifyEligibleRidersForShipment({
        app,
        shipment: nextShipment,
        mainOrder: releasedOrder,
      });
    }
  }

  return expiredOrders.length;
};

const notifyAssignedRider = async ({ app, riderId, mainOrder, pickupOTP, deliveryOTP }) => {
  if (!riderId || !mainOrder) return;

  const message = `You accepted order ${mainOrder._id}. Pickup OTP is ${pickupOTP}.`;
  await Rider.findByIdAndUpdate(riderId, {
    $push: {
      notifications: riderNotification({
        message,
        relatedId: mainOrder._id,
      }),
    },
  });

  app?.get('notifyRider')?.(riderId.toString(), {
    type: 'order_assigned',
    title: 'Delivery assigned',
    message,
    orderId: mainOrder._id,
    pickupOTP,
    deliveryOTP,
  });

  await notificationService.sendToUser(riderId.toString(), {
    title: 'Delivery assigned',
    message,
    data: {
      type: 'order_assigned',
      orderId: mainOrder._id,
      pickupOTP,
      deliveryOTP,
    },
  }).catch((error) => {
    console.error(`Rider push notification failed for ${riderId}:`, error.message);
  });
};

const notifyRiderAssignmentOffer = async ({
  app,
  riderId,
  mainOrder,
  message = 'New delivery job assigned to you. Open Assigned Orders to accept or reject.',
  type = 'rider_order_assigned',
  title = 'New assigned order',
}) => {
  if (!riderId || !mainOrder) return;

  const shipments = await Shipment.find({ mainOrder: mainOrder._id }).lean();
  const payoutBreakdown =
    mainOrder.riderPayoutBreakdown ||
    calculateOrderRiderEarningsBreakdown({
      mainOrder,
      shipments,
    });

  const payload = {
    type,
    title,
    message,
    orderId: mainOrder._id,
    estimatedEarnings: Number(mainOrder.riderPayoutAmount || payoutBreakdown.amount || 0),
    riderPayoutBreakdown: payoutBreakdown,
  };

  await Rider.findByIdAndUpdate(riderId, {
    $push: {
      notifications: riderNotification({
        message,
        relatedId: mainOrder._id,
      }),
    },
  });

  app?.get('notifyRider')?.(riderId.toString(), payload);

  await notificationService.sendToUser(riderId.toString(), {
    title: payload.title,
    message,
    data: payload,
  }).catch((error) => {
    console.error(`Rider assignment offer push failed for ${riderId}:`, error.message);
  });
};

module.exports = {
  MAX_ACTIVE_DELIVERIES,
  findEligibleRiders,
  notifyEligibleRidersForShipment,
  notifyAssignedRider,
  notifyRiderAssignmentOffer,
  releaseExpiredRiderAssignments,
};
