const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const { RefinementError, id } = require('../utils/imageRefinementPolicy');
function createImageRefinementRouter({ service, ready = async () => true, inspectReadiness, initializeDatabase, authenticate = protect, admin = authorizeRoles('admin') }) {
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
    const writeLimit = rateLimit({ windowMs: 60000, limit: 10, keyGenerator: (req) => String(req.user._id), standardHeaders: 'draft-7', legacyHeaders: false,
        message: { message: 'Please wait before starting another image batch or setup request.' } });
    router.get('/config', wrap(async (_req, res) => {
        let databaseReady = false;
        let databaseChecks = [];
        if (service.enabled()) {
            try {
                if (inspectReadiness) {
                    const report = await inspectReadiness(); databaseReady = report.ready; databaseChecks = report.checks;
                } else databaseReady = await ready();
            } catch (_) {}
        }
        res.json({ ...service.configuration(), enabled: service.enabled(), processingEnabled: service.processingEnabled() && databaseReady, databaseReady,
            databaseChecks, workerStatus: 'not_verified',
            setupAvailable: typeof initializeDatabase === 'function' && service.enabled() && !databaseReady && databaseChecks.length === 3 &&
                databaseChecks.every(check => ['ready', 'collection_missing', 'missing_indexes'].includes(check.status)) });
    }));
    // Setup must be reachable before the missing-index readiness gate. It remains
    // behind Admin authentication, the feature gate, rate limiting and explicit consent.
    router.post('/setup', writeLimit, wrap(async (req, res) => {
        const input = req.body || {};
        if (input.confirmation !== 'CREATE_IMAGE_STUDIO_COLLECTIONS_AND_INDEXES' || Object.keys(input).length !== 1) {
            throw new RefinementError('Confirm creation of only the Image Studio collections and required indexes.');
        }
        if (!service.enabled() || typeof initializeDatabase !== 'function') throw new RefinementError('Image Studio database setup is unavailable.', 503);
        const report = await initializeDatabase();
        const databaseReady = report.status === 'READY';
        console.info('Image Studio database setup:', { actor: String(req.user._id), status: report.status });
        res.status(databaseReady ? 200 : 409).json({ ready: databaseReady, checks: report.after?.checks || report.before?.checks || [],
            message: databaseReady ? 'Image Studio collections and indexes are ready. No images were queued or processed. Worker/provider operation still needs verification.'
                : report.reason || 'Database setup needs operator review. Refresh setup status before retrying.' });
    }));
    router.use(async (_req, res, next) => {
        try { if (service.enabled() && await ready()) return next(); } catch (_) {}
        res.status(503).json({ message: 'Image refinement is not enabled or is still preparing.' });
    });
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
