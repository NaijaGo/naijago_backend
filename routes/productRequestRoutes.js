const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const { RequestInputError } = require('../utils/productRequestPolicy');
function createProductRequestRouter({ service, ready = async () => true, authenticate = protect, admin = authorizeRoles('admin') }) {
    const router = express.Router();
    const wrap = (work) => async (req, res) => {
        try { await work(req, res); }
        catch (error) {
            const safe = error instanceof RequestInputError;
            const status = safe && [400, 403, 404, 409, 429, 503].includes(error.status) ? error.status : 503;
            res.status(status).json({ message: safe ? error.message : 'Product requests are temporarily unavailable. Please try again.' });
        }
    };
    router.get('/config', wrap(async (_req, res) => {
        const enabled = service.enabled() && await ready();
        res.json({ enabled, previewEnabled: enabled && service.previewEnabled() });
    }));
    router.use(authenticate);
    router.get('/admin', admin, wrap(async (req, res) => res.json(await service.list({ admin: true, state: req.query.state, before: req.query.before, query: req.query.query }))));
    router.get('/admin/:id', admin, wrap(async (req, res) => res.json(await service.get({ owner: req.user._id, requestId: req.params.id, admin: true }))));
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (!service.enabled()) return res.status(503).json({ message: 'Product requests are not enabled yet.' });
        if (req.user.constructor?.modelName !== 'User') return res.status(403).json({ message: 'Use your customer account for product requests.' });
        next();
    });
    router.use(rateLimit({ windowMs: 60000, limit: 90, keyGenerator: (req) => String(req.user._id), standardHeaders: 'draft-7', legacyHeaders: false,
        message: { message: 'Please wait before checking requests again.' } }));
    router.use(async (_req, res, next) => {
        try { if (await ready()) return next(); } catch (_) {}
        res.status(503).json({ message: 'Product requests are preparing. Please try again shortly.' });
    });
    const writeLimit = rateLimit({ windowMs: 60000, limit: 10, keyGenerator: (req) => String(req.user._id), standardHeaders: 'draft-7', legacyHeaders: false,
        message: { message: 'Too many requests. Please wait a minute.' } });
    const args = (req) => ({ owner: req.user._id, requestId: req.params.id, input: req.body || {} });
    router.put('/admin/:id', admin, writeLimit, wrap(async (req, res) => res.json(await service.update({ ...args(req), admin: true }))));
    router.get('/', wrap(async (req, res) => res.json(await service.list({ owner: req.user._id, state: req.query.state, before: req.query.before }))));
    router.post('/', writeLimit, wrap(async (req, res) => res.status(201).json(await service.create(args(req)))));
    router.get('/:id', wrap(async (req, res) => res.json(await service.get(args(req)))));
    router.get('/:id/product', wrap(async (req, res) => res.json(await service.matched(args(req)))));
    router.put('/:id', writeLimit, wrap(async (req, res) => res.json(await service.update(args(req)))));
    router.post('/:id/preview', writeLimit, wrap(async (req, res) => res.status(202).json(await service.generate(args(req)))));
    return router;
}
module.exports = createProductRequestRouter(require('../services/productRequestRuntime'));
module.exports.createProductRequestRouter = createProductRequestRouter;
