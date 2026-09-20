const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { workerTestEnvironment, spawnIsolatedWorker } = require('../scripts/lib/isolatedWorkerProcess');
const { resolveTestDatabase, ATLAS_TEST_HOST } = require('../scripts/lib/integrationTestDatabase');

const target = () => resolveTestDatabase({ uri: 'mongodb+srv://test-user:synthetic-only@' + ATLAS_TEST_HOST,
    allowAtlas: true, runId: 'a'.repeat(32) });
test('worker child receives only the approved test URI and essential OS environment', () => {
    const env = workerTestEnvironment({ target: target(), scenario: 'crash' }, {
        Path: 'node-path', SystemRoot: 'system-path', TEMP: 'temp-path',
        MONGO_URI: 'production-placeholder', GEMINI_API_KEY: 'provider-placeholder',
        ONESIGNAL_REST_API_KEY: 'provider-placeholder', NODE_OPTIONS: '--require forbidden.js',
        BACKGROUND_JOBS_ENABLED: 'true', UNKNOWN_CONFIG: 'unsafe-placeholder',
    });
    assert.equal(env.Path, 'node-path'); assert.equal(env.SystemRoot, 'system-path');
    assert.equal(env.NAIJAGO_TEST_RUN_ID, 'a'.repeat(32));
    assert.equal(new URL(env.NAIJAGO_TEST_MONGO_URI).hostname, ATLAS_TEST_HOST);
    for (const key of ['MONGO_URI', 'GEMINI_API_KEY', 'ONESIGNAL_REST_API_KEY', 'NODE_OPTIONS', 'BACKGROUND_JOBS_ENABLED', 'UNKNOWN_CONFIG']) assert.equal(env[key], undefined);
});
test('worker child rejects unsafe targets, database overrides and unknown scenarios before spawning', () => {
    for (const options of [
        { target: { ...target(), uri: 'mongodb+srv://test-user:synthetic-only@production.invalid/' }, scenario: 'crash' },
        { target: { ...target(), dbName: 'production' }, scenario: 'crash' },
        { target: target(), scenario: 'media.cleanup' },
        { target: target(), scenario: 'crash', mode: 'provider_live' },
    ]) assert.throws(() => workerTestEnvironment(options, {}));
    assert.throws(() => spawnIsolatedWorker({ target: target(), scenario: 'crash', effects: null,
        forkProcess: () => assert.fail('Invalid configuration must not spawn anything.') }));
});

function fixture({ hold = false } = {}, effects = new Map()) {
    const child = new EventEmitter();
    child.pid = 12345; child.connected = true;
    const sent = [], kills = [];
    const emit = (message) => queueMicrotask(() => child.emit('message', message));
    const close = () => {
        child.connected = false;
        child.emit('exit', 0); child.emit('close', 0);
    };
    child.kill = (signal) => { kills.push(signal); queueMicrotask(close); return true; };
    child.send = (message, callback) => {
        sent.push(message); callback?.();
        if (message.kind === 'tick') {
            if (hold) emit({ kind: 'held', phase: 'before' });
            else emit({ kind: 'effect', requestId: 'request', key: '12345678-1234-4123-8123-123456789abc' });
        }
        if (message.kind === 'effect_result') emit({ kind: 'tick_result', ok: true, receipt: message.receipt });
        if (message.kind === 'stop') {
            emit({ kind: 'stopped' }); queueMicrotask(close);
        }
    };
    const worker = spawnIsolatedWorker({ target: target(), scenario: 'competition', effects,
        forkProcess(filename, args, options) {
            assert.equal(path.basename(filename), 'testBackgroundWorker.js');
            assert.deepEqual(args, []); assert.deepEqual(options.execArgv, []);
            assert.equal(options.windowsHide, true);
            assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
            emit({ kind: 'ready', pid: child.pid });
            return child;
        },
    });
    return { worker, child, sent, kills, effects };
}
test('worker harness handles ready/tick/stop and deduplicates simulated provider receipts across processes', async () => {
    const effects = new Map();
    const first = fixture({}, effects), second = fixture({}, effects);
    await first.worker.ready(); await second.worker.ready();
    const one = await first.worker.tick(Date.now()), two = await second.worker.tick(Date.now());
    assert.equal(one.receipt, two.receipt); assert.equal(effects.size, 1);
    assert.equal([...effects.values()][0].calls, 2);
    await first.worker.stop(); await second.worker.stop();
    assert.deepEqual(first.kills, []);
    await first.worker.terminate();
    assert.deepEqual(first.kills, [], 'Cleanup must not signal an already closed child.');
});
test('worker harness rejects an interrupted tick and kills only its own child handle', async () => {
    const f = fixture({ hold: true });
    await f.worker.ready();
    const pending = f.worker.tick(Date.now());
    const rejected = assert.rejects(pending, /Isolated worker ended/);
    await f.worker.held();
    await f.worker.terminate(); await rejected;
    assert.deepEqual(f.kills, ['SIGKILL']);
    assert.equal(f.effects.size, 0);
});
test('worker harness hides raw process error messages', async () => {
    const f = fixture({ hold: true });
    await f.worker.ready();
    const pending = f.worker.tick(Date.now());
    const rejected = assert.rejects(pending, (error) => {
        assert.match(error.message, /Isolated worker ended/);
        assert.doesNotMatch(error.message, /synthetic-secret/); return true;
    });
    f.child.emit('error', new Error('synthetic-secret'));
    await rejected; await f.worker.terminate();
});
test('test-only worker refuses a standalone launch before opening a database', async () => {
    const env = workerTestEnvironment({ target: target(), scenario: 'competition' });
    const result = await new Promise((resolve) => execFile(process.execPath,
        [path.join(__dirname, '..', 'scripts', 'testBackgroundWorker.js')],
        { env, windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
    assert.equal(result.error?.code, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-only|mongodb\+srv/);
});
