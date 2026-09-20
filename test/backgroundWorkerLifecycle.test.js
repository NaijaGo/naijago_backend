const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWorkerLoop, createWorkerSchedule, startManagedWorker } = require('../services/backgroundWorkerLifecycle');
const { createJobRunner } = require('../services/backgroundJobService');
const { createMediaCleanupService } = require('../services/mediaCleanupService');
const { createMediaRevocationService } = require('../services/mediaRevocationService');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function timers() {
    const callbacks = new Set();
    return { callbacks, setInterval(callback) { callbacks.add(callback); return callback; },
        clearInterval(callback) { callbacks.delete(callback); } };
}
function fixture(overrides = {}) {
    const calls = [], intervals = timers();
    const runner = { busy: false, tick: async () => { calls.push('run'); return true; }, stop: () => calls.push('abort') };
    const loop = createWorkerLoop({ runner, schedule: async () => calls.push('scan'),
        disconnect: async () => calls.push('disconnect'), onError: () => calls.push('error'), intervals, ...overrides });
    return { loop, runner, calls, intervals };
}
test('worker stop waits for an in-flight scan before disconnecting and never claims another job', async () => {
    const entered = deferred(), release = deferred();
    let signal;
    const f = fixture({ schedule: async (context) => { signal = context.signal; entered.resolve(); await release.promise; } });
    const tick = f.loop.tick(); await entered.promise;
    const stop = f.loop.stop();
    assert.equal(stop, f.loop.stop());
    await Promise.resolve();
    assert.equal(signal.aborted, true);
    assert.deepEqual(f.calls, ['abort']);
    release.resolve();
    assert.equal(await tick, false);
    assert.deepEqual(await stop, { drained: true, disconnected: true, forced: false });
    assert.deepEqual(f.calls, ['abort', 'disconnect']);
    assert.equal(await f.loop.tick(), false); assert.equal(f.loop.start(), false);
});
test('worker drains the actual job runner after abort without completing or failing its interrupted job', async () => {
    const started = deferred(), events = [];
    const runner = createJobRunner({ onError: () => {}, queue: { leaseMs: 180000,
        claim: async () => ({ type: 'test', payload: {} }), renew: async () => true,
        complete: async () => assert.fail('Interrupted work cannot be completed.'),
        fail: async () => assert.fail('Stopped work stays leased for recovery.'),
    }, handlers: { test: async (_, { signal }) => {
        started.resolve();
        return new Promise((resolve) => signal.addEventListener('abort', () => { events.push('aborted'); resolve({}); }, { once: true }));
    } } });
    const f = fixture({ runner, disconnect: async () => { assert.equal(runner.busy, false); events.push('disconnected'); } });
    const tick = f.loop.tick(); await started.promise;
    assert.equal((await f.loop.stop()).forced, false);
    assert.equal(await tick, false);
    assert.deepEqual(events, ['aborted', 'disconnected']);
});
test('worker polling is idempotent, never overlaps and is removed on stop', async () => {
    const entered = deferred(), release = deferred();
    let scans = 0;
    const f = fixture({ schedule: async () => { scans++; entered.resolve(); await release.promise; } });
    assert.equal(f.loop.start(), true); assert.equal(f.loop.start(), false);
    assert.equal(f.intervals.callbacks.size, 1);
    const callback = [...f.intervals.callbacks][0];
    await entered.promise;
    callback(); callback();
    assert.equal(await f.loop.tick(), false); assert.equal(scans, 1);
    const stopped = f.loop.stop(); release.resolve(); await stopped;
    assert.equal(f.intervals.callbacks.size, 0);
    callback(); await Promise.resolve();
    assert.equal(scans, 1);
});
test('scheduling failures release the tick guard and never report raw exceptions', async () => {
    let attempt = 0;
    const f = fixture({ schedule: async () => { if (++attempt === 1) throw new Error('synthetic-secret'); } });
    assert.equal(await f.loop.tick(), false);
    assert.equal(await f.loop.tick(), true);
    assert.deepEqual(f.calls, ['error', 'run']);
    await f.loop.stop();
});
test('a stuck scan has a bounded drain and never gets acknowledged by shutdown', async () => {
    const entered = deferred();
    const f = fixture({ drainTimeoutMs: 15, schedule: async () => { entered.resolve(); await new Promise(() => {}); } });
    void f.loop.tick(); await entered.promise;
    assert.deepEqual(await f.loop.stop(), { drained: false, disconnected: true, forced: true });
    assert.deepEqual(f.calls, ['abort', 'disconnect']);
});
test('failed or stuck database close requests a forced exit instead of reporting success', async () => {
    for (const disconnect of [async () => { throw new Error('synthetic-secret'); }, () => new Promise(() => {})]) {
        const f = fixture({ disconnect, disconnectTimeoutMs: 15 });
        assert.deepEqual(await f.loop.stop(), { drained: true, disconnected: false, forced: true });
    }
});
test('worker timeout configuration rejects invalid values', () => {
    for (const value of [0, -1, Infinity, 1.5, 300001]) assert.throws(() => fixture({ drainTimeoutMs: value }), /Invalid worker timeout/);
});

