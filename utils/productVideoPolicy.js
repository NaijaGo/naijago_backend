const VIDEO_POLICY_VERSION = 'product-video-v1';
const MAX_VIDEO_SECONDS = 60;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const ALLOWED_VIDEO_FORMATS = ['mp4', 'mov', 'webm'];
const ALLOWED_VIDEO_MIMES = ['video/mp4', 'video/quicktime', 'video/webm'];
const VIDEO_WARNINGS = [
    'Show the actual product accurately, with clear lighting and a clean background.',
    'Do not upload nudity, violence, hate, illegal products or offensive content.',
    'Do not alter the product or make misleading claims about what buyers will receive.',
    'Do not include unrelated advertisements, private information or contact details.',
    'Only upload videos you own or have permission to use. Maximum length: 60 seconds.',
];

class MediaValidationError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'MediaValidationError';
        this.status = status;
    }
}

function validateVideoRequest({ mimeType, bytes, policyVersion } = {}) {
    if (policyVersion !== VIDEO_POLICY_VERSION) {
        throw new MediaValidationError('Please review and accept the product video guidelines.');
    }
    if (!ALLOWED_VIDEO_MIMES.includes(mimeType)) {
        throw new MediaValidationError('Choose an MP4, MOV or WebM video.');
    }
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_VIDEO_BYTES) {
        throw new MediaValidationError('The video must be no larger than 50 MB.');
    }
}

// Read this information from Cloudinary's authenticated Admin API, never from
// a client upload response. An image/audio renamed to .mp4 must fail here.
function validateUploadedVideo(resource, expectedPublicId) {
    if (!resource || resource.public_id !== expectedPublicId ||
        resource.resource_type !== 'video' || resource.type !== 'authenticated') {
        throw new MediaValidationError('We could not verify this video upload.');
    }
    if (!ALLOWED_VIDEO_FORMATS.includes(resource.format) ||
        !Number.isFinite(resource.duration) || resource.duration <= 0 ||
        resource.duration > MAX_VIDEO_SECONDS ||
        !Number.isInteger(resource.bytes) || resource.bytes <= 0 ||
        resource.bytes > MAX_VIDEO_BYTES ||
        !Number.isFinite(resource.width) || resource.width <= 0 ||
        !Number.isFinite(resource.height) || resource.height <= 0 ||
        !Number.isSafeInteger(resource.version) || resource.version <= 0) {
        throw new MediaValidationError('Upload a valid video no longer than 60 seconds and no larger than 50 MB.');
    }
    return {
        duration: resource.duration, bytes: resource.bytes,
        width: resource.width, height: resource.height,
        format: resource.format, version: resource.version,
    };
}

module.exports = {
    VIDEO_POLICY_VERSION, MAX_VIDEO_SECONDS, MAX_VIDEO_BYTES,
    ALLOWED_VIDEO_FORMATS, ALLOWED_VIDEO_MIMES, VIDEO_WARNINGS,
    MediaValidationError, validateVideoRequest, validateUploadedVideo,
};
