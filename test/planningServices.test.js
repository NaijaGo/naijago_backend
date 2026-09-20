const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { createDeliveryReservationService } = require('../services/deliveryReservationService');
const { createGroupOrderService } = require('../services/groupOrderService');
const { createRecurringOrderService } = require('../services/recurringOrderService');
const names = ['DeliveryWindow', 'DeliveryReservation', 'GroupOrder', 'RecurringPlan', 'RecurringOccurrence'];
const owner = '000000000000000000000001', guest = '000000000000000000000002', seller = '000000000000000000000003', product = '000000000000000000000004';
const clone = (value) => JSON.parse(JSON.stringify(value));
const eq = (a, b) => String(a) === String(b);
function match(row, filter) {
    return Object.entries(filter).every(([key, value]) => {
        if (key === '$expr') return row.used < row.capacity;
        if (key === '$or') return value.some((part) => match(row, part));
        const actual = key.split('.').reduce((result, part) => result?.[part], row);
        if (value && typeof value === 'object' && !value._bsontype && !(value instanceof Date)) {
            return Object.entries(value).every(([op, arg]) => {
                const x = arg instanceof Date ? new Date(actual).getTime() : actual;
                const y = arg instanceof Date ? arg.getTime() : arg;
                if (op === '$in') return arg.some((entry) => eq(actual, entry));
                if (op === '$gte') return x >= y;
                if (op === '$lte') return x <= y;
                if (op === '$ne') return !eq(actual, arg);
                throw new Error(`Unsupported fake query operator: ${op}`);
            });
        }
        return eq(actual, value);
    });
}
function fixture(t) {
    let records = Object.fromEntries(names.map((name) => [name, []])); let jobs = [];
    let clock = new Date('2100-01-01T08:00:00Z'); const now = () => new Date(clock);
    const models = Object.fromEntries(names.map((name) => [name, require('../models/' + name)]));
    const session = { inTransaction: () => true };
    // Fake rollback tests service orchestration only, not Mongo races/locking.
    const connection = { transaction: async (fn) => {
        const before = clone(records), oldJobs = clone(jobs);
        try { return await fn(session); } catch (error) { records = before; jobs = oldJobs; throw error; }
    } };
    const query = (fn) => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, session() { return this; },
        lean() { return Promise.resolve(fn()).then((value) => Array.isArray(value) ? value.map((row) => row.toObject()) : value?.toObject()); },
        then(resolve, reject) { return Promise.resolve().then(fn).then(resolve, reject); } });
    for (const [name, Model] of Object.entries(models)) {
        const find = (filter) => records[name].filter((row) => match(row, filter)).map((row) => Model.hydrate(clone(row)));
        t.mock.method(Model, 'find', (filter) => query(() => find(filter)));
        t.mock.method(Model, 'findOne', (filter) => query(() => find(filter)[0] || null));
        t.mock.method(Model, 'findById', (id) => query(() => find({ _id: id })[0] || null));
        t.mock.method(Model.prototype, 'save', async function(options) {
            assert.equal(options.session, session); await this.validate();
            const value = clone(this.toObject()); const index = records[name].findIndex((row) => eq(row._id, this._id));
            if (index < 0) records[name].push(value); else records[name][index] = value;
            return this;
        });
        t.mock.method(Model, 'create', async (values, options) => {
            const result = []; for (const value of values) { const row = new Model(value); await row.save(options); result.push(row); } return result;
        });
        t.mock.method(Model, 'updateOne', async (filter, update, options) => {
            assert.equal(options.session, session); const row = records[name].find((value) => match(value, filter));
            if (!row) return { modifiedCount: 0 };
            for (const [key, increment] of Object.entries(update.$inc || {})) row[key] += increment;
            return { modifiedCount: 1 };
        });
    }
    const queue = { enqueue: async (job, options) => { assert.equal(options.session, session); jobs.push(clone(job)); return { _id: new mongoose.Types.ObjectId() }; } };
    const destination = { address: 'Private synthetic address', city: 'Abuja', postalCode: '900001', country: 'NG', phoneNumber: 'private-phone', latitude: 9, longitude: 7 };
    const validateItems = async () => ({ fulfillmentKey: `vendor:${seller}` });
    const validateOccurrence = async () => ({ eligible: true, totalKobo: 500000 });
    const groups = createGroupOrderService({ Group: models.GroupOrder, connection, queue, validateItems, now });
    const recurringArgs = { Plan: models.RecurringPlan, Occurrence: models.RecurringOccurrence, connection, queue, validateOccurrence, now };
    const recurring = createRecurringOrderService(recurringArgs);
    const booking = createDeliveryReservationService({ Window: models.DeliveryWindow, Reservation: models.DeliveryReservation, connection, now });
    const createGroup = () => groups.create({ actor: owner, displayName: 'Owner', input: { name: 'Synthetic group', sellerType: 'vendor', sellerId: seller,
        fulfillmentKey: `vendor:${seller}`, cutoffAt: '2100-01-01T12:00:00Z', destinationLabel: 'Office', destination } });
    const createPlan = () => recurring.create({ actor: owner, input: { name: 'Synthetic plan', items: [{ product, quantity: 2 }], destination,
        rule: { timeZone: 'Africa/Lagos', startDate: '2100-01-02', frequency: 'weekly', windowStart: '09:00', windowEnd: '12:00' } } });
    const reserveInput = async (capacity = 1) => {
        const windows = await models.DeliveryWindow.create(['area:abuja', `vendor:${seller}`, 'riders:abuja'].map((resourceKey) => ({
            resourceKey, startAt: new Date('2100-01-02T08:00:00Z'), endAt: new Date('2100-01-02T11:00:00Z'), capacity, enabled: true, policyRevision: 1,
        })), { session });
        return { orderId: String(new mongoose.Types.ObjectId()), owner, windowIds: windows.map((row) => String(row._id)), resourceKeys: windows.map((row) => row.resourceKey),
            policy: { revision: 1, timeZone: 'Africa/Lagos', minimumLeadMinutes: 120, maximumAdvanceDays: 30, dispatchLeadMinutes: 45, changeCutoffMinutes: 60, paymentHoldMinutes: 10 } };
    };
    return { models, connection, queue, now, session, groups, booking, recurring, recurringArgs, createGroup, createPlan, reserveInput,
        setTime: (value) => { clock = new Date(value); }, records: (name) => records[name], jobs: () => jobs };
}

