const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackgroundJobService, createJobRunner, boundedJson, retryDelayMs, providerRetryMs, retryable,
    JobConflictError, JobLeaseLostError } = require('../services/backgroundJobService');
const BackgroundJob = require('../models/BackgroundJob');

test('provider Retry-After seconds and dates are honored without accepting invalid delays', () => {
    const date = new Date('2026-09-20T12:00:00Z');
    const error = (value) => ({ response: { headers: { 'retry-after': value } } });
    assert.equal(providerRetryMs(error('120'), date), 120000);
    assert.equal(providerRetryMs(error('Sun, 20 Sep 2026 12:05:00 GMT'), date), 300000);
    assert.equal(providerRetryMs(error('invalid'), date), 0);
    assert.equal(providerRetryMs(error('-10'), date), 0);
});

test('job data is canonical, bounded JSON and schema rejects invalid states', async () => {
    assert.deepEqual(boundedJson({ b: 2, a: 1 }, 100), { a: 1, b: 2 });
    assert.throws(() => boundedJson({ value: Infinity }, 100));
    assert.throws(() => boundedJson({ value: 'x'.repeat(100) }, 30));
    const job = new BackgroundJob({ type: 'media.cleanup', dedupeKey: 'a', payload: {}, payloadHash: 'hash', runAt: new Date(), state: 'published' });
    await assert.rejects(job.validate(), /state/);
});
test('repeated enqueue preserves job identity and rejects changed payload or owner', async () => {
    let saved;
    const Job = { findOneAndUpdate: async (_query, update) => saved ||= { _id: 'job1', ...update.$setOnInsert } };
    const queue = createBackgroundJobService({ Job, allowedTypes: ['media.cleanup'] });
    const input = { type: 'media.cleanup', dedupeKey: 'asset1', owner: 'owner1', payload: { assetId: '1' } };
    assert.equal((await queue.enqueue(input))._id, (await queue.enqueue(input))._id);
    await assert.rejects(queue.enqueue({ ...input, payload: { assetId: '2' } }), JobConflictError);
    await assert.rejects(queue.enqueue({ ...input, owner: 'owner2' }), JobConflictError);
    await assert.rejects(queue.enqueue({ ...input, type: 'arbitrary' }));
});
test('claim is a single conditional write with lease and attempt bounds', async () => {
    const date = new Date('2026-09-20T10:00:00Z');
    let claim;
    let exhausted;
    const Job = {
        updateMany: async (filter, update) => { exhausted = { filter, update }; },
        findOneAndUpdate: async (filter, update, options) => { claim = { filter, update, options }; return null; },
    };
    const queue = createBackgroundJobService({ Job, allowedTypes: ['media.cleanup'], now: () => date, token: () => 'lease1' });
    await queue.claim();
    assert.deepEqual(claim.filter.$expr, { $lt: ['$attempts', '$maxAttempts'] });
    assert.equal(claim.update.$inc.attempts, 1);
    assert.equal(claim.update.$set.lockToken, 'lease1');
    assert.equal(claim.update.$set.leaseUntil.getTime(), date.getTime() + 180000);
    assert.equal(claim.options.new, true);
    assert.equal(exhausted.update.$set.state, 'failed');
    assert.equal(claim.filter.$or[1].state, 'running');
});
test('completion cannot acknowledge a lease owned by another worker', async () => {
    let filter;
    const queue = createBackgroundJobService({ allowedTypes: ['media.cleanup'], Job: {
        updateOne: async (query) => { filter = query; return { matchedCount: 0 }; },
    } });
    await assert.rejects(queue.complete({ _id: 'job1', lockToken: 'old' }, { done: true }), JobLeaseLostError);
    assert.equal(filter.state, 'running');
    assert.equal(filter.lockToken, 'old');
    assert.ok(filter.leaseUntil.$gt instanceof Date);
});
test('failure sanitizes provider secrets and uses bounded exponential retry', async () => {
    let update;
    const queue = createBackgroundJobService({ allowedTypes: ['media.cleanup'], Job: {
        updateOne: async (_, value) => { update = value; return { matchedCount: 1 }; },
    } });
    const error = Object.assign(new Error('Authorization: secret'), { response: { status: 503 } });
    await queue.fail({ _id: '1', lockToken: 'a', attempts: 1, maxAttempts: 4 }, error);
    assert.equal(update.$set.state, 'queued');
    assert.equal(update.$set.errorCode, 'operation_failed');
    assert.equal(JSON.stringify(update).includes('secret'), false);
    await queue.fail({ _id: '1', lockToken: 'a', attempts: 4, maxAttempts: 4 }, error);
    assert.equal(update.$set.state, 'failed');
    assert.equal(retryable({ response: { status: 403 } }), false);
    assert.equal(retryable({ response: { status: 429 } }), true);
    assert.equal(retryDelayMs(20), 900000);
});
test('runner does not overlap ticks and acknowledges only completed work', async () => {
    let release;
    const wait = new Promise((resolve) => { release = resolve; });
    const calls = [];
    const queue = { leaseMs: 180000, claim: async () => ({ type: 'test', payload: {}, lockToken: 'a' }),
        renew: async () => true, complete: async () => calls.push('complete'), fail: async () => calls.push('fail') };
    const runner = createJobRunner({ queue, handlers: { test: async () => { await wait; return { ok: true }; } }, onError: () => {} });
    const pending = runner.tick();
    assert.equal(await runner.tick(), false);
    release();
    assert.equal(await pending, true);
    assert.deepEqual(calls, ['complete']);
    assert.equal(runner.busy, false);
});
test('stopping a worker aborts its task without falsely acknowledging it', async () => {
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    let completes = 0;
    const queue = { leaseMs: 180000, claim: async () => ({ type: 'test', payload: {} }),
        renew: async () => true, complete: async () => completes++, fail: async () => assert.fail('stopped jobs await lease recovery') };
    const runner = createJobRunner({ queue, onError: () => {}, handlers: {
        test: async (_, { signal }) => { started(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); },
    } });
    const pending = runner.tick();
    await ready;
    runner.stop();
    assert.equal(await pending, false);
    assert.equal(completes, 0);
});
