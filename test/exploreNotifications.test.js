const test = require('node:test');
const assert = require('node:assert/strict');
const { createExploreNotificationService } = require('../services/exploreNotificationService');
const now = new Date('2026-09-20T12:00:00Z');
const payload = { recipient: 'vendor1', actor: 'customer1', targetType: 'product', target: 'product1', kind: 'comment', commentId: 'comment1' };
const context = () => ({ job: { _id: 'job1', createdAt: now, deliveryKey: 'a3038044-f7b0-4d52-aea4-73e38ee2a632' }, signal: new AbortController().signal });
function setup(extra = {}) {
    const writes = [];
    const sends = [];
    const notify = createExploreNotificationService({
        User: { findById: () => ({ select: () => ({ lean: async () => ({ isVendor: true }) }) }), updateOne: async (...args) => writes.push(args) },
        UserBlock: { exists: async () => false }, FeedComment: { exists: async () => true },
        explore: { loadTarget: async () => ({ owner: 'vendor1', title: 'Listing' }) },
        notifications: { hasAudienceConfiguration: () => true, getPlatformOptions: () => ({}), createNotification: async (...args) => { sends.push(args); return { body: { id: 'provider1' } }; } },
        now: () => now, ...extra,
    });
    return { notify, writes, sends };
}
test('notification retries use the same in-app ID and OneSignal idempotency key', async () => {
    const { notify, writes, sends } = setup();
    await notify(payload, context()); await notify(payload, context());
    assert.deepEqual(writes[0][0], { _id: 'vendor1', 'notifications._id': { $ne: 'job1' } });
    assert.equal(writes[0][1].$push.notifications.explore.comment, 'comment1');
    assert.equal(sends[0][0], 'vendor');
    assert.equal(sends[0][1].idempotency_key, sends[1][1].idempotency_key);
});
test('blocked interactions do not reach the recipient', async () => {
    const { notify, writes, sends } = setup({ UserBlock: { exists: async () => true } });
    assert.deepEqual(await notify(payload, context()), { skipped: 'blocked' });
    assert.equal(writes.length + sends.length, 0);
});

test('Explore preferences suppress both inbox and push without muting order alerts', async () => {
    const { notify, writes, sends } = setup({ User: {
        findById: () => ({ select: () => ({ lean: async () => ({ isVendor: true, notificationPreferences: { orderUpdates: true, exploreActivity: false } }) }) }),
        updateOne: async () => { throw new Error('preferences must be checked first'); },
    } });
    const result = await notify(payload, context());
    assert.ok(result.skipped);
    assert.equal(writes.length + sends.length, 0);
});
test('missing push configuration preserves in-app notification but flags job failure', async () => {
    const { notify, writes } = setup({ notifications: { hasAudienceConfiguration: () => false } });
    await assert.rejects(notify(payload, context()), { jobCode: 'push_not_configured', retryable: false });
    assert.equal(writes.length, 1);
});
test('deleted comments and stale activity do not send push', async () => {
    const { notify, sends } = setup({ FeedComment: { exists: async () => false } });
    assert.deepEqual(await notify(payload, context()), { skipped: 'removed_comment' });
    const stale = context(); stale.job.createdAt = new Date('2026-09-01');
    assert.deepEqual(await notify(payload, stale), { skipped: 'stale_activity' });
    assert.equal(sends.length, 0);
});
