const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const p = require('../utils/orderPlanningPolicy');
const g = require('../utils/groupOrderPolicy');
const r = require('../utils/photoReviewPolicy');
const user = '000000000000000000000001', guest = '000000000000000000000002', product = '000000000000000000000003';
const orderId = '000000000000000000000004';
const rule = { timeZone: 'Africa/Lagos', startDate: '2028-01-31', frequency: 'monthly', windowStart: '09:00', windowEnd: '12:00' };
const now = new Date('2026-09-20T10:00:00Z');
const policy = { revision: 1, timeZone: 'Africa/Lagos', minimumLeadMinutes: 120, maximumAdvanceDays: 30,
    dispatchLeadMinutes: 45, changeCutoffMinutes: 60, paymentHoldMinutes: 10 };
const window = { startAt: '2026-09-21T09:00:00+01:00', endAt: '2026-09-21T12:00:00+01:00', now, policy };

test('WAT conversion is explicit and independent of the process timezone', () => {
    assert.equal(p.watInstant('2026-09-21', '09:00').toISOString(), '2026-09-21T08:00:00.000Z');
    assert.equal(p.watInstant('2026-09-21', '00:00').toISOString(), '2026-09-20T23:00:00.000Z');
});
test('calendar inputs reject date rollover, missing offsets, NaN and impossible times', () => {
    for (const value of ['2026-02-30', '2026-09-31', '2026-9-1', 'anything']) assert.throws(() => p.calendarDate(value));
    for (const value of ['24:00', '23:60', '09:99', '9:00']) assert.throws(() => p.clockMinutes(value));
    for (const value of ['2026-09-20T10:00:00', '2026-02-30T09:00:00Z', '2026-09-20T24:00:00Z', 0, null, new Date(NaN)]) assert.throws(() => p.instant(value));
});
test('monthly recurrence keeps the original calendar anchor across leap and short months', () => {
    assert.deepEqual([0, 1, 2, 3].map((index) => p.occurrenceAt(rule, index).date), ['2028-01-31', '2028-02-29', '2028-03-31', '2028-04-30']);
    assert.equal(p.occurrenceAt({ ...rule, startDate: '2027-01-31' }, 1).date, '2027-02-28');
    assert.equal(p.occurrenceAt(rule, 12).date, '2029-01-31');
});
test('weekly, biweekly and custom intervals respect local dates, bounds and inclusive end date', () => {
    for (const [frequency, intervalDays, expected] of [['weekly', null, '2028-02-07'], ['biweekly', null, '2028-02-14'], ['custom_days', 3, '2028-02-03']]) {
        assert.equal(p.occurrenceAt({ ...rule, frequency, intervalDays }, 1).date, expected);
    }
    assert.equal(p.occurrenceAt({ ...rule, maxOccurrences: 2 }, 2), null);
    assert.equal(p.occurrenceAt({ ...rule, endDate: '2028-02-29' }, 1).date, '2028-02-29');
    assert.equal(p.occurrenceAt({ ...rule, endDate: '2028-02-29' }, 2), null);
    assert.throws(() => p.normalizeRecurrence({ ...rule, frequency: 'custom_days', intervalDays: 0 }));
    assert.throws(() => p.normalizeRecurrence({ ...rule, windowEnd: '08:00' }));
    assert.throws(() => p.normalizeRecurrence({ ...rule, timeZone: 'UTC' }));
});
test('recurrence previews skip past dates without altering the anchor and cannot enable autopay', () => {
    const values = p.upcomingOccurrences(rule, { after: new Date('2028-02-01T00:00:00Z'), limit: 2 });
    assert.deepEqual(values.map((value) => value.date), ['2028-02-29', '2028-03-31']);
    assert.equal(p.normalizeRecurrence(rule).paymentMode, 'reminder_to_pay');
    assert.throws(() => p.normalizeRecurrence({ ...rule, paymentMode: 'auto_pay' }), { code: 'AUTOPAY_UNAVAILABLE' });
});
test('delivery reservation exposes hold, dispatch and change deadlines without exact-time promises', () => {
    const value = p.schedulingTimes(window);
    assert.equal(value.startAt.toISOString(), '2026-09-21T08:00:00.000Z');
    assert.equal(value.dispatchAt.toISOString(), '2026-09-21T07:15:00.000Z');
    assert.equal(value.changeCutoffAt.toISOString(), '2026-09-21T07:00:00.000Z');
    assert.equal(value.expiresAt.toISOString(), '2026-09-20T10:10:00.000Z');
});
test('delivery windows reject too-soon, past, distant, inverted and invalid policy requests', () => {
    assert.throws(() => p.schedulingTimes({ ...window, startAt: '2026-09-20T10:15:00Z' }), { code: 'WINDOW_UNAVAILABLE' });
    assert.throws(() => p.schedulingTimes({ ...window, now: new Date('2026-07-01T00:00:00Z') }));
    assert.throws(() => p.schedulingTimes({ ...window, endAt: '2026-09-20T10:15:00Z' }));
    assert.throws(() => p.schedulingTimes({ ...window, policy: { ...policy, minimumLeadMinutes: -1 } }));
    const value = p.schedulingTimes({ ...window, now: new Date('2026-09-21T05:55:00Z'), policy: { ...policy, changeCutoffMinutes: 120 } });
    assert.equal(value.expiresAt.toISOString(), '2026-09-21T06:00:00.000Z');
});
test('unpaid, unconfirmed, future, missed-window and terminal orders cannot dispatch', () => {
    const order = { isPaid: true, mainOrderStatus: 'processing' };
    assert.equal(p.canDispatch(order, now), true);
    const scheduled = { ...order, schedule: { mode: 'scheduled', state: 'confirmed', ...p.schedulingTimes(window) } };
    assert.equal(p.canDispatch(scheduled, now), false);
    assert.equal(p.canDispatch(scheduled, new Date('2026-09-21T07:15:00Z')), true);
    assert.equal(p.canDispatch(scheduled, new Date('2026-09-21T11:00:00Z')), false);
    for (const state of ['held', 'expired', 'needs_attention']) assert.equal(p.canDispatch({ ...scheduled, schedule: { ...scheduled.schedule, state } }, new Date('2026-09-21T08:00:00Z')), false);
    for (const mainOrderStatus of ['cancelled', 'completed', 'pending_payment', 'delivered']) assert.equal(p.canDispatch({ ...order, mainOrderStatus }, now), false);
    assert.equal(p.canDispatch({ ...order, isPaid: false }, now), false);
});
test('schedule changes stop at the cutoff or after rider assignment', () => {
    const order = { isPaid: true, mainOrderStatus: 'processing', schedule: { mode: 'scheduled', state: 'confirmed', ...p.schedulingTimes(window) } };
    assert.doesNotThrow(() => p.assertScheduleChange(order, now));
    assert.throws(() => p.assertScheduleChange(order, new Date('2026-09-21T07:00:00Z')), { code: 'SCHEDULE_LOCKED' });
    assert.throws(() => p.assertScheduleChange({ ...order, assignedRider: user }, now));
});
function group() { return { _id: orderId, owner: user, name: 'Office lunch', ownerDisplayName: 'Owner',
    state: 'open', revision: 0, cutoffAt: new Date('2026-09-20T12:00:00Z'), destinationLabel: 'Office reception',
    destination: { address: 'Private address', phoneNumber: 'private phone' }, inviteHash: 'private invite hash',
    members: [{ user, displayName: 'Owner', state: 'active', items: [{ product, quantity: 2 }], submittedAt: now },
        { user: guest, displayName: 'Guest', state: 'active', items: [{ product, quantity: 1 }], submittedAt: now }],
    sellerType: 'vendor', sellerId: user, order: orderId }; }
