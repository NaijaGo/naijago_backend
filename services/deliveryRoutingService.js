const crypto = require('crypto');
const { getDrivingRoute } = require('./mapboxDirectionsService');

const ROUTE_CACHE_TTL_MS = 10 * 60 * 1000;
const ROUTE_CACHE_MAX_ENTRIES = 1000;
const routeCache = new Map();

const readCoordinate = (value, minimum, maximum) => {
  if (value === null || value === undefined || value === '') return null;
  const coordinate = Number(value);
  return Number.isFinite(coordinate) && coordinate >= minimum && coordinate <= maximum
    ? coordinate
    : null;
};

const normalizeRouteStops = (stops = []) => {
  if (!Array.isArray(stops) || stops.length < 2) {
    const error = new Error('A pickup location and customer location are required.');
    error.statusCode = 400;
    error.code = 'MISSING_ROUTE_STOPS';
    throw error;
  }

  if (stops.length > 25) {
    const error = new Error('This order has more pickup stops than road routing can support.');
    error.statusCode = 422;
    error.code = 'TOO_MANY_ROUTE_STOPS';
    throw error;
  }

  return stops.map((stop) => {
    const latitude = readCoordinate(stop?.latitude, -90, 90);
    const longitude = readCoordinate(stop?.longitude, -180, 180);
    if (latitude === null || longitude === null) {
      const error = new Error('A delivery location is missing valid coordinates.');
      error.statusCode = 400;
      error.code = 'INVALID_ROUTE_COORDINATES';
      throw error;
    }
    return {
      latitude: Number(latitude.toFixed(6)),
      longitude: Number(longitude.toFixed(6)),
    };
  });
};

const trimExpiredRoutes = (now) => {
  for (const [key, cached] of routeCache) {
    if (cached.expiresAt <= now) routeCache.delete(key);
  }
  while (routeCache.size >= ROUTE_CACHE_MAX_ENTRIES) {
    routeCache.delete(routeCache.keys().next().value);
  }
};

const getRoadRoute = async (stops) => {
  const coordinates = normalizeRouteStops(stops);
  const cacheKey = crypto
    .createHash('sha256')
    .update(JSON.stringify({ profile: 'driving', coordinates }))
    .digest('hex');
  const now = Date.now();
  const cached = routeCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.route;

  const route = await getDrivingRoute(coordinates);
  const result = {
    distanceKm: Number((route.distanceMeters / 1000).toFixed(3)),
    durationMinutes: Number((route.durationSeconds / 60).toFixed(1)),
    legDistancesKm: route.legDistancesMeters.map((distance) =>
      Number((distance / 1000).toFixed(3)),
    ),
    profile: 'driving',
  };

  trimExpiredRoutes(now);
  routeCache.set(cacheKey, { route: result, expiresAt: now + ROUTE_CACHE_TTL_MS });
  return result;
};

const calculateKmDeliveryFee = ({ distanceKm, pricing }) => {
  const distance = Number(distanceKm);
  const baseFee = Number(pricing?.baseFee);
  const pricePerKm = Number(pricing?.pricePerKm);
  const minimumFee = Number(pricing?.minimumFee);
  const maximumFee = pricing?.maximumFee == null ? null : Number(pricing.maximumFee);
  const maximumDistanceKm = pricing?.maximumDistanceKm == null
    ? null
    : Number(pricing.maximumDistanceKm);

  if (![distance, baseFee, pricePerKm, minimumFee].every(Number.isFinite) || distance < 0) {
    const error = new Error('Delivery pricing settings or road distance are invalid.');
    error.statusCode = 503;
    error.code = 'INVALID_DELIVERY_PRICING';
    throw error;
  }
  if (maximumDistanceKm !== null && distance > maximumDistanceKm) {
    const error = new Error('This location is outside the current delivery area.');
    error.statusCode = 422;
    error.code = 'DELIVERY_OUT_OF_RANGE';
    throw error;
  }

  const base = Number(baseFee.toFixed(2));
  const distanceFee = Number((distance * pricePerKm).toFixed(2));
  const uncappedFee = base + distanceFee;
  const minimumApplied = Math.max(uncappedFee, minimumFee);
  const fee = Number((maximumFee === null ? minimumApplied : Math.min(minimumApplied, maximumFee)).toFixed(2));

  return {
    distanceKm: Number(distance.toFixed(3)),
    baseFee: base,
    distanceFee,
    deliveryFee: fee,
    minimumFee,
    maximumFee,
    maximumDistanceKm,
    pricingMode: 'road_km',
  };
};

