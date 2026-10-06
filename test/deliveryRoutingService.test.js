const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateKmDeliveryFee,
  calculateRiderPayout,
  allocateCustomerFee,
  getRoadRoute,
} = require('../services/deliveryRoutingService');

test('road distance fee applies base, per-kilometre, minimum, and maximum settings', () => {
  const result = calculateKmDeliveryFee({
    distanceKm: 5,
    pricing: {
      baseFee: 500,
      pricePerKm: 150,
      minimumFee: 400,
      maximumFee: 2000,
      maximumDistanceKm: 30,
    },
  });
  assert.equal(result.distanceFee, 750);
  assert.equal(result.deliveryFee, 1250);
});

test('road distance fee applies a configured minimum and rejects out-of-range routes', () => {
  assert.equal(calculateKmDeliveryFee({
    distanceKm: 0.1,
    pricing: { baseFee: 0, pricePerKm: 100, minimumFee: 500 },
  }).deliveryFee, 500);

  assert.throws(() => calculateKmDeliveryFee({
    distanceKm: 31,
    pricing: { baseFee: 500, pricePerKm: 150, minimumFee: 0, maximumDistanceKm: 30 },
  }), { code: 'DELIVERY_OUT_OF_RANGE', statusCode: 422 });
});

test('rider payout is calculated separately and applies multi-vendor stop adjustment', () => {
  const result = calculateRiderPayout({
    distanceKm: 5,
    stopCount: 3,
    pricing: {
      basePayout: 300,
      pricePerKm: 100,
      minimumPayout: 0,
      maximumPayout: 1000,
      multiVendorAdjustment: 75,
    },
  });
  assert.equal(result.distancePayout, 500);
  assert.equal(result.multiVendorAdjustment, 150);
  assert.equal(result.amount, 950);
});

test('shipment fee allocation is non-negative and sums exactly to the customer fee', () => {
  const shares = allocateCustomerFee({
    fee: 0.02,
    legDistancesKm: [1, 1, 1, 1, 1],
  });
  assert.ok(shares.every((amount) => amount >= 0));
  assert.equal(Number(shares.reduce((sum, amount) => sum + amount, 0).toFixed(2)), 0.02);
});

test('routing rejects missing or excessive stop counts before contacting Mapbox', async () => {
  await assert.rejects(getRoadRoute([]), { code: 'MISSING_ROUTE_STOPS', statusCode: 400 });
  await assert.rejects(
    getRoadRoute(Array.from({ length: 26 }, () => ({ latitude: 9, longitude: 7 }))),
    { code: 'TOO_MANY_ROUTE_STOPS', statusCode: 422 },
  );
});
