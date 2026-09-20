const test = require('node:test');
const assert = require('node:assert/strict');
const { openIsolatedTestDatabase } = require('../../scripts/lib/openIsolatedTestDatabase');
const { spawnIsolatedWorker } = require('../../scripts/lib/isolatedWorkerProcess');
const { createBackgroundJobService, JobLeaseLostError } = require('../../services/backgroundJobService');

async function settled(promises) {
    const results = await Promise.allSettled(promises);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    return results.map((result) => result.value);
}

// Real OS processes, independent Mongo connections and the actual queue/runner.
// Only the external provider and clock are controlled: no push/payment/media call,
// and no need to wait the production three-minute lease between crash scenarios.
test('isolated Mongo: independent worker processes, crash recovery and bounded retries', {
    skip: !process.env.NAIJAGO_TEST_MONGO_URI, timeout: 300000,
}, async (t) => {
    const children = [], cleanup = [], effects = new Map();
    let connection;
    t.after(async () => {
        // All processes must be confirmed closed before deleting their collection.
        const results = await Promise.allSettled(children.map((child) => child.terminate()));
        if (results.some((result) => result.status === 'rejected')) {
            await connection?.close();
            throw new Error('A test worker could not be stopped. Test collections were preserved for inspection.');
        }
        for (const close of cleanup) await close();
    });
    const isolated = await openIsolatedTestDatabase({ after: (close) => cleanup.push(close) }, ['BackgroundJob']);
    connection = isolated.connection;
    const Job = isolated.models.BackgroundJob;
    async function start(scenario, mode = 'normal') {
        const worker = spawnIsolatedWorker({ target: isolated.target, scenario, mode, effects });
        children.push(worker);
        const ready = await worker.ready();
        assert.equal(ready.pid, worker.pid);
        assert.notEqual(worker.pid, process.pid);
        return worker;
    }
    function scenarioQueue(scenario) {
        let clock = new Date(Date.now() + 86400000);
        const type = 'test.worker.' + scenario;
        const queue = createBackgroundJobService({ Job, allowedTypes: [type], leaseMs: 30000, now: () => clock });
        return { queue, type, now: () => clock.getTime(),
            expire: (row) => { clock = new Date(row.leaseUntil.getTime() + 1); },
            enqueue: (key, maxAttempts = 4) => queue.enqueue({ type, dedupeKey: key, payload: { synthetic: true }, maxAttempts }),
        };
    }
    await t.test('two separate processes claim and complete each queued job only once', async () => {
        const scenario = scenarioQueue('competition');
        const jobs = await settled(Array.from({ length: 12 }, (_, index) => scenario.enqueue('job-' + index)));
        const [one, two] = await settled([start('competition'), start('competition')]);
        assert.notEqual(one.pid, two.pid);
        for (let index = 0; index < 6; index++) {
            const results = await settled([one.tick(scenario.now()), two.tick(scenario.now())]);
            for (const result of results) { assert.equal(result.ok, true); assert.deepEqual(result.errors, []); }
        }
        const rows = await Job.find({ type: scenario.type }).lean();
        assert.equal(rows.length, 12);
        assert.ok(rows.every((row) => row.state === 'completed' && row.attempts === 1 && !row.lockToken));
        for (const row of rows) {
            const receipt = effects.get(row.deliveryKey);
            assert.equal(receipt.calls, 1);
            assert.equal(row.result.receipt, receipt.id);
        }
        assert.equal(new Set(jobs.map((job) => job.deliveryKey)).size, 12);
        assert.equal((await one.tick(scenario.now())).ok, false);
        await settled([one.stop(), two.stop()]);
    });
    await t.test('crash after provider acceptance retries the same delivery key without another simulated effect', async () => {
        const scenario = scenarioQueue('crash');
        const job = await scenario.enqueue('accepted-before-crash');
        const first = await start('crash', 'hold_after');
        // Attach a rejection handler immediately: a deliberate kill must not
        // produce an unhandled rejected promise in the parent test process.
        const interrupted = first.tick(scenario.now()).then((result) => ({ result }), () => ({ interrupted: true }));
        const held = await first.held();
        assert.equal(held.phase, 'after'); assert.equal(held.jobId, String(job._id));
        const before = await Job.findById(job._id).lean();
        const receipt = effects.get(before.deliveryKey);
        assert.equal(before.state, 'running'); assert.equal(before.attempts, 1);
        assert.equal(receipt.calls, 1);
        await first.terminate();
        assert.deepEqual(await interrupted, { interrupted: true });
        const replacement = await start('crash');
        assert.notEqual(replacement.pid, first.pid);
        assert.equal((await replacement.tick(scenario.now())).ok, false, 'A still-valid lease cannot be stolen.');
        scenario.expire(before);
        const recovered = await replacement.tick(scenario.now());
        assert.equal(recovered.ok, true); assert.deepEqual(recovered.errors, []);
        const after = await Job.findById(job._id).lean();
        assert.equal(after.state, 'completed'); assert.equal(after.attempts, 2);
        assert.equal(after.deliveryKey, before.deliveryKey);
        assert.equal(after.result.receipt, receipt.id); assert.equal(receipt.calls, 2);
        assert.equal(after.lockToken, undefined);
        await assert.rejects(scenario.queue.complete(before, { stale: true }), JobLeaseLostError);
        assert.equal((await Job.findById(job._id).lean()).result.receipt, receipt.id);
        await replacement.stop();
    });
    await t.test('graceful stop aborts an in-flight handler without marking its job completed or failed', async () => {
        const scenario = scenarioQueue('stop');
        const job = await scenario.enqueue('stop-before-provider');
        const first = await start('stop', 'hold_before');
        const pending = first.tick(scenario.now()).then((result) => ({ result }), () => ({ interrupted: true }));
        await first.held();
        await first.stop();
        const { result } = await pending;
        assert.ok(result, 'Graceful stop must return the pending tick result.');
        assert.equal(result.ok, false); assert.deepEqual(result.errors, ['lease_lost']);
        const before = await Job.findById(job._id).lean();
        assert.equal(before.state, 'running'); assert.equal(before.attempts, 1);
        assert.equal(effects.has(before.deliveryKey), false);
        scenario.expire(before);
        const replacement = await start('stop');
        assert.equal((await replacement.tick(scenario.now())).ok, true);
        const after = await Job.findById(job._id).lean();
        assert.equal(after.state, 'completed'); assert.equal(after.attempts, 2);
        assert.equal(effects.get(after.deliveryKey).calls, 1);
        await replacement.stop();
    });
    await t.test('an exhausted crashed job becomes failed instead of looping forever', async () => {
        const scenario = scenarioQueue('exhausted');
        const job = await scenario.enqueue('last-attempt', 1);
        const first = await start('exhausted', 'hold_before');
        const pending = first.tick(scenario.now()).catch(() => null);
        await first.held();
        const before = await Job.findById(job._id).lean();
        await first.terminate(); await pending;
        scenario.expire(before);
        const replacement = await start('exhausted');
        for (let index = 0; index < 2; index++) assert.equal((await replacement.tick(scenario.now())).ok, false);
        const after = await Job.findById(job._id).lean();
        assert.equal(after.state, 'failed'); assert.equal(after.errorCode, 'lease_expired');
        assert.equal(after.attempts, 1); assert.equal(after.lockToken, undefined);
        assert.equal(effects.has(after.deliveryKey), false);
        await replacement.stop();
    });
});
