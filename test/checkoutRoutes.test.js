'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const { Types } = require('mongoose');
const P = '111111111111111111111111', O = '222222222222222222222222', S = '333333333333333333333333';
const P2 = '444444444444444444444444', O2 = '555555555555555555555555';
const item = (extra = {}) => ({ product: P, quantity: 2, ...extra });
const location = { latitude: 9, longitude: 7, formattedAddress: 'Synthetic shop' };
const address = { address: 'Synthetic destination', city: 'Abuja', country: 'NG', postalCode: '900001' };
const body = (extra = {}) => ({ cartItems: [item()], shippingAddress: address, userLocation: { latitude: 9.1, longitude: 7.1 }, paymentMethod: 'Card', ...extra });
const query = (value) => ({ select() { return this; }, session() { return this; }, lean() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });

async function setup(t, options = {}) {
    const saved = { orders: [], shipments: [], commits: 0, aborts: 0, ends: 0, feeCalls: [], buyerReads: [], sessionReads: [], vendorNotices: [], buyerNotices: [], inventoryWrites: 0 };
    const readQuery = (name, value) => { const result = query(value); result.session = function(value) { saved.sessionReads.push({ name, value }); return this; }; return result; };
    // Lean Mongo results retain BSON ObjectIds; HTTP serialization must not be
    // required to make an internal quote usable by the order creator.
    const product = { _id: new Types.ObjectId(P), name: 'Real catalog shirt', price: 5000, discountPrice: null, stockQuantity: 999,
        category: 'Fashion', isActive: true, moderationStatus: 'approved', productStatus: 'active', sellerType: 'vendor', vendor: new Types.ObjectId(S),
        imageUrls: ['https://example.invalid/real.jpg'], variants: [], ...options.product };
    const offer = { _id: new Types.ObjectId(O), product: new Types.ObjectId(P), sellerType: 'vendor', sellerId: new Types.ObjectId(S), price: 1000, discountPrice: null, stockQuantity: 4,
        isPrimary: true, status: 'active', fulfilmentLocation: location, variants: [], ...options.offer };
    const seller = { _id: new Types.ObjectId(S), isVendor: true, vendorStatus: 'approved', businessName: 'Low Cost', businessLocation: location,
        pickupEnabled: true, pickupSettings: { maximumConcurrentOrders: 20, estimatedPreparationMinutes: 30 }, ...options.seller };
    class MainOrder { constructor(data) { Object.assign(this, data); this._id = '666666666666666666666666'; }
        async save() { if (!saved.orders.includes(this)) saved.orders.push(this); return this; } }
    class Shipment { constructor(data) { Object.assign(this, data); this._id = `shipment-${saved.shipments.length}`; }
        async save() { if (!saved.shipments.includes(this)) saved.shipments.push(this); return this; } static countDocuments() { return query(0); } }
    const session = { startTransaction() {}, inTransaction: () => true, endSession() { saved.ends++; },
        async abortTransaction() { saved.aborts++; }, async commitTransaction() { saved.commits++; } };
    const models = { MainOrder, Shipment, Product: { find: () => options.databaseError ? { lean: async () => { throw new Error('synthetic-private-connection-string'); } } : readQuery('products', [product, ...(options.products || [])]) },
        ProductOffer: { find: () => readQuery('offers', [offer, ...(options.offers || [])]) },
        User: { find: () => readQuery('sellers', [seller]), findById: (id) => { saved.buyerReads.push(String(id)); return readQuery('buyer', String(id) === S ? seller : options.buyer || {}); }, findOne: () => query(seller) },
        AppSetting: { findOne: () => readQuery('commission', { costLowStore: { vendorId: S, commissionKoboPerUnit: 5700 } }) },
        DeliveryReservation: {} };
    if (options.realOrderModels) {
        for (const name of ['MainOrder', 'Shipment']) {
            models[name] = require('../models/' + name);
            t.mock.method(models[name].prototype, 'save', async function(args) {
                assert.equal(args.session, session); await this.validate();
                if (name === 'Shipment' && options.shipmentWriteError) throw new Error('synthetic-shipment-write-failure');
                const rows = name === 'MainOrder' ? saved.orders : saved.shipments;
                const index = rows.findIndex((entry) => String(entry._id) === String(this._id));
                if (index < 0) rows.push(this); else rows[index] = this;
                return this;
            });
            if (name === 'Shipment') t.mock.method(models[name], 'countDocuments', () => query(0));
        }
    }
    const file = path.join(__dirname, '../routes/orderRoutes.js'), actualRequire = createRequire(file), module = { exports: {} };
    const middleware = (req, res, next) => { req.user = { _id: '777777777777777777777777', id: '777777777777777777777777', ...options.actor }; next(); };
    function requireForRoute(name) {
        if (name === 'mongoose') return { startSession: async () => session, connection: { transaction: async work => {
            try { const result = await work(session); await session.commitTransaction(); return result; }
            catch (error) { await session.abortTransaction(); throw error; }
        } } };
        if (name.startsWith('../models/')) return models[name.split('/').pop()] || {};
        if (name === '../middleware/authMiddleware') return { protect: middleware, authorizeRoles: () => middleware };
        if (name === '../services/deliveryFeeService') return { getDeliveryFeeSettings: async () => ({}), buildDeliveryFeeQuote: (args) => { saved.feeCalls.push(args); return { amount: options.deliveryFee ?? 500, source: 'test', zone: null }; } };
        if (name.endsWith('/analyticsService')) return { trackAnalyticsEvent() { if (options.analyticsError) throw new Error('synthetic-analytics-failure'); return Promise.resolve(); } };
        if (name === '../services/vendorOrderNotificationService') return { notifyVendorOfPaidShipment: async () => { saved.vendorNotices.push(saved.commits); } };
        if (name === '../services/notificationService') return { sendToUser: async () => { saved.buyerNotices.push(saved.commits); } };
        if (name === '../services/checkoutInventoryService' && options.fakeInventory) return { createCheckoutInventoryService: () => ({ decrement: async () => {
            saved.inventoryWrites++; if (options.failInventory) throw new Error('synthetic-stock-conflict');
        } }) };
        if (name.startsWith('../services/') && !['../services/checkoutCatalogService', '../services/checkoutInventoryService', '../services/deliveryReservationService', '../services/scheduledOrderPaymentService', '../services/verifiedPaymentReviewService', '../services/checkoutPaymentFreshnessService', '../services/korapayOrderService', '../services/shipmentStatusService'].includes(name)) return {};
        return actualRequire(name);
    }
    vm.runInThisContext('(function(require, module, exports, console) {\n' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(requireForRoute, module, module.exports, { log() {}, error() {} });
    const app = express(); app.use(express.json()); app.use('/orders', module.exports);
    const listener = app.listen(0, '127.0.0.1'); await new Promise((resolve) => listener.once('listening', resolve));
    t.after(() => { listener.closeAllConnections(); return new Promise((resolve) => listener.close(resolve)); });
    return { saved, models, session, product, offer, seller, createUnpaidOrder: module.exports.createUnpaidOrder,
        settleVerifiedPayment: module.exports.settleVerifiedPayment,
        calculateCheckoutSummary: module.exports.calculateCheckoutSummary, async post(route, input, method = 'POST') { const response = await fetch(`http://127.0.0.1:${listener.address().port}/orders${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(15000) }); return { status: response.status, data: await response.json() }; } };
}

test('legacy payment polling cannot write orders or shipments', async (t) => {
    const f = await setup(t);
    for (const model of [f.models.MainOrder, f.models.Shipment]) model.updateMany = () => { throw new Error('Unexpected write'); };
    const result = await f.post('/update-pending-to-processing', {});
    assert.equal(result.status, 200); assert.equal(result.data.count, 0);
});

test('paid responses remain private even when payment is already settled', async (t) => {
    const f = await setup(t);
    f.models.MainOrder.findById = () => query({ _id: O, user: 'another-owner', isPaid: true, mainOrderStatus: 'payment_review', shippingAddress: address });
    for (const path of ['/pay', '/pay/wallet']) {
        const result = await f.post('/' + O + path, {}, 'PUT');
        assert.equal(result.status, 401);
        assert.equal(result.data.shippingAddress, undefined);
        assert.equal(result.data.isPaid, undefined);
    }
    assert.equal(f.saved.commits, 0);
});

test('owned paid-review payment retry returns the existing receipt without charging', async (t) => {
    const f = await setup(t);
    f.models.MainOrder.findById = () => query({ _id: O, user: '777777777777777777777777', isPaid: true, mainOrderStatus: 'payment_review' });
    const result = await f.post('/' + O + '/pay', {}, 'PUT');
    assert.equal(result.status, 200); assert.equal(result.data.mainOrderStatus, 'payment_review');
    assert.equal(f.saved.buyerReads.length, 0); assert.equal(f.saved.inventoryWrites, 0);
});

test('all vendor shipment routes reject payment review before any writes', async (t) => {
    const f = await setup(t);
    f.models.Shipment.findById = () => query({ _id: P, mainOrder: O, vendor: '777777777777777777777777', shipmentStatus: 'processing' });
    f.models.MainOrder.findById = () => query({ _id: O, isPaid: true, mainOrderStatus: 'payment_review' });
    for (const [path, input] of [['accept', {}], ['reject', { reason: 'Cannot supply this item' }], ['status-update', { status: 'ready_for_pickup' }]]) {
        const result = await f.post(`/shipments/${P}/${path}`, input, 'PUT');
        assert.equal(result.status, 409); assert.equal(result.data.code, 'ORDER_PAYMENT_REVIEW');
    }
    assert.equal(f.saved.commits, 0); assert.equal(f.saved.aborts, 3);
});

test('admin status route cannot overwrite a paid review or reset payment', async (t) => {
    const f = await setup(t, { actor: { isAdmin: true } });
    for (const [order, status, code] of [[{ isPaid: true, mainOrderStatus: 'payment_review' }, 'processing', 'ORDER_PAYMENT_REVIEW'],
        [{ isPaid: true, mainOrderStatus: 'processing' }, 'pending_payment', 'ORDER_ALREADY_PAID'],
        [{ isPaid: false }, 'completed', 'ORDER_UNPAID']]) {
        f.models.MainOrder.findById = () => query(order);
        const result = await f.post(`/${O}/status`, { status }, 'PUT');
        assert.equal(result.status, 409); assert.equal(result.data.code, code);
    }
    assert.equal(f.saved.commits, 0);
});

test('private scheduled creator preserves the approved window and transaction-owned reservation on the real receipt', async (t) => {
    const f = await setup(t, { realOrderModels: true }), userId = '777777777777777777777777';
    const schedule = { mode: 'scheduled', timeZone: 'Africa/Lagos', areaKey: 'abuja', policyRevision: 2,
        startAt: new Date('2100-01-01T12:00:00Z'), endAt: new Date('2100-01-01T14:00:00Z'),
        dispatchAt: new Date('2100-01-01T11:00:00Z'), changeCutoffAt: new Date('2100-01-01T10:00:00Z') };
    const quote = { ...await f.calculateCheckoutSummary({ ...body(), userId, deliveryAt: schedule.startAt }), schedule };
    let reservations = 0;
    const service = { check: async ({ session, lines }) => {
        assert.equal(session, f.session); assert.equal(lines.length, 1); return { eligible: true, schedule };
    }, reserve: async (args) => {
        reservations++; assert.equal(args.session, f.session); assert.equal(args.owner, userId);
        assert.deepEqual(args.expectedSchedule, schedule); assert.equal(args.lines.length, 1);
        return { ...schedule, _id: new Types.ObjectId(), order: args.orderId, owner: userId,
            state: 'held', expiresAt: new Date('2100-01-01T09:00:00Z') };
    } };
    const args = { userId, session: f.session, expectedQuote: quote, scheduleService: service,
        planning: { kind: 'recurring', sourceId: P2, revision: 1 }, input: body({ shipmentSummaries: quote.shipmentSummaries, schedule }) };
    const result = await f.createUnpaidOrder(args);
    assert.equal(result.order.schedule.state, 'held'); assert.equal(result.order.schedule.areaKey, 'abuja');
    assert.equal(result.order.schedule.startAt.toISOString(), schedule.startAt.toISOString());
    assert.equal(result.order.isPaid, false); assert.equal(result.order.totalPrice, 2500); assert.equal(reservations, 1);
    assert.equal(f.saved.commits, 0); assert.equal(f.saved.inventoryWrites, 0); assert.equal(f.saved.vendorNotices.length, 0);
    await assert.rejects(f.createUnpaidOrder({ ...args, input: { ...args.input, schedule: { ...schedule, areaKey: 'forged' } } }), { code: 'SCHEDULE_CHANGED' });
    await assert.rejects(f.createUnpaidOrder({ ...args, scheduleService: { ...service,
        check: async () => ({ eligible: true, schedule: { ...schedule, policyRevision: 3 } }) } }), { code: 'SCHEDULE_CHANGED' });
    assert.equal(reservations, 1); assert.equal(f.saved.orders.length, 1);
});

test('failed scheduled capacity reservation writes no receipt or shipment and never commits the caller transaction', async (t) => {
    const f = await setup(t, { realOrderModels: true }), userId = '777777777777777777777777';
    const schedule = { mode: 'scheduled', timeZone: 'Africa/Lagos', areaKey: 'abuja', policyRevision: 1,
        startAt: '2100-01-01T12:00:00Z', endAt: '2100-01-01T14:00:00Z', dispatchAt: '2100-01-01T11:00:00Z', changeCutoffAt: '2100-01-01T10:00:00Z' };
    const quote = { ...await f.calculateCheckoutSummary({ ...body(), userId, deliveryAt: schedule.startAt }), schedule };
    await assert.rejects(f.createUnpaidOrder({ userId, session: f.session, expectedQuote: quote,
        scheduleService: { check: async () => ({ eligible: true, schedule }), reserve: async () => { throw new Error('synthetic-capacity-conflict'); } },
        input: body({ shipmentSummaries: quote.shipmentSummaries, schedule }) }), /synthetic-capacity-conflict/);
    assert.equal(f.saved.orders.length, 0); assert.equal(f.saved.shipments.length, 0); assert.equal(f.saved.commits, 0);
});

test('shared provider settlement is idempotent and never sends external notifications inside the payment transaction', async (t) => {
    const f = await setup(t, { fakeInventory: true }), userId = '777777777777777777777777';
    const quote = await f.calculateCheckoutSummary({ ...body(), userId });
    const { order } = await f.createUnpaidOrder({ userId, session: f.session, input: body({ shipmentSummaries: quote.shipmentSummaries }) });
    f.models.Shipment.find = () => query([...f.saved.shipments]);
    const args = { order, session: f.session, buyer: {}, verifiedTx: { id: 'verified', tx_ref: 'synthetic-ref', status: 'successful', amount: 2500, currency: 'NGN' }, provider: 'squad', method: 'test' };
    await f.settleVerifiedPayment(args);
    assert.equal(order.isPaid, true); assert.equal(order.mainOrderStatus, 'processing'); assert.equal(f.saved.inventoryWrites, 1);
    assert.equal(f.saved.vendorNotices.length, 0); assert.equal(f.saved.buyerNotices.length, 0);
    await f.settleVerifiedPayment(args); assert.equal(f.saved.inventoryWrites, 1);
    await assert.rejects(f.settleVerifiedPayment({ ...args, verifiedTx: { ...args.verifiedTx, tx_ref: 'different-payment' } }), { code: 'PAYMENT_ALREADY_RECORDED' });
    await assert.rejects(f.settleVerifiedPayment({ ...args, session: null }), { code: 'TRANSACTION_REQUIRED' });
});

test('wallet sends buyer/vendor alerts only after commit; failed inventory sends neither', async (t) => {
    for (const failInventory of [false, true]) {
        const buyer = { userWalletBalance: 10000, async save() { return this; } };
        const f = await setup(t, { buyer, fakeInventory: true, failInventory }), userId = '777777777777777777777777';
        const quote = await f.calculateCheckoutSummary({ ...body(), userId });
        const { order } = await f.createUnpaidOrder({ userId, session: f.session, input: body({ paymentMethod: 'Wallet', shipmentSummaries: quote.shipmentSummaries }) });
        order.toObject = () => ({ ...order });
        f.models.MainOrder.findById = () => query(order); f.models.Shipment.find = () => query([...f.saved.shipments]);
        const result = await f.post('/' + order._id + '/pay/wallet', {}, 'PUT');
        assert.equal(result.status, failInventory ? 500 : 200);
        assert.deepEqual(f.saved.vendorNotices, failInventory ? [] : [1]);
        assert.deepEqual(f.saved.buyerNotices, failInventory ? [] : [1]);
        assert.equal(f.saved.commits, failInventory ? 0 : 1);
    }
});

test('payment intent rechecks current prices and never silently reprices an existing unpaid receipt', async t => {
    const f = await setup(t), userId = '777777777777777777777777';
    const quote = await f.calculateCheckoutSummary({ ...body(), userId });
    const { order } = await f.createUnpaidOrder({ userId, session: f.session, input: body({ shipmentSummaries: quote.shipmentSummaries }) });
    f.models.MainOrder.findById = () => query(order); f.models.Shipment.find = () => query([...f.saved.shipments]);
    f.offer.price = 1500;
    const result = await f.post('/' + order._id + '/payment-intent', {});
    assert.equal(result.status, 409); assert.equal(result.data.code, 'PAYMENT_QUOTE_CHANGED');
    assert.equal(order.totalPrice, 2500); assert.equal(order.paymentResult, undefined); assert.equal(order.isPaid, false);
});

test('wallet rejects changed prices before debiting, consuming benefits or inventory', async t => {
    const buyer = { userWalletBalance: 10000, async save() { throw new Error('Unexpected debit'); } };
    const f = await setup(t, { buyer, fakeInventory: true }), userId = '777777777777777777777777';
    const quote = await f.calculateCheckoutSummary({ ...body(), userId });
    const { order } = await f.createUnpaidOrder({ userId, session: f.session, input: body({ paymentMethod: 'Wallet', shipmentSummaries: quote.shipmentSummaries }) });
    f.models.MainOrder.findById = () => query(order); f.models.Shipment.find = () => query([...f.saved.shipments]);
    f.offer.price++;
    const result = await f.post('/' + order._id + '/pay/wallet', {}, 'PUT');
    assert.equal(result.status, 409); assert.equal(buyer.userWalletBalance, 10000);
    assert.equal(f.saved.inventoryWrites, 0); assert.equal(order.isPaid, false); assert.equal(f.saved.commits, 0);
});

test('disabled offers are rejected before returning an earlier hosted-checkout URL', async t => {
    const f = await setup(t), userId = '777777777777777777777777';
    const quote = await f.calculateCheckoutSummary({ ...body(), userId });
    const { order } = await f.createUnpaidOrder({ userId, session: f.session, input: body({ shipmentSummaries: quote.shipmentSummaries }) });
    order.paymentResult = { provider: 'squad', tx_ref: 'synthetic-ref', checkoutUrl: 'https://example.invalid/old-checkout' };
    f.models.MainOrder.findById = () => query(order); f.models.Shipment.find = () => query([...f.saved.shipments]);
    f.offer.status = 'disabled';
    const result = await f.post('/' + order._id + '/payment-intent', {});
    assert.equal(result.status, 409); assert.equal(result.data.checkout_url, undefined);
    assert.equal(result.data.code, 'OFFER_UNAVAILABLE');
});

test('unchanged real delivery and pickup receipts pass wallet freshness with legacy selection and notes intact', async t => {
    for (const method of ['delivery', 'pickup']) {
        const buyer = { userWalletBalance: 10000, async save() { return this; } };
        const f = await setup(t, { buyer, fakeInventory: true, realOrderModels: true }), userId = '777777777777777777777777';
        const quote = await f.calculateCheckoutSummary({ ...body(), userId, fulfillmentSelections: { [S]: { method } } });
        const { order } = await f.createUnpaidOrder({ userId, session: f.session, input: body({ paymentMethod: 'Wallet', shipmentSummaries: quote.shipmentSummaries }) });
        f.models.MainOrder.findById = () => query(order); f.models.Shipment.find = () => query([...f.saved.shipments]);
        const result = await f.post('/' + order._id + '/pay/wallet', {}, 'PUT');
        assert.equal(result.status, 200, JSON.stringify(result.data));
        assert.equal(buyer.userWalletBalance, method === 'pickup' ? 8000 : 7500);
        assert.equal(f.saved.inventoryWrites, 1); assert.equal(f.saved.commits, 1);
    }
});

test('future quotes evaluate subscription expiry and benefit hours at delivery time', async (t) => {
    const f = await setup(t, { buyer: { naijagoSubscription: { status: 'active', expiresAt: '2100-02-01T00:00:00Z',
        deliveriesRemaining: 2, minimumOrderValue: 0, validHours: { start: '09:00', end: '18:00' }, planId: 'test-plan' } } });
    const quote = (deliveryAt) => f.calculateCheckoutSummary({ ...body(), userId: '777777777777777777777777', deliveryAt });
    assert.equal((await quote('2100-01-01T12:00:00+01:00')).totalShippingPrice, 0);
    assert.equal((await quote('2100-01-01T19:00:00+01:00')).totalShippingPrice, 500);
    assert.equal((await quote('2100-02-01T12:00:00+01:00')).totalShippingPrice, 500);
    assert.equal(f.saved.orders.length, 0);
});

test('future restaurant quotes use the selected WAT time, not the host clock', async (t) => {
    const f = await setup(t, { product: { category: 'Restaurant', orderStartTime: '11:00', orderEndTime: '12:00' } });
    const quote = (deliveryAt) => f.calculateCheckoutSummary({ ...body(), userId: '777777777777777777777777', deliveryAt });
    assert.equal((await quote('2100-01-01T10:30:00Z')).totalPrice, 2500);
    await assert.rejects(quote('2100-01-01T09:30:00Z'), { code: 'RESTAURANT_CLOSED' });
    await assert.rejects(quote('2100-01-01T11:30:00Z'), { code: 'RESTAURANT_CLOSED' });
    assert.equal(f.saved.orders.length, 0);
});

test('ordinary HTTP quotes ignore a forged pricing date and cannot revive an expired subscription', async (t) => {
    const f = await setup(t, { buyer: { naijagoSubscription: { status: 'active', expiresAt: '2001-01-01T00:00:00Z',
        deliveriesRemaining: 2, minimumOrderValue: 0, validHours: { start: '00:00', end: '00:00' } } } });
    const input = body({ deliveryAt: '2000-01-01T12:00:00+01:00' });
    assert.equal((await f.calculateCheckoutSummary({ ...input, userId: '777777777777777777777777' })).totalShippingPrice, 0);
    const response = await f.post('/summary', input);
    assert.equal(response.status, 200); assert.equal(response.data.totalShippingPrice, 500);
});

test('existing creator persists real order/shipment schemas without charging and leaves input quote unchanged', async (t) => {
    const f = await setup(t, { realOrderModels: true }), userId = '777777777777777777777777';
    const quote = await f.calculateCheckoutSummary({ ...body(), userId });
    const before = JSON.stringify(quote);
    const result = await f.createUnpaidOrder({ userId, session: f.session, expectedQuote: quote,
        planning: { kind: 'group', sourceId: P, revision: 3 }, input: body({ shipmentSummaries: quote.shipmentSummaries }) });
    assert.equal(result.order.isPaid, false); assert.equal(result.order.mainOrderStatus, 'pending_payment');
    assert.equal(result.order.totalPrice, 2500); assert.equal(result.order.shipments.length, 1);
    assert.equal(result.order.planning.kind, 'group'); assert.equal(String(result.order.planning.sourceId), P);
    assert.equal(f.saved.shipments[0].items[0].price, 1000); assert.equal(f.saved.shipments[0].items[0].commissionKoboPerUnit, 5700);
    assert.equal(JSON.stringify(quote), before); assert.equal(f.saved.commits, 0); assert.equal(f.saved.ends, 0);
});

test('BSON-backed quote keeps canonical string product, offer and variant IDs for direct and HTTP checkout', async (t) => {
    const variantId = '999999999999999999999999';
    const f = await setup(t, { realOrderModels: true,
        product: { variants: [{ _id: new Types.ObjectId(variantId), attributes: { size: 'M' }, stockQuantity: 4, isActive: true }] },
        offer: { variants: [{ _id: new Types.ObjectId(), productVariantId: new Types.ObjectId(variantId), price: 1000, stockQuantity: 4, isActive: true }] } });
    const input = body({ cartItems: [item({ selectedSize: 'M' })] }), userId = '777777777777777777777777';
    const quote = await f.calculateCheckoutSummary({ ...input, userId });
    const line = quote.shipmentSummaries[0].items[0];
    assert.equal(line.product, P); assert.equal(line.offer, O); assert.equal(line.variantId, variantId);
    const http = await f.post('/summary', input); assert.equal(http.status, 200);
    assert.deepEqual(JSON.parse(JSON.stringify(quote)), http.data);
    const before = JSON.stringify(quote);
    const result = await f.createUnpaidOrder({ userId, session: f.session, expectedQuote: quote,
        planning: { kind: 'group', sourceId: P2, revision: 2 }, input: { ...input, shipmentSummaries: quote.shipmentSummaries } });
    assert.equal(result.order.isPaid, false); assert.equal(result.order.totalPrice, 2500);
    const savedLine = f.saved.shipments[0].items[0];
    assert.equal(String(savedLine.product), P); assert.equal(String(savedLine.offer), O); assert.equal(String(savedLine.variantId), variantId);
    assert.equal(savedLine.selectedSize, 'M'); assert.equal(JSON.stringify(quote), before);
});

test('legacy quote without offers keeps null IDs and creates the same unpaid order directly', async (t) => {
    const f = await setup(t, { realOrderModels: true });
    f.models.ProductOffer.find = () => query([]);
    const userId = '777777777777777777777777', quote = await f.calculateCheckoutSummary({ ...body(), userId });
    const line = quote.shipmentSummaries[0].items[0];
    assert.equal(line.product, P); assert.equal(line.offer, null); assert.equal(line.variantId, null);
    const result = await f.createUnpaidOrder({ userId, session: f.session, expectedQuote: quote,
        input: body({ shipmentSummaries: quote.shipmentSummaries }) });
    assert.equal(result.order.totalPrice, 10500); assert.equal(result.order.isPaid, false);
    assert.equal(f.saved.shipments[0].items[0].offer, null);
});

test('creator rejects changed line prices, equal-total fee swaps, seller location and stock before writes', async (t) => {
    const options = { deliveryFee: 500 }, f = await setup(t, options), userId = '777777777777777777777777';
    const quote = await f.calculateCheckoutSummary({ ...body(), userId });
    const run = () => f.createUnpaidOrder({ userId, session: f.session, expectedQuote: quote, input: body({ shipmentSummaries: quote.shipmentSummaries }) });
    f.offer.price = 1100; options.deliveryFee = 300; // Same 2500 total, different lines/fees.
    await assert.rejects(run(), { code: 'QUOTE_CHANGED' });
    f.offer.price = 1000; options.deliveryFee = 500;
    f.offer.fulfilmentLocation = { ...location, latitude: 8 };
    await assert.rejects(run(), { code: 'QUOTE_CHANGED' });
    f.offer.fulfilmentLocation = location; f.offer.stockQuantity = 1;
    await assert.rejects(run(), { code: 'INSUFFICIENT_STOCK' });
    assert.equal(f.saved.orders.length, 0); assert.equal(f.saved.shipments.length, 0);
});

test('creator requires active transaction; scheduled/recurring writes remain blocked even with a quote', async (t) => {
    const f = await setup(t), userId = '777777777777777777777777';
    const quote = await f.calculateCheckoutSummary({ ...body(), userId });
    const args = { userId, input: body({ shipmentSummaries: quote.shipmentSummaries }), session: f.session, expectedQuote: quote };
    await assert.rejects(f.createUnpaidOrder({ ...args, session: null }), { code: 'TRANSACTION_REQUIRED' });
    await assert.rejects(f.createUnpaidOrder({ ...args, expectedQuote: { ...quote, schedule: { mode: 'scheduled' } } }), { code: 'SCHEDULE_UNAVAILABLE' });
    await assert.rejects(f.createUnpaidOrder({ ...args, planning: { kind: 'recurring', sourceId: P, revision: 1 } }), { code: 'SCHEDULE_UNAVAILABLE' });
    await assert.rejects(f.createUnpaidOrder({ ...args, expectedQuote: null, planning: { kind: 'group', sourceId: P, revision: 1 } }), { code: 'INVALID_PLANNING_SOURCE' });
    assert.equal(f.saved.orders.length, 0);
});

test('ordinary HTTP checkout ignores forged planning/approval identity and closes its session once', async (t) => {
    const f = await setup(t), quote = await f.post('/summary', body());
    const result = await f.post('', body({ shipmentSummaries: quote.data.shipmentSummaries, userId: S,
        planning: { kind: 'group', sourceId: P, revision: 1 }, expectedQuote: { totalPrice: 1 }, session: { forged: true } }));
    assert.equal(result.status, 201); assert.equal(result.data.planning, undefined); assert.equal(result.data.user, '777777777777777777777777');
    assert.equal(f.saved.commits, 1); assert.equal(f.saved.ends, 1); assert.equal(f.saved.aborts, 0);
    assert.equal((await f.post('', body({ shipmentSummaries: quote.data.shipmentSummaries, schedule: { mode: 'scheduled' } }))).status, 503);
    assert.equal(f.saved.ends, 2); assert.equal(f.saved.orders.length, 1);
});

test('invalid payment method fails before writes and analytics failure cannot turn a committed order into failure', async (t) => {
    const f = await setup(t, { analyticsError: true, product: { category: 'Restaurant', restaurantName: 'Synthetic', orderStartTime: '00:00', orderEndTime: '00:00' } });
    const quote = await f.post('/summary', body());
    const invalid = await f.post('', body({ shipmentSummaries: quote.data.shipmentSummaries, paymentMethod: 'Free' }));
    assert.equal(invalid.status, 400); assert.equal(f.saved.orders.length, 0); assert.equal(f.saved.ends, 1);
    const result = await f.post('', body({ shipmentSummaries: quote.data.shipmentSummaries }));
    assert.equal(result.status, 201); assert.equal(f.saved.commits, 1); assert.equal(f.saved.orders.length, 1);
});

async function plannedFixture(t, options = {}) {
    const f = await setup(t, { ...options, realOrderModels: true });
    const Group = require('../models/GroupOrder'); let rows = [], jobs = [];
    const clone = (value) => JSON.parse(JSON.stringify(value));
    t.mock.method(Group, 'findById', (id) => query(rows.find((row) => row._id === String(id)) ? Group.hydrate(clone(rows.find((row) => row._id === String(id)))) : null));
    t.mock.method(Group, 'findOne', (filter) => { const row = rows.find((row) => row.inviteHash === filter.inviteHash); return query(row ? Group.hydrate(clone(row)) : null); });
    t.mock.method(Group.prototype, 'save', async function({ session }) {
        assert.equal(session, f.session); await this.validate();
        const index = rows.findIndex((row) => row._id === String(this._id)), value = clone(this.toObject());
        if (index < 0) rows.push(value); else rows[index] = value;
        return this;
    });
    // Real service and schema orchestration; fake rollback, not Mongo race proof.
    const connection = { transaction: async (work) => {
        const before = clone(rows), oldJobs = clone(jobs), orders = f.saved.orders.length, shipments = f.saved.shipments.length;
        try { return await work(f.session); }
        catch (error) { rows = before; jobs = oldJobs; f.saved.orders.length = orders; f.saved.shipments.length = shipments; throw error; }
    } };
    const queue = { enqueue: async (job, { session }) => { assert.equal(session, f.session); jobs.push(clone(job)); } };
    const { createPlannedOrderServices } = require('../services/plannedOrderServiceFactory');
    const services = createPlannedOrderServices({ models: { ...f.models, GroupOrder: Group }, connection, queue,
        calculateCheckoutSummary: f.calculateCheckoutSummary, createUnpaidOrder: f.createUnpaidOrder,
        signingSecret: 'synthetic-private-planned-order-integration-test', now: () => new Date('2100-01-01T08:00:00Z') });
    const owner = '777777777777777777777777', guest = '888888888888888888888888';
    const created = await services.groups.create({ actor: owner, displayName: 'Owner', input: { name: 'Synthetic group', sellerType: 'vendor', sellerId: S,
        anchorItem: item({ quantity: 1 }), cutoffAt: '2100-01-01T12:00:00Z', destinationLabel: 'Reception',
        destination: { ...address, phoneNumber: 'synthetic', latitude: 9.1, longitude: 7.1 } } });
    const groupId = created.group.id;
    let current = await services.groups.join({ token: created.inviteToken, actor: guest, displayName: 'Guest' });
    current = await services.groups.edit({ groupId, actor: guest, revision: current.revision, items: [item({ quantity: 1 })] });
    current = await services.groups.edit({ groupId, actor: owner, revision: current.revision, items: [item({ quantity: 1 })] });
    current = await services.groups.control({ groupId, actor: owner, revision: current.revision, action: 'close' });
    const args = { groupId, actor: owner, revision: current.revision, paymentMethod: 'Card' };
    return { ...f, services, queue, args, guest, rows: () => clone(rows), jobs: () => clone(jobs) };
}

test('composed group checkout creates one actual unpaid receipt and one shipment for both members, with retry identity', async (t) => {
    const f = await plannedFixture(t), approved = await f.services.groups.quote(f.args);
    const first = await f.services.checkoutGroup({ ...f.args, approvalToken: approved.approvalToken });
    const again = await f.services.checkoutGroup(f.args);
    assert.equal(first.orderId, again.orderId); assert.equal(again.reused, true);
    assert.equal(f.saved.orders.length, 1); assert.equal(f.saved.shipments.length, 1);
    const order = f.saved.orders[0], shipment = f.saved.shipments[0];
    assert.equal(order.totalPrice, 2500); assert.equal(order.totalShippingPrice, 500); assert.equal(order.isPaid, false);
    assert.equal(String(order.planning.sourceId), f.args.groupId); assert.equal(shipment.items.length, 2);
    assert.equal(shipment.platformFee, 114); assert.equal(f.rows()[0].order, first.orderId);
    assert.equal(f.jobs().filter((job) => job.payload.event === 'checkout_started').length, 1);
});

test('composed group checkout rejects other members and price changes before order creation', async (t) => {
    const f = await plannedFixture(t), approved = await f.services.groups.quote(f.args);
    await assert.rejects(f.services.checkoutGroup({ ...f.args, actor: f.guest, approvalToken: approved.approvalToken }), { code: 'OWNER_REQUIRED' });
    f.offer.price = 1100;
    await assert.rejects(f.services.checkoutGroup({ ...f.args, approvalToken: approved.approvalToken }), { code: 'QUOTE_CHANGED' });
    assert.equal(f.saved.orders.length, 0); assert.equal(f.saved.shipments.length, 0);
});

test('composed order, shipments and source link all roll back on notification failure', async (t) => {
    const f = await plannedFixture(t), approved = await f.services.groups.quote(f.args), before = f.rows(), jobs = f.jobs();
    f.queue.enqueue = async () => { throw new Error('synthetic-outbox-failure'); };
    await assert.rejects(f.services.checkoutGroup({ ...f.args, approvalToken: approved.approvalToken }), /synthetic-outbox-failure/);
    assert.equal(f.saved.orders.length, 0); assert.equal(f.saved.shipments.length, 0);
    assert.deepEqual(f.rows(), before); assert.deepEqual(f.jobs(), jobs);
});

test('composed order creation rolls back an early receipt if shipment persistence fails', async (t) => {
    const f = await plannedFixture(t, { shipmentWriteError: true }), approved = await f.services.groups.quote(f.args), before = f.rows();
    await assert.rejects(f.services.checkoutGroup({ ...f.args, approvalToken: approved.approvalToken }), /synthetic-shipment-write-failure/);
    assert.equal(f.saved.orders.length, 0); assert.equal(f.saved.shipments.length, 0); assert.deepEqual(f.rows(), before);
});

test('planning origin remains optional for historical orders and has a scoped unique source index', () => {
    const MainOrder = require('../models/MainOrder');
    assert.equal(new MainOrder().planning, undefined);
    const index = MainOrder.schema.indexes().find(([, options]) => options.name === 'unique_planned_order_source');
    assert.equal(index[1].unique, true); assert.deepEqual(index[1].partialFilterExpression, { 'planning.sourceId': { $type: 'objectId' } });
    const invalid = new MainOrder({ planning: { kind: 'unknown', sourceId: P, revision: -1 } }).validateSync();
    assert.ok(invalid.errors['planning.kind']); assert.ok(invalid.errors['planning.revision']);
});

test('shared quote matches the HTTP quote and cannot inherit a client-supplied owner or session', async (t) => {
    const f = await setup(t), owner = '777777777777777777777777', session = { inTransaction: () => true };
    const http = await f.post('/summary', body({ userId: S, session: { forged: true } }));
    assert.equal(http.status, 200); assert.deepEqual(f.saved.buyerReads, [owner]); assert.equal(f.saved.sessionReads.length, 0);
    const internal = await f.calculateCheckoutSummary({ ...body(), userId: owner, session });
    assert.deepEqual(JSON.parse(JSON.stringify(internal)), http.data);
    assert.deepEqual(f.saved.sessionReads.map((entry) => entry.name), ['products', 'offers', 'sellers', 'commission', 'buyer']);
    assert.ok(f.saved.sessionReads.every((entry) => entry.value === session));
    assert.equal(f.saved.orders.length, 0); assert.equal(f.saved.shipments.length, 0);
});

test('planned group adapter uses the actual summary implementation with the same fees and signed quote snapshot', async (t) => {
    const f = await setup(t), owner = '777777777777777777777777';
    const { createCheckoutCatalogService } = require('../services/checkoutCatalogService');
    const { createPlannedOrderCatalogService } = require('../services/plannedOrderCatalogService');
    const { createPlannedCheckoutApproval } = require('../utils/plannedCheckoutApproval');
    const adapter = createPlannedOrderCatalogService({ catalog: createCheckoutCatalogService(f.models), User: f.models.User, calculateCheckoutSummary: f.calculateCheckoutSummary });
    const group = { owner, sellerType: 'vendor', sellerId: S, fulfillmentKey: `vendor:${S}:9:7`,
        destination: { ...address, phoneNumber: 'synthetic', latitude: 9.1, longitude: 7.1 }, schedule: { mode: 'now', timeZone: 'Africa/Lagos' } };
    const first = await adapter.quoteGroup({ group, items: [item({ selectedSize: null })] });
    assert.equal(first.totalPrice, 2500); assert.equal(first.totalPlatformFees, 114); assert.equal(first.shipmentSummaries.length, 1);
    const approval = createPlannedCheckoutApproval({ secret: 'synthetic-local-test-secret-not-for-production' });
    const context = { kind: 'group', owner, recordId: P, revision: 3, destination: group.destination, schedule: group.schedule };
    const issued = approval.issue({ context, quote: first });
    const again = await adapter.quoteGroup({ group, items: [item()], session: { inTransaction: () => true } });
    assert.equal(approval.verify({ context, quote: again, token: issued.approvalToken }), true);
    assert.equal(f.saved.orders.length, 0);
});

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