test('booking service reuses a matching held reservation and rejects changed owner/resources', async (t) => {
    const f = fixture(t), input = await f.reserveInput();
    const first = await f.booking.reserve(input), again = await f.booking.reserve(input);
    assert.equal(String(first._id), String(again._id)); assert.equal(f.records('DeliveryReservation').length, 1);
    assert.ok(f.records('DeliveryWindow').every((row) => row.used === 1));
    await assert.rejects(f.booking.reserve({ ...input, owner: guest }), { code: 'RESERVATION_CHANGED' });
    await assert.rejects(f.booking.reserve({ ...input, resourceKeys: ['area:forged'] }), { code: 'INVALID_RESOURCES' });
});
test('booking transaction orchestration rolls back partially claimed resources', async (t) => {
    const f = fixture(t), input = await f.reserveInput(); f.records('DeliveryWindow')[2].used = 1;
    await assert.rejects(f.booking.reserve(input), { code: 'WINDOW_FULL' });
    assert.deepEqual(f.records('DeliveryWindow').map((row) => row.used), [0, 0, 1]);
    assert.equal(f.records('DeliveryReservation').length, 0);
});
test('booking requires settlement session; expiry returns counters exactly once', async (t) => {
    const f = fixture(t), input = await f.reserveInput(); await f.booking.reserve(input);
    await assert.rejects(f.booking.confirm(input), { code: 'TRANSACTION_REQUIRED' });
    f.setTime('2100-01-01T08:11:00Z');
    await assert.rejects(f.connection.transaction((session) => f.booking.confirm({ ...input, session })), { code: 'PAID_SLOT_NEEDS_ATTENTION' });
    await f.booking.release({ ...input, expiredOnly: true }); await f.booking.release({ ...input, expiredOnly: true });
    assert.ok(f.records('DeliveryWindow').every((row) => row.used === 0)); assert.equal(f.records('DeliveryReservation')[0].state, 'expired');
});
test('group service keeps participant data private and rejects stale or unauthorized edits', async (t) => {
    const f = fixture(t), created = await f.createGroup(); const groupId = created.group.id;
    const joined = await f.groups.join({ token: created.inviteToken, actor: guest, displayName: 'Guest' });
    assert.equal(joined.destination, undefined); assert.equal(joined.members, undefined);
    await assert.rejects(f.groups.edit({ groupId, actor: owner, revision: 0, items: [{ product, quantity: 1 }] }), { code: 'GROUP_CHANGED' });
    await assert.rejects(f.groups.control({ groupId, actor: guest, revision: joined.revision, action: 'close' }), { code: 'OWNER_REQUIRED' });
    const saved = await f.groups.edit({ groupId, actor: guest, revision: joined.revision, items: [{ product, quantity: 2, price: 1 }] });
    assert.equal(saved.own.items[0].price, undefined); assert.equal(saved.own.items[0].quantity, 2);
});
test('group outbox failure rolls back revision and submitted items', async (t) => {
    const f = fixture(t), created = await f.createGroup(); const before = clone(f.records('GroupOrder'));
    f.queue.enqueue = async () => { throw new Error('synthetic-outbox-failure'); };
    await assert.rejects(f.groups.edit({ groupId: created.group.id, actor: owner, revision: created.group.revision, items: [{ product, quantity: 1 }] }), /synthetic-outbox-failure/);
    assert.deepEqual(f.records('GroupOrder'), before);
});
test('group closes before owner checkout and repeated checkout reuses one order adapter result', async (t) => {
    const f = fixture(t), created = await f.createGroup(); const groupId = created.group.id;
    let current = await f.groups.edit({ groupId, actor: owner, revision: created.group.revision, items: [{ product, quantity: 1 }] });
    let calls = 0; const createOrder = async () => { calls++; return { _id: product, user: owner }; };
    await assert.rejects(f.connection.transaction((session) => f.groups.checkout({ groupId, actor: owner, revision: current.revision, session, createOrder })), { code: 'GROUP_NOT_CLOSED' });
    current = await f.groups.control({ groupId, actor: owner, revision: current.revision, action: 'close' });
    const first = await f.connection.transaction((session) => f.groups.checkout({ groupId, actor: owner, revision: current.revision, session, createOrder }));
    const retry = await f.connection.transaction((session) => f.groups.checkout({ groupId, actor: owner, revision: current.revision, session, createOrder }));
    assert.equal(first.orderId, retry.orderId); assert.equal(calls, 1); assert.equal(retry.reused, true);
});
test('recurring generation creates one awaiting-payment occurrence, no order, and one reminder', async (t) => {
    const f = fixture(t), plan = await f.createPlan();
    await f.recurring.generate(String(plan._id)); await f.recurring.generate(String(plan._id));
    assert.equal(f.records('RecurringOccurrence').length, 1); assert.equal(f.jobs().length, 1);
    assert.equal(f.records('RecurringOccurrence')[0].state, 'awaiting_review'); assert.equal(f.records('RecurringOccurrence')[0].order, null);
    assert.equal(f.records('RecurringPlan')[0].nextIndex, 1);
});
test('recurring outbox failure rolls back occurrence and plan advancement', async (t) => {
    const f = fixture(t), plan = await f.createPlan(); const before = clone(f.records('RecurringPlan'));
    f.queue.enqueue = async () => { throw new Error('synthetic-outbox-failure'); };
    await assert.rejects(f.recurring.generate(String(plan._id)), /synthetic-outbox-failure/);
    assert.equal(f.records('RecurringOccurrence').length, 0); assert.deepEqual(f.records('RecurringPlan'), before);
});
test('recurring validation failure needs attention and never creates a confirmed order', async (t) => {
    const f = fixture(t), plan = await f.createPlan();
    const service = createRecurringOrderService({ ...f.recurringArgs, validateOccurrence: async () => ({ eligible: false }) });
    await service.generate(String(plan._id));
    const row = f.records('RecurringOccurrence')[0]; assert.equal(row.state, 'needs_attention'); assert.equal(row.order, null); assert.equal(row.estimatedTotalKobo, null);
});
test('occurrence edits remain private and do not change the repeating template', async (t) => {
    const f = fixture(t), plan = await f.createPlan(); await f.recurring.generate(String(plan._id));
    const row = f.records('RecurringOccurrence')[0];
    await assert.rejects(f.recurring.editOccurrence({ occurrenceId: row._id, actor: guest, revision: row.revision, action: 'skip' }), { code: 'OCCURRENCE_NOT_FOUND' });
    await f.recurring.editOccurrence({ occurrenceId: row._id, actor: owner, revision: row.revision, action: 'edit', input: { items: [{ product, quantity: 5 }] } });
    assert.equal(f.records('RecurringPlan')[0].items[0].quantity, 2); assert.equal(f.records('RecurringOccurrence')[0].items[0].quantity, 5);
    assert.equal(f.records('RecurringOccurrence')[0].state, 'needs_attention');
});
test('pause prevents generation; cancellation leaves paid/checkout-linked occurrences for normal order handling', async (t) => {
    const f = fixture(t), plan = await f.createPlan();
    let current = await f.recurring.control({ planId: String(plan._id), actor: owner, revision: plan.revision, action: 'pause' });
    assert.equal(await f.recurring.generate(String(plan._id)), null);
    current = await f.recurring.control({ planId: String(plan._id), actor: owner, revision: current.revision, action: 'resume' });
    await f.recurring.generate(String(plan._id));
    f.records('RecurringOccurrence')[0].state = 'checkout'; f.records('RecurringOccurrence')[0].order = product;
    current = f.records('RecurringPlan')[0];
    await f.recurring.control({ planId: String(plan._id), actor: owner, revision: current.revision, action: 'cancel' });
    assert.equal(f.records('RecurringOccurrence')[0].state, 'checkout'); assert.equal(f.records('RecurringOccurrence')[0].order, product);
});