function managedFixture(overrides = {}) {
    const calls = [], logs = [], host = new EventEmitter(), intervals = timers();
    host.exit = (code) => calls.push('exit:' + code);
    const db = { connect: async (_, options) => { assert.equal(options.serverSelectionTimeoutMS, 10000); calls.push('connect'); },
        disconnect: async () => calls.push('disconnect') };
    const options = { env: { BACKGROUND_JOBS_ENABLED: 'true', MONGO_URI: 'test-placeholder', EXPLORE_ENABLED: 'true' }, db,
        ensureIndexes: async () => calls.push('indexes'),
        createRuntime: (types) => {
            assert.deepEqual(types, ['explore.notify']); calls.push('runtime');
            return { schedule: async () => calls.push('scan'), runner: { busy: false,
                tick: async () => { calls.push('run'); return true; }, stop: () => calls.push('abort') } };
        }, host, intervals, logger: { log: (message) => logs.push(message), error: (message) => logs.push(message) }, ...overrides };
    return { options, calls, logs, host, intervals, db, start: () => startManagedWorker(options) };
}
test('managed worker initializes indexes before polling and drains once for repeated shutdown signals', async () => {
    const f = managedFixture();
    const worker = await f.start();
    assert.deepEqual(f.calls.slice(0, 3), ['connect', 'indexes', 'runtime']);
    assert.equal(f.host.listenerCount('SIGTERM'), 1); assert.equal(f.host.listenerCount('SIGINT'), 1);
    f.host.emit('SIGTERM'); f.host.emit('SIGINT');
    const stop = worker.stop(); assert.equal(stop, worker.stop());
    assert.equal((await stop).forced, false);
    assert.equal(f.host.listenerCount('SIGTERM'), 0); assert.equal(f.host.listenerCount('SIGINT'), 0);
    assert.equal(f.intervals.callbacks.size, 0);
    assert.equal(f.calls.filter((call) => call === 'disconnect').length, 1);
    assert.equal(f.calls.filter((call) => call === 'abort').length, 1);
    assert.equal(f.calls.some((call) => call.startsWith('exit:')), false);
});
test('index and runtime initialization failures close Mongo and never leave a polling worker', async () => {
    for (const stage of ['ensureIndexes', 'createRuntime']) {
        const f = managedFixture({ [stage]: () => { throw new Error('mongodb+srv://synthetic-secret'); } });
        await assert.rejects(f.start(), (error) => {
            assert.equal(error.code, 'WORKER_STARTUP_FAILED'); assert.equal(error.forceExit, false);
            assert.doesNotMatch(error.message, /synthetic-secret|mongodb\+srv/); assert.equal(error.cause, undefined); return true;
        });
        assert.equal(f.calls.at(-1), 'disconnect');
        assert.equal(f.intervals.callbacks.size, 0); assert.equal(f.host.listenerCount('SIGTERM'), 0);
    }
});
test('disabled/unconfigured/handler-free workers fail before connecting', async () => {
    for (const env of [{}, { BACKGROUND_JOBS_ENABLED: 'true' }, { BACKGROUND_JOBS_ENABLED: 'true', MONGO_URI: 'test-placeholder' }]) {
        const f = managedFixture({ env });
        await assert.rejects(f.start(), { code: 'WORKER_STARTUP_FAILED' });
        assert.deepEqual(f.calls, ['disconnect']);
    }
});
test('startup failure requests forced exit if database cleanup fails or hangs', async () => {
    for (const disconnect of [async () => { throw new Error('synthetic-secret'); }, () => new Promise(() => {})]) {
        const f = managedFixture({ disconnectTimeoutMs: 15,
            db: { connect: async () => { throw new Error('synthetic-secret'); }, disconnect } });
        await assert.rejects(f.start(), { code: 'WORKER_STARTUP_FAILED', forceExit: true });
    }
});
test('managed shutdown invokes only its own process exit adapter when draining cannot finish', async () => {
    const entered = deferred();
    const f = managedFixture({ drainTimeoutMs: 15,
        createRuntime: () => ({ runner: { stop() {} }, schedule: async () => { entered.resolve(); await new Promise(() => {}); } }) });
    const worker = await f.start(); await entered.promise;
    assert.equal((await worker.stop()).forced, true);
    assert.equal(f.calls.at(-1), 'exit:1');
    assert.equal(f.intervals.callbacks.size, 0);
});
test('production worker module imports without loading live settings or starting a connection', () => {
    const dotenvPath = require.resolve('dotenv'), prior = require.cache[dotenvPath];
    const entrypoint = require('../workers/backgroundWorker');
    assert.equal(typeof entrypoint.main, 'function');
    assert.equal(require.cache[dotenvPath], prior);
});

