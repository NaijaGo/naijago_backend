// Real checkout/routing logic, isolated catalogue/settings and Mapbox boundaries.
// Coordinates and distances below are test fixtures, not captured customer data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const inventory = require('../services/inventoryService');
const zones = require('../services/deliveryFeeService');
const orderSource = fs.readFileSync(path.join(__dirname, '../routes/orderRoutes.js'), 'utf8');

const customer = { latitude: 9.08, longitude: 7.46 };
const shippingAddress = { address: 'Delivery diagnosis fixture', city: 'Abuja', country: 'Nigeria' };
function load(file, dependencies, extras = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, exports: module.exports, require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
      return dependencies[name];
    }, Date, Map, Set, Number, String, Math, Object, Array, JSON, ...extras,
  }, { filename: file });
  return module.exports;
}
function extract(name, context) {
  const start = orderSource.indexOf(`const ${name} = async (`);
  const end = orderSource.indexOf('\n};', start);
  assert.ok(start >= 0 && end > start, `Actual ${name} must exist`);
  return vm.runInContext(`(${orderSource.slice(start, end + 3).replace(`const ${name} = `, '').replace(/;$/, '')})`, context);
}
function harness({ legs = [5000], maximumDistanceKm = 10, count = 1, mode = 'road_km', providerError = null, providerData = null } = {}) {
  const calls = [];
  const directions = load('services/mapboxDirectionsService.js', {
    axios: { async get(url) {
      if (providerError) throw providerError; if (providerData) return { data: providerData }; calls.push(url.split('/').at(-1).split(';').map(pair => pair.split(',').map(Number)));
      return { data: { routes: [{ distance: legs.reduce((a, b) => a + b, 0), duration: 120,
        legs: legs.map(distance => ({ distance })) }] } };
    } },
  }, { process: { env: { MAPBOX_ACCESS_TOKEN: 'isolated-routing-test-value' } } });
  const routing = load('services/deliveryRoutingService.js', { crypto, './mapboxDirectionsService': directions });
  const vendors = Array.from({ length: count }, (_, i) => ({ _id: `vendor-${i}`, businessName: `Test vendor ${i}`,
    businessLocation: { latitude: 9.1 + i * 0.01, longitude: 7.4 + i * 0.01 } }));
  const products = vendors.map((vendor, i) => ({ _id: `product-${i}`, vendor, sellerType: 'vendor',
    sellerId: vendor._id, category: 'Groceries', name: `Test product ${i}`, price: 1000,
    stockQuantity: 5, reservedStockQuantity: 0, imageUrls: [] }));
  const offers = products.map((product, i) => ({ _id: `offer-${i}`, product: product._id,
    sellerType: 'vendor', sellerId: vendors[i], fulfilmentLocation: vendors[i].businessLocation,
    stockQuantity: 5, reservedStockQuantity: 0, price: 1000 }));
  const query = value => ({ populate() { return this; }, select() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  const settings = { deliveryPricing: { mode, baseFee: 500, pricePerKm: 150, minimumFee: 1000,
    maximumFee: 5000, maximumDistanceKm }, riderPayoutPricing: {}, freeDeliveryCampaign: { enabled: false }, zones: [] };
  const sandbox = { ...require('../utils/checkoutLocation'), ...require('../utils/addressCoordinates'), Date, Map, Set, Number, String, Math, Object, Array, parseFloat,
    console: { error: (...args) => console.error("Isolated summary diagnostic:", ...args) },
    User: { findById: () => query({}) },
    Product: { findById: id => query(products.find(row => row._id === id)) },
    ProductOffer: { findOne: filter => query(offers.find(row => row.product === filter.product)) },
    assertImmediateOrderRequest: async () => {}, loadDealContext: async () => null,
    resolveProductPrice: product => ({ finalPrice: product.price }), inventory,
    getDeliveryFeeSettings: async () => settings, getCostLowCommissionConfig: async () => ({}),
    calculateItemCommission: () => ({ commissionRate: 0, itemCommission: 0 }),
    buildDeliveryFeeQuote: zones.buildDeliveryFeeQuote,
    calculateConsolidatedDelivery: routing.calculateConsolidatedDelivery,
    resolveCampaignRouteDistance: async () => 0,
    evaluateFreeDeliveryCampaign: async () => ({ eligible: false }),
    buildSubscriptionDeliveryDiscount: () => ({ eligible: false }),
  };
  vm.createContext(sandbox);
  for (const name of ['hasValidCoordinates', 'resolvePickupLocation']) {
    const start = orderSource.indexOf(`const ${name} =`);
    const end = orderSource.indexOf('\n};', start);
    vm.runInContext(orderSource.slice(start, end + 3).replace(`const ${name}`, `var ${name}`), sandbox);
  }
  for (const name of ['isMedicineProduct', 'isRestrictedMedicine', 'isRestaurantProduct', 'buildOrderItemFromProduct', 'calculateDistance']) {
    const fn = orderSource.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\r?\\n\\}`));
    assert.ok(fn); vm.runInContext(fn[0], sandbox);
  }
  sandbox.applyRoadPricingToSummaries = extract('applyRoadPricingToSummaries', sandbox);
  const summary = extract('calculateOrderSummary', sandbox);
  return { calls, routing, sandbox, settings, vendors, offers, async run(location = customer, address = shippingAddress) {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(data) { this.data = data; return this; } };
    await summary({ user: { _id: 'test-customer' }, body: { shippingAddress: address, userLocation: location,
      cartItems: products.map((product, i) => ({ product: product._id, offer: offers[i]._id, quantity: 1 })) } }, res);
    return res;
  } };
}

test('actual summary accepts an inside road route and preserves customer coordinates', async () => {
  const h = harness(); const res = await h.run();
  assert.equal(res.statusCode, 200, res.data?.message);
  assert.equal(res.data.totalShippingPrice, 1250);
  assert.deepEqual(JSON.parse(JSON.stringify(res.data.userLocation)), customer);
  assert.deepEqual(h.calls, [[[7.4, 9.1], [7.46, 9.08]]]);
});
test('actual summary rejects an outside road route with the exact customer error', async () => {
  const h = harness({ legs: [11000] }); const res = await h.run();
  assert.equal(res.statusCode, 422);
  assert.equal(res.data.message, 'This location is outside the current delivery area.');
  assert.equal(res.data.totalPrice, undefined);
});
test('the maximum applies to road KM; exact boundary passes and an over-limit route fails', () => {
  const h = harness();
  assert.equal(h.routing.calculateKmDeliveryFee({ distanceKm: 10, pricing: h.settings.deliveryPricing }).distanceKm, 10);
  assert.throws(() => h.routing.calculateKmDeliveryFee({ distanceKm: 10.001, pricing: h.settings.deliveryPricing }),
    { code: 'DELIVERY_OUT_OF_RANGE', statusCode: 422 });
});
test('saved address coordinates supplied to the summary use the same valid route', async () => {
  const saved = { ...shippingAddress, latitude: customer.latitude, longitude: customer.longitude };
  const h = harness(); const res = await h.run({ latitude: saved.latitude, longitude: saved.longitude }, saved);
  assert.equal(res.statusCode, 200, res.data?.message);
  assert.deepEqual(h.calls[0].at(-1), [saved.longitude, saved.latitude]);
});
test('missing and invalid customer coordinates fail before Mapbox, never as an area rejection', async () => {
  for (const location of [{}, { latitude: null, longitude: 7.46 }, { latitude: 91, longitude: 7.46 }]) {
    const h = harness(); const res = await h.run(location);
    assert.equal(res.statusCode, 400);
    assert.equal(res.data.message, require('../utils/checkoutLocation').validateCheckoutLocation(shippingAddress, location));
    assert.equal(h.calls.length, 0);
  }
});
test('Haversine argument order is lat/lon; Mapbox URI order is deliberately lon/lat', () => {
  const h = harness();
  const correct = h.sandbox.calculateDistance(0, 60, 1, 60);
  const swapped = h.sandbox.calculateDistance(60, 0, 60, 1);
  assert.ok(correct > 110 && correct < 112);
  assert.ok(swapped > 55 && swapped < 57);
});
test('multi-vendor summary sends one ordered pickup route ending at the same customer', async () => {
  const h = harness({ count: 2, legs: [4000, 4000] }); const res = await h.run();
  assert.equal(res.statusCode, 200, res.data?.message);
  assert.deepEqual(h.calls, [[[7.4, 9.1], [7.41, 9.11], [7.46, 9.08]]]);
  assert.equal(res.data.totalShippingPrice, 1700);
  assert.equal(res.data.shipmentSummaries.reduce((s, row) => s + row.shippingPrice, 0), 1700);
});
test('one long leg rejects the entire consolidated multi-vendor checkout', async () => {
  const h = harness({ count: 2, legs: [4000, 12000] }); const res = await h.run();
  assert.equal(res.statusCode, 422);
  assert.equal(res.data.message, 'This location is outside the current delivery area.');
  assert.equal(h.calls.length, 1);
});
test('zone mode does not call road routing or apply its distance cap', async () => {
  const h = harness({ mode: 'zone', legs: [50000], maximumDistanceKm: 1 }); const res = await h.run();
  assert.equal(res.statusCode, 200, res.data?.message);
  assert.equal(h.calls.length, 0);
});
test('Geoapify mapping keeps lat as latitude and lon as longitude', () => {
  const result = require('../utils/locationSuggestions').normalizeGeoapifySuggestion({
    lat: 9.08, lon: 7.46, formatted: 'Delivery diagnosis fixture', city: 'Abuja' });
  assert.equal(result.latitude, 9.08); assert.equal(result.longitude, 7.46);
});

// Additional deterministic cases: provider distances are scripted, never live Mapbox measurements.
for (const scenario of [
  { name: 'same pickup/customer point', customer: { latitude: 9.1, longitude: 7.4 }, meters: 0, status: 200 },
  { name: 'near pickup/customer point', customer: { latitude: 9.1005, longitude: 7.4005 }, meters: 100, status: 200 },
  { name: 'short synthetic road trip', customer: { latitude: 9.11, longitude: 7.41 }, meters: 2000, status: 200 },
  { name: 'long synthetic road trip', customer: { latitude: 10, longitude: 8.5 }, meters: 200000, status: 422 },
  { name: 'below maximum', customer: { latitude: 9.12, longitude: 7.42 }, meters: 9999, status: 200 },
  { name: 'exact maximum', customer: { latitude: 9.12, longitude: 7.42 }, meters: 10000, status: 200 },
  { name: 'above maximum', customer: { latitude: 9.12, longitude: 7.42 }, meters: 10001, status: 422 },
]) {
  test(`deterministic summary: ${scenario.name}`, async () => {
    const h = harness({ legs: [scenario.meters] });
    const res = await h.run(scenario.customer);
    assert.equal(res.statusCode, scenario.status, res.data?.message);
    assert.deepEqual(h.calls, [[[7.4, 9.1], [scenario.customer.longitude, scenario.customer.latitude]]]);
    if (scenario.status === 200) assert.equal(res.data.deliveryFeePolicy.route.distanceKm, scenario.meters / 1000);
    else assert.equal(res.data.message, 'This location is outside the current delivery area.');
    const straightKm = h.sandbox.calculateDistance(9.1, 7.4, scenario.customer.latitude, scenario.customer.longitude);
    console.log(JSON.stringify({ fixture: scenario.name, customer: scenario.customer,
      pickup: { latitude: 9.1, longitude: 7.4 }, straightKm: Number(straightKm.toFixed(6)),
      scriptedRoadMeters: scenario.meters, roadKm: scenario.meters / 1000, maximumDistanceKm: 10,
      decision: scenario.status === 200 ? 'INSIDE' : 'OUTSIDE' }));
  });
}

test('deterministic two-vendor route preserves input order and applies cap to total', async () => {
  const h = harness({ count: 2, legs: [2000, 2000] });
  const destination = { latitude: 9.12, longitude: 7.42 };
  const res = await h.run(destination);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.calls, [[[7.4, 9.1], [7.41, 9.11], [7.42, 9.12]]]);
  assert.equal(res.data.deliveryFeePolicy.route.distanceKm, 4);
  const straightKm = h.sandbox.calculateDistance(9.1, 7.4, 9.11, 7.41)
    + h.sandbox.calculateDistance(9.11, 7.41, 9.12, 7.42);
  console.log(JSON.stringify({ fixture: 'ordered two-vendor', straightLegSumKm: straightKm,
    scriptedRoadMeters: 4000, roadKm: 4, maximumDistanceKm: 10, decision: 'INSIDE' }));
});

test('routing boundary accepts numeric strings and zero, rejects null/missing coordinates', async () => {
  const h = harness({ legs: [0] });
  const route = await h.routing.getRoadRoute([
    { latitude: '0', longitude: '0' }, { latitude: 0, longitude: 0 },
  ]);
  assert.equal(route.distanceKm, 0);
  assert.deepEqual(h.calls, [[[0, 0], [0, 0]]]);
  await assert.rejects(() => h.routing.getRoadRoute([
    { latitude: null, longitude: 0 }, { latitude: 0, longitude: 0 },
  ]), { code: 'INVALID_ROUTE_COORDINATES' });
});

test('provider timeout returns controlled failure without substituting a distance', async () => {
  const h = harness({ providerError: new Error('isolated timeout') });
  const res = await h.run();
  assert.equal(res.statusCode, 502);
  assert.equal(res.data.message, 'Unable to calculate delivery distance right now. Please try again.');
  assert.equal(res.data.totalPrice, undefined);
});

test('no route and explicitly missing total distance fail closed', async () => {
  for (const providerData of [
    { routes: [] },
    { routes: [{ duration: 120, legs: [{ distance: 1000 }] }] },
    { routes: [{ distance: null, duration: 120, legs: [{ distance: 1000 }] }] },
  ]) {
    const h = harness({ providerData }); const res = await h.run();
    assert.equal(res.statusCode, 502);
    assert.equal(res.data.totalPrice, undefined);
  }
});

test('summary preserves a valid zero-latitude offer', async () => {
  const h = harness();
  h.offers[0].fulfilmentLocation = { latitude: 0, longitude: 7.4 };
  const res = await h.run();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.calls[0][0], [7.4, 0]);
});

test('summary accepts a valid zero-latitude pickup', async () => {
  const h = harness(); h.vendors[0].businessLocation.latitude = 0;
  const res = await h.run();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.calls[0][0], [7.4, 0]);
});

test('distance limit is evaluated after routing rounds to three decimal KM', async () => {
  const h = harness({ legs: [10000.4] }); const res = await h.run();
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.deliveryFeePolicy.route.distanceKm, 10);
});