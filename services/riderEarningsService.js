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
  const distanceKm = calculateDistance(
    shipment?.vendorLocation?.latitude,
    shipment?.vendorLocation?.longitude,
    mainOrder?.userLocation?.latitude,
    mainOrder?.userLocation?.longitude,
  );

  if (distanceKm !== null) {
    return roundMoney(distanceKm * RIDER_RATE_PER_KM);
  }

  return roundMoney(Number(shipment?.shippingPrice || 0) * FALLBACK_RIDER_SHIPPING_SHARE);
};

const calculateOrderRiderEarnings = ({ mainOrder, shipments = [] }) => {
  const sourceShipments = shipments.length ? shipments : mainOrder?.shipments || [];
  return roundMoney(
    sourceShipments.reduce(
      (sum, shipment) => sum + calculateShipmentRiderEarning(shipment, mainOrder),
      0,
    ),
  );
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
    return { credited: false, amount: Number(mainOrder?.riderPayoutAmount || 0) };
  }

  const amount = calculateOrderRiderEarnings({ mainOrder, shipments });
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

  return { credited: true, amount };
};

module.exports = {
  calculateOrderRiderEarnings,
  calculateShipmentRiderEarning,
  creditRiderForCompletedOrder,
};
