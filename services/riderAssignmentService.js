const Rider = require('../models/Rider');
const notificationService = require('./notificationService');
const { calculateDistance } = require('../utils/distanceCalculator');

const MAX_ACTIVE_DELIVERIES = 5;
const DEFAULT_OFFER_LIMIT = 5;
const DEFAULT_RADIUS_KM = 25;

const riderNotification = ({ message, relatedId }) => ({
  type: 'order_update',
  message,
  relatedId,
  relatedModel: 'MainOrder',
});

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
} = {}) => {
  const riders = await Rider.find({
    status: 'approved',
    isAvailable: true,
    isActive: true,
    activeDeliveries: { $lt: MAX_ACTIVE_DELIVERIES },
  })
    .select('fullName phoneNumber plateNumber vehicleType currentLocation activeDeliveries rating totalRatings')
    .lean();

  return riders
    .map((rider) => ({
      ...rider,
      distanceKm: distanceFromPickup(rider, pickupLocation),
    }))
    .filter((rider) => rider.distanceKm == null || rider.distanceKm <= radiusKm)
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
}) => {
  if (!shipment || !mainOrder) return [];

  const riders = await findEligibleRiders({
    pickupLocation: shipment.vendorLocation,
    radiusKm,
    limit,
  });

  if (riders.length === 0) return [];

  const message = `New pickup available for order ${mainOrder._id}. Estimated earning: ₦${Number(
    mainOrder.totalShippingPrice || shipment.shippingPrice || 0,
  ).toFixed(0)}.`;

  await Rider.updateMany(
    { _id: { $in: riders.map((rider) => rider._id) } },
    {
      $push: {
        notifications: riderNotification({
          message,
          relatedId: mainOrder._id,
        }),
      },
    },
  );

  const payload = {
    type: 'delivery_offer',
    title: 'New delivery available',
    message,
    orderId: mainOrder._id,
    shipmentId: shipment._id,
    estimatedEarnings: Number(mainOrder.totalShippingPrice || shipment.shippingPrice || 0) * 0.7,
    pickupLocation: shipment.vendorLocation,
  };

  for (const rider of riders) {
    app?.get('notifyRider')?.(rider._id.toString(), payload);
  }

  await Promise.allSettled(
    riders.map((rider) =>
      notificationService.sendToUser(rider._id.toString(), {
        title: payload.title,
        message,
        data: payload,
      })
    )
  );

  app?.get('notifyAdmin')?.({
    type: 'rider_offer_wave_sent',
    message: `Sent rider offer for order ${mainOrder._id} to ${riders.length} riders.`,
    orderId: mainOrder._id,
    shipmentId: shipment._id,
    riderCount: riders.length,
  });

  return riders;
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

module.exports = {
  MAX_ACTIVE_DELIVERIES,
  findEligibleRiders,
  notifyEligibleRidersForShipment,
  notifyAssignedRider,
};
