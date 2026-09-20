const mongoose = require('mongoose');
const { MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS } = require('../utils/productVideoPolicy');

const mediaAssetSchema = new mongoose.Schema({
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    purpose: { type: String, enum: ['product_video', 'campaign_video'], required: true },
    provider: { type: String, enum: ['cloudinary'], default: 'cloudinary' },
    publicId: { type: String, required: true, unique: true },
    status: {
        type: String,
        enum: ['pending_upload', 'pending_review', 'approved', 'rejected', 'invalid', 'abandoned'],
        default: 'pending_upload', index: true,
    },
    declaredMimeType: { type: String, required: true },
    declaredBytes: { type: Number, required: true, min: 1, max: MAX_VIDEO_BYTES },
    policyVersion: { type: String, required: true },
    policyAcceptedAt: { type: Date, required: true },
    uploadExpiresAt: { type: Date, required: true },
    duration: { type: Number, min: 0, max: MAX_VIDEO_SECONDS },
    bytes: { type: Number, min: 1, max: MAX_VIDEO_BYTES },
    width: Number,
    height: Number,
    format: String,
    version: Number,
    cleanedAt: Date,
    cleanupQueuedAt: Date,
    cleanupReceipt: String,
    revocation: {
        token: String,
        state: { type: String, enum: ['pending', 'completed'] },
        fromPublicId: String,
        toPublicId: String,
        requestedAt: Date,
        queuedAt: Date,
        completedAt: Date,
    },
    rejectionReason: { type: String, default: '', maxlength: 1000 },
    reviewedAt: Date,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewHistory: [{
        actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        action: { type: String, enum: ['approved', 'rejected'], required: true },
        reason: { type: String, maxlength: 1000 },
        at: { type: Date, default: Date.now },
    }],
}, { timestamps: true, optimisticConcurrency: true });

mediaAssetSchema.index({ status: 1, createdAt: -1 });
mediaAssetSchema.index({ purpose: 1, status: 1, cleanupQueuedAt: 1, uploadExpiresAt: 1 });
mediaAssetSchema.index({ 'revocation.state': 1, 'revocation.queuedAt': 1, _id: 1 });
module.exports = mongoose.model('MediaAsset', mediaAssetSchema);
