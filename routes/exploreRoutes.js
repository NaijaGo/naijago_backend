const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const { REACTIONS, UGC_POLICY_VERSION, objectId, text, parseTarget } = require('../utils/explorePolicy');

function createExploreRouter({ explore, interactions, FeedComment, FeedReport, UserBlock, User, Product, CarouselSlide,
    authenticate = protect, admin = authorizeRoles('admin'), vendor = authorizeRoles('vendor', 'admin'),
    enabled = () => process.env.EXPLORE_ENABLED === 'true',
    ready = async () => true,
}) {
    const router = express.Router();
    const wrap = (action) => async (req, res) => {
        try { await action(req, res); }
        catch (error) {
            const status = [400, 403, 404, 409, 429].includes(error.status) ? error.status : 503;
            if (status === 503) console.error('Explore operation unavailable', { name: error.name, code: error.code });
            res.status(status).json({ message: status === 503 ? 'Explore is temporarily unavailable. Please retry shortly.' : error.message });
        }
    };
    router.get('/config', wrap(async (_req, res) => res.json({ enabled: enabled() && await ready(), reactions: REACTIONS, policyVersion: UGC_POLICY_VERSION,
        guidelines: ['Keep comments respectful and relevant.', 'No nudity, violence, hate, scams or personal information.',
            'Only share content you have permission to use.', 'Report harmful content; you can block an account.',
            'Moderators may remove content that breaks these rules.'] })));
    router.use(authenticate);
    router.use((req, res, next) => {
        if (!enabled()) return res.status(503).json({ message: 'Explore is not enabled yet.' });
        if (req.user.constructor?.modelName !== 'User') return res.status(403).json({ message: 'Use your customer or vendor account for Explore.' });
        next();
    });
    router.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
        keyGenerator: (req) => String(req.user._id), message: { message: 'Please slow down and try again shortly.' } }));
    router.use(async (_req, res, next) => {
        try {
            if (await ready()) return next();
        } catch (_) { /* Fail closed until required indexes exist. */ }
        res.status(503).json({ message: 'Explore is preparing. Please retry shortly.' });
    });
    const writeLimit = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
        keyGenerator: (req) => String(req.user._id), message: { message: 'Too many changes. Please wait a minute.' } });
    const args = (req) => ({ type: req.params.type, id: req.params.id, userId: req.user._id });

    router.get('/feed', wrap(async (req, res) => res.json(await explore.feed({ before: req.query.before, limit: req.query.limit || 20, userId: req.user._id }))));
    router.get('/items/:type/:id', wrap(async (req, res) => {
        await interactions.requireTarget(req.params.type, req.params.id, req.user._id);
        const stats = await explore.statistics([{ type: req.params.type, id: req.params.id }], req.user._id);
        res.json(stats.get(`${req.params.type}:${req.params.id}`));
    }));
    router.put('/items/:type/:id/reaction', writeLimit, wrap(async (req, res) => res.json(await interactions.react({ ...args(req), reaction: req.body.reaction }))));
    router.get('/items/:type/:id/comments', wrap(async (req, res) => res.json(await interactions.comments({ ...args(req), parent: req.query.parent, before: req.query.before }))));
    router.post('/items/:type/:id/comments', writeLimit, wrap(async (req, res) => res.status(201).json(await interactions.addComment({ ...args(req), input: req.body }))));
    router.post('/items/:type/:id/views', wrap(async (req, res) => res.json(await interactions.startView(args(req)))));
    router.post('/views/:id/complete', wrap(async (req, res) => res.json(await interactions.finishView({ viewId: req.params.id, userId: req.user._id, watchedMilliseconds: req.body.watchedMilliseconds }))));
    router.delete('/comments/:id', writeLimit, wrap(async (req, res) => {
        objectId(req.params.id, 'comment');
        const result = await FeedComment.updateOne({ _id: req.params.id, user: req.user._id, state: { $ne: 'deleted' } }, { $set: { state: 'deleted', body: '[Comment removed]' } });
        if (!result.matchedCount) return res.status(404).json({ message: 'Comment not found.' });
        res.json({ deleted: true });
    }));
    router.get('/blocks', wrap(async (req, res) => {
        if (req.query.before) objectId(req.query.before, 'block cursor');
        const rows = await UserBlock.find({ user: req.user._id, ...(req.query.before ? { _id: { $lt: req.query.before } } : {}) })
            .sort({ _id: -1 }).limit(31).populate('blockedUser', 'firstName businessName').lean();
        res.json({ blocks: rows.slice(0, 30).map((row) => ({ id: String(row._id), userId: String(row.blockedUser?._id || ''), name: row.blockedUser?.businessName || row.blockedUser?.firstName || 'Account' })),
            nextCursor: rows.length > 30 ? String(rows[29]._id) : null });
    }));
    router.put('/blocks/:id', writeLimit, wrap(async (req, res) => {
        objectId(req.params.id, 'account');
        if (String(req.user._id) === req.params.id) return res.status(400).json({ message: 'You cannot block your own account.' });
        if (!await User.exists({ _id: req.params.id })) return res.status(404).json({ message: 'Account not found.' });
        const identity = { user: req.user._id, blockedUser: req.params.id };
        try { await UserBlock.updateOne(identity, { $setOnInsert: identity }, { upsert: true }); }
        catch (error) { if (error.code !== 11000) throw error; }
        res.json({ blocked: true });
    }));
    router.delete('/blocks/:id', writeLimit, wrap(async (req, res) => {
        objectId(req.params.id, 'account');
        await UserBlock.deleteOne({ user: req.user._id, blockedUser: req.params.id });
        res.json({ blocked: false });
    }));
    router.post('/reports', writeLimit, wrap(async (req, res) => {
        const { targetType, target, reason } = req.body;
        if (!['spam', 'misleading', 'inappropriate', 'harassment', 'rights', 'other'].includes(reason)) return res.status(400).json({ message: 'Select a report reason.' });
        objectId(target, 'reported item');
        if (targetType === 'comment') {
            const comment = await FeedComment.findOne({ _id: target, state: 'visible' }).lean();
            if (!comment) return res.status(404).json({ message: 'Comment unavailable.' });
            await interactions.requireTarget(comment.targetType, String(comment.target), req.user._id);
        } else { parseTarget(targetType, target); await interactions.requireTarget(targetType, target, req.user._id); }
        const identity = { reporter: req.user._id, targetType, target };
        try { await FeedReport.updateOne(identity, { $setOnInsert: { ...identity, reason, details: text(req.body.details, 1000, 'report details') } }, { upsert: true, runValidators: true }); }
        catch (error) { if (error.code !== 11000) throw error; }
        res.status(201).json({ message: 'Report received. The NaijaGo team will review it.' });
    }));
    router.get('/vendor/activity', vendor, wrap(async (req, res) => {
        if (req.query.before) objectId(req.query.before, 'activity cursor');
        // Indexed ownership lookup avoids accepting a vendor ID from the client.
        const products = await Product.find({ vendor: req.user._id }).select('_id').lean();
        const campaigns = await CarouselSlide.find({ vendor: req.user._id, placement: 'explore' }).select('_id').lean();
        const rows = await FeedComment.find({ state: 'visible', user: { $nin: [req.user._id, ...await explore.blockedUsers(req.user._id)] },
            $or: [{ targetType: 'product', target: { $in: products.map((p) => p._id) } }, { targetType: 'campaign', target: { $in: campaigns.map((p) => p._id) } }],
            ...(req.query.before ? { _id: { $lt: req.query.before } } : {}),
        }).sort({ _id: -1 }).limit(21).populate('user', 'firstName').lean();
        res.json({ comments: rows.slice(0, 20).map((row) => ({ id: String(row._id), targetType: row.targetType, target: String(row.target),
            body: row.body, authorName: row.user?.firstName || 'NaijaGo member', parent: row.parent, createdAt: row.createdAt })), nextCursor: rows.length > 20 ? String(rows[19]._id) : null });
    }));
    router.get('/admin/reports', admin, wrap(async (req, res) => {
        if (req.query.before) objectId(req.query.before, 'report cursor');
        const state = ['open', 'resolved', 'dismissed'].includes(req.query.state) ? req.query.state : 'open';
        const rows = await FeedReport.find({ state, ...(req.query.before ? { _id: { $lt: req.query.before } } : {}) }).sort({ _id: -1 }).limit(21).lean();
        const comments = await FeedComment.find({ _id: { $in: rows.filter((row) => row.targetType === 'comment').map((row) => row.target) } }).select('body target targetType state').lean();
        const byId = new Map(comments.map((row) => [String(row._id), row]));
        res.json({ reports: rows.slice(0, 20).map((row) => ({ ...row, comment: byId.get(String(row.target)) || null })), nextCursor: rows.length > 20 ? String(rows[19]._id) : null });
    }));
    router.put('/admin/reports/:id', admin, writeLimit, wrap(async (req, res) => {
        objectId(req.params.id, 'report');
        if (!['resolved', 'dismissed'].includes(req.body.state)) return res.status(400).json({ message: 'Select a review outcome.' });
        const resolution = text(req.body.resolution, 1000, 'review reason', true);
        await FeedReport.db.transaction(async (session) => {
            const report = await FeedReport.findById(req.params.id).session(session);
            if (!report) throw Object.assign(new Error('Report not found.'), { status: 404 });
            if (!Number.isInteger(req.body.revision) || req.body.revision !== report.__v) throw Object.assign(new Error('This report changed. Refresh before reviewing.'), { status: 409 });
            if (req.body.hideComment === true) {
                if (report.targetType !== 'comment' || req.body.state !== 'resolved') throw Object.assign(new Error('Only resolved comment reports can hide a comment.'), { status: 400 });
                await FeedComment.updateOne({ _id: report.target, state: 'visible' }, { $set: { state: 'hidden', moderatedBy: req.user._id, moderationReason: resolution, moderatedAt: new Date() } }, { session });
            }
            report.state = req.body.state; report.resolution = resolution; report.reviewedBy = req.user._id; report.reviewedAt = new Date();
            report.reviewHistory.push({ actor: req.user._id, action: req.body.hideComment ? 'hide_comment' : req.body.state, reason: resolution });
            await report.save({ session });
        });
        res.json({ reviewed: true });
    }));
    return router;
}
const runtime = require('../services/exploreRuntime');
module.exports = createExploreRouter({ ...runtime, FeedComment: require('../models/FeedComment'), FeedReport: require('../models/FeedReport'),
    UserBlock: require('../models/UserBlock'), User: require('../models/User'), Product: require('../models/Product'), CarouselSlide: require('../models/CarouselSlide').CarouselSlide });
module.exports.createExploreRouter = createExploreRouter;
