'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sift = createRequire(require.resolve('mongoose'))('sift').default;
const { canDispatch, dispatchEligibilityFilter } = require('../utils/orderPlanningPolicy');
const { createAdminDispatchService } = require('../services/adminDispatchService');
const O = '111111111111111111111111', S = '222222222222222222222222', R = '333333333333333333333333';
const C = '444444444444444444444444', CR = '555555555555555555555555';
const time = new Date(), past = new Date(time.getTime() - 60000), future = new Date(time.getTime() + 3600000);
const scheduled = { mode: 'scheduled', state: 'confirmed', dispatchAt: past, endAt: future };
const order = () => ({ _id: O, isPaid: true, isClaimed: false, mainOrderStatus: 'processing', schedule: { ...scheduled },
    user: { firstName: 'Synthetic', lastName: 'Customer' }, shippingAddress: { address: 'Test address', city: 'Abuja', postalCode: '900001' }, totalShippingPrice: 500 });
const shipment = () => ({ _id: S, mainOrder: O, shipmentStatus: 'ready_for_pickup', isClaimed: false, fulfillmentMethod: 'delivery',
    vendorLocation: { latitude: 9, longitude: 7, formattedAddress: 'Synthetic shop' }, items: [{ name: 'Shirt', quantity: 1, price: 1000 }] });
