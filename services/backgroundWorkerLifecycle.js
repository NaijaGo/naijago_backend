function positiveTimeout(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 300000) throw new Error('Invalid worker timeout.');
    return value;
}
async function finishesWithin(work, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(work).then(() => true, () => false),
            new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
    } finally { clearTimeout(timer); }
}
function createWorkerSchedule({ allowedTypes, media, revocation, now = Date.now }) {
    const types = new Set(allowedTypes);
    let lastCleanup = null, lastRevocation = null;
    return async function schedule({ signal }) {
        signal.throwIfAborted();
        if (types.has('media.revoke') && (lastRevocation === null || now() - lastRevocation >= 15000)) {
            await revocation.schedule({ signal }); lastRevocation = now();
        }
        signal.throwIfAborted();
        if (types.has('media.cleanup') && (lastCleanup === null || now() - lastCleanup >= 3600000)) {
            await media.schedule({ signal }); lastCleanup = now();
        }
    };
}
function createWorkerLoop({ runner, schedule, disconnect, onError = () => {}, pollMs = 5000,
    drainTimeoutMs = 30000, disconnectTimeoutMs = 5000, intervals = { setInterval, clearInterval } }) {
    positiveTimeout(pollMs); positiveTimeout(drainTimeoutMs); positiveTimeout(disconnectTimeoutMs);
    const controller = new AbortController();
    let active, interval, shutdown, stopping = false;
    function tick() {
        if (stopping || active || runner.busy) return Promise.resolve(false);
        active = Promise.resolve().then(async () => {
            if (stopping) return false;
            await schedule({ signal: controller.signal });
            if (stopping) return false;
            return await runner.tick();
        }).catch(() => {
            // Do not expose provider exceptions or report an expected abort as
            // a fresh failure. The next running tick retries scheduling errors.
            if (!stopping) { try { onError(); } catch (_) {} }
            return false;
        }).finally(() => { active = undefined; });
        return active;
    }
    function start() {
        if (stopping || interval !== undefined) return false;
        interval = intervals.setInterval(() => { void tick(); }, pollMs);
        void tick();
        return true;
    }
    function stop() {
        if (shutdown) return shutdown;
        stopping = true;
        if (interval !== undefined) intervals.clearInterval(interval);
        interval = undefined;
        // Assign the shared promise before signalling abort to keep repeated
        // signals idempotent, including callbacks triggered by cancellation.
        shutdown = Promise.resolve().then(async () => {
            let abortSucceeded = true;
            try { controller.abort(); runner.stop(); } catch (_) { abortSucceeded = false; }
            const drained = await finishesWithin(() => active, drainTimeoutMs) && abortSucceeded;
            const disconnected = await finishesWithin(disconnect, disconnectTimeoutMs);
            return { drained, disconnected, forced: !drained || !disconnected };
        });
        return shutdown;
    }
    return { tick, start, stop, get busy() { return Boolean(active); }, get stopping() { return stopping; } };
}

// The production entrypoint supplies its actual Mongo/index/service adapters.
// Tests exercise the same startup/signal/drain orchestration without providers.
async function startManagedWorker({ env, db, ensureIndexes, createRuntime, host = process,
    logger = console, drainTimeoutMs = 30000, disconnectTimeoutMs = 5000, intervals }) {
    positiveTimeout(drainTimeoutMs); positiveTimeout(disconnectTimeoutMs);
    const report = (level, message) => { try { logger[level](message); } catch (_) {} };
    let loop, stop;
    try {
        if (env.BACKGROUND_JOBS_ENABLED !== 'true' || !env.MONGO_URI) throw new Error('Missing worker configuration.');
        const allowedTypes = [];
        if (env.MEDIA_CLEANUP_ENABLED === 'true') allowedTypes.push('media.cleanup');
        if (env.PRODUCT_VIDEO_ENABLED === 'true') allowedTypes.push('media.revoke');
        if (env.EXPLORE_ENABLED === 'true') allowedTypes.push('explore.notify');
        if (env.PRODUCT_REQUESTS_ENABLED === 'true') allowedTypes.push('request.preview', 'request.notify');
        if (!allowedTypes.length) throw new Error('No worker handlers are enabled.');
        await db.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
        await ensureIndexes(allowedTypes);
        const runtime = createRuntime(allowedTypes);
        loop = createWorkerLoop({ ...runtime, disconnect: () => db.disconnect(), drainTimeoutMs, disconnectTimeoutMs, intervals,
            onError: () => report('error', 'Background worker tick unavailable; it will retry.') });
        let stopped;
        stop = () => {
            if (!stopped) {
                host.removeListener('SIGTERM', stop); host.removeListener('SIGINT', stop);
                stopped = loop.stop().then((result) => {
                    if (result.forced) {
                        report('error', 'Background worker shutdown exceeded its safe drain/connection budget. Leased jobs remain recoverable.');
                        host.exit(1);
                    } else { report('log', 'Background worker stopped after draining work and closing the database.'); }
                    return result;
                });
            }
            return stopped;
        };
        host.once('SIGTERM', stop); host.once('SIGINT', stop);
        loop.start();
        report('log', 'Durable background worker started. Enabled types: ' + allowedTypes.join(', '));
        return { stop, tick: loop.tick, get busy() { return loop.busy; }, get stopping() { return loop.stopping; } };
    } catch (_) {
        if (stop) { host.removeListener('SIGTERM', stop); host.removeListener('SIGINT', stop); }
        const closed = loop ? !(await loop.stop()).forced : await finishesWithin(() => db.disconnect(), disconnectTimeoutMs);
        // No raw error/cause: the driver or provider exception can contain a URI.
        const error = new Error('Background worker startup failed. Check worker configuration, database access and indexes.');
        error.code = 'WORKER_STARTUP_FAILED'; error.forceExit = !closed;
        throw error;
    }
}
module.exports = { createWorkerLoop, createWorkerSchedule, startManagedWorker };
