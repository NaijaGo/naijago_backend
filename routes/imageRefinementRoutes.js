const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const { RefinementError, id } = require('../utils/imageRefinementPolicy');
function createImageRefinementRouter({ service, ready = async () => true, authenticate = protect, admin = authorizeRoles('admin') }) {
    const router = express.Router();
    const wrap = (work) => async (req, res) => {
        try { await work(req, res); }
        catch (error) { res.status(error instanceof RefinementError ? error.status : 503).json({
            message: error instanceof RefinementError ? error.message : 'Image review is temporarily unavailable. Refresh to check its status.',
        }); }
    };
    router.use(authenticate, admin, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.use(rateLimit({ windowMs: 60000, limit: 90, keyGenerator: (req) => String(req.user._id), standardHeaders: 'draft-7', legacyHeaders: false,
        message: { message: 'Please wait before checking image reviews again.' } }));
    router.get('/config', wrap(async (_req, res) => {
        let databaseReady = false;
        if (service.enabled()) { try { databaseReady = await ready(); } catch (_) {} }
        res.json({ ...service.configuration(), enabled: service.enabled(), processingEnabled: service.processingEnabled() && databaseReady, databaseReady,
            workerStatus: 'not_verified' });
    }));
    router.use(async (_req, res, next) => {
        try { if (service.enabled() && await ready()) return next(); } catch (_) {}
        res.status(503).json({ message: 'Image refinement is not enabled or is still preparing.' });
    });
    const writeLimit = rateLimit({ windowMs: 60000, limit: 10, keyGenerator: (req) => String(req.user._id), standardHeaders: 'draft-7', legacyHeaders: false,
        message: { message: 'Please wait before starting another image batch.' } });
    router.get('/', wrap(async (req, res) => res.json(await service.list({ state: req.query.state, before: req.query.before, productId: req.query.productId }))));
    router.post('/preview', wrap(async (req, res) => res.json(await service.previewBatch({ productIds: req.body?.productIds }))));
    router.post('/batch', writeLimit, wrap(async (req, res) => {
        const input = req.body || {};
        if (!Array.isArray(input.productIds) || !input.productIds.length || input.productIds.length > 20) throw new RefinementError('Select between 1 and 20 products.');
        input.productIds.forEach(id);
        if (input.rightsConfirmed !== true) throw new RefinementError('Confirm permission to send these product images to the processing provider.');
        res.status(202).json(await service.requestBatch({ productIds: input.productIds, actor: req.user._id, profile: input.profile || 'standard' }));
    }));
    router.get('/:id', wrap(async (req, res) => res.json(await service.get(req.params.id))));
    router.put('/:id', writeLimit, wrap(async (req, res) => res.json(await service.review({ refinementId: req.params.id, actor: req.user._id, input: req.body || {} }))));
    return router;
}
module.exports = createImageRefinementRouter(require('../services/imageRefinementRuntime'));
module.exports.createImageRefinementRouter = createImageRefinementRouter;