const calculateRiderPayout = ({ distanceKm, stopCount, pricing }) => {
  const basePayout = Math.max(0, Number(pricing?.basePayout || 0));
  const pricePerKm = Math.max(0, Number(pricing?.pricePerKm || 0));
  const minimumPayout = Math.max(0, Number(pricing?.minimumPayout || 0));
  const maximumPayout = pricing?.maximumPayout == null
    ? null
    : Math.max(0, Number(pricing.maximumPayout));
  const multiVendorAdjustment = Math.max(0, Number(pricing?.multiVendorAdjustment || 0));
  const adjustment = Math.max(0, Number(stopCount || 0) - 1) * multiVendorAdjustment;
  const distancePayout = Math.max(0, Number(distanceKm || 0)) * pricePerKm;
  const uncapped = Math.max(minimumPayout, basePayout + distancePayout + adjustment);
  const amount = Number((maximumPayout === null ? uncapped : Math.min(uncapped, maximumPayout)).toFixed(2));
  return {
    pricingVersion: 2,
    method: 'road_distance',
    distanceKm: Number(Number(distanceKm || 0).toFixed(3)),
    stopCount: Number(stopCount || 0),
    basePayout: Number(basePayout.toFixed(2)),
    pricePerKm,
    distancePayout: Number(distancePayout.toFixed(2)),
    multiVendorAdjustment: Number(adjustment.toFixed(2)),
    minimumPayout,
    maximumPayout,
    amount,
  };
};

const allocateCustomerFee = ({ fee, legDistancesKm }) => {
  const legs = Array.isArray(legDistancesKm) ? legDistancesKm : [];
  if (!legs.length) return [];
  const totalLegDistance = legs.reduce((sum, distance) => sum + Math.max(0, Number(distance || 0)), 0);
  if (totalLegDistance <= 0) {
    return [Number(Number(fee || 0).toFixed(2)), ...legs.slice(1).map(() => 0)];
  }

  const totalCents = Math.round(Number(fee || 0) * 100);
  const shares = legs.map((distance) => {
    const exactCents = totalCents * Math.max(0, Number(distance || 0)) / totalLegDistance;
    return { cents: Math.floor(exactCents), remainder: exactCents % 1 };
  });
  let unallocatedCents = totalCents - shares.reduce((sum, share) => sum + share.cents, 0);
  const remainderOrder = shares
    .map((share, index) => ({ index, remainder: share.remainder }))
    .sort((a, b) => b.remainder - a.remainder);
  for (let index = 0; index < unallocatedCents; index += 1) {
    shares[remainderOrder[index % remainderOrder.length].index].cents += 1;
  }
  return shares.map((share) => Number((share.cents / 100).toFixed(2)));
};

const calculateConsolidatedDelivery = async ({
  shipments = [],
  customerLocation,
  deliveryPricing,
  riderPayoutPricing,
}) => {
  const deliveryShipments = shipments.filter(
    (shipment) => String(shipment?.fulfillmentMethod || 'delivery').toLowerCase() !== 'pickup',
  );
  if (!deliveryShipments.length) {
    return {
      route: { distanceKm: 0, durationMinutes: 0, legDistancesKm: [], profile: 'driving' },
      customerFee: { distanceKm: 0, baseFee: 0, distanceFee: 0, deliveryFee: 0, pricingMode: 'road_km' },
      shipmentFees: [],
      riderPayout: calculateRiderPayout({ distanceKm: 0, stopCount: 0, pricing: riderPayoutPricing }),
    };
  }

  const routeStops = [
    ...deliveryShipments.map((shipment) => ({
      latitude: shipment.vendorLocation?.latitude,
      longitude: shipment.vendorLocation?.longitude,
    })),
    customerLocation,
  ];
  const route = await getRoadRoute(routeStops);
  const customerFee = calculateKmDeliveryFee({
    distanceKm: route.distanceKm,
    pricing: deliveryPricing,
  });
  const shipmentFees = allocateCustomerFee({
    fee: customerFee.deliveryFee,
    legDistancesKm: route.legDistancesKm,
  });
  const riderPayout = calculateRiderPayout({
    distanceKm: route.distanceKm,
    stopCount: deliveryShipments.length,
    pricing: riderPayoutPricing,
  });

  return { route, customerFee, shipmentFees, riderPayout };
};

module.exports = {
  getRoadRoute,
  calculateKmDeliveryFee,
  calculateRiderPayout,
  allocateCustomerFee,
  calculateConsolidatedDelivery,
};
