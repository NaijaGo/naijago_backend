const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateDeliveryPricingBounds,
  DELIVERY_PRICING_LIMITS,
} = require('../services/deliveryFeeService');

test('accepts normal delivery and rider pricing settings', () => {
  assert.equal(validateDeliveryPricingBounds({
    deliveryPricing: {
      mode: 'road_km', baseFee: 500, pricePerKm: 150, minimumFee: 1000,
      maximumFee: 5000, maximumDistanceKm: 30,
    },
    riderPayoutPricing: {
      basePayout: 300, pricePerKm: 100, minimumPayout: 500,
      maximumPayout: 50000, multiVendorAdjustment: 75,
    },
  }), null);
});

test('rejects non-finite, negative, and excessive pricing values', () => {
  for (const value of [NaN, Infinity, -1, DELIVERY_PRICING_LIMITS.baseFee + 1]) {
    assert.match(validateDeliveryPricingBounds({
      deliveryPricing: { baseFee: value },
    }), /baseFee/);
  }
});

test('rejects maximum fees below their corresponding minimums and unknown modes', () => {
  assert.match(validateDeliveryPricingBounds({
    deliveryPricing: { minimumFee: 1000, maximumFee: 999 },
  }), /Maximum delivery fee/);
  assert.match(validateDeliveryPricingBounds({
    riderPayoutPricing: { minimumPayout: 1000, maximumPayout: 999 },
  }), /Maximum rider payout/);
  assert.match(validateDeliveryPricingBounds({ deliveryPricing: { mode: 'other' } }), /Pricing method/);
});

test('rejects zero caps that would silently waive all delivery fees or rider payout', () => {
  assert.match(validateDeliveryPricingBounds({
    deliveryPricing: { minimumFee: 0, maximumFee: 0 },
  }), /maximumFee must be greater than zero/);
  assert.match(validateDeliveryPricingBounds({
    riderPayoutPricing: { minimumPayout: 0, maximumPayout: 0 },
  }), /maximumPayout must be greater than zero/);
});