test('scheduler preserves scan intervals and checks cancellation between scan types', async () => {
    let now = 0;
    const calls = [], controller = new AbortController();
    const schedule = createWorkerSchedule({ allowedTypes: ['media.revoke', 'media.cleanup'], now: () => now,
        revocation: { schedule: async ({ signal }) => { assert.equal(signal, controller.signal); calls.push('revoke'); } },
        media: { schedule: async () => calls.push('cleanup') } });
    await schedule({ signal: controller.signal });
    now = 14000; await schedule({ signal: controller.signal });
    now = 15000; await schedule({ signal: controller.signal });
    now = 3600000; await schedule({ signal: controller.signal });
    assert.deepEqual(calls, ['revoke', 'cleanup', 'revoke', 'revoke', 'cleanup']);
    controller.abort();
    await assert.rejects(schedule({ signal: controller.signal }), { name: 'AbortError' });
});
test('scheduler cannot begin cleanup if shutdown arrives during the revocation scan', async () => {
    const controller = new AbortController();
    const schedule = createWorkerSchedule({ allowedTypes: ['media.revoke', 'media.cleanup'],
        revocation: { schedule: async () => controller.abort() },
        media: { schedule: async () => assert.fail('Shutdown must prevent the next scan.') } });
    await assert.rejects(schedule({ signal: controller.signal }), { name: 'AbortError' });
});
for (const [label, createService] of [['cleanup', createMediaCleanupService], ['revocation', createMediaRevocationService]]) {
    test(label + ' scan stops between writes and never queues a second asset after cancellation', async () => {
        for (const abortAt of ['before_query', 'after_query', 'enqueue', 'update']) {
            const controller = new AbortController(), calls = [];
            const rows = [{ _id: 'a', owner: 'owner', revocation: { token: 'token-a' } }, { _id: 'b', owner: 'owner', revocation: { token: 'token-b' } }];
            const service = createService({ MediaAsset: {
                find() { calls.push('query'); return { select() { return this; }, sort() { return this; }, limit() { return this; },
                    lean: async () => { if (abortAt === 'after_query') controller.abort(); return rows; } }; },
                async updateOne() { calls.push('update'); if (abortAt === 'update') controller.abort(); },
            }, queue: { async enqueue() { calls.push('enqueue'); if (abortAt === 'enqueue') controller.abort(); } } });
            if (abortAt === 'before_query') controller.abort();
            await assert.rejects(service.schedule({ signal: controller.signal }), { name: 'AbortError' });
            const expected = { before_query: [], after_query: ['query'], enqueue: ['query', 'enqueue'], update: ['query', 'enqueue', 'update'] };
            assert.deepEqual(calls, expected[abortAt]);
        }
    });
}
