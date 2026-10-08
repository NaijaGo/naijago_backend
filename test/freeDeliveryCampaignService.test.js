const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateFreeDeliveryCampaign } = require('../services/freeDeliveryCampaignService');

const campaign = {
  enabled: true,
  minimumOrderAmount: 10000,
  maximumDistanceKm: 10,
  customerEligibility: 'everyone',
  vendorIds: [],
  productIds: [],
  areas: [],
  promoCode: 'FREESHIP',
};

test('free delivery campaign applies when all configured conditions are met', async () => {
  const result = await evaluateFreeDeliveryCampaign({
    campaign,
    userId: 'customer-1',
    orderSubtotal: 12000,
    routeDistanceKm: 8,
    shippingAddress: { city: 'Abuja' },
    deliveryShipments: [{ sellerId: 'vendor-1', items: [{ product: 'product-1' }] }],
    promoCode: 'freeship',
    now: new Date('2026-10-06T12:00:00Z'),
  });
  assert.equal(result.eligible, true);
});

test('free delivery campaign does not qualify below minimum, over distance, or without its promo code', async () => {
  const base = {
    campaign,
    userId: 'customer-1',
    shippingAddress: { city: 'Abuja' },
    deliveryShipments: [{ sellerId: 'vendor-1', items: [{ product: 'product-1' }] }],
    now: new Date('2026-10-06T12:00:00Z'),
  };
  assert.equal((await evaluateFreeDeliveryCampaign({ ...base, orderSubtotal: 9999, routeDistanceKm: 8, promoCode: 'FREESHIP' })).eligible, false);
  assert.equal((await evaluateFreeDeliveryCampaign({ ...base, orderSubtotal: 12000, routeDistanceKm: 11, promoCode: 'FREESHIP' })).eligible, false);
  assert.equal((await evaluateFreeDeliveryCampaign({ ...base, orderSubtotal: 12000, routeDistanceKm: 8, promoCode: '' })).eligible, false);
});

test('free delivery campaign respects its start and end timestamps', async () => {
  const scheduled = { ...campaign, startsAt: new Date('2026-10-07T00:00:00Z'), endsAt: new Date('2026-10-09T00:00:00Z') };
  const result = await evaluateFreeDeliveryCampaign({
    campaign: scheduled,
    userId: 'customer-1',
    orderSubtotal: 12000,
    routeDistanceKm: 8,
    shippingAddress: { city: 'Abuja' },
    deliveryShipments: [{ sellerId: 'vendor-1', items: [{ product: 'product-1' }] }],
    promoCode: 'FREESHIP',
    now: new Date('2026-10-06T12:00:00Z'),
  });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /not started/i);
});
