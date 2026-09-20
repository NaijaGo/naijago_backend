'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCheckoutCatalogService } = require('../services/checkoutCatalogService');
const { createPlannedOrderCatalogService } = require('../services/plannedOrderCatalogService');
const { createPlannedOrderServices } = require('../services/plannedOrderServiceFactory');
const P = '111111111111111111111111', O = '222222222222222222222222', S = '333333333333333333333333';
const P2 = '444444444444444444444444', O2 = '555555555555555555555555', V = '666666666666666666666666';
const destination = { address: 'Synthetic address', city: 'Abuja', postalCode: '900001', country: 'NG', phoneNumber: 'test-only', latitude: 9, longitude: 7 };
const item = (extra = {}) => ({ product: P, quantity: 1, ...extra });
function fixture({ checkSchedule } = {}) {
    const products = [{ _id: P, name: 'Synthetic shirt', isActive: true, moderationStatus: 'approved', productStatus: 'active', sellerType: 'naijago',
        price: 2000, stockQuantity: 8, productLocation: { latitude: 0, longitude: 0 }, variants: [] }];
    const offers = [{ _id: O, product: P, sellerType: 'naijago', sellerId: null, status: 'active', isPrimary: true, price: 1500, stockQuantity: 5, variants: [] }];
    const sellers = [{ _id: S, isVendor: true, vendorStatus: 'approved', businessName: 'Synthetic shop', businessLocation: { latitude: 9, longitude: 7 } }];
    const sessions = [], quotes = [];
    const model = (rows) => {
        const match = (row, filter) => Object.entries(filter).every(([key, value]) => value?.$in ? value.$in.includes(String(row[key])) : String(row[key]) === String(value));
        const query = (run) => ({ select() { return this; }, session(value) { sessions.push(value); return this; }, lean: async () => run() });
        return { find: (filter) => query(() => rows.filter((row) => match(row, filter))), findOne: (filter) => query(() => rows.find((row) => match(row, filter)) || null) };
    };
    const models = { Product: model(products), ProductOffer: model(offers), User: model(sellers) };
    const catalog = createCheckoutCatalogService(models);
    // Stub only fee calculation here; HTTP route tests exercise the actual shared
    // quote implementation. Product/offer/variant eligibility above is REAL code.
    const calculateCheckoutSummary = async (args) => { quotes.push(args); return { totalPrice: 2712.57, totalShippingPrice: 1000, totalPlatformFees: 57,
        shipmentSummaries: [{ items: args.cartItems, sellerType: offers[0].sellerType, sellerId: offers[0].sellerId }] }; };
    const service = createPlannedOrderCatalogService({ catalog, User: models.User, calculateCheckoutSummary, checkSchedule });
    const vendor = () => { offers[0].sellerType = 'vendor'; offers[0].sellerId = S; return `vendor:${S}:9:7`; };
    const group = (extra = {}) => ({ owner: S, sellerType: 'naijago', sellerId: null, fulfillmentKey: 'naijago:0:0', destination, schedule: { mode: 'now' }, ...extra });
    return { service, catalog, models, calculateCheckoutSummary, products, offers, sellers, sessions, quotes, vendor, group };
}

test('planning derives group fulfilment from approved shops or real NaijaGo products, never supplied coordinates', async () => {
    const f = fixture(), session = {}, key = f.vendor();
    assert.equal((await f.service.validateItems({ items: [], sellerType: 'vendor', sellerId: S, session, purpose: 'create' })).fulfillmentKey, key);
    assert.ok(f.sessions.includes(session));
    await assert.rejects(f.service.validateItems({ items: [], sellerType: 'vendor', sellerId: S, fulfillmentKey: `vendor:${S}:1:1` }), { code: 'FULFILLMENT_CHANGED' });
    f.sellers[0].vendorStatus = 'pending';
    await assert.rejects(f.service.validateItems({ items: [], sellerType: 'vendor', sellerId: S }), { code: 'INVALID_SELLER' });
    const direct = fixture();
    await assert.rejects(direct.service.validateItems({ items: [], sellerType: 'naijago', sellerId: null }), { code: 'PICK_PRODUCT_FIRST' });
    assert.equal((await direct.service.validateItems({ items: [], sellerType: 'naijago', sellerId: null, anchorItem: item() })).fulfillmentKey, 'naijago:0:0');
    await assert.rejects(direct.service.validateItems({ items: [], sellerType: 'vendor', sellerId: S, anchorItem: item() }), { code: 'INVALID_SELLER' });
});

test('saved plan items retain canonical sizes, offer and variant but never submitted prices', async () => {
    const f = fixture(), session = {};
    f.products[0].sizeData = { sizes: [{ value: 'M', label: 'Medium', unit: 'size' }] };
    const result = await f.service.validateTemplate({ items: [item({ selectedSize: { value: 'M', label: 'Fake', price: 1 }, price: 1, sellerId: S })], session });
    assert.deepEqual(result.items[0].selectedSize, { value: 'M', label: 'Medium', unit: 'size' });
    assert.equal(result.items[0].offer, O); assert.equal(result.items[0].price, undefined); assert.equal(result.items[0].sellerId, undefined);
    assert.ok(f.sessions.every((value) => value === session));
    await assert.rejects(f.service.validateTemplate({ items: [item({ selectedSize: 'XXL' })] }), { code: 'SIZE_UNAVAILABLE' });
    f.products[0].variants = [{ _id: V, isActive: true, attributes: { size: 'M' }, price: 1000, stockQuantity: 5 }];
    f.offers[0].variants = [{ productVariantId: V, isActive: true, price: 1500, stockQuantity: 2 }];
    assert.equal((await f.service.validateTemplate({ items: [item({ selectedSize: 'M' })] })).items[0].variantId, V);
});

