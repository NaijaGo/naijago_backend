const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const Review = require('../models/Review');
const Product = require('../models/Product');
const Shipment = require('../models/Shipment');
const MainOrder = require('../models/MainOrder');
const service = require('../services/reviewService');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 5, fileSize: 5 * 1024 * 1024, fields: 3, fieldSize: 12000, parts: 8 } }).array('photos', 5);
const writeLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
        res.status(error.code === 11000 ? 409 : error.statusCode || 500).json({ message: error.code === 11000 ? 'You have already reviewed this product.' : error.statusCode ? error.message : 'Reviews are temporarily unavailable. Please try again.' });
    }
};
const paginate = req => {
    const page = Number(req.query.page || 1), limit = Number(req.query.limit || 20);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw service.failure(400, 'Invalid pagination.');
    return { page, limit };
};
async function list(req, filter, admin = false) {
    const { page, limit } = paginate(req);
    const [rows, total] = await Promise.all([
        Review.find(filter).populate('product', 'name imageUrls').populate('user', 'firstName lastName').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Review.countDocuments(filter),
    ]);
    return { reviews: admin ? rows : rows.map(service.publicReview), total, page, hasMore: page * limit < total };
}
router.get('/myreviews', protect, wrap(async (req, res) => {
    // Preserve the array contract for existing clients.
    const rows = await Review.find({ user: req.user._id, deletedAt: null }).populate('product', 'name imageUrls').populate('user', 'firstName lastName').sort({ createdAt: -1 }).lean();
    res.json(rows.map(service.publicReview));
}));
router.get('/admin', protect, authorizeRoles('admin'), wrap(async (req, res) => {
    const filter = { deletedAt: null };
    if (req.query.status === 'reported') filter['reports.0'] = { $exists: true };
    else if (['approved', 'pending', 'rejected'].includes(req.query.status)) filter.moderationStatus = req.query.status;
    else filter.moderationStatus = 'pending';
    res.json(await list(req, filter, true));
}));
router.get('/', wrap(async (req, res) => {
    res.json(await list(req, { product: service.objectId(req.query.productId), ...service.visible }));
}));
router.post('/', protect, writeLimit, (req, res, next) => {
    if (!req.is('multipart/form-data')) return next();
    upload(req, res, error => error ? res.status(400).json({ message: 'Attach up to five JPEG, PNG or WebP photos, at most 5 MB each.' }) : next());
}, wrap(async (req, res) => {
    const productId = service.objectId(req.body.productId), fields = service.content(req.body);
    if (!await Product.exists({ _id: productId })) throw service.failure(404, 'Product not found.');
    if (await Review.exists({ product: productId, user: req.user._id })) throw service.failure(409, 'You have already reviewed this product.');
    const orders = await MainOrder.find({ user: req.user._id, isPaid: true, mainOrderStatus: { $ne: 'cancelled' } }).select('_id').lean();
    if (!orders.length || !await Shipment.exists({ mainOrder: { $in: orders.map(order => order._id) }, 'items.product': productId, shipmentStatus: { $nin: ['cancelled', 'rejected'] } })) throw service.failure(403, 'You can only review products you have purchased.');
    const photos = await service.uploadPhotos(req.files || []);
    let review;
    try {
        review = await service.mutate(async session => {
            const [created] = await Review.create([{ product: productId, user: req.user._id, ...fields, photos, verifiedPurchase: true, reviewKey: `${req.user._id}:${productId}`, moderationStatus: photos.length ? 'pending' : 'approved' }], { session });
            await service.updateRating(productId, session);
            return created;
        });
    } catch (error) { await service.cleanupPhotos(photos); throw error; }
    res.status(201).json({ message: photos.length ? 'Review submitted. Photos will appear after moderation.' : 'Review added successfully!', review: service.publicReview(review) });
}));
router.put('/:id', protect, writeLimit, wrap(async (req, res) => {
    const id = service.objectId(req.params.id), fields = service.content(req.body);
    const review = await service.mutate(async session => {
        const row = await Review.findOne({ _id: id, user: req.user._id, deletedAt: null }).session(session);
        if (!row) throw service.failure(404, 'Review not found.');
        Object.assign(row, fields, { moderationStatus: 'pending', moderationReason: '' });
        await row.save({ session }); await service.updateRating(row.product, session); return row;
    });
    res.json({ review: service.publicReview(review) });
}));
router.post('/:id/report', protect, writeLimit, wrap(async (req, res) => {
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason || reason.length > 500) throw service.failure(400, 'Provide a report reason of up to 500 characters.');
    const row = await Review.findOneAndUpdate({ _id: service.objectId(req.params.id), ...service.visible, 'reports.user': { $ne: req.user._id } }, { $push: { reports: { user: req.user._id, reason, createdAt: new Date() } } });
    if (!row) throw service.failure(409, 'Review unavailable or already reported.');
    res.json({ message: 'Report received for moderation.' });
}));
router.put('/:id/moderation', protect, authorizeRoles('admin'), wrap(async (req, res) => {
    const status = req.body.status, reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!['approved', 'rejected'].includes(status) || reason.length > 500 || (status === 'rejected' && !reason)) throw service.failure(400, 'Choose approve or reject and provide a reason for rejection.');
    const review = await service.mutate(async session => {
        const row = await Review.findOneAndUpdate({ _id: service.objectId(req.params.id), deletedAt: null }, { $set: { moderationStatus: status, moderationReason: reason, moderatedBy: req.user._id }, $unset: { reports: 1 } }, { new: true, session });
        if (!row) throw service.failure(404, 'Review not found.');
        await service.updateRating(row.product, session); return row;
    });
    res.json({ review: service.publicReview(review) });
}));
router.delete('/:id', protect, wrap(async (req, res) => {
    const review = await service.mutate(async session => {
        const row = await Review.findOneAndUpdate({ _id: service.objectId(req.params.id), deletedAt: null, ...(req.user.isAdmin ? {} : { user: req.user._id }) }, { $set: { deletedAt: new Date() } }, { new: true, session });
        if (!row) throw service.failure(404, 'Review not found.');
        await service.updateRating(row.product, session); return row;
    });
    await service.cleanupPhotos(review.photos || []);
    res.json({ message: 'Review removed.' });
}));
module.exports = router;
