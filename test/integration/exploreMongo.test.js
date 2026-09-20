const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { createBackgroundJobService, JobLeaseLostError } = require('../../services/backgroundJobService');
const { createExploreInteractionService } = require('../../services/exploreInteractionService');
const { UGC_POLICY_VERSION } = require('../../utils/explorePolicy');

// Never reuse MONGO_URI. These destructive cleanup operations are allowed only
// in a randomly named test database on an explicitly supplied loopback server.
const uri = process.env.NAIJAGO_TEST_MONGO_URI;
test('isolated Mongo: queue claims, leases, transactional Explore retries and rollback', { skip: !uri, timeout: 90000 }, async (t) => {
    const parsed = new URL(uri);
    assert.equal(parsed.protocol, 'mongodb:');
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'Only loopback Mongo is allowed');
    assert.equal(parsed.username, '');
    assert.equal(parsed.password, '');
    assert.ok(['', '/'].includes(parsed.pathname), 'Do not specify an existing database');
    const dbName = `naijago_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const connection = await mongoose.createConnection(uri, { dbName, serverSelectionTimeoutMS: 5000, maxPoolSize: 20 }).asPromise();
    t.after(async () => {
        try {
            assert.match(connection.name, /^naijago_test_[a-f0-9]{32}$/);
            assert.equal(connection.name, dbName);
            await connection.dropDatabase();
        } finally { await connection.close(); }
    });
    const hello = await connection.db.admin().command({ hello: 1 });
    assert.ok(hello.setName, 'A local replica set is required for transaction tests');
    const models = {};
    for (const name of ['BackgroundJob', 'FeedReaction', 'FeedComment', 'FeedView']) {
        const source = require(`../../models/${name}`);
        models[name] = connection.model(name, source.schema.clone());
    }
    await Promise.all(Object.values(models).map((model) => model.init()));
    const { BackgroundJob: Job, FeedReaction, FeedComment, FeedView } = models;
    let now = new Date();
    const queue = createBackgroundJobService({ Job, allowedTypes: ['explore.notify'], now: () => now });
    const userId = new mongoose.Types.ObjectId(), owner = new mongoose.Types.ObjectId(), id = String(new mongoose.Types.ObjectId());

    await t.test('concurrent enqueue and claim retain one identity', async () => {
        const jobs = await Promise.all(Array.from({ length: 20 }, () => queue.enqueue({
            type: 'explore.notify', dedupeKey: 'concurrent', owner, payload: { test: true },
        })));
        assert.equal(new Set(jobs.map((job) => String(job._id))).size, 1);
        const claims = (await Promise.all(Array.from({ length: 10 }, () => queue.claim()))).filter(Boolean);
        assert.equal(claims.length, 1);
        now = new Date(now.getTime() + queue.leaseMs + 1);
        const next = await queue.claim();
        assert.equal(String(next._id), String(claims[0]._id));
        assert.notEqual(next.lockToken, claims[0].lockToken);
        await assert.rejects(queue.complete(claims[0], {}), JobLeaseLostError);
        await queue.complete(next, { done: true });
    });
    const explore = { loadTarget: async () => ({ targetType: 'product', target: id, owner }),
        blockedUsers: async () => [], statistics: async () => new Map([[`product:${id}`, {}]]) };
    const interactions = createExploreInteractionService({ connection, FeedReaction, FeedComment, FeedView, queue, explore });
    await t.test('concurrent reaction retries keep one reaction and one outbox item', async () => {
        await Promise.all(Array.from({ length: 10 }, () => interactions.react({ type: 'product', id, userId, reaction: 'love' })));
        assert.equal(await FeedReaction.countDocuments({ target: id, user: userId }), 1);
        assert.equal(await Job.countDocuments({ dedupeKey: `reaction:product:${id}:${userId}:love:${owner}` }), 1);
    });
    await t.test('concurrent comment retries keep one comment and one notification', async () => {
        const input = { body: 'Is this available?', clientRequestId: crypto.randomUUID(), policyVersion: UGC_POLICY_VERSION };
        const results = await Promise.all(Array.from({ length: 10 }, () => interactions.addComment({ type: 'product', id, userId, input })));
        assert.equal(new Set(results.map((row) => row.id)).size, 1);
        assert.equal(await FeedComment.countDocuments({ user: userId, clientRequestId: input.clientRequestId }), 1);
        assert.equal(await Job.countDocuments({ dedupeKey: `comment:${results[0].id}:${owner}` }), 1);
    });
    await t.test('outbox failure rolls back the reaction', async () => {
        const otherUser = new mongoose.Types.ObjectId();
        const failed = createExploreInteractionService({ connection, FeedReaction, FeedComment, FeedView, explore,
            queue: { enqueue: async () => { throw new Error('Controlled outbox failure'); } } });
        await assert.rejects(failed.react({ type: 'product', id, userId: otherUser, reaction: 'like' }));
        assert.equal(await FeedReaction.countDocuments({ user: otherUser, target: id }), 0);
    });
});