test('group participants share aggregated stock and cannot mix sellers or warehouses', async () => {
    const f = fixture();
    await assert.rejects(f.service.quoteGroup({ group: f.group(), items: [item({ quantity: 3 }), item({ quantity: 3 })] }), { code: 'INSUFFICIENT_STOCK' });
    assert.equal(f.quotes.length, 0);
    f.products.push({ ...f.products[0], _id: P2, productLocation: { latitude: 1, longitude: 1 } });
    f.offers.push({ ...f.offers[0], _id: O2, product: P2 });
    await assert.rejects(f.service.quoteGroup({ group: f.group(), items: [item(), item({ product: P2 })] }), { code: 'FULFILLMENT_CHANGED' });
    const key = f.vendor();
    await assert.rejects(f.service.validateItems({ items: [item()], sellerType: 'naijago', sellerId: null }), { code: 'FULFILLMENT_CHANGED' });
    assert.equal((await f.service.validateItems({ items: [item()], sellerType: 'vendor', sellerId: S, fulfillmentKey: key })).items[0].offer, O);
});

test('planning quotes reuse shared totals, fees, address and owner context and retain duplicate member lines', async () => {
    const f = fixture(), session = {};
    const result = await f.service.quoteGroup({ group: f.group(), items: [item(), item({ quantity: 2 })], session });
    assert.equal(result.totalPrice, 2712.57); assert.equal(result.totalPlatformFees, 57); assert.equal(result.totalShippingPrice, 1000);
    assert.equal(f.quotes.length, 1); const args = f.quotes[0];
    assert.equal(args.userId, S); assert.equal(args.session, session); assert.equal(args.cartItems.length, 2);
    assert.deepEqual(args.cartItems.map((entry) => entry.offer), [O, O]);
    assert.equal(args.shippingAddress.address, destination.address); assert.deepEqual(args.userLocation, { latitude: 9, longitude: 7 });
    await assert.rejects(f.service.quoteGroup({ group: f.group({ destination: { ...destination, latitude: undefined } }), items: [item()] }), { code: 'INVALID_ADDRESS' });
});

test('scheduled quotes require explicit capacity validation and pass server-owned schedule/session', async () => {
    const occurrence = { owner: S, items: [item()], destination, startAt: new Date('2100-01-02T08:00:00Z'), endAt: new Date('2100-01-02T11:00:00Z') };
    const f = fixture();
    await assert.rejects(f.service.quoteOccurrence({ occurrence }), (error) => error.code === 'SCHEDULE_UNAVAILABLE' && error.statusCode === 503);
    assert.equal(f.quotes.length, 0);
    const blocked = fixture({ checkSchedule: async () => ({ eligible: false }) });
    assert.deepEqual(await blocked.service.validateOccurrence({ occurrence }), { eligible: false });
    const session = {}, checked = [];
    const allowed = fixture({ checkSchedule: async (args) => { checked.push(args); return { eligible: true }; } });
    const quoted = await allowed.service.quoteOccurrence({ occurrence, session });
    assert.equal(checked[0].session, session); assert.equal(checked[0].lines[0].item.offer, O);
    assert.equal(quoted.schedule.mode, 'scheduled'); assert.deepEqual(quoted.schedule.startAt, occurrence.startAt);
    assert.deepEqual(await allowed.service.validateOccurrence({ occurrence }), { eligible: true, totalKobo: 271257 });
});

test('commercial failures require review; infrastructure failures remain retryable and cannot look like stock failures', async () => {
    const occurrence = { owner: S, items: [item()], destination, startAt: new Date('2100-01-02T08:00:00Z'), endAt: new Date('2100-01-02T11:00:00Z') };
    const f = fixture({ checkSchedule: async () => ({ eligible: true }) });
    f.offers[0].stockQuantity = 0;
    assert.deepEqual(await f.service.validateOccurrence({ occurrence }), { eligible: false });
    f.offers[0].stockQuantity = 5; f.catalog.resolve = async () => { throw new Error('synthetic-database-unavailable'); };
    await assert.rejects(f.service.validateOccurrence({ occurrence }), /synthetic-database-unavailable/);
    await assert.rejects(fixture().service.validateOccurrence({ occurrence }), { code: 'SCHEDULE_UNAVAILABLE', statusCode: 503 });
});

test('composition needs a private key and does no database work or automatic activation', async () => {
    const f = fixture();
    const args = { models: f.models, connection: {}, queue: { enqueue() { throw new Error('Must not enqueue on composition'); } }, calculateCheckoutSummary: f.calculateCheckoutSummary };
    assert.throws(() => createPlannedOrderServices(args), /private signing secret/);
    const services = createPlannedOrderServices({ ...args, signingSecret: 'synthetic-private-server-secret-for-tests' });
    assert.equal(typeof services.groups.quote, 'function'); assert.equal(typeof services.recurring.checkout, 'function');
    assert.equal(f.quotes.length, 0); assert.equal(f.sessions.length, 0);
});
