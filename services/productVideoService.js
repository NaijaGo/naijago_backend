const crypto = require('node:crypto');
const {
    MediaValidationError, ALLOWED_VIDEO_FORMATS, validateVideoRequest,
    validateUploadedVideo,
} = require('../utils/productVideoPolicy');

// Pre-generate authenticated derivatives; unapproved originals and derivatives
// require signed URLs. Keep transform strings identical at upload and delivery.
const PLAYBACK_TRANSFORM = 'c_limit,h_1280,w_1280,vc_h264,f_mp4,q_auto';
const POSTER_TRANSFORM = 'c_limit,w_640,so_0,f_jpg';

function createProductVideoService({ cloudinary, MediaAsset, now = () => new Date() }) {
    function configuration() {
        const config = cloudinary.config();
        if (!config.cloud_name || !config.api_key || !config.api_secret) {
            throw new MediaValidationError('Product video uploads are not configured yet.', 503);
        }
        return config;
    }

    async function issueUpload(owner, input) {
        validateVideoRequest(input);
        const config = configuration();
        const date = now();
        const publicId = `naijago/product_videos/${owner}/${crypto.randomUUID()}`;
        const asset = await MediaAsset.create({
            owner, purpose: 'product_video', publicId,
            declaredMimeType: input.mimeType, declaredBytes: input.bytes,
            policyVersion: input.policyVersion, policyAcceptedAt: date,
            uploadExpiresAt: new Date(date.getTime() + 60 * 60 * 1000),
        });
        const parameters = {
            timestamp: Math.floor(date.getTime() / 1000),
            public_id: publicId, type: 'authenticated', overwrite: false,
            allowed_formats: ALLOWED_VIDEO_FORMATS.join(','),
            eager: `${PLAYBACK_TRANSFORM}|${POSTER_TRANSFORM}`,
        };
        return {
            assetId: String(asset._id),
            uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloud_name}/video/upload`,
            expiresAt: asset.uploadExpiresAt,
            fields: {
                ...Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])),
                api_key: config.api_key,
                signature: cloudinary.utils.api_sign_request(parameters, config.api_secret),
            },
        };
    }

    function serialize(asset, { preview = false } = {}) {
        const result = {
            id: String(asset._id), status: asset.status,
            duration: asset.duration, bytes: asset.bytes,
            width: asset.width, height: asset.height,
            rejectionReason: asset.rejectionReason || '',
            revision: asset.__v || 0,
        };
        if ((asset.status === 'approved' || preview) && asset.version != null) {
            const options = {
                resource_type: 'video', type: 'authenticated',
                sign_url: true, secure: true, version: asset.version,
            };
            result.url = cloudinary.url(asset.publicId, {
                ...options, raw_transformation: PLAYBACK_TRANSFORM, format: 'mp4',
            });
            result.posterUrl = cloudinary.url(asset.publicId, {
                ...options, raw_transformation: POSTER_TRANSFORM, format: 'jpg',
            });
        }
        return result;
    }

    async function completeUpload(asset) {
        if (asset.status !== 'pending_upload') return serialize(asset, { preview: true });
        if (asset.uploadExpiresAt < now()) {
            throw new MediaValidationError('This upload has expired. Please select the video again.', 410);
        }
        const resource = await cloudinary.api.resource(asset.publicId, {
            resource_type: 'video', type: 'authenticated',
        });
        try {
            Object.assign(asset, validateUploadedVideo(resource, asset.publicId));
        } catch (error) {
            if (!(error instanceof MediaValidationError)) throw error;
            asset.status = 'invalid';
            asset.rejectionReason = error.message;
            await asset.save();
            // Keep invalid uploads authenticated. Cleanup runs separately so a
            // provider failure cannot accidentally publish an invalid video.
            throw error;
        }
        asset.status = 'pending_review';
        await asset.save();
        return serialize(asset, { preview: true });
    }

    return { issueUpload, completeUpload, serialize };
}

module.exports = { createProductVideoService, PLAYBACK_TRANSFORM, POSTER_TRANSFORM };
