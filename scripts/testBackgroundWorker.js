// Test-only child. Never import the production worker, dotenv or any provider.
const mongoose = require('mongoose');
const crypto = require('node:crypto');
const { resolveTestDatabase } = require('./lib/integrationTestDatabase');
const { SCENARIOS, MODES } = require('./lib/isolatedWorkerProcess');
const { createBackgroundJobService, createJobRunner, JobLeaseLostError } = require('../services/backgroundJobService');

let connection, runner, pendingTick;
let stopping = false;
const providerReplies = new Map();
const send = (message) => new Promise((resolve) => {
    if (!process.connected) return resolve();
    process.send(message, () => resolve());
});
function waitForAbort(signal) {
    return new Promise((_, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}
function simulatedEffect(key, signal) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const finish = (value) => { signal.removeEventListener('abort', abort); providerReplies.delete(requestId); resolve(value); };
        const abort = () => { providerReplies.delete(requestId); reject(signal.reason); };
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        providerReplies.set(requestId, finish);
        void send({ kind: 'effect', key, requestId });
    });
}
async function stop() {
    if (stopping) return;
    stopping = true;
    runner?.stop();
    if (pendingTick) await pendingTick;
    if (connection) await connection.close();
    await send({ kind: 'stopped' });
    if (process.connected) process.disconnect();
}
async function main() {
    if (!process.send || !process.connected || process.env.MONGO_URI) throw new Error('Dedicated test IPC is required.');
    const scenario = process.env.NAIJAGO_TEST_WORKER_SCENARIO, mode = process.env.NAIJAGO_TEST_WORKER_MODE;
    if (!SCENARIOS.includes(scenario) || !MODES.includes(mode) || !process.env.NAIJAGO_TEST_RUN_ID) throw new Error('Invalid isolated worker scenario.');
    const target = resolveTestDatabase({ uri: process.env.NAIJAGO_TEST_MONGO_URI,
        allowAtlas: process.env.NAIJAGO_ALLOW_ATLAS_TESTS === 'true', runId: process.env.NAIJAGO_TEST_RUN_ID });
    connection = mongoose.createConnection(target.uri, { dbName: target.dbName, serverSelectionTimeoutMS: 10000,
        maxPoolSize: 3, autoCreate: false, autoIndex: false, ...(target.kind === 'atlas-test' ? { tls: true } : {}) });
    await connection.asPromise();
    const collection = target.collections.BackgroundJob;
    if (!await connection.db.listCollections({ name: collection }, { nameOnly: true }).hasNext()) throw new Error('Parent test collection is missing.');
    const schema = require('../models/BackgroundJob').schema.clone();
    schema.set('autoCreate', false); schema.set('autoIndex', false);
    const Job = connection.model('BackgroundJob', schema, collection);
    let clock = new Date(), errors = [];
    const type = 'test.worker.' + scenario;
    const queue = createBackgroundJobService({ Job, allowedTypes: [type], leaseMs: 30000, now: () => clock });
    runner = createJobRunner({ queue,
        onError: (error) => errors.push(error instanceof JobLeaseLostError ? 'lease_lost' : 'worker_operation_failed'),
        handlers: { [type]: async (_, { job, signal }) => {
            if (mode === 'hold_before') { await send({ kind: 'held', phase: 'before', jobId: String(job._id) }); await waitForAbort(signal); }
            const receipt = await simulatedEffect(job.deliveryKey, signal);
            if (mode === 'hold_after') { await send({ kind: 'held', phase: 'after', jobId: String(job._id) }); await waitForAbort(signal); }
            return { receipt };
        } },
    });
    process.on('message', (message) => {
        if (!message || typeof message !== 'object') return;
        if (message.kind === 'effect_result') { providerReplies.get(message.requestId)?.(message.receipt); return; }
        if (message.kind === 'stop') { void stop().catch(fatal); return; }
        if (message.kind !== 'tick' || stopping || pendingTick) return;
        if (!Number.isSafeInteger(message.nowMs) || !Number.isFinite(new Date(message.nowMs).getTime())) { void fatal(); return; }
        clock = new Date(message.nowMs); errors = [];
        pendingTick = runner.tick();
        pendingTick.then((ok) => {
            pendingTick = undefined;
            return send({ kind: 'tick_result', ok, errors });
        }).catch(fatal);
    });
    process.once('disconnect', () => { void stop().catch(fatal); });
    await send({ kind: 'ready', pid: process.pid });
}
async function fatal() {
    runner?.stop();
    await send({ kind: 'fatal', code: 'ISOLATED_WORKER_FAILED' });
    if (connection) await connection.close().catch(() => {});
    process.exitCode = 1;
    if (process.connected) process.disconnect();
}
if (require.main === module) main().catch(fatal);
