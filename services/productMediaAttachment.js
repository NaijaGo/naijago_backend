const mongoose = require('mongoose');
const MediaAsset = require('../models/MediaAsset');
const { MediaValidationError } = require('../utils/productVideoPolicy');

async function resolveProductVideoAttachment(value, user) {
    // Absence means keep existing media; empty string is an explicit removal.
    if (value === undefined) return { supplied: false };
    if (process.env.PRODUCT_VIDEO_ENABLED !== 'true') {
        throw new MediaValidationError('Product videos are not enabled yet.', 503);
    }
    if (value === '' || value === null) return { supplied: true, id: undefined };
    if (typeof value !== 'string' || !mongoose.isObjectIdOrHexString(value)) {
        throw new MediaValidationError('Invalid product video.');
    }
    const filter = { _id: value, status: { $in: ['pending_review', 'approved'] }, purpose: 'product_video' };
    // Even administrators attach only uploads from their own session. Review is
    // separate authority and must not allow guessing another uploader's asset.
    filter.owner = user._id;
    const asset = await MediaAsset.findOne(filter).select('_id').lean();
    if (!asset) throw new MediaValidationError('Finish uploading your video before saving the product.');
    return { supplied: true, id: asset._id };
}

module.exports = { resolveProductVideoAttachment };
