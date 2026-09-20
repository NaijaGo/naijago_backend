const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { createBackgroundJobService, JobLeaseLostError } = require('../../services/backgroundJobService');
const { createExploreInteractionService } = require('../../services/exploreInteractionService');
const { UGC_POLICY_VERSION } = require('../../utils/explorePolicy');
const { resolveTestDatabase, cleanupTestCollections, supportsTransactions } = require('../../scripts/lib/integrationTestDatabase');

async function settledBatch(tasks) {
    // Drain every request before starting another test or cleaning collections,
    // including when one of the concurrent requests fails early.
    const results = await Promise.allSettled(tasks);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    return results.map((result) => result.value);
}

// Never reuse MONGO_URI. Atlas requires explicit opt-in and a pinned TEST host.
const uri = process.env.NAIJAGO_TEST_MONGO_URI;
test('isolated Mongo: queue claims, leases, transactional Explore retries and rollback', { skip: !uri, timeout: 240000 }, async (t) => {
    const target = resolveTestDatabase({ uri, allowAtlas: process.env.NAIJAGO_ALLOW_ATLAS_TESTS === 'true' });
    let connection;
    try {
        connection = mongoose.createConnection(target.uri, { dbName: target.dbName,
            serverSelectionTimeoutMS: 10000, maxPoolSize: 20, autoCreate: false, autoIndex: false,
            ...(target.kind === 'atlas-test' ? { tls: true } : {}) });
        await connection.asPromise();
    } catch (_) {
        if (connection) await connection.close().catch(() => {});
        throw new Error('Test database connection failed. Check test credentials, current IP access and cluster availability. Do not paste credentials into logs.');
    }
    const owned = [];
    t.after(async () => {
        try {
            await cleanupTestCollections(connection, target, owned);
        } finally { await connection.close(); }
    });
    const hello = await connection.db.admin().command({ hello: 1 });
    assert.ok(supportsTransactions(hello), 'A replica set or sharded test cluster supporting sessions is required');
    console.log(`Isolated test run: ${target.host} / ${target.dbName} / ${target.runId}`);
    const models = {};
    for (const name of ['BackgroundJob', 'FeedReaction', 'FeedComment', 'FeedView']) {
        const source = require(`../../models/${name}`);
        const collection = target.collections[name];
        assert.equal(await connection.db.listCollections({ name: collection }, { nameOnly: true }).hasNext(), false,
            'Refusing to reuse an existing test collection');
        const schema = source.schema.clone(); schema.set('autoCreate', false); schema.set('autoIndex', false);
        models[name] = connection.model(name, schema, collection);
        await models[name].createCollection();
        owned.push(collection);
        await models[name].createIndexes();
    }
    const { BackgroundJob: Job, FeedReaction, FeedComment, FeedView } = models;
    let now = new Date();
    const queue = createBackgroundJobService({ Job, allowedTypes: ['explore.notify'], now: () => now });
    const userId = new mongoose.Types.ObjectId(), owner = new mongoose.Types.ObjectId(), id = String(new mongoose.Types.ObjectId());

    await t.test('concurrent enqueue and claim retain one identity', async () => {
        const jobs = await settledBatch(Array.from({ length: 20 }, () => queue.enqueue({
            type: 'explore.notify', dedupeKey: 'concurrent', owner, payload: { test: true },
        })));
        assert.equal(new Set(jobs.map((job) => String(job._id))).size, 1);
        assert.equal(new Set(jobs.map((job) => job.deliveryKey)).size, 1);
        assert.match(jobs[0].deliveryKey, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        const claims = (await settledBatch(Array.from({ length: 10 }, () => queue.claim()))).filter(Boolean);
        assert.equal(claims.length, 1);
        now = new Date(now.getTime() + queue.leaseMs + 1);
        const next = await queue.claim();
        assert.equal(String(next._id), String(claims[0]._id));
        assert.equal(next.deliveryKey, jobs[0].deliveryKey);
        assert.notEqual(next.lockToken, claims[0].lockToken);
        await assert.rejects(queue.complete(claims[0], {}), JobLeaseLostError);
        await queue.complete(next, { done: true });
    });
    const explore = { loadTarget: async () => ({ targetType: 'product', target: id, owner }),
        blockedUsers: async () => [], statistics: async () => new Map([[`product:${id}`, {}]]) };
    const interactions = createExploreInteractionService({ connection, FeedReaction, FeedComment, FeedView, queue, explore });
    await t.test('concurrent reaction retries keep one reaction and one outbox item', async () => {
        await settledBatch(Array.from({ length: 10 }, () => interactions.react({ type: 'product', id, userId, reaction: 'love' })));
        assert.equal(await FeedReaction.countDocuments({ target: id, user: userId }), 1);
        assert.equal(await Job.countDocuments({ dedupeKey: `reaction:product:${id}:${userId}:love:${owner}` }), 1);
    });
    await t.test('concurrent comment retries keep one comment and one notification', async () => {
        const input = { body: 'Is this available?', clientRequestId: crypto.randomUUID(), policyVersion: UGC_POLICY_VERSION };
        const results = await settledBatch(Array.from({ length: 10 }, () => interactions.addComment({ type: 'product', id, userId, input })));
        assert.equal(new Set(results.map((row) => row.id)).size, 1);
        assert.equal(await FeedComment.countDocuments({ user: userId, clientRequestId: input.clientRequestId }), 1);
        assert.equal(await Job.countDocuments({ dedupeKey: `comment:${results[0].id}:${owner}` }), 1);
    });
    await t.test('outbox failure rolls back the reaction', async () => {
        const otherUser = new mongoose.Types.ObjectId();
        const controlledFailure = new Error('Controlled outbox failure');
        const failed = createExploreInteractionService({ connection, FeedReaction, FeedComment, FeedView, explore,
            queue: { enqueue: async () => { throw controlledFailure; } } });
        await assert.rejects(failed.react({ type: 'product', id, userId: otherUser, reaction: 'like' }),
            (error) => error === controlledFailure);
        assert.equal(await FeedReaction.countDocuments({ user: otherUser, target: id }), 0);
    });
});
