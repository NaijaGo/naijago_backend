const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Types } = require('mongoose');
const { openIsolatedTestDatabase } = require('../../scripts/lib/openIsolatedTestDatabase');
const { createProductRequestService } = require('../../services/productRequestService');
const { createBackgroundJobService } = require('../../services/backgroundJobService');
const { createRequestNotificationWorker } = require('../../services/productRequestWorkers');
async function settled(promises) {
    const outcomes = await Promise.allSettled(promises);
    const rejected = outcomes.find((result) => result.status === 'rejected'); if (rejected) throw rejected.reason;
    return outcomes.map((result) => result.value);
}
test('isolated Mongo: product request privacy, transactional notifications and preview budgets', {
    skip: !process.env.NAIJAGO_TEST_MONGO_URI, timeout: 180000,
}, async (t) => {
    const { connection, models } = await openIsolatedTestDatabase(t, ['ProductRequest', 'BackgroundJob', 'AiUsageBucket', 'User']);
    const { ProductRequest: Request, BackgroundJob: Job, AiUsageBucket: Usage, User } = models;
    const owner = new Types.ObjectId(), stranger = new Types.ObjectId();
    await User.collection.insertOne({ _id: owner, notifications: [] });
    const now = () => new Date('2100-01-01T12:00:00Z'); // Keeps real TTL expiry away from synthetic quota tests.
    const queue = createBackgroundJobService({ Job, allowedTypes: ['request.preview', 'request.notify'], now });
    const catalog = { hasMatches: async () => false, available: async () => null };
    const env = { PRODUCT_REQUESTS_ENABLED: 'true', BACKGROUND_JOBS_ENABLED: 'true', PRODUCT_REQUEST_PREVIEWS_ENABLED: 'true',
        GEMINI_API_KEY: 'synthetic-test-only', CLOUDINARY_CLOUD_NAME: 'test', CLOUDINARY_API_KEY: 'test', CLOUDINARY_API_SECRET: 'test', GEMINI_PREVIEW_DAILY_LIMIT: '20' };
    const make = (overrides = {}) => createProductRequestService({ Request, Job, Usage, connection, queue, catalog, env, now, ...overrides });
    const service = make();
    const input = { query: 'synthetic unmatched backpack', clientRequestId: crypto.randomUUID(), notes: 'Synthetic test data only' };
    let row;
    await t.test('concurrent draft retries keep one request and cannot cross owners', async () => {
        const rows = await settled(Array.from({ length: 6 }, () => service.create({ owner, input })));
        assert.equal(new Set(rows.map((item) => item.id)).size, 1); row = rows[0];
        assert.equal(await Request.countDocuments({ owner }), 1);
        await assert.rejects(service.get({ requestId: row.id, owner: stranger }), { status: 404 });
        await assert.rejects(service.get({ requestId: row.id, owner: stranger, admin: true }), { status: 404 });
        await assert.rejects(service.create({ owner, input: { ...input, notes: 'Different intent' } }), { status: 409 });
    });
    await t.test('concurrent submit retries keep one state change and one notification job', async () => {
        await settled(Array.from({ length: 5 }, () => service.update({ requestId: row.id, owner, input: { state: 'requested', revision: 0 } })));
        const saved = await Request.findById(row.id).lean();
        assert.equal(saved.state, 'requested'); assert.equal(saved.history.length, 1);
        assert.equal(await Job.countDocuments({ type: 'request.notify' }), 1);
        assert.equal((await service.list({ admin: true })).requests.length, 1);
    });
    await t.test('notification outbox failure rolls back sourcing status and history', async () => {
        const broken = make({ queue: { enqueue: async () => { throw new Error('injected-request-outbox-failure'); } } });
        await assert.rejects(broken.update({ requestId: row.id, owner: stranger, admin: true, input: { state: 'sourcing', message: 'Checking stock', revision: 1 } }), /injected-request-outbox-failure/);
        const saved = await Request.findById(row.id).lean(); assert.equal(saved.state, 'requested'); assert.equal(saved.history.length, 1);
    });
    await t.test('concurrent preview taps reserve one pair of quotas and one generation job', async () => {
        const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => service.generate({ requestId: row.id, owner, input: { revision: 1, aiConsent: true } })));
        for (const result of outcomes) if (result.status === 'rejected') assert.equal(result.reason.status, 409);
        assert.ok(outcomes.some((result) => result.status === 'fulfilled'));
        assert.equal(await Job.countDocuments({ type: 'request.preview' }), 1);
        const quotas = await Usage.find({}).lean(); assert.equal(quotas.length, 2); assert.ok(quotas.every((quota) => quota.used === 1));
        const saved = await Request.findById(row.id).lean(); assert.equal(saved.preview.generation, 1); assert.equal(saved.statusRevision, 1);
    });
    await t.test('concurrent global preview reservations stay within budget and failed attempts roll back', async () => {
        const capped = make({ now: () => new Date('2100-01-02T12:00:00Z'), env: { ...env, GEMINI_PREVIEW_DAILY_LIMIT: '2' } });
        const drafts = await settled(Array.from({ length: 6 }, () => capped.create({ owner: new Types.ObjectId(), input: { ...input, clientRequestId: crypto.randomUUID() } })));
        const owners = await Request.find({ _id: { $in: drafts.map((draft) => draft.id) } }).lean();
        const results = await Promise.allSettled(owners.map((draft) => capped.generate({ requestId: String(draft._id), owner: draft.owner, input: { revision: 0, aiConsent: true } })));
        for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.status, 429);
        const global = await Usage.findById('preview:2100-01-02:global').lean(); assert.ok(global.used <= 2);
        assert.equal(await Request.countDocuments({ _id: { $in: owners.map((draft) => draft._id) }, 'preview.state': 'queued' }), global.used);
        const buckets = await Usage.find({ _id: /^preview:2100-01-02:/ }).lean(); assert.equal(buckets.filter((bucket) => !bucket._id.endsWith(':global')).length, global.used);
    });
    await t.test('real in-app notification retries are unique and preview revisions do not suppress them', async () => {
        const job = await Job.findOne({ type: 'request.notify' }).lean(); const deliveries = [];
        const notify = createRequestNotificationWorker({ Request, User, now, notifications: {
            hasAudienceConfiguration: () => true, getPlatformOptions: () => ({}),
            createNotification: async (_, data) => { deliveries.push(data.idempotency_key); return { body: { id: 'simulated-acceptance' } }; },
        } });
        await settled(Array.from({ length: 4 }, () => notify(job.payload, { job, signal: new AbortController().signal })));
        const user = await User.findById(owner).lean(); assert.equal(user.notifications.length, 1);
        assert.equal(user.notifications[0].relatedModel, 'ProductRequest'); assert.equal(new Set(deliveries).size, 1);
    });
});
