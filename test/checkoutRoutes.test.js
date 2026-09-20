'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const P = '111111111111111111111111', O = '222222222222222222222222', S = '333333333333333333333333';
const P2 = '444444444444444444444444', O2 = '555555555555555555555555';
const item = (extra = {}) => ({ product: P, quantity: 2, ...extra });
const location = { latitude: 9, longitude: 7, formattedAddress: 'Synthetic shop' };
const address = { address: 'Synthetic destination', city: 'Abuja', country: 'NG', postalCode: '900001' };
const body = (extra = {}) => ({ cartItems: [item()], shippingAddress: address, userLocation: { latitude: 9.1, longitude: 7.1 }, paymentMethod: 'Card', ...extra });
const query = (value) => ({ select() { return this; }, session() { return this; }, lean() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });

async function setup(t, options = {}) {
    const saved = { orders: [], shipments: [], commits: 0, aborts: 0, feeCalls: [] };
    const product = { _id: P, name: 'Real catalog shirt', price: 5000, discountPrice: null, stockQuantity: 999,
        category: 'Fashion', isActive: true, moderationStatus: 'approved', productStatus: 'active', sellerType: 'vendor', vendor: S,
        imageUrls: ['https://example.invalid/real.jpg'], variants: [], ...options.product };
    const offer = { _id: O, product: P, sellerType: 'vendor', sellerId: S, price: 1000, discountPrice: null, stockQuantity: 4,
        isPrimary: true, status: 'active', fulfilmentLocation: location, variants: [], ...options.offer };
    const seller = { _id: S, isVendor: true, vendorStatus: 'approved', businessName: 'Low Cost', businessLocation: location,
        pickupEnabled: true, pickupSettings: { maximumConcurrentOrders: 20, estimatedPreparationMinutes: 30 }, ...options.seller };
    class MainOrder { constructor(data) { Object.assign(this, data); this._id = '666666666666666666666666'; }
        async save() { if (!saved.orders.includes(this)) saved.orders.push(this); return this; } }
    class Shipment { constructor(data) { Object.assign(this, data); this._id = `shipment-${saved.shipments.length}`; }
        async save() { saved.shipments.push(this); return this; } static countDocuments() { return query(0); } }
    const session = { startTransaction() {}, inTransaction: () => true, endSession() {},
        async abortTransaction() { saved.aborts++; }, async commitTransaction() { saved.commits++; } };
    const models = { MainOrder, Shipment, Product: { find: () => options.databaseError ? { lean: async () => { throw new Error('synthetic-private-connection-string'); } } : query([product, ...(options.products || [])]) },
        ProductOffer: { find: () => query([offer, ...(options.offers || [])]) },
        User: { find: () => query([seller]), findById: (id) => query(String(id) === S ? seller : options.buyer || {}), findOne: () => query(seller) },
        AppSetting: { findOne: () => query({ costLowStore: { vendorId: S, commissionKoboPerUnit: 5700 } }) } };
    const file = path.join(__dirname, '../routes/orderRoutes.js'), actualRequire = createRequire(file), module = { exports: {} };
    const middleware = (req, res, next) => { req.user = { _id: '777777777777777777777777', id: '777777777777777777777777' }; next(); };
    function requireForRoute(name) {
        if (name === 'mongoose') return { startSession: async () => session };
        if (name.startsWith('../models/')) return models[name.split('/').pop()] || {};
        if (name === '../middleware/authMiddleware') return { protect: middleware, authorizeRoles: () => middleware };
        if (name === '../services/deliveryFeeService') return { getDeliveryFeeSettings: async () => ({}), buildDeliveryFeeQuote: (args) => { saved.feeCalls.push(args); return { amount: 500, source: 'test', zone: null }; } };
        if (name.endsWith('/analyticsService')) return { async trackAnalyticsEvent() {} };
        if (name.startsWith('../services/') && !['../services/checkoutCatalogService', '../services/checkoutInventoryService'].includes(name)) return {};
        return actualRequire(name);
    }
    vm.runInThisContext('(function(require, module, exports, console) {\n' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(requireForRoute, module, module.exports, { log() {}, error() {} });
    const app = express(); app.use(express.json()); app.use('/orders', module.exports);
    const listener = app.listen(0, '127.0.0.1'); await new Promise((resolve) => listener.once('listening', resolve));
    t.after(() => { listener.closeAllConnections(); return new Promise((resolve) => listener.close(resolve)); });
    return { saved, async post(route, input) { const response = await fetch(`http://127.0.0.1:${listener.address().port}/orders${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(15000) }); return { status: response.status, data: await response.json() }; } };
}

test('real summary route retains delivery fees and the fixed Low Cost commission using authoritative item values', async (t) => {
    const { post, saved } = await setup(t);
    const { status, data } = await post('/summary', body({ taxPrice: -100000, cartItems: [item({ price: 1, name: 'Forged', sku: 'Fake' })] }));
    assert.equal(status, 200); assert.equal(data.totalSubtotal, 2000); assert.equal(data.totalShippingPrice, 500);
    assert.equal(data.taxPrice, 0); assert.equal(data.totalPrice, 2500); assert.equal(data.totalPlatformFees, 114);
    assert.equal(data.shipmentSummaries[0].items[0].name, 'Real catalog shirt');
    assert.equal(data.shipmentSummaries[0].items[0].offer, O); assert.equal(saved.feeCalls.length, 1);
});

test('real summary/order routes preserve zero-fee pickup and ignore forged seller, location and totals', async (t) => {
    const { post, saved } = await setup(t);
    const quote = await post('/summary', body({ fulfillmentSelections: { [`vendor:${S}`]: { method: 'pickup' } } }));
    assert.equal(quote.status, 200); assert.equal(quote.data.totalShippingPrice, 0); assert.equal(quote.data.totalPrice, 2000);
    const summary = quote.data.shipmentSummaries[0]; Object.assign(summary, { sellerId: P2, vendorId: P2, sellerName: 'Forged', vendorLocation: { latitude: 0, longitude: 0 } });
    const result = await post('', body({ shipmentSummaries: [summary], totalPrice: 1, taxPrice: -99999 }));
    assert.equal(result.status, 201); assert.equal(result.data.totalPrice, 2000); assert.equal(result.data.isPaid, false);
    assert.equal(saved.shipments[0].sellerId, S); assert.equal(saved.shipments[0].sellerName, 'Low Cost');
    assert.equal(saved.shipments[0].vendorLocation.latitude, 9); assert.equal(saved.shipments[0].shippingPrice, 0);
    assert.equal(saved.feeCalls.length, 0); assert.equal(saved.commits, 1);
});

test('invalid quantities and aggregate excess fail before order writes, including across shipments', async (t) => {
    const { post, saved } = await setup(t);
    assert.equal((await post('/summary', body({ cartItems: [item({ quantity: -1 })] }))).status, 400);
    const response = await post('', body({ shipmentSummaries: [{ items: [item({ quantity: 3 })] }, { items: [item({ quantity: 3 })] }] }));
    assert.equal(response.status, 409); assert.equal(response.data.code, 'INSUFFICIENT_STOCK');
    assert.equal(saved.orders.length, 0); assert.equal(saved.shipments.length, 0); assert.equal(saved.aborts, 1);
});

test('summary and creation both reject an unavailable explicit offer instead of using the product price', async (t) => {
    const { post, saved } = await setup(t);
    const invalid = item({ offer: O2 });
    for (const [route, input] of [['/summary', body({ cartItems: [invalid] })], ['', body({ shipmentSummaries: [{ items: [invalid] }] })]]) {
        const response = await post(route, input); assert.equal(response.status, 409); assert.equal(response.data.code, 'OFFER_UNAVAILABLE');
    }
    assert.equal(saved.orders.length, 0);
});

test('different fulfilment points stay separate and cannot be forged into one shipment', async (t) => {
    const { post, saved } = await setup(t, { products: [{ _id: P2, name: 'Second warehouse item', sellerType: 'naijago', category: 'Fashion', isActive: true, moderationStatus: 'approved', productStatus: 'active' }],
        offers: [{ _id: O2, product: P2, sellerType: 'naijago', status: 'active', price: 1000, stockQuantity: 4, fulfilmentLocation: { latitude: 10, longitude: 8 } }] });
    const items = [item(), item({ product: P2 })];
    const quote = await post('/summary', body({ cartItems: items })); assert.equal(quote.status, 200); assert.equal(quote.data.shipmentSummaries.length, 2);
    const response = await post('', body({ shipmentSummaries: [{ items }] }));
    assert.equal(response.status, 409); assert.equal(response.data.code, 'SHIPMENT_CHANGED'); assert.equal(saved.orders.length, 0);
});

test('database errors stay private and invalid coordinates fail with a short client message', async (t) => {
    const { post } = await setup(t, { databaseError: true });
    const invalid = await post('/summary', body({ userLocation: { latitude: 95, longitude: 7 } })); assert.equal(invalid.status, 400);
    const response = await post('/summary', body()); assert.equal(response.status, 500);
    assert.equal(JSON.stringify(response.data).includes('synthetic-private'), false); assert.equal(response.data.error, undefined);
});

test('per-item restaurant notes survive checkout and override the whole-order fallback', async (t) => {
    const { post, saved } = await setup(t, { product: { category: 'Restaurant', restaurantName: 'Synthetic restaurant', orderStartTime: '00:00', orderEndTime: '00:00' } });
    const response = await post('', body({ restaurantOrderNote: 'Fallback', shipmentSummaries: [{ items: [item({ customerNote: 'No onions' })] }] }));
    assert.equal(response.status, 201); assert.equal(saved.shipments[0].items[0].customerNote, 'No onions');
});

test('subscription free delivery still applies to both summary and newly created orders', async (t) => {
    const { post, saved } = await setup(t, { buyer: { naijagoSubscription: { status: 'active', expiresAt: new Date(Date.now() + 86400000),
        deliveriesRemaining: 3, validHours: { start: '00:00', end: '00:00' }, minimumOrderValue: 1, planId: 'synthetic', planName: 'Fixture' } } });
    const quote = await post('/summary', body()); assert.equal(quote.status, 200);
    assert.equal(quote.data.originalShippingPrice, 500); assert.equal(quote.data.totalShippingPrice, 0); assert.equal(quote.data.subscriptionFreeDeliveryApplied, true);
    const response = await post('', body({ shipmentSummaries: quote.data.shipmentSummaries }));
    assert.equal(response.status, 201); assert.equal(response.data.totalPrice, 2000); assert.equal(response.data.subscriptionDeliveryDiscount, 500);
    assert.equal(saved.shipments[0].subscriptionFreeDeliveryApplied, true);
});

test('authoritative variant identity, SKU, attributes and legacy size survive summary-to-order conversion', async (t) => {
    const variantId = '888888888888888888888888';
    const { post, saved } = await setup(t, { product: { variants: [{ _id: variantId, isActive: true, attributes: { size: 'M', colour: 'Blue' } }] },
        offer: { variants: [{ productVariantId: variantId, isActive: true, price: 1300, stockQuantity: 2, sku: 'REAL-M' }] } });
    const quote = await post('/summary', body({ cartItems: [item({ selectedSize: { value: 'M', label: 'Fake', price: 1 } })] }));
    assert.equal(quote.status, 200); assert.equal(quote.data.totalSubtotal, 2600);
    const response = await post('', body({ shipmentSummaries: quote.data.shipmentSummaries }));
    assert.equal(response.status, 201);
    const savedItem = saved.shipments[0].items[0]; assert.equal(savedItem.variantId, variantId); assert.equal(savedItem.sku, 'REAL-M');
    assert.equal(savedItem.selectedSize, 'M'); assert.equal(savedItem.price, 1300); assert.deepEqual(savedItem.productSnapshot.attributes, { size: 'M', colour: 'Blue' });
});
