const mongoose = require('mongoose');
const Review = require('../models/Review');
const Product = require('../models/Product');
const cloudinary = require('../utils/cloudinary');
const visible = { deletedAt: null, $or: [{ moderationStatus: 'approved' }, { moderationStatus: { $exists: false } }] };
const failure = (statusCode, message) => Object.assign(new Error(message), { statusCode });
function objectId(value) {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw failure(400, 'Invalid review or product ID.');
    return value;
}
function content(body) {
    const rating = Number(body.rating), comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !comment || comment.length > 3000) throw failure(400, 'Provide a rating from 1 to 5 and a comment of 1–3,000 characters.');
    return { rating, comment };
}
function validateImage(buffer) {
    if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return;
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
    if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return;
    throw failure(400, 'Review photos must be JPEG, PNG or WebP images.');
}
async function cleanupPhotos(photos) {
    await Promise.allSettled(photos.map(photo => cloudinary.uploader.destroy(photo.publicId, { invalidate: true })));
}
async function uploadPhotos(files) {
    if (files.length > 5) throw failure(400, 'You can attach up to five photos.');
    for (const file of files) {
        if (!file.buffer || file.buffer.length > 5 * 1024 * 1024) throw failure(400, 'Each photo must be no larger than 5 MB.');
        validateImage(file.buffer);
    }
    if (!files.length) return [];
    if (!cloudinary.config().api_key || !cloudinary.config().api_secret || !cloudinary.config().cloud_name) throw failure(503, 'Photo uploads are temporarily unavailable.');
    const photos = [];
    try {
        for (const file of files) {
            const result = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream({
                    folder: 'naijago/review-photos', resource_type: 'image',
                    // Strip EXIF/GPS before storing the asset; re-encode and compress.
                    transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto:good', fetch_format: 'jpg', flags: 'force_strip' }],
                }, (error, value) => error ? reject(error) : resolve(value));
                stream.end(file.buffer);
            });
            if (!result?.secure_url || !result?.public_id) throw failure(502, 'Photo upload failed.');
            photos.push({ url: result.secure_url, publicId: result.public_id });
        }
        return photos;
    } catch (error) { await cleanupPhotos(photos); throw failure(error.statusCode || 502, 'Photo upload failed. Please try again.'); }
}
async function updateRating(product, session) {
    const rows = await Review.aggregate([
        { $match: { product: new mongoose.Types.ObjectId(String(product)), ...visible } },
        { $group: { _id: null, count: { $sum: 1 }, average: { $avg: '$rating' } } },
    ]).session(session);
    // Rating-only update never saves a stale Product inventory snapshot.
    await Product.updateOne({ _id: product }, { $set: { numReviews: rows[0]?.count || 0, averageRating: rows[0]?.average || 0 } }, { session });
}
async function mutate(callback) {
    const session = await mongoose.startSession();
    try { let result; await session.withTransaction(async () => { result = await callback(session); }); return result; }
    finally { await session.endSession(); }
}
function publicReview(doc) {
    const result = doc.toObject ? doc.toObject() : { ...doc };
    delete result.reports; delete result.reviewKey; delete result.moderatedBy; delete result.moderationReason;
    result.photos = (result.photos || []).map(photo => ({ url: photo.url }));
    return result;
}
module.exports = { visible, failure, objectId, content, uploadPhotos, cleanupPhotos, updateRating, mutate, publicReview };
