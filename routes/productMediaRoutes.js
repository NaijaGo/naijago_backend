const express = require('express');
const mongoose = require('mongoose');
const { rateLimit } = require('express-rate-limit');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const Product = require('../models/Product');
const MediaAsset = require('../models/MediaAsset');
const cloudinary = require('../utils/cloudinary');
const { createProductVideoService } = require('../services/productVideoService');
const {
    VIDEO_POLICY_VERSION, VIDEO_WARNINGS, MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS,
    ALLOWED_VIDEO_MIMES, MediaValidationError,
} = require('../utils/productVideoPolicy');

const router = express.Router();
const service = createProductVideoService({ cloudinary, MediaAsset });
const enabled = () => process.env.PRODUCT_VIDEO_ENABLED === 'true';
const isAdmin = (user) => user?.isAdmin === true || user?.role === 'admin';
const uploadLimit = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 6, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => String(req.user._id),
    message: { message: 'Too many video uploads. Please try again in a few minutes.' },
});
const validId = (value) => typeof value === 'string' && mongoose.isObjectIdOrHexString(value);

function handleError(res, error) {
    if (error instanceof MediaValidationError) return res.status(error.status).json({ message: error.message });
    if (error.name === 'VersionError') {
        return res.status(409).json({ message: 'This video changed. Refresh it and try again.' });
    }
    // Provider errors can contain credentials or full request headers.
    console.error('Product media operation failed', { name: error.name, code: error.code, httpCode: error.http_code });
    return res.status(503).json({ message: 'Video processing is unavailable right now. Please retry shortly.' });
}

router.get('/config', (_req, res) => {
    const config = cloudinary.config();
    res.json({
        enabled: enabled() && Boolean(config.cloud_name && config.api_key && config.api_secret),
        policyVersion: VIDEO_POLICY_VERSION, warnings: VIDEO_WARNINGS,
        maxBytes: MAX_VIDEO_BYTES, maxSeconds: MAX_VIDEO_SECONDS,
        mimeTypes: ALLOWED_VIDEO_MIMES,
    });
});

router.get('/products/:productId', async (req, res) => {
    if (!enabled()) return res.json({ videos: [] });
    if (!validId(req.params.productId)) return res.status(400).json({ message: 'Invalid product.' });
    try {
        const product = await Product.findOne({
            _id: req.params.productId,
            moderationStatus: 'approved', productStatus: { $in: ['active', 'out_of_stock'] },
        }).select('videoAssetId').lean();
        if (!product) return res.status(404).json({ message: 'Product not available.' });
        const asset = product.videoAssetId
            ? await MediaAsset.findOne({ _id: product.videoAssetId, status: 'approved' }).lean()
            : null;
        return res.json({ videos: asset ? [service.serialize(asset)] : [] });
    } catch (error) { return handleError(res, error); }
});

router.use(protect);
router.use((req, res, next) => {
    if (!enabled()) return res.status(503).json({ message: 'Product videos are not enabled yet.' });
    return next();
});

router.post('/uploads', authorizeRoles('vendor', 'admin'), uploadLimit, async (req, res) => {
    try {
        if (!isAdmin(req.user) && req.user.vendorStatus !== 'approved') {
            return res.status(403).json({ message: 'Only approved vendors can upload product videos.' });
        }
        const ticket = await service.issueUpload(req.user._id, req.body);
        return res.status(201).json(ticket);
    } catch (error) { return handleError(res, error); }
});

async function ownAsset(req) {
    if (!validId(req.params.assetId)) throw new MediaValidationError('Invalid video.');
    const asset = await MediaAsset.findById(req.params.assetId);
    if (!asset || (!isAdmin(req.user) && String(asset.owner) !== String(req.user._id))) {
        throw new MediaValidationError('Video not found.', 404);
    }
    return asset;
}

router.get('/assets/:assetId', authorizeRoles('vendor', 'admin'), async (req, res) => {
    try { return res.json(service.serialize(await ownAsset(req), { preview: true })); }
    catch (error) { return handleError(res, error); }
});

router.post('/assets/:assetId/complete', authorizeRoles('vendor', 'admin'), async (req, res) => {
    try { return res.json(await service.completeUpload(await ownAsset(req))); }
    catch (error) { return handleError(res, error); }
});

router.get('/review', authorizeRoles('admin'), async (req, res) => {
    try {
        const status = ['pending_review', 'approved', 'rejected'].includes(req.query.status)
            ? req.query.status : 'pending_review';
        const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
        const assets = await MediaAsset.find({ status }).sort({ createdAt: -1, _id: -1 })
            .skip((page - 1) * 20).limit(21).populate('owner', 'businessName').lean();
        const results = assets.slice(0, 20);
        const products = await Product.find({ videoAssetId: { $in: results.map((asset) => asset._id) } })
            .select('name videoAssetId').lean();
        const productByAsset = new Map(products.map((product) => [String(product.videoAssetId), product]));
        return res.json({
            page, hasMore: assets.length > 20,
            videos: results.map((asset) => ({
                ...service.serialize(asset, { preview: true }),
                ownerName: asset.owner?.businessName || 'NaijaGo',
                product: productByAsset.get(String(asset._id)) || null,
                createdAt: asset.createdAt,
            })),
        });
    } catch (error) { return handleError(res, error); }
});

router.put('/assets/:assetId/review', authorizeRoles('admin'), async (req, res) => {
    try {
        const { status, revision } = req.body;
        const reason = String(req.body.reason || '').trim();
        if (!['approved', 'rejected'].includes(status) || reason.length > 1000 ||
            (status === 'rejected' && !reason)) {
            throw new MediaValidationError('Select approve or reject; a rejection requires a reason (up to 1000 characters).');
        }
        const asset = await ownAsset(req);
        if (!['pending_review', 'approved', 'rejected'].includes(asset.status)) {
            throw new MediaValidationError('Only a verified upload can be reviewed.', 409);
        }
        if (!Number.isInteger(revision) || revision !== asset.__v) {
            throw new MediaValidationError('This video changed. Refresh it before reviewing.', 409);
        }
        if (asset.status !== status || asset.rejectionReason !== reason) {
            asset.status = status;
            asset.rejectionReason = status === 'rejected' ? reason : '';
            asset.reviewedBy = req.user._id;
            asset.reviewedAt = new Date();
            asset.reviewHistory.push({ actor: req.user._id, action: status, reason });
            await asset.save();
        }
        return res.json(service.serialize(asset, { preview: true }));
    } catch (error) { return handleError(res, error); }
});

module.exports = router;
