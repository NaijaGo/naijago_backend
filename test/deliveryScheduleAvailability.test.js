'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { coversOpeningHours, watParts, locationResourceKey, resolveScheduleResources } = require('../utils/deliveryScheduleAvailability');
const { createDeliveryScheduleService, createSchedulePolicyReader } = require('../services/deliveryScheduleService');
const { Types } = require('mongoose');
const clock = new Date('2026-09-20T06:00:00Z');
const schedule = { mode: 'scheduled', timeZone: 'Africa/Lagos', startAt: '2026-09-20T12:00:00+01:00', endAt: '2026-09-20T13:00:00+01:00' };
const allHours = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((day) => ({ day, open: '09:00', close: '19:00' }));
function fixture() {
    const destination = { latitude: 9.06, longitude: 7.49 };
    const line = { sellerType: 'vendor', sellerId: new Types.ObjectId('000000000000000000000001'), sellerLocation: { latitude: 9.05, longitude: 7.48 }, sellerVendor: {} };
    const policy = { enabled: true, revision: 1, timeZone: 'Africa/Lagos', minimumLeadMinutes: 60, maximumAdvanceDays: 14,
        dispatchLeadMinutes: 30, changeCutoffMinutes: 60, paymentHoldMinutes: 15,
        areas: [{ key: 'abuja', enabled: true, center: { ...destination }, radiusKm: 20, riderPoolKey: 'abuja_pool' }],
        shops: [{ resourceKey: locationResourceKey(line), enabled: true, deliveryRadiusKm: 10, preparationMinutes: 30, operatingHours: allHours }] };
    return { lines: [line], destination, policy, schedule: { ...schedule }, now: clock };
}
const rejectsCode = (fn, code) => assert.throws(fn, (error) => error.code === code);

