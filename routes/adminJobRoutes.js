const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const { objectId, text } = require('../utils/explorePolicy');

const RETRYABLE_TYPES = ['explore.notify', 'request.notify', 'media.cleanup', 'media.revoke'];
const SAFE_FIELDS = '_id type state attempts maxAttempts manualRetries runAt leaseUntil startedAt finishedAt createdAt updatedAt errorCode reviewHistory __v';

function createAdminJobsRouter({ Job, authenticate = protect, admin = authorizeRoles('admin'), now = () => new Date() }) {
    const router = express.Router();
    router.use(authenticate, admin);
    router.use(rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
        keyGenerator: (req) => String(req.user._id), message: { message: 'Please wait before checking jobs again.' } }));
    const wrap = (action) => async (req, res) => {
        try { await action(req, res); }
        catch (error) { res.status(error.status === 400 ? 400 : 503).json({ message: error.status === 400 ? error.message : 'Background jobs are temporarily unavailable.' }); }
    };
    router.get('/', wrap(async (req, res) => {
        const states = ['queued', 'running', 'completed', 'failed', 'cancelled'];
        if (req.query.state && !states.includes(req.query.state)) return res.status(400).json({ message: 'Select a valid job status.' });
        if (req.query.before) objectId(req.query.before, 'job cursor');
        const filter = { type: { $in: RETRYABLE_TYPES }, ...(req.query.state ? { state: req.query.state } : {}),
            ...(req.query.before ? { _id: { $lt: req.query.before } } : {}) };
        const rows = await Job.find(filter).select(SAFE_FIELDS).sort({ _id: -1 }).limit(26).lean();
        res.json({ jobs: rows.slice(0, 25), nextCursor: rows.length > 25 ? String(rows[24]._id) : null,
            workerRequired: true, retryableTypes: RETRYABLE_TYPES });
    }));
    router.post('/:id/retry', wrap(async (req, res) => {
        objectId(req.params.id, 'job');
        if (!Number.isInteger(req.body.revision) || req.body.revision < 0) return res.status(400).json({ message: 'Refresh this job before retrying.' });
        const reason = text(req.body.reason, 500, 'retry reason', true);
        // Paid preview generation and payment/capture/refund jobs are deliberately not exposed here. Retain
        // original dedupe/provider keys and creation date to avoid duplicate work.
        const date = now();
        const job = await Job.findOneAndUpdate({ _id: req.params.id, __v: req.body.revision, state: 'failed',
            type: { $in: RETRYABLE_TYPES }, createdAt: { $gt: new Date(date.getTime() - 7 * 86400000) },
            $or: [{ manualRetries: { $exists: false } }, { manualRetries: { $lt: 3 } }],
        }, { $set: { state: 'queued', attempts: 0, runAt: date, errorCode: '' },
            $unset: { lockToken: '', leaseUntil: '', finishedAt: '' },
            $inc: { __v: 1, manualRetries: 1 },
            $push: { reviewHistory: { actor: req.user._id, action: 'retry', reason, at: date } },
        }, { new: true, runValidators: true }).select(SAFE_FIELDS).lean();
        if (!job) return res.status(409).json({ message: 'Retry unavailable: the job changed, is older than seven days, or reached its retry limit. Refresh the list.' });
        res.json({ job });
    }));
    return router;
}
module.exports = createAdminJobsRouter({ Job: require('../models/BackgroundJob') });
module.exports.createAdminJobsRouter = createAdminJobsRouter;
module.exports.SAFE_FIELDS = SAFE_FIELDS;