test('group participant DTO does not leak other baskets, private destination, invite or payment linkage', () => {
    const view = g.groupView(group(), guest);
    assert.equal(view.own.items.length, 1); assert.equal(view.own.items[0].quantity, 1);
    for (const field of ['members', 'destination', 'inviteHash', 'owner', 'orderId']) assert.equal(Object.hasOwn(view, field), false);
    assert.ok(!JSON.stringify(view).includes('private'));
    assert.ok(g.groupView(group(), user).destination);
    assert.throws(() => g.groupView(group(), product), { statusCode: 404 });
    const removed = group(); removed.members[1].state = 'removed'; assert.throws(() => g.groupView(removed, guest));
});
test('group controls enforce owner and cutoff, and retain participant attribution for checkout', () => {
    const row = group(); assert.doesNotThrow(() => g.assertOpen(row, now));
    assert.throws(() => g.assertOpen(row, row.cutoffAt), { code: 'GROUP_CLOSED' });
    assert.throws(() => g.closedGroupItems(row, user), { code: 'GROUP_NOT_CLOSED' });
    row.state = 'closed'; assert.equal(g.closedGroupItems(row, user).length, 2);
    assert.throws(() => g.closedGroupItems(row, guest), { code: 'OWNER_REQUIRED' });
    row.members[1].state = 'removed'; assert.equal(g.closedGroupItems(row, user).length, 1);
});
test('group items drop supplied prices and validate quantities, duplicate variants and notes', () => {
    const item = g.normalizeItems([{ product, quantity: 2, price: 1, sellerId: 'forged', customerNote: ' no pepper ' }])[0];
    assert.equal(item.price, undefined); assert.equal(item.sellerId, undefined); assert.equal(item.customerNote, 'no pepper');
    for (const quantity of [0, -1, 100, 1.5, '2', NaN]) assert.throws(() => g.normalizeItems([{ product, quantity }]));
    assert.throws(() => g.normalizeItems([{ product, quantity: 1 }, { product, quantity: 2 }]));
    assert.throws(() => g.normalizeItems([{ product, quantity: 1, customerNote: 'a'.repeat(501) }]));
    assert.throws(() => g.normalizeItems([null]), { code: 'INVALID_ITEMS' });
    assert.throws(() => g.normalizeItems([{ product, quantity: 1, selectedSize: 'XL' }]), { code: 'VARIANT_REQUIRED' });
    assert.equal(g.normalizeItems([{ product, quantity: 1, selectedSize: 'XL', variantId: user }])[0].variantId, user);
});
test('group invites have high entropy and only hashed identity needs storage', () => {
    const a = g.createInvite(), b = g.createInvite(); assert.notEqual(a.token, b.token);
    assert.equal(a.hash.length, 64); assert.equal(a.hash, g.inviteHash(a.token));
    assert.notEqual(a.hash, a.token); assert.throws(() => g.inviteHash('123456'));
});
test('reviews require completed shipment and paid ownership; verified pickup is accepted', () => {
    const order = { _id: orderId, user, isPaid: true, mainOrderStatus: 'processing' };
    const shipment = { mainOrder: orderId, shipmentStatus: 'delivered', items: [{ product }] };
    const input = { order, shipment, actor: user, productId: product };
    assert.equal(r.isVerifiedPurchase(input), true);
    for (const shipmentStatus of ['processing', 'accepted', 'out_for_delivery', 'cancelled', 'returned']) assert.equal(r.isVerifiedPurchase({ ...input, shipment: { ...shipment, shipmentStatus } }), false);
    assert.equal(r.isVerifiedPurchase({ ...input, actor: guest }), false);
    assert.equal(r.isVerifiedPurchase({ ...input, order: { ...order, isPaid: false } }), false);
    assert.equal(r.isVerifiedPurchase({ ...input, shipment: { ...shipment, shipmentStatus: 'picked_up', fulfillmentMethod: 'pickup', pickupDetails: { verifiedAt: now } } }), true);
    assert.equal(r.isVerifiedPurchase({ ...input, shipment: { ...shipment, shipmentStatus: 'picked_up', fulfillmentMethod: 'pickup' } }), false);
});
test('review content allows optional text but never URLs, fractional stars, duplicates or excess photos', () => {
    assert.throws(() => r.normalizeReview(null), { code: 'INVALID_REVIEW' });
    assert.equal(r.normalizeReview({ productId: product, rating: 5 }).comment, '');
    assert.throws(() => r.normalizeReview({ productId: product, rating: 4.5 }));
    assert.throws(() => r.normalizeReview({ productId: product, rating: 4, photos: ['https://example.invalid/photo.png'] }));
    assert.throws(() => r.normalizeReview({ productId: product, rating: 4, photos: [user, user] }));
    assert.throws(() => r.normalizeReview({ productId: product, rating: 4, photos: Array(6).fill(user) }));
});
test('photo byte gate recognizes JPEG, PNG and HEIC and rejects unsupported or oversized data', () => {
    assert.equal(r.photoFormat(Buffer.from([255, 216, 255, 224])), 'jpeg');
    assert.equal(r.photoFormat(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'png');
    const heic = Buffer.alloc(24); heic.writeUInt32BE(24, 0); heic.write('ftyp', 4); heic.write('heic', 8); heic.write('mif1', 16);
    assert.equal(r.photoFormat(heic), 'heic'); heic.write('avif', 8); assert.throws(() => r.photoFormat(heic));
    assert.throws(() => r.photoFormat(Buffer.from('<svg></svg>')));
    assert.throws(() => r.photoFormat(Buffer.alloc(r.MAX_BYTES + 1)));
    // Recognition is not decode, sanitization or EXIF-stripping acceptance.
});
test('new planning schemas validate safely without connecting or changing existing order models', async () => {
    const Window = require('../models/DeliveryWindow'); const Group = require('../models/GroupOrder');
    const Plan = require('../models/RecurringPlan'); const Reservation = require('../models/DeliveryReservation');
    require('../models/RecurringOccurrence');
    assert.equal(mongoose.connection.readyState, 0);
    await assert.rejects(new Window({ resourceKey: 'vendor:test', startAt: now, endAt: now, capacity: 1, used: 2, policyRevision: 1 }).validate());
    const destination = { address: 'Synthetic only', city: 'Abuja', postalCode: '900001', country: 'NG', phoneNumber: 'synthetic', latitude: 9, longitude: 7 };
    const row = new Group({ ...group(), fulfillmentKey: 'vendor:test', inviteHash: 'x'.repeat(64), destination, participantLimit: 2 });
    await row.validate(); row.members.push({ user: guest, displayName: 'Duplicate', state: 'active' }); await assert.rejects(row.validate());
    const plan = new Plan({ owner: user, name: 'Synthetic plan', items: [{ product, quantity: 1 }], destination, rule, nextGenerateAt: now });
    await plan.validate(); plan.rule.paymentMode = 'auto_pay'; await assert.rejects(plan.validate());
    assert.ok(Reservation.schema.indexes().some(([keys, opts]) => keys.order && opts.unique));
    assert.ok(!Reservation.schema.indexes().some(([, opts]) => Object.hasOwn(opts, 'expireAfterSeconds')));
});
