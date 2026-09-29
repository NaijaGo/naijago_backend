const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlanningNotificationService } = require('../services/planningNotificationService');

const owner = '000000000000000000000001';
const member = '000000000000000000000002';
const removed = '000000000000000000000003';
const recordId = '000000000000000000000004';
const jobId = '000000000000000000000005';
const planId = '000000000000000000000006';

function model(row) {
    return {
        findById(id) {
            assert.equal(id, recordId);
            return { select() { return this; }, lean: async () => row };
        },
    };
}

function fixture({ configured = false, row } = {}) {
    const updates = [], pushes = [];
    const group = row === undefined ? {
        owner,
        revision: 2,
        state: 'open',
        members: [
            { user: owner, state: 'active' },
            { user: member, state: 'active' },
            { user: removed, state: 'removed' },
        ],
    } : row;
    const handler = createPlanningNotificationService({
        Group: model(group),
        Occurrence: model(row === undefined ? { owner, plan: planId, revision: 2, state: 'awaiting_review' } : row),
        User: { async updateMany(filter, update) { updates.push({ filter, update }); } },
        notifications: {
            hasAudienceConfiguration: () => configured,
            getPlatformOptions: () => ({ android_channel_id: 'test-channel' }),
            async createNotification(audience, notification) {
                pushes.push({ audience, notification });
                return { body: { id: 'provider-id' } };
            },
        },
        now: () => new Date('2026-09-29T12:00:00Z'),
    });
    return { handler, updates, pushes };
}

test('group notifications reach active members in-app without requiring push configuration', async () => {
    const f = fixture();
    const result = await f.handler(
        { groupId: recordId, event: 'participant_joined' },
        { job: { _id: jobId, type: 'group.notify', deliveryKey: 'delivery-key' }, signal: new AbortController().signal },
    );
    assert.deepEqual(result, { inApp: true, pushSkipped: 'not_configured', recipients: 2 });
    assert.deepEqual(f.updates[0].filter._id.$in, [owner, member]);
    assert.equal(f.updates[0].update.$push.notifications.relatedModel, 'GroupOrder');
    assert.deepEqual(f.updates[0].update.$push.notifications.plannedOrder, {
        kind: 'group', id: recordId,
    });
    assert.equal(f.pushes.length, 0);
});

test('recurring notification uses one idempotent push and safe navigation identity', async () => {
    const f = fixture({ configured: true, row: { owner, plan: planId, revision: 1, state: 'awaiting_review' } });
    const result = await f.handler(
        { occurrenceId: recordId, event: 'occurrence_generated' },
        { job: { _id: jobId, type: 'recurring.notify', deliveryKey: 'delivery-key' }, signal: new AbortController().signal },
    );
    assert.equal(result.pushAccepted, true);
    assert.equal(f.updates[0].update.$push.notifications.relatedModel, 'RecurringOccurrence');
    assert.deepEqual(f.updates[0].update.$push.notifications.plannedOrder, {
        kind: 'recurring', id: planId,
    });
    assert.deepEqual(f.pushes[0].notification.include_aliases.external_id, [owner]);
    assert.equal(f.pushes[0].notification.idempotency_key, 'delivery-key');
    assert.deepEqual(f.pushes[0].notification.data, {
        type: 'recurring_order_update',
        recordId,
        planId,
    });
});

test('removed records complete safely without notifying stale recipients', async () => {
    const f = fixture({ row: null });
    const result = await f.handler(
        { groupId: recordId, event: 'group_closed' },
        { job: { _id: jobId, type: 'group.notify' }, signal: new AbortController().signal },
    );
    assert.deepEqual(result, { skipped: 'record_unavailable' });
    assert.equal(f.updates.length, 0);
});
