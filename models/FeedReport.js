const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    targetType: { type: String, enum: ['product', 'campaign', 'comment'], required: true },
    target: { type: mongoose.Schema.Types.ObjectId, required: true },
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: ['spam', 'misleading', 'inappropriate', 'harassment', 'rights', 'other'], required: true },
    details: { type: String, maxlength: 1000 },
    state: { type: String, enum: ['open', 'resolved', 'dismissed'], default: 'open' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolution: { type: String, maxlength: 1000 },
    reviewedAt: Date,
    reviewHistory: [{ actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, action: String, reason: String, at: { type: Date, default: Date.now } }],
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ reporter: 1, targetType: 1, target: 1 }, { unique: true });
schema.index({ state: 1, createdAt: 1 });
module.exports = mongoose.model('FeedReport', schema);
