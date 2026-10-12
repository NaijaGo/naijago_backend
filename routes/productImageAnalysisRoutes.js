const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { protect } = require('../middleware/authMiddleware');
const { isCatalogAdmin, isApprovedVendor, isApprovedPharmacistVendor } = require('../utils/productPermissions');
const analysis = require('../services/productImageAnalysisService');
const Product = require('../models/Product');

// Process-local limits complement the provider/project budget. No DB writes.
function createRouter({ authenticate = protect, service = analysis, products = Product, env = process.env,
    clock = Date.now } = {}) {
    const router = express.Router();
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 } }).single('image');
    const limiter = rateLimit({ windowMs: 60000, limit: 3, keyGenerator: req => String(req.user._id),
        standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Wait a minute before analyzing more photos.' } });
    const daily = new Map(); let day = '', total = 0, running = 0;
    router.use(authenticate, (req, res, next) => {
        if (!isCatalogAdmin(req.user) && !isApprovedVendor(req.user)) return res.status(403).json({ message: 'An administrator or approved vendor account is required.' });
        next();
    });
    router.get('/config', (req, res) => res.json({ ...service.configuration(env), maxImageBytes: 5 * 1024 * 1024, reviewRequired: true }));
    router.post('/', limiter, (req, res, next) => {
        if (!service.configuration(env).enabled) return res.status(503).json({ message: 'AI suggestions are unavailable. Enter product details manually.' });
        upload(req, res, error => {
            if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ message: 'Upload exactly one JPEG, PNG or WebP image, up to 5 MB, without extra fields.' });
            next();
        });
    }, async (req, res) => {
        try { service.imageMime(req.file?.buffer); } catch (error) { return res.status(400).json({ message: error.message }); }
        const today = new Date(clock()).toISOString().slice(0, 10);
        if (today !== day) { day = today; total = 0; daily.clear(); }
        const key = String(req.user._id), used = daily.get(key) || 0;
        const configuredLimit = Number(env.PRODUCT_IMAGE_ANALYSIS_DAILY_LIMIT);
        const limit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? Math.min(configuredLimit, 1000) : 100;
        if (used >= 20 || total >= limit || running >= 2) return res.status(429).json({ message: 'Image analysis limit reached. Enter details manually or try later.' });
        daily.set(key, used + 1); total++; running++;
        try {
            const result = await service.analyze(req.file.buffer, { env });
            if (result.restricted.medicine && !isCatalogAdmin(req.user) && !isApprovedPharmacistVendor(req.user)) {
                result.classification = null; result.needsManualCategory = true;
                result.warnings.unshift('This account is not eligible to list medicine. An approved pharmacist vendor is required.');
            }
            // Advisory exact-name matches from this account only: never leak
            // another vendor's private listings or save/merge duplicates.
            let possibleDuplicates = [], duplicateCheckAvailable = false;
            if (result.suggestions.name) {
                try {
                    const escaped = result.suggestions.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const owner = isCatalogAdmin(req.user) ? { sellerType: 'naijago' } :
                        { sellerType: 'vendor', $or: [{ sellerId: req.user._id }, { vendor: req.user._id }] };
                    const rows = await products.find({ ...owner, name: { $regex: `^${escaped}$`, $options: 'i' } })
                        .select('_id name brand').limit(5).maxTimeMS(1500).lean();
                    possibleDuplicates = rows.map(row => ({ id: String(row._id), name: row.name, brand: row.brand || '' }));
                    duplicateCheckAvailable = true;
                } catch (_) { result.warnings.push('Duplicate lookup unavailable. Check existing listings before saving.'); }
            }
            res.json({ ...result, possibleDuplicates, duplicateCheckAvailable });
        } catch (error) {
            res.status(error instanceof analysis.AnalysisError ? error.status : 502).json({ message:
                error instanceof analysis.AnalysisError ? error.message : 'Image analysis failed. Enter product details manually.' });
        } finally { running--; }
    });
    return router;
}
module.exports = { createRouter };
