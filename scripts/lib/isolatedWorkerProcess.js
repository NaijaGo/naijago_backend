const { fork } = require('node:child_process');
const path = require('node:path');
const { resolveTestDatabase } = require('./integrationTestDatabase');

const SCENARIOS = ['competition', 'crash', 'stop', 'exhausted'];
const MODES = ['normal', 'hold_before', 'hold_after'];
function workerTestEnvironment({ target, scenario, mode = 'normal' }, source = process.env) {
    const checked = resolveTestDatabase({ uri: target.uri, runId: target.runId, allowAtlas: target.kind === 'atlas-test' });
    if (checked.dbName !== target.dbName || !SCENARIOS.includes(scenario) || !MODES.includes(mode)) throw new Error('Invalid isolated worker configuration.');
    // Do not inherit production MONGO_URI, provider keys, Node preload hooks or
    // arbitrary configuration from the developer shell into a test child.
    const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP']);
    const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toUpperCase())));
    return { ...env, NAIJAGO_TEST_MONGO_URI: checked.uri, NAIJAGO_ALLOW_ATLAS_TESTS: String(checked.kind === 'atlas-test'),
        NAIJAGO_TEST_RUN_ID: checked.runId, NAIJAGO_TEST_WORKER_SCENARIO: scenario, NAIJAGO_TEST_WORKER_MODE: mode };
}
function deadline(promise, milliseconds, message) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })])
        .finally(() => clearTimeout(timer));
}
function spawnIsolatedWorker({ target, scenario, mode = 'normal', effects, forkProcess = fork }) {
    if (!(effects instanceof Map)) throw new Error('An isolated simulated provider is required.');
    const child = forkProcess(path.join(__dirname, '..', 'testBackgroundWorker.js'), [], {
        execArgv: [], env: workerTestEnvironment({ target, scenario, mode }), windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let ended = false, failed = false;
    const buffered = [], waiters = new Set();
    const closed = new Promise((resolve) => child.once('close', () => { ended = true; resolve(); }));
    const rejectWaiting = () => {
        for (const waiter of waiters) waiter.reject(new Error('Isolated worker ended before its expected response.'));
        waiters.clear();
    };
    child.on('error', () => { failed = true; rejectWaiting(); });
    child.on('exit', () => { ended = true; rejectWaiting(); });
    child.on('message', (message) => {
        if (!message || typeof message !== 'object') return;
        if (message.kind === 'effect') {
            // A local simulated provider, shared across child restarts. Record
            // one effect per deliveryKey, then replay its receipt on retries.
            if (typeof message.key !== 'string' || !/^[a-f0-9-]{36}$/.test(message.key)) { failed = true; rejectWaiting(); return; }
            let receipt = effects.get(message.key);
            if (!receipt) { receipt = { id: 'simulated-receipt-' + effects.size, calls: 0 }; effects.set(message.key, receipt); }
            receipt.calls++;
            if (child.connected) child.send({ kind: 'effect_result', requestId: message.requestId, receipt: receipt.id }, () => {});
            return;
        }
        if (message.kind === 'fatal') { failed = true; rejectWaiting(); return; }
        const waiter = [...waiters].find((item) => item.kind === message.kind);
        if (waiter) { waiters.delete(waiter); waiter.resolve(message); }
        else buffered.push(message);
    });
    function next(kind, timeout = 45000) {
        const index = buffered.findIndex((message) => message.kind === kind);
        if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
        if (ended || failed) return Promise.reject(new Error('Isolated worker is not available.'));
        let waiter;
        const promise = new Promise((resolve, reject) => { waiter = { kind, resolve, reject }; waiters.add(waiter); });
        return deadline(promise, timeout, 'Isolated worker response timed out: ' + kind).finally(() => waiters.delete(waiter));
    }
    function command(kind, resultKind, extra = {}) {
        const response = next(resultKind);
        if (!ended && child.connected) child.send({ kind, ...extra }, (error) => { if (error) rejectWaiting(); });
        else rejectWaiting();
        return response;
    }
    return {
        pid: child.pid, ready: () => next('ready'), held: () => next('held'),
        tick: (nowMs) => command('tick', 'tick_result', { nowMs }),
        async stop() { await command('stop', 'stopped'); await deadline(closed, 10000, 'Isolated worker did not close after stop.'); },
        async terminate() {
            if (!ended) child.kill('SIGKILL');
            await deadline(closed, 10000, 'Could not stop the exact isolated worker process.');
        },
    };
}
module.exports = { workerTestEnvironment, spawnIsolatedWorker, SCENARIOS, MODES };