test('WAT opening intervals are independent of the server timezone and include preparation', () => {
    assert.deepEqual(watParts('2026-09-19T23:15:00Z'), { day: 'sunday', minutes: 15 });
    const result = resolveScheduleResources(fixture());
    assert.equal(result.times.dispatchAt.toISOString(), '2026-09-20T10:30:00.000Z');
    assert.equal(result.resourceKeys.length, 3);
    const args = fixture(); args.policy.shops[0].operatingHours = [{ day: 'sunday', open: '11:15', close: '19:00' }];
    rejectsCode(() => resolveScheduleResources(args), 'SHOP_CLOSED');
});
test('overnight hours include the previous day, merge adjoining spans, and reject gaps or malformed times', () => {
    const hours = [{ day: 'saturday', open: '22:00', close: '02:00' }];
    assert.equal(coversOpeningHours(hours, '2026-09-20T00:00:00+01:00', '2026-09-20T02:00:00+01:00'), true);
    assert.equal(coversOpeningHours(hours, '2026-09-20T00:00:00+01:00', '2026-09-20T02:01:00+01:00'), false);
    assert.equal(coversOpeningHours([...hours, { day: 'sunday', open: '02:00', close: '08:00' }], '2026-09-20T01:00:00+01:00', '2026-09-20T03:00:00+01:00'), true);
    assert.equal(coversOpeningHours([...hours, { day: 'sunday', open: '02:01', close: '08:00' }], '2026-09-20T01:00:00+01:00', '2026-09-20T03:00:00+01:00'), false);
    for (const invalid of [[], [{ day: 'sunday', open: '24:00', close: '09:00' }], [{ day: 'sunday', open: '00:00', close: '00:00', isClosed: true }]]) {
        assert.equal(coversOpeningHours(invalid, schedule.startAt, schedule.endAt), false);
    }
});
test('closed, missing or ambiguous operational configuration fails closed', () => {
    for (const mutate of [a => { a.policy.enabled = false; }, a => { a.policy = null; }, a => { a.policy.revision = 0; }]) {
        const args = fixture(); mutate(args); rejectsCode(() => resolveScheduleResources(args), 'SCHEDULE_UNAVAILABLE');
    }
    for (const mutate of [a => { a.policy.areas = []; }, a => { a.policy.areas.push({ ...a.policy.areas[0], key: 'overlap' }); }, a => { a.destination.latitude = 0; }]) {
        const args = fixture(); mutate(args); rejectsCode(() => resolveScheduleResources(args), 'SCHEDULE_AREA_UNAVAILABLE');
    }
    for (const mutate of [a => { a.policy.shops = []; }, a => { a.lines[0].sellerVendor.isTemporarilyClosed = true; }]) {
        const args = fixture(); mutate(args); rejectsCode(() => resolveScheduleResources(args), 'SHOP_UNAVAILABLE');
    }
});
test('coverage respects configured radius and does not inherit the legacy 1000km test override', () => {
    const args = fixture(); args.policy.shops[0].deliveryRadiusKm = 0.1;
    rejectsCode(() => resolveScheduleResources(args), 'OUTSIDE_DELIVERY_RADIUS');
    args.lines[0].sellerLocation = { latitude: 6.46, longitude: 3.41 };
    rejectsCode(() => resolveScheduleResources(args), 'SPLIT_ORDER_REQUIRED');
});
test('repeated products share one shop claim; different shops and warehouse locations have distinct identities', () => {
    const args = fixture(); args.lines.push({ ...args.lines[0] });
    assert.equal(resolveScheduleResources(args).resourceKeys.length, 3);
    const platform = { sellerType: 'naijago', sellerId: null, sellerLocation: { latitude: 9.04, longitude: 7.48 } };
    args.lines.push(platform); args.policy.shops.push({ ...args.policy.shops[0], resourceKey: locationResourceKey(platform) });
    assert.equal(resolveScheduleResources(args).resourceKeys.length, 4);
    assert.notEqual(locationResourceKey(platform), locationResourceKey({ ...platform, sellerLocation: { latitude: 9.03, longitude: 7.48 } }));
    rejectsCode(() => locationResourceKey({ ...platform, sellerId: '000000000000000000000001' }), 'SHOP_UNAVAILABLE');
});
test('lead time, bounds, coordinates, timezone and preparation remain mandatory', () => {
    const cases = [
        [a => { a.schedule.startAt = '2026-09-20T07:10:00+01:00'; }, 'WINDOW_UNAVAILABLE'],
        [a => { a.schedule.timeZone = 'UTC'; }, 'INVALID_WINDOW'],
        [a => { a.destination.longitude = '7.49'; }, 'INVALID_ADDRESS'],
        [a => { a.policy.shops[0].preparationMinutes = -1; }, 'SCHEDULE_UNAVAILABLE'],
        [a => { a.policy.shops[0].preparationMinutes = 300; }, 'SHOP_CLOSED'],
    ];
    for (const [mutate, code] of cases) { const args = fixture(); mutate(args); rejectsCode(() => resolveScheduleResources(args), code); }
});
function serviceFixture() {
    const args = fixture(); const sessions = [], filters = [], reservations = [];
    const windows = resolveScheduleResources(args).resourceKeys.map((resourceKey) => ({ _id: new Types.ObjectId(), resourceKey, capacity: 2, used: 0 }));
    const service = createDeliveryScheduleService({ now: () => clock,
        Window: { find(filter) { filters.push(filter); return { sort() { return this; }, session(value) { sessions.push(value); return this; }, async lean() { return windows; } }; } },
        readPolicy: async ({ session }) => { sessions.push(session); return args.policy; },
        reservations: { async reserve(input) { reservations.push(input); return { state: 'held' }; } } });
    return { args, sessions, filters, windows, reservations, service };
}
test('live vendor hours, delivery radius, preparation and last-order cutoff can narrow the operational policy', () => {
    for (const [vendor, code] of [
        [{ deliveryRadiusKm: 0.1 }, 'OUTSIDE_DELIVERY_RADIUS'],
        [{ prepTimeMinutes: 300 }, 'SHOP_CLOSED'],
        [{ operatingHours: [{ day: 'sunday', isOpen: false, openTime: '09:00', closeTime: '19:00' }] }, 'SHOP_CLOSED'],
        [{ operatingHours: [{ day: 'sunday', isOpen: true, openTime: '09:00', closeTime: '19:00', lastOrderTime: '10:59' }] }, 'SHOP_CLOSED'],
    ]) { const args = fixture(); args.lines[0].sellerVendor = vendor; rejectsCode(() => resolveScheduleResources(args), code); }
    const args = fixture(); args.lines[0].sellerVendor = { operatingHours: [{ day: 'sunday', isOpen: true, openTime: '09:00', closeTime: '19:00', lastOrderTime: '18:30' }] };
    assert.equal(resolveScheduleResources(args).resourceKeys.length, 3);
});
test('database availability matches all server-derived resources at exactly one policy revision/window', async () => {
    const f = serviceFixture(), session = { inTransaction: () => true };
    const result = await f.service.check({ ...f.args, session, windowIds: ['forged'], resourceKeys: ['riders:forged'] });
    assert.equal(result.eligible, true); assert.equal(result.schedule.areaKey, 'abuja');
    assert.equal(f.filters[0].policyRevision, 1); assert.equal(f.filters[0].enabled, true);
    assert.deepEqual(f.filters[0].resourceKey.$in, resolveScheduleResources(f.args).resourceKeys);
    assert.deepEqual(f.sessions, [session, session]);
    assert.equal('windowIds' in result, false);
});
test('missing, duplicate, corrupt or full resource windows cannot be advertised as available', async () => {
    for (const [mutate, code] of [
        [f => f.windows.pop(), 'SCHEDULE_UNAVAILABLE'],
        [f => { f.windows[1] = f.windows[0]; }, 'SCHEDULE_UNAVAILABLE'],
        [f => { f.windows[0].used = -1; }, 'SCHEDULE_UNAVAILABLE'],
        [f => { f.windows[0].used = 2; }, 'WINDOW_FULL'],
    ]) { const f = serviceFixture(); mutate(f); await assert.rejects(f.service.check(f.args), e => e.code === code); }
});
test('reservation recomputes authority in the caller transaction and lets the atomic service handle full-window retries', async () => {
    const f = serviceFixture(); const session = { inTransaction: () => true };
    await assert.rejects(f.service.reserve(f.args), e => e.code === 'TRANSACTION_REQUIRED');
    f.windows[0].used = 2;
    assert.deepEqual(await f.service.reserve({ ...f.args, session, orderId: '000000000000000000000002', owner: '000000000000000000000003', windowIds: ['forged'] }), { state: 'held' });
    const call = f.reservations[0]; assert.equal(call.session, session);
    assert.deepEqual(call.windowIds, f.windows.map(row => String(row._id)));
    assert.deepEqual(call.resourceKeys, resolveScheduleResources(f.args).resourceKeys);
    assert.equal(call.policy, f.args.policy);
});

test('stored configuration is optional, strictly validated and read from the transaction session', async () => {
    const AppSetting = require('../models/AppSetting');
    const legacy = new AppSetting({ key: 'unrelated_existing_setting' });
    await legacy.validate(); assert.equal(legacy.scheduledDelivery, undefined);
    const args = fixture();
    const row = new AppSetting({ key: 'scheduled_delivery_program', scheduledDelivery: args.policy });
    await row.validate();
    const calls = [], session = { inTransaction: () => true };
    const read = createSchedulePolicyReader({ findOne(filter) { calls.push(filter); return { select(fields) { calls.push(fields); return this; },
        session(value) { calls.push(value); return this; }, async lean() { return row.toObject(); } }; } });
    assert.equal((await read({ session })).enabled, true);
    assert.deepEqual(calls, [{ key: 'scheduled_delivery_program' }, 'scheduledDelivery', session]);
    row.scheduledDelivery.shops.push(row.scheduledDelivery.shops[0].toObject());
    await assert.rejects(row.validate(), /Shop resource keys must be unique/);
    const missing = new AppSetting({ key: 'scheduled_delivery_program', scheduledDelivery: { enabled: true } });
    await assert.rejects(missing.validate());
});
