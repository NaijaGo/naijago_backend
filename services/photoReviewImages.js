'use strict';
const { PlanningError, fail, id } = require('../utils/orderPlanningPolicy');
const { photoFormat, MAX_BYTES } = require('../utils/photoReviewPolicy');
const THUMBNAIL = 'c_limit,h_320,w_320,f_jpg,q_75,fl_force_strip';
// Incoming transformation, not merely a delivery transform: metadata must not
// survive in the stored review asset. Not an AI alteration of a customer's photo.
const SANITIZE = 'c_limit,h_1600,w_1600,f_jpg,q_80,fl_force_strip';

function createPhotoReviewImages({ cloudinary, now = () => new Date() }) {
    function configured() {
        const config = cloudinary.config();
        if (!config.cloud_name || !config.api_key || !config.api_secret) fail('PHOTO_STORAGE_UNAVAILABLE', 'Review photo uploads are not configured.', 503);
    }
    const key = (owner, assetId) => `naijago/review_photos/${id(owner)}/${id(assetId)}`;
    function describe(result, expected) {
        if (!result || result.public_id !== expected || result.resource_type !== 'image' || result.type !== 'authenticated' ||
            result.format !== 'jpg' || !Number.isSafeInteger(result.version) || result.version < 1 ||
            !Number.isSafeInteger(result.width) || result.width < 1 || result.width > 1600 ||
            !Number.isSafeInteger(result.height) || result.height < 1 || result.height > 1600 ||
            !Number.isSafeInteger(result.bytes) || result.bytes < 1 || result.bytes > MAX_BYTES) {
            fail('PHOTO_PROCESSING_INVALID', 'The photo could not be processed safely. Please choose another photo.', 502);
        }
        return { publicId: result.public_id, version: result.version, format: result.format,
            width: result.width, height: result.height, bytes: result.bytes, storageType: 'authenticated' };
    }
    async function process({ owner, assetId, bytes, signal }) {
        const format = photoFormat(bytes); configured(); signal?.throwIfAborted();
        const publicId = key(owner, assetId);
        const mime = { jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic' }[format];
        let result;
        try {
            result = await cloudinary.uploader.upload(`data:${mime};base64,${bytes.toString('base64')}`, {
                resource_type: 'image', type: 'authenticated', public_id: publicId,
                overwrite: false, unique_filename: false, use_filename: false,
                transformation: SANITIZE, format: 'jpg', eager: THUMBNAIL, eager_async: false,
                exif: false, image_metadata: false, timeout: 60000,
            });
        } catch (_) {
            // Do not log SDK errors: they may contain API credentials or image data.
            // Caller retains its durable upload record and reconciles storage
            // after an ambiguous timeout, instead of starting a new asset upload.
            throw new PlanningError('PHOTO_UPLOAD_UNCERTAIN', 'The photo upload could not be confirmed. Check its status before retrying.', 503);
        }
        signal?.throwIfAborted();
        return describe(result, publicId);
    }
    async function recover({ owner, assetId, signal }) {
        configured(); signal?.throwIfAborted(); const publicId = key(owner, assetId);
        try {
            const result = await cloudinary.api.resource(publicId, { resource_type: 'image', type: 'authenticated', exif: false, image_metadata: false });
            signal?.throwIfAborted(); return describe(result, publicId);
        } catch (error) {
            if (error instanceof PlanningError) throw error;
            if (error.http_code === 404) return null;
            throw new PlanningError('PHOTO_STORAGE_UNAVAILABLE', 'The photo status could not be checked. Try again later.', 503);
        }
    }
    function privatePreview({ owner, assetId, asset }) {
        configured();
        if (!asset || asset.publicId !== key(owner, assetId) || asset.storageType !== 'authenticated' || asset.format !== 'jpg') fail('PHOTO_NOT_FOUND', 'Review photo not found.', 404);
        return cloudinary.utils.private_download_url(asset.publicId, 'jpg', { resource_type: 'image', type: 'authenticated',
            expires_at: Math.floor(now().getTime() / 1000) + 300, attachment: false });
    }
    return { process, recover, privatePreview };
}
module.exports = { createPhotoReviewImages, SANITIZE, THUMBNAIL };
