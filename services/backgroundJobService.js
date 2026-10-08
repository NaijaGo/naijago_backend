const crypto = require('node:crypto');

class JobInputError extends Error {}
class JobConflictError extends Error {}
class JobLeaseLostError extends Error {}

function canonical(value, depth = 0) {
    if (depth > 20) throw new JobInputError('Job data is nested too deeply.');
    if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], depth + 1)]));
    }
    throw new JobInputError('Job data must be plain JSON.');
}
function boundedJson(value, maxBytes) {
    const normalized = canonical(value);
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > maxBytes) throw new JobInputError('Job data is too large.');
    return normalized;
}
function errorCode(error) {
    // Never persist raw provider errors: they may include API keys/request headers.
    return /^[a-z][a-z0-9_]{1,79}$/.test(error?.jobCode || '') ? error.jobCode : 'operation_failed';
}
function retryable(error) {
    if (error?.retryable === false || error instanceof JobInputError) return false;
    const status = error?.response?.status || error?.status;
    return !status || [408, 409, 425, 429].includes(status) || status >= 500;
}
const retryDelayMs = (attempt) => Math.min(15 * 60 * 1000, 5000 * 2 ** Math.max(0, attempt - 1));
function providerRetryMs(error, date) {
    const raw = error?.response?.headers?.['retry-after'];
    if (raw === undefined || raw === null) return 0;
    const seconds = Number(raw);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(String(raw)) - date.getTime();
    return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 7 * 86400000)) : 0;
}

function createBackgroundJobService({ Job, allowedTypes, now = () => new Date(), token = () => crypto.randomUUID(), leaseMs = 180000 }) {
    const types = new Set(allowedTypes);
    if (!Number.isFinite(leaseMs) || leaseMs < 30000) throw new JobInputError('Job lease is too short.');
    const leaseFilter = (job) => ({ _id: job._id, state: 'running', lockToken: job.lockToken, leaseUntil: { $gt: now() } });

    async function enqueue({ type, dedupeKey, owner, payload, runAt = now(), maxAttempts = 4, priority = 0 }, { session } = {}) {
        if (!types.has(type) || typeof dedupeKey !== 'string' || !dedupeKey.trim() || dedupeKey.length > 200) throw new JobInputError('Invalid job type or deduplication key.');
        if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8 || !Number.isInteger(priority) || priority < 0 || priority > 10) throw new JobInputError('Invalid retry or priority configuration.');
        if (!(runAt instanceof Date) || !Number.isFinite(runAt.getTime())) throw new JobInputError('Invalid job time.');
        const normalized = boundedJson(payload, 32 * 1024);
        const payloadHash = crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
        const identity = { type, dedupeKey };
        let job;
        try {
            job = await Job.findOneAndUpdate(identity, { $setOnInsert: {
                ...identity, ...(owner ? { owner } : {}), payload: normalized, payloadHash,
                state: 'queued', attempts: 0, maxAttempts, priority, runAt,
            } }, { upsert: true, new: true, runValidators: true, ...(session ? { session } : {}) });
        } catch (error) {
            if (error.code !== 11000 || session) throw error;
            job = await Job.findOne(identity);
        }
        if (!job || job.payloadHash !== payloadHash || String(job.owner || '') !== String(owner || '')) {
            throw new JobConflictError('This request key already belongs to a different operation.');
        }
        return job;
    }

    async function claim() {
        const date = now();
        await Job.updateMany({ state: 'running', type: { $in: [...types] }, leaseUntil: { $lte: date },
            $expr: { $gte: ['$attempts', '$maxAttempts'] } }, {
            $set: { state: 'failed', errorCode: 'lease_expired', finishedAt: date }, $unset: { lockToken: '', leaseUntil: '' },
        });
        return Job.findOneAndUpdate({ type: { $in: [...types] }, $expr: { $lt: ['$attempts', '$maxAttempts'] },
            $or: [{ state: 'queued', runAt: { $lte: date } }, { state: 'running', leaseUntil: { $lte: date } }],
        }, { $set: { state: 'running', startedAt: date, lockToken: token(), leaseUntil: new Date(date.getTime() + leaseMs) },
            $inc: { attempts: 1 } }, { sort: { priority: -1, runAt: 1, _id: 1 }, new: true });
    }

    async function renew(job) {
        const updated = await Job.updateOne(leaseFilter(job), { $set: { leaseUntil: new Date(now().getTime() + leaseMs) } });
        return updated.matchedCount === 1;
    }
    async function complete(job, result) {
        const updated = await Job.updateOne(leaseFilter(job), { $set: {
            state: 'completed', result: boundedJson(result ?? {}, 128 * 1024), finishedAt: now(), errorCode: '',
        }, $unset: { lockToken: '', leaseUntil: '' } });
        if (!updated.matchedCount) throw new JobLeaseLostError('Job lease was lost.');
    }
    async function fail(job, error) {
        const retry = retryable(error) && job.attempts < job.maxAttempts;
        const date = now();
        const updated = await Job.updateOne(leaseFilter(job), { $set: {
            state: retry ? 'queued' : 'failed', errorCode: errorCode(error),
            ...(retry ? { runAt: new Date(date.getTime() + Math.max(retryDelayMs(job.attempts), providerRetryMs(error, date))) } : { finishedAt: date }),
        }, $unset: { lockToken: '', leaseUntil: '' } });
        return updated.matchedCount === 1;
    }
    async function cancelQueued(id, owner) {
        return Job.findOneAndUpdate({ _id: id, owner, state: 'queued' }, {
            $set: { state: 'cancelled', finishedAt: now() },
        }, { new: true });
    }
    return { enqueue, claim, renew, complete, fail, cancelQueued, leaseMs };
}

function createJobRunner({ queue, handlers, onError = (error) => console.error('Background job runner', { code: errorCode(error) }) }) {
    let processing = false;
    let stopping = false;
    let activeAbort;
    async function tick() {
        if (processing || stopping) return false;
        processing = true;
        let job;
        let heartbeat;
        try {
            job = await queue.claim();
            if (!job || stopping) return false;
            const controller = new AbortController();
            activeAbort = controller;
            let renewing = false;
            heartbeat = setInterval(async () => {
                if (renewing || controller.signal.aborted) return;
                renewing = true;
                try { if (!await queue.renew(job)) controller.abort(new JobLeaseLostError('Job lease lost.')); }
                catch (_) { controller.abort(new JobLeaseLostError('Job lease could not be renewed.')); }
                finally { renewing = false; }
            }, Math.floor(queue.leaseMs / 3));
            heartbeat.unref?.();
            const handler = handlers[job.type];
            if (!handler) throw new JobInputError('No handler registered for this job.');
            const result = await handler(job.payload, { job, signal: controller.signal });
            controller.signal.throwIfAborted();
            await queue.complete(job, result);
            return true;
        } catch (error) {
            if (job && !(error instanceof JobLeaseLostError) && !stopping) await queue.fail(job, error).catch(onError);
            onError(error);
            return false;
        } finally {
            clearInterval(heartbeat);
            activeAbort = undefined;
            processing = false;
        }
    }
    function stop() {
        stopping = true;
        activeAbort?.abort(new JobLeaseLostError('Worker stopping; job will be recovered.'));
    }
    return { tick, stop, get busy() { return processing; } };
}

module.exports = { createBackgroundJobService, createJobRunner, boundedJson, retryDelayMs, providerRetryMs, retryable, errorCode,
    JobInputError, JobConflictError, JobLeaseLostError };
