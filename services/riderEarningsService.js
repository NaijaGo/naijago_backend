const Rider = require('../models/Rider');

const RIDER_RATE_PER_KM = Number(process.env.RIDER_EARNING_RATE_PER_KM || 150);
const FALLBACK_RIDER_SHIPPING_SHARE = Number(process.env.RIDER_SHIPPING_SHARE || 0.7);

const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100;

const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const coords = [lat1, lon1, lat2, lon2].map(Number);
  if (coords.some((coord) => !Number.isFinite(coord))) return null;

  const [fromLat, fromLon, toLat, toLon] = coords;
  const radiusKm = 6371;
  const dLat = (toLat - fromLat) * (Math.PI / 180);
  const dLon = (toLon - fromLon) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(fromLat * (Math.PI / 180)) *
      Math.cos(toLat * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return parseFloat((radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(2));
};

const calculateShipmentRiderEarning = (shipment, mainOrder) => {
  return calculateShipmentRiderEarningBreakdown(shipment, mainOrder).amount;
};

const calculateShipmentRiderEarningBreakdown = (shipment, mainOrder) => {
  const distanceKm = calculateDistance(
    shipment?.vendorLocation?.latitude,
    shipment?.vendorLocation?.longitude,
    mainOrder?.userLocation?.latitude,
    mainOrder?.userLocation?.longitude,
  );

  if (distanceKm !== null) {
    return {
      shipmentId: shipment?._id || null,
      method: 'distance_rate',
      distanceKm,
      ratePerKm: RIDER_RATE_PER_KM,
      shippingPrice: roundMoney(shipment?.shippingPrice || 0),
      fallbackShare: null,
      amount: roundMoney(distanceKm * RIDER_RATE_PER_KM),
    };
  }

  return {
    shipmentId: shipment?._id || null,
    method: 'shipping_share',
    distanceKm: null,
    ratePerKm: null,
    shippingPrice: roundMoney(shipment?.shippingPrice || 0),
    fallbackShare: FALLBACK_RIDER_SHIPPING_SHARE,
    amount: roundMoney(Number(shipment?.shippingPrice || 0) * FALLBACK_RIDER_SHIPPING_SHARE),
  };
};

const calculateOrderRiderEarnings = ({ mainOrder, shipments = [] }) => {
  return calculateOrderRiderEarningsBreakdown({ mainOrder, shipments }).amount;
};

const calculateOrderRiderEarningsBreakdown = ({ mainOrder, shipments = [] }) => {
  const sourceShipments = shipments.length ? shipments : mainOrder?.shipments || [];
  const shipmentBreakdowns = sourceShipments.map((shipment) =>
    calculateShipmentRiderEarningBreakdown(shipment, mainOrder),
  );
  const amount = roundMoney(
    shipmentBreakdowns.reduce((sum, shipment) => sum + shipment.amount, 0),
  );
  const distanceShipments = shipmentBreakdowns.filter((shipment) => shipment.distanceKm !== null);
  const totalDistanceKm = roundMoney(
    distanceShipments.reduce((sum, shipment) => sum + Number(shipment.distanceKm || 0), 0),
  );

  return {
    method:
      distanceShipments.length === shipmentBreakdowns.length
        ? 'distance_rate'
        : distanceShipments.length > 0
          ? 'mixed'
          : 'shipping_share',
    amount,
    totalDistanceKm,
    ratePerKm: RIDER_RATE_PER_KM,
    fallbackShare: FALLBACK_RIDER_SHIPPING_SHARE,
    shipments: shipmentBreakdowns,
  };
};

const creditRiderForCompletedOrder = async ({
  mainOrder,
  shipments = [],
  session,
  updateDeliveryStats = false,
}) => {
  const riderId =
    mainOrder?.rider ||
    shipments.find((shipment) => shipment?.rider)?.rider ||
    null;

  if (!riderId || mainOrder.riderPaidAt) {
    return {
      credited: false,
      amount: Number(mainOrder?.riderPayoutAmount || 0),
      breakdown: mainOrder?.riderPayoutBreakdown || null,
    };
  }

  const breakdown = calculateOrderRiderEarningsBreakdown({ mainOrder, shipments });
  const amount = breakdown.amount;
  if (amount <= 0) return { credited: false, amount: 0 };

  const inc = {
    walletBalance: amount,
    totalEarnings: amount,
  };

  if (updateDeliveryStats) {
    inc.activeDeliveries = -1;
    inc.completedDeliveries = 1;
  }

  await Rider.findByIdAndUpdate(
    riderId,
    {
      $inc: inc,
      $set: { lastActive: new Date() },
    },
    { session },
  );

  mainOrder.riderPaidAt = new Date();
  mainOrder.riderPayoutAmount = amount;
  mainOrder.riderPayoutBreakdown = breakdown;

  return { credited: true, amount, breakdown };
};

module.exports = {
  calculateOrderRiderEarnings,
  calculateOrderRiderEarningsBreakdown,
  calculateShipmentRiderEarning,
  calculateShipmentRiderEarningBreakdown,
  creditRiderForCompletedOrder,
};
