const test = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { openIsolatedTestDatabase } = require('../../scripts/lib/openIsolatedTestDatabase');
const { createDeliveryReservationService } = require('../../services/deliveryReservationService');
const { createGroupOrderService } = require('../../services/groupOrderService');
const { createRecurringOrderService } = require('../../services/recurringOrderService');
const { createBackgroundJobService } = require('../../services/backgroundJobService');
const { createDeliveryScheduleService, createSchedulePolicyReader } = require('../../services/deliveryScheduleService');
const { locationResourceKey } = require('../../utils/deliveryScheduleAvailability');
const oid = () => String(new Types.ObjectId());

test('isolated Mongo: delivery reservation, group privacy and recurring occurrence transactions', {
    skip: !process.env.NAIJAGO_TEST_MONGO_URI, timeout: 240000,
}, async (t) => {
    const { connection, models } = await openIsolatedTestDatabase(t,
        ['DeliveryWindow', 'DeliveryReservation', 'GroupOrder', 'RecurringPlan', 'RecurringOccurrence', 'BackgroundJob', 'AppSetting']);
    const { DeliveryWindow: Window, DeliveryReservation: Reservation, GroupOrder: Group, RecurringPlan: Plan, RecurringOccurrence: Occurrence, BackgroundJob: Job } = models;
    let time = new Date('2100-01-01T08:00:00Z'); const now = () => new Date(time);
    const policy = { revision: 1, timeZone: 'Africa/Lagos', minimumLeadMinutes: 120, maximumAdvanceDays: 30,
        dispatchLeadMinutes: 45, changeCutoffMinutes: 60, paymentHoldMinutes: 10 };
    const booking = createDeliveryReservationService({ Window, Reservation, connection, now });
    const queue = createBackgroundJobService({ Job, allowedTypes: ['group.notify', 'recurring.notify'], now });
    const destination = { address: 'Synthetic test address only', city: 'Abuja', postalCode: '900001', country: 'NG', phoneNumber: 'synthetic-only', latitude: 9, longitude: 7 };
    const actor = oid(), seller = oid(), product = oid();
    async function windows(capacity = 1) {
        const suffix = oid();
        return Window.create(['area', 'vendor', 'riders'].map((type) => ({ resourceKey: `${type}:${suffix}`,
            startAt: new Date('2100-01-02T08:00:00Z'), endAt: new Date('2100-01-02T11:00:00Z'), capacity, enabled: true, policyRevision: 1 })));
    }
    const request = (rows, orderId = oid()) => ({ orderId, owner: actor, windowIds: rows.map((row) => String(row._id)), resourceKeys: rows.map((row) => row.resourceKey), policy });
    await t.test('competing bookings cannot oversell any area, vendor or rider capacity', async () => {
        const rows = await windows();
        const results = await Promise.allSettled(Array.from({ length: 5 }, () => booking.reserve(request(rows))));
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'WINDOW_FULL');
        const saved = await Window.find({ _id: { $in: rows.map((row) => row._id) } }).lean();
        assert.ok(saved.every((row) => row.used === 1));
    });
    await t.test('repeated checkout preserves one reservation and no partial resource claim', async () => {
        const rows = await windows(4); const input = request(rows);
        const results = await Promise.allSettled(Array.from({ length: 4 }, () => booking.reserve(input)));
        assert.ok(results.every((result) => result.status === 'fulfilled'));
        assert.equal(await Reservation.countDocuments({ order: input.orderId }), 1);
        assert.ok((await Window.find({ _id: { $in: rows.map((row) => row._id) } })).every((row) => row.used === 1));
        await assert.rejects(booking.reserve({ ...input, owner: oid() }), { code: 'RESERVATION_CHANGED' });
        const fullRows = await windows(); await Window.updateOne({ _id: fullRows[2]._id }, { $set: { used: 1 } });
        await assert.rejects(booking.reserve(request(fullRows)), { code: 'WINDOW_FULL' });
        assert.equal((await Window.findById(fullRows[0]._id)).used, 0); assert.equal((await Window.findById(fullRows[1]._id)).used, 0);
    });
    await t.test('expiry releases once; late payment cannot confirm an expired hold', async () => {
        const rows = await windows(); const input = request(rows); await booking.reserve(input);
        time = new Date('2100-01-01T08:11:00Z');
        await assert.rejects(connection.transaction((session) => booking.confirm({ ...input, session })), { code: 'PAID_SLOT_NEEDS_ATTENTION' });
        await Promise.all([booking.release({ ...input, expiredOnly: true }), booking.release({ ...input, expiredOnly: true })]);
        assert.ok((await Window.find({ _id: { $in: rows.map((row) => row._id) } })).every((row) => row.used === 0));
        assert.equal((await Reservation.findOne({ order: input.orderId })).state, 'expired');
        await assert.rejects(booking.reserve(input), { code: 'RESERVATION_EXPIRED' });
    });
    await t.test('payment transaction rollback restores held state; confirmed capacity does not expire', async () => {
        const rows = await windows(); const input = request(rows); await booking.reserve(input);
        await assert.rejects(connection.transaction(async (session) => {
            await booking.confirm({ ...input, session }); throw new Error('synthetic-settlement-failure');
        }), /synthetic-settlement-failure/);
        assert.equal((await Reservation.findOne({ order: input.orderId })).state, 'held');
        await connection.transaction((session) => booking.confirm({ ...input, session }));
        time = new Date('2100-01-01T08:30:00Z'); await booking.release({ ...input, expiredOnly: true });
        assert.equal((await Reservation.findOne({ order: input.orderId })).state, 'confirmed');
        assert.equal((await Window.findById(rows[0]._id)).used, 1);
    });
    await t.test('stored schedule policy derives real resources, quotes capacity and reserves once under contention', async () => {
        const line = { sellerType: 'vendor', sellerId: new Types.ObjectId(seller), sellerLocation: { latitude: 9.001, longitude: 7.001 }, sellerVendor: {} };
        const shopKey = locationResourceKey(line), areaKey = 'isolated_area', poolKey = 'isolated_pool';
        const configured = { ...policy, enabled: true,
            areas: [{ key: areaKey, enabled: true, center: { latitude: 9, longitude: 7 }, radiusKm: 20, riderPoolKey: poolKey }],
            shops: [{ resourceKey: shopKey, enabled: true, deliveryRadiusKm: 10, preparationMinutes: 30,
                operatingHours: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map(day => ({ day, open: '00:00', close: '00:00' })) }] };
        await models.AppSetting.create({ key: 'scheduled_delivery_program', scheduledDelivery: configured });
        const resources = [`area:${areaKey}`, `riders:${poolKey}`, shopKey];
        const startAt = new Date('2100-01-02T08:00:00Z'), endAt = new Date('2100-01-02T11:00:00Z');
        const rows = await Window.create(resources.map(resourceKey => ({ resourceKey, startAt, endAt, capacity: 1, enabled: true, policyRevision: 1 })));
        const availability = createDeliveryScheduleService({ Window, readPolicy: createSchedulePolicyReader(models.AppSetting), reservations: booking, now });
        const input = { owner: actor, lines: [line, { ...line }], destination, schedule: { mode: 'scheduled', timeZone: 'Africa/Lagos', startAt, endAt },
            windowIds: [oid()], resourceKeys: ['riders:forged'], policy: { enabled: false } };
        assert.equal((await availability.check(input)).eligible, true);
        const results = await Promise.allSettled(Array.from({ length: 4 }, () => {
            const orderId = oid(); return connection.transaction(session => availability.reserve({ ...input, orderId, session }));
        }));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'WINDOW_FULL');
        const held = results.find(result => result.status === 'fulfilled').value;
        assert.equal(held.windowIds.length, 3);
        await connection.transaction(session => availability.reserve({ ...input, orderId: String(held.order), session }));
        assert.ok((await Window.find({ _id: { $in: rows.map(row => row._id) } })).every(row => row.used === 1));
        await assert.rejects(availability.check(input), { code: 'WINDOW_FULL' });
        await booking.release({ orderId: String(held.order), owner: actor });
        const rolledBackOrder = oid();
        await assert.rejects(connection.transaction(async session => {
            await availability.reserve({ ...input, orderId: rolledBackOrder, session });
            throw new Error('synthetic-receipt-failure');
        }), /synthetic-receipt-failure/);
        assert.equal(await Reservation.countDocuments({ order: rolledBackOrder }), 0);
        assert.ok((await Window.find({ _id: { $in: rows.map(row => row._id) } })).every(row => row.used === 0));
        await models.AppSetting.updateOne({ key: 'scheduled_delivery_program' }, { $set: { 'scheduledDelivery.revision': 2 } });
        await assert.rejects(availability.check(input), { code: 'SCHEDULE_UNAVAILABLE' });
    });
    const validateItems = async ({ items }) => ({ fulfillmentKey: `vendor:${seller}`, items });
    const groups = createGroupOrderService({ Group, connection, queue, validateItems, now });
    let group, token;
    await t.test('concurrent joins enforce participant limit and retries cannot duplicate membership', async () => {
        const created = await groups.create({ actor, displayName: 'Synthetic Owner', input: {
            name: 'Synthetic group', sellerType: 'vendor', sellerId: seller, fulfillmentKey: `vendor:${seller}`,
            cutoffAt: '2100-01-01T12:00:00Z', participantLimit: 2, destination, destinationLabel: 'Office reception' } });
        group = created.group; token = created.inviteToken;
        const results = await Promise.allSettled(Array.from({ length: 4 }, () => groups.join({ token, actor: oid(), displayName: 'Synthetic Participant' })));
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'GROUP_FULL');
        const saved = await Group.findById(group.id); const guest = String(saved.members[1].user);
        await groups.join({ token, actor: guest, displayName: 'Retry' });
        assert.equal((await Group.findById(group.id)).members.length, 2);
        const view = await groups.get({ groupId: group.id, actor: guest });
        assert.equal(view.destination, undefined); assert.equal(view.members, undefined); assert.equal(view.orderId, undefined);
        assert.equal(await Job.countDocuments({ type: 'group.notify', 'payload.event': 'participant_joined' }), 1);
    });
    await t.test('group outbox failure rolls back edited items and revision', async () => {
        const saved = await Group.findById(group.id);
        const broken = createGroupOrderService({ Group, connection, validateItems, now,
            queue: { enqueue: async () => { throw new Error('synthetic-group-outbox-failure'); } } });
        await assert.rejects(broken.edit({ groupId: group.id, actor, revision: saved.revision, items: [{ product, quantity: 3 }] }), /synthetic-group-outbox-failure/);
        const result = await Group.findById(group.id); assert.equal(result.revision, saved.revision); assert.equal(result.members[0].items.length, 0);
        await assert.rejects(groups.edit({ groupId: group.id, actor: oid(), revision: saved.revision, items: [] }), { code: 'GROUP_NOT_FOUND' });
    });
    const validateOccurrence = async () => ({ eligible: true, totalKobo: 500000 });
    const validateTemplate = async ({ items }) => ({ items }); // Commercial adapters remain simulated in this isolation gate.
    const recurring = createRecurringOrderService({ Plan, Occurrence, connection, queue, validateOccurrence, validateTemplate, now });
    let plan;
    await t.test('concurrent recurring generation retains one occurrence and one reminder', async () => {
        plan = await recurring.create({ actor, input: { name: 'Synthetic water plan', items: [{ product, quantity: 2 }], destination,
            rule: { timeZone: 'Africa/Lagos', startDate: '2100-01-02', frequency: 'weekly', windowStart: '09:00', windowEnd: '12:00' } } });
        const results = await Promise.allSettled(Array.from({ length: 4 }, () => recurring.generate(String(plan._id))));
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        assert.equal(await Occurrence.countDocuments({ plan: plan._id }), 1);
        assert.equal(await Job.countDocuments({ type: 'recurring.notify' }), 1);
        const row = await Occurrence.findOne({ plan: plan._id });
        assert.equal(row.state, 'awaiting_review'); assert.equal(row.order, null); assert.equal(row.estimatedTotalKobo, 500000);
        assert.equal((await Plan.findById(plan._id)).nextIndex, 1);
    });
    await t.test('recurring outbox failure rolls back generation and advancement', async () => {
        const another = await recurring.create({ actor, input: { name: 'Synthetic rollback plan', items: [{ product, quantity: 1 }], destination,
            rule: { timeZone: 'Africa/Lagos', startDate: '2100-01-02', frequency: 'monthly', windowStart: '09:00', windowEnd: '12:00' } } });
        const broken = createRecurringOrderService({ Plan, Occurrence, connection, validateOccurrence, validateTemplate, now,
            queue: { enqueue: async () => { throw new Error('synthetic-recurring-outbox-failure'); } } });
        await assert.rejects(broken.generate(String(another._id)), /synthetic-recurring-outbox-failure/);
        assert.equal(await Occurrence.countDocuments({ plan: another._id }), 0); assert.equal((await Plan.findById(another._id)).nextIndex, 0);
    });
    await t.test('only owner can skip; pause stops generation; cancellation never charges or creates an order', async () => {
        const row = await Occurrence.findOne({ plan: plan._id });
        await assert.rejects(recurring.editOccurrence({ occurrenceId: String(row._id), actor: oid(), revision: row.revision, action: 'skip' }), { code: 'OCCURRENCE_NOT_FOUND' });
        await recurring.editOccurrence({ occurrenceId: String(row._id), actor, revision: row.revision, action: 'skip' });
        assert.equal((await Occurrence.findById(row._id)).state, 'skipped');
        let current = await Plan.findById(plan._id);
        await recurring.control({ planId: String(plan._id), actor, revision: current.revision, action: 'pause' });
        assert.equal(await recurring.generate(String(plan._id)), null);
        current = await Plan.findById(plan._id);
        await recurring.control({ planId: String(plan._id), actor, revision: current.revision, action: 'cancel' });
        assert.equal((await Plan.findById(plan._id)).state, 'cancelled'); assert.equal((await Occurrence.findById(row._id)).order, null);
    });
});
