'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createShipmentStatusService } = require('../services/shipmentStatusService');
const { assertAdminStatusChange } = require('../utils/orderFulfillmentPolicy');
const ShipmentSchema = require('../models/Shipment').schema;
const now = new Date('2026-09-21T10:00:00Z');
const futureSchedule = { mode: 'scheduled', state: 'confirmed', dispatchAt: new Date('2026-09-22T10:00:00Z'), endAt: new Date('2026-09-22T12:00:00Z') };
const query = value => ({ session() { return this; }, select() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
function fixture({ order = {}, shipment = {}, failParent = false, failShipment = false } = {}) {
    let rows = { order: { _id: 'order', isPaid: true, mainOrderStatus: 'processing', ...order },
        shipment: { _id: 'shipment', mainOrder: 'order', vendor: 'vendor', fulfillmentMethod: 'delivery', shipmentStatus: 'processing', ...shipment } };
    const counts = { commits: 0, rollbacks: 0, parentWrites: 0, shipmentWrites: 0 };
    const session = {};
    const document = name => {
        const row = structuredClone(rows[name]);
        Object.defineProperties(row, { increment: { value() { this.__v = (this.__v || 0) + 1; } }, save: { value: async function(args) {
            assert.equal(args.session, session);
            if ((name === 'order' && failParent) || (name === 'shipment' && failShipment)) throw new Error('synthetic-write-failure');
            rows[name] = structuredClone(this); counts[name === 'order' ? 'parentWrites' : 'shipmentWrites']++;
        } } });
        return row;
    };
    const MainOrder = { findById: () => query(document('order')) };
    const Shipment = { findById: () => query(document('shipment')), find: () => query([rows.shipment]) };
    let tail = Promise.resolve();
    const connection = { transaction: work => {
        const next = tail.then(async () => { const before = structuredClone(rows);
            try { const result = await work(session); counts.commits++; return result; }
            catch (error) { rows = before; counts.rollbacks++; throw error; }
        }); tail = next.catch(() => {}); return next;
    } };
    const service = createShipmentStatusService({ MainOrder, Shipment, connection, now: () => now });
    return { rows: () => rows, counts, run: extra => service.transition({ shipmentId: 'shipment', actorId: 'vendor', status: 'accepted', ...extra }) };
}

test('preparation denies unpaid, review, closed and invalid-window orders without writes', async () => {
    for (const order of [{ isPaid: false }, { mainOrderStatus: 'pending_payment' }, { mainOrderStatus: 'payment_review' },
        { paymentResult: { fulfillmentStatus: 'needs_attention' } }, { mainOrderStatus: 'cancelled' }, { isDelivered: true },
        { schedule: { ...futureSchedule, state: 'held' } }, { schedule: { ...futureSchedule, endAt: now } }]) {
        const f = fixture({ order }); await assert.rejects(f.run());
        assert.equal(f.counts.shipmentWrites, 0); assert.equal(f.counts.parentWrites, 0);
    }
});
test('vendor ownership is enforced including nullable NaijaGo owners; admin can prepare NaijaGo stock', async () => {
    for (const vendor of [null, 'another-vendor']) await assert.rejects(fixture({ shipment: { vendor } }).run(), { code: 'SHIPMENT_FORBIDDEN' });
    const f = fixture({ shipment: { vendor: null } }); await f.run({ isAdmin: true }); assert.equal(f.rows().shipment.shipmentStatus, 'accepted');
});
test('scheduled preparation may happen early but dispatch and uncoordinated cancellation cannot', async () => {
    const f = fixture({ order: { schedule: futureSchedule } });
    await f.run(); assert.equal(f.rows().shipment.shipmentStatus, 'accepted');
    await assert.rejects(f.run({ status: 'out_for_delivery', isAdmin: true }), { code: 'SCHEDULE_NOT_DUE' });
    await assert.rejects(f.run({ status: 'cancelled', isAdmin: true }), { code: 'SCHEDULE_LOCKED' });
    await assert.rejects(f.run({ status: 'rejected', reason: 'Cannot prepare' }), { code: 'SCHEDULE_LOCKED' });
});
test('duplicate acceptance is idempotent and ready shipments cannot regress', async () => {
    const f = fixture(); const results = await Promise.all([f.run(), f.run()]);
    assert.equal(results.filter(row => row.changed).length, 1); assert.equal(f.counts.shipmentWrites, 1); assert.equal(f.counts.parentWrites, 1);
    await f.run({ status: 'ready_for_pickup' });
    assert.equal(f.rows().order.shipmentStatus, 'ready_for_pickup'); assert.equal(f.rows().order.mainOrderStatus, 'processing');
    await assert.rejects(f.run(), { code: 'STATUS_REGRESSION' });
});
test('a failed parent write rolls back the shipment transition', async () => {
    const f = fixture({ failParent: true }); await assert.rejects(f.run(), /synthetic-write-failure/);
    assert.equal(f.rows().shipment.shipmentStatus, 'processing'); assert.equal(f.counts.commits, 0); assert.equal(f.counts.rollbacks, 1);
});
test('pickup, terminal and in-transit shipments cannot use vendor preparation controls', async () => {
    for (const shipment of [{ fulfillmentMethod: 'pickup' }, ...['cancelled', 'rejected', 'delivered', 'returned', 'picked_up', 'out_for_delivery'].map(shipmentStatus => ({ shipmentStatus }))]) {
        await assert.rejects(fixture({ shipment }).run());
    }
});
test('rejection requires a reason and the existing shipment schema supports that status', async () => {
    const f = fixture(); await assert.rejects(f.run({ status: 'rejected', reason: 'no' }), { code: 'REJECTION_REASON_REQUIRED' });
    await f.run({ status: 'rejected', reason: 'Out of stock' });
    assert.equal(f.rows().shipment.rejectionReason, 'Out of stock');
    assert.ok(ShipmentSchema.path('shipmentStatus').enumValues.includes('rejected'));
});
test('admin controls cannot erase review, reset a paid order, pay out unpaid orders or dispatch early', () => {
    for (const mainOrderStatus of ['payment_review', 'processing']) {
        const order = { isPaid: true, mainOrderStatus, paymentResult: { fulfillmentStatus: 'needs_attention' } };
        for (const status of ['pending_payment', 'processing', 'out_for_delivery', 'completed', 'cancelled']) assert.throws(() => assertAdminStatusChange(order, status, now), { code: 'ORDER_PAYMENT_REVIEW' });
    }
    assert.throws(() => assertAdminStatusChange({ isPaid: true }, 'pending_payment'), { code: 'ORDER_ALREADY_PAID' });
    assert.throws(() => assertAdminStatusChange({ isPaid: false }, 'completed'), { code: 'ORDER_UNPAID' });
    assert.throws(() => assertAdminStatusChange({ isPaid: true, schedule: futureSchedule }, 'out_for_delivery', now), { code: 'SCHEDULE_NOT_DUE' });
    assert.doesNotThrow(() => assertAdminStatusChange({ isPaid: true, mainOrderStatus: 'completed' }, 'completed'));
});
