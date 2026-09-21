'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { createDeliveryReservationService } = require('../services/deliveryReservationService');
const { createScheduledOrderPaymentService } = require('../services/scheduledOrderPaymentService');
const { reservationSnapshot, scheduleQuoteSnapshot, assertScheduleQuoteUnchanged } = require('../utils/scheduledOrderSnapshot');
const Schedule = require('../models/schemas/OrderSchedule');
const Model = mongoose.model('ScheduledPaymentSchemaTest', new mongoose.Schema({ schedule: { type: Schedule, default: undefined } }));
const ids = ['111111111111111111111111', '222222222222222222222222', '333333333333333333333333', '444444444444444444444444'];

function fixture() {
    const clock = new Date('2030-01-01T08:00:00Z'), session = { inTransaction: () => true };
    const writes = [], queries = [];
    const row = { _id: ids[2], order: ids[0], owner: ids[1], state: 'held', timeZone: 'Africa/Lagos', policyRevision: 1,
        windowIds: [ids[3]], startAt: new Date('2030-01-01T12:00:00Z'), endAt: new Date('2030-01-01T13:00:00Z'),
        dispatchAt: new Date('2030-01-01T11:30:00Z'), changeCutoffAt: new Date('2030-01-01T11:00:00Z'), expiresAt: new Date('2030-01-01T08:15:00Z'),
        async save(args) { assert.equal(args.session, session); writes.push(this.state); return this; } };
    let stored = row;
    const Reservation = { findOne(filter) { queries.push(filter); return { session(value) { assert.equal(value, session); return this; },
        then(resolve, reject) { return Promise.resolve(stored).then(resolve, reject); } }; } };
    const Window = { async updateOne(filter, update, args) { assert.equal(args.session, session); writes.push('release-capacity'); return { modifiedCount: 1 }; } };
    const reservations = createDeliveryReservationService({ Window, Reservation, now: () => clock });
    const service = createScheduledOrderPaymentService({ Reservation, reservations, now: () => clock });
    const order = { _id: ids[0], user: ids[1], isPaid: false, mainOrderStatus: 'pending_payment', schedule: reservationSnapshot(row, 'central') };
    return { order, row, clock, session, writes, queries, service, remove() { stored = null; } };
}

test('schedule approval compares equivalent instants and rejects changed policy, location or times', () => {
    const f = fixture(), schedule = f.order.schedule;
    const equivalent = { ...schedule, startAt: '2030-01-01T13:00:00+01:00' };
    assert.deepEqual(scheduleQuoteSnapshot(schedule), scheduleQuoteSnapshot(equivalent));
    for (const change of [{ policyRevision: 2 }, { areaKey: 'other' }, { dispatchAt: '2030-01-01T11:00:00Z' }, { mode: 'now' }]) {
        assert.throws(() => assertScheduleQuoteUnchanged(schedule, { ...schedule, ...change }), { code: 'SCHEDULE_CHANGED' });
    }
});

test('legacy orders have no default schedule; real schedule schema rejects inconsistent cutoffs', async () => {
    const f = fixture();
    assert.equal(new Model().schedule, undefined);
    await new Model({ schedule: f.order.schedule }).validate();
    await assert.rejects(new Model({ schedule: { ...f.order.schedule, changeCutoffAt: '2030-01-01T12:00:00Z' } }).validate());
    await assert.rejects(new Model({ schedule: { ...f.order.schedule, state: 'confirmed' } }).validate());
});

test('immediate checkout retains its path and cannot pay a cancelled or already paid order', async () => {
    const f = fixture(); delete f.order.schedule;
    assert.equal(await f.service.inspect(f.order), null);
    assert.equal(await f.service.confirm(f.order, f.session), null);
    assert.equal(f.queries.length, 0);
    f.order.mainOrderStatus = 'cancelled';
    await assert.rejects(f.service.inspect(f.order), { code: 'ORDER_NOT_PAYABLE' });
    f.order.mainOrderStatus = 'pending_payment'; f.order.isPaid = true;
    await assert.rejects(f.service.inspect(f.order), { code: 'ORDER_NOT_PAYABLE' });
});

test('valid payment confirms the real reservation service in the caller transaction', async () => {
    const f = fixture();
    await f.service.confirm(f.order, f.session);
    assert.deepEqual(f.writes, ['confirmed']);
    assert.equal(f.row.state, 'confirmed'); assert.equal(f.order.schedule.state, 'confirmed');
    assert.equal(+f.order.schedule.confirmedAt, +f.clock);
    assert.ok(f.queries.every((query) => query.order === ids[0] && query.owner === ids[1]));
    await new Model({ schedule: f.order.schedule }).validate();
});

test('wallet/payment intent checks reject expired reservations before any state mutation', async () => {
    const f = fixture(); f.clock.setTime(+f.row.expiresAt);
    await assert.rejects(f.service.inspect(f.order), { code: 'RESERVATION_EXPIRED' });
    await assert.rejects(f.service.confirm(f.order, f.session), { code: 'RESERVATION_EXPIRED' });
    assert.deepEqual(f.writes, []); assert.equal(f.order.isPaid, false); assert.equal(f.row.state, 'held');
});

test('late verified gateway payment enters review and releases expired capacity exactly once', async () => {
    const f = fixture(); f.clock.setTime(+f.row.expiresAt);
    let failure;
    try { await f.service.confirm(f.order, f.session); } catch (error) { failure = error; }
    f.order.isPaid = true; f.order.paymentResult = { tx_ref: 'synthetic-ref', verifiedAt: f.clock, provider: 'squad' };
    await f.service.markVerifiedReview({ order: f.order, error: failure, session: f.session });
    assert.equal(f.order.mainOrderStatus, 'payment_review'); assert.equal(f.order.schedule.state, 'needs_attention');
    assert.equal(f.order.paymentResult.fulfillmentStatus, 'needs_attention');
    assert.equal(f.row.state, 'expired'); assert.deepEqual(f.writes, ['release-capacity', 'expired']);
    await f.service.markVerifiedReview({ order: f.order, error: failure, session: f.session });
    assert.deepEqual(f.writes, ['release-capacity', 'expired']);
    await new Model({ schedule: f.order.schedule }).validate();
});

test('missing or mismatched reservation cannot confirm payment or release another booking', async () => {
    for (const field of ['_id', 'owner', 'order', 'policyRevision', 'startAt']) {
        const f = fixture(); f.row[field] = field === 'policyRevision' ? 2 : field === 'startAt' ? new Date('2030-01-02T12:00:00Z') : ids[3];
        await assert.rejects(f.service.confirm(f.order, f.session), { code: 'RESERVATION_CHANGED' });
        assert.deepEqual(f.writes, []);
    }
    const f = fixture(); f.remove();
    await assert.rejects(f.service.confirm(f.order, f.session), { code: 'RESERVATION_NOT_FOUND' });
});

test('settlement and review cannot run outside a transaction or fake a verified payment', async () => {
    const f = fixture();
    await assert.rejects(f.service.confirm(f.order, null), { code: 'TRANSACTION_REQUIRED' });
    await assert.rejects(f.service.markVerifiedReview({ order: f.order, error: { code: 'RESERVATION_EXPIRED' }, session: f.session }), { code: 'VERIFIED_PAYMENT_REQUIRED' });
    f.order.isPaid = true; f.order.paymentResult = { tx_ref: 'synthetic-ref', verifiedAt: f.clock };
    const error = new Error('synthetic-database-failure');
    await assert.rejects(f.service.markVerifiedReview({ order: f.order, error, session: f.session }), error);
    assert.deepEqual(f.writes, []);
});