const query = (value) => ({ session() { return this; }, select() { return this; }, lean() { return this; },
    populate() { return this; }, sort() { return this; }, limit(n) { value = Array.isArray(value) ? value.slice(0, n) : value; return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
function apply(row, update) {
    Object.assign(row, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete row[key];
    for (const [key, value] of Object.entries(update.$pull || {})) row[key] = (row[key] || []).filter((entry) => entry !== value);
}
function fixture(options = {}) {
    let rows = { orders: [order()], shipments: [shipment()], deliveries: [] };
    const calls = { pushes: 0, offers: 0, riderReads: 0, commits: 0, rollbacks: 0 };
    const session = { inTransaction: () => true };
    const rider = { _id: R, fullName: 'Synthetic rider', status: 'approved', isAvailable: true, isActive: true, activeDeliveries: 0,
        currentLocation: { lat: 9.01, lng: 7.01, lastUpdated: time }, ...options.rider };
    const company = { _id: C, status: 'active', ...options.company };
    const companyRider = { _id: CR, company: C, status: 'active', isActive: true, stats: { activeDeliveries: 0 }, ...options.companyRider };
    function model(key) { return {
        find: (filter) => query(rows[key].filter(sift(filter))),
        findOne: (filter) => query(rows[key].find(sift(filter)) || null),
        findOneAndUpdate: (filter, update) => {
            if (options.beforeClaim && key === 'orders') options.beforeClaim(rows.orders[0]);
            const row = rows[key].find(sift(filter)); if (row) apply(row, update);
            return query(row ? structuredClone(row) : null);
        },
        updateMany: async (filter, update) => {
            if (options.failShipments) throw new Error('synthetic-shipment-failure');
            const matched = rows[key].filter(sift(filter)); for (const row of matched) apply(row, update);
            return { matchedCount: matched.length };
        },
    }; }
    const models = { MainOrder: model('orders'), Shipment: model('shipments'),
        Rider: { findOne: (filter) => query(sift(filter)(rider) ? rider : null),
            find: (filter) => { calls.riderReads++; return query([rider].filter(sift(filter))); },
            findByIdAndUpdate: async () => { calls.pushes++; } },
        Company: { findOne: (filter) => query(sift(filter)(company) ? company : null) },
        CompanyRider: { findOne: (filter) => query(sift(filter)(companyRider) ? companyRider : null) },
        CompanyDelivery: { ...model('deliveries'), create: async (input, args) => {
            assert.equal(args.session, session); if (options.failDelivery) throw new Error('synthetic-delivery-failure');
            rows.deliveries.push(...structuredClone(input)); return input;
        } },
    };
    // Serial fake transactions exercise rollback orchestration, NOT Mongo races.
    let tail = Promise.resolve();
    const connection = { transaction: (work) => {
        const result = tail.then(async () => { const before = structuredClone(rows);
            try { const result = await work(session); calls.commits++; return result; }
            catch (error) { rows = before; calls.rollbacks++; throw error; }
        }); tail = result.catch(() => {}); return result;
    } };
    const file = path.join(__dirname, '../services/riderAssignmentService.js'), actual = createRequire(file), module = { exports: {} };
    const safeRequire = (name) => {
        if (name.startsWith('../models/')) return models[name.split('/').pop()];
        if (name === './notificationService') return { sendToUser: async () => { calls.offers++; } };
        if (name === './riderEarningsService') return { calculateOrderRiderEarningsBreakdown: () => ({ amount: 300 }) };
        if (['../utils/distanceCalculator', '../utils/orderPlanningPolicy'].includes(name)) return actual(name);
        throw new Error('External dependency forbidden: ' + name);
    };
    vm.runInThisContext('(function(require,module,exports){\n' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(safeRequire, module, module.exports);
    return { rows: () => rows, calls, models, auto: module.exports,
        admin: createAdminDispatchService({ ...models, connection, now: () => time }) };
}

test('atomic dispatch predicate matches the in-memory rule and preserves caller ownership conditions', () => {
    const base = order();
    const variants = [base, { ...base, schedule: undefined }, { ...base, schedule: null }, { ...base, schedule: { mode: 'now' } },
        ...[false, null, undefined].map((isPaid) => ({ ...base, isPaid })), { ...base, isDelivered: true },
        ...['cancelled', 'completed', 'delivered', 'pending_payment', 'payment_review'].map((mainOrderStatus) => ({ ...base, mainOrderStatus })),
        { ...base, paymentResult: { fulfillmentStatus: 'needs_attention' } },
        ...['held', 'expired', 'released', 'needs_attention'].map((state) => ({ ...base, schedule: { ...scheduled, state } })),
        { ...base, schedule: { ...scheduled, dispatchAt: future } }, { ...base, schedule: { ...scheduled, endAt: time } },
        { ...base, schedule: { mode: 'unknown' } }];
    for (const row of variants) assert.equal(sift(dispatchEligibilityFilter({}, time))(row), canDispatch(row, time));
    const filter = dispatchEligibilityFilter({ $or: [{ assignedRider: null }, { assignedRider: R }], $and: [{ company: null }] }, time);
    assert.equal(sift(filter)(base), true);
    assert.equal(sift(filter)({ ...base, assignedRider: CR }), false);
    assert.equal(sift(filter)({ ...base, company: C }), false);
});

test('automatic offers reject unpaid, early, review, company, pickup and unaccepted jobs before rider lookup', async () => {
    for (const change of [row => { row.isPaid = false; }, row => { row.schedule.dispatchAt = future; },
        row => { row.mainOrderStatus = 'payment_review'; }, row => { row.company = C; }]) {
        const f = fixture(); change(f.rows().orders[0]);
        assert.deepEqual(await f.auto.notifyEligibleRidersForShipment({ mainOrder: f.rows().orders[0], shipment: f.rows().shipments[0] }), []);
        assert.equal(f.calls.riderReads, 0); assert.equal(f.calls.offers, 0);
    }
    for (const patch of [{ fulfillmentMethod: 'pickup' }, { shipmentStatus: 'processing' }, { company: C }]) {
        const f = fixture(); Object.assign(f.rows().shipments[0], patch);
        await f.auto.notifyEligibleRidersForShipment({ mainOrder: f.rows().orders[0], shipment: f.rows().shipments[0] });
        assert.equal(f.calls.riderReads, 0);
    }
});
test('automatic atomic claim rechecks review state after its initial read', async () => {
    const f = fixture({ beforeClaim: row => { row.mainOrderStatus = 'payment_review'; } });
    await f.auto.notifyEligibleRidersForShipment({ mainOrder: structuredClone(f.rows().orders[0]), shipment: f.rows().shipments[0] });
    assert.equal(f.rows().orders[0].assignedRider, undefined); assert.equal(f.calls.offers, 0);
});
test('concurrent automatic offers have one guarded winner and one notification', async () => {
    const f = fixture(), mainOrder = structuredClone(f.rows().orders[0]);
    await Promise.all([1, 2].map(() => f.auto.notifyEligibleRidersForShipment({ mainOrder, shipment: f.rows().shipments[0] })));
    assert.equal(f.rows().orders[0].assignedRider, R); assert.equal(f.calls.offers, 1); assert.equal(f.calls.pushes, 1);
});
test('existing assignment scanner offers due scheduled work and ignores future, expired and review work', async () => {
    const f = fixture();
    f.rows().orders.push(...[
        { ...order(), _id: 'early', schedule: { ...scheduled, dispatchAt: future } },
        { ...order(), _id: 'late', schedule: { ...scheduled, endAt: past } },
        { ...order(), _id: 'review', mainOrderStatus: 'payment_review' },
    ]);
    assert.equal(await f.auto.offerDueScheduledOrders(), 1);
    assert.equal(f.calls.offers, 1);
    assert.equal(await f.auto.offerDueScheduledOrders(), 0);
});
test('admin individual assignment commits eligible shipments without turning pickup into delivery', async () => {
    const f = fixture(); f.rows().shipments.push({ ...shipment(), _id: 'pickup', fulfillmentMethod: 'pickup' });
    await f.admin.assignIndividual({ orderId: O, riderId: R });
    assert.equal(f.rows().orders[0].assignedRider, R); assert.equal(f.rows().shipments[0].assignedRider, R);
    assert.equal(f.rows().shipments[1].assignedRider, undefined); assert.equal(f.calls.commits, 1); assert.equal(f.calls.offers, 0);
});
test('both admin assignment methods reject future, unpaid, paid-review and already-assigned orders', async () => {
    for (const method of ['assignIndividual', 'assignCompany']) {
        for (const change of [row => { row.isPaid = false; }, row => { row.schedule.dispatchAt = future; },
            row => { row.mainOrderStatus = 'payment_review'; }, row => { row.company = C; }, row => { row.assignedRider = R; }]) {
            const f = fixture(); change(f.rows().orders[0]);
            await assert.rejects(f.admin[method]({ orderId: O, riderId: method === 'assignCompany' ? CR : R, companyId: C }), { code: 'ORDER_NOT_DISPATCHABLE' });
            assert.equal(f.calls.commits, 0); assert.equal(f.rows().deliveries.length, 0);
        }
    }
});
test('shipment write failure rolls back an admin individual offer', async () => {
    const f = fixture({ failShipments: true });
    await assert.rejects(f.admin.assignIndividual({ orderId: O, riderId: R }), /synthetic-shipment-failure/);
    assert.equal(f.rows().orders[0].assignedRider, undefined); assert.equal(f.calls.rollbacks, 1);
});
test('company assignment retains the actual company owner and never writes company rider into individual rider reference', async () => {
    const f = fixture(); const result = await f.admin.assignCompany({ orderId: O, companyId: C, riderId: CR });
    assert.equal(f.rows().orders[0].company, C); assert.equal(f.rows().orders[0].rider, undefined);
    assert.equal(f.rows().shipments[0].company, C); assert.equal(result.delivery.rider, CR);
    assert.match(result.delivery.deliveryId, /^CD-[a-f0-9-]{36}$/);
    assert.match(result.delivery.pickupDetails.pickupOTP, /^\d{6}$/);
    assert.equal(result.delivery.pickupDetails.vendorAddress, 'Synthetic shop');
    await assert.rejects(f.admin.assignCompany({ orderId: O, companyId: C, riderId: CR }));
    assert.equal(f.rows().deliveries.length, 1);
});
test('company assignment rejects another company rider, suspended company, pickup and unprepared shipments', async () => {
    const foreign = fixture({ companyRider: { company: O } });
    await assert.rejects(foreign.admin.assignCompany({ orderId: O, companyId: C, riderId: CR }), { code: 'RIDER_UNAVAILABLE' });
    const suspended = fixture({ company: { status: 'suspended' } });
    await assert.rejects(suspended.admin.assignCompany({ orderId: O, companyId: C }), { code: 'COMPANY_UNAVAILABLE' });
    for (const patch of [{ fulfillmentMethod: 'pickup' }, { shipmentStatus: 'processing' }]) {
        const f = fixture(); Object.assign(f.rows().shipments[0], patch);
        await assert.rejects(f.admin.assignCompany({ orderId: O, companyId: C }), { code: 'SHIPMENT_UNAVAILABLE' });
    }
});
test('company delivery and shipment failures roll back all assignment records', async () => {
    for (const options of [{ failDelivery: true }, { failShipments: true }]) {
        const f = fixture(options);
        await assert.rejects(f.admin.assignCompany({ orderId: O, companyId: C, riderId: CR }), /synthetic-/);
        assert.equal(f.rows().orders[0].company, undefined); assert.equal(f.rows().shipments[0].company, undefined);
        assert.equal(f.rows().deliveries.length, 0); assert.equal(f.calls.rollbacks, 1);
    }
});
