const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    targetType: { type: String, enum: ['product', 'campaign'], required: true },
    target: { type: mongoose.Schema.Types.ObjectId, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'FeedComment', default: null },
    body: { type: String, trim: true, required: true, maxlength: 2000 },
    clientRequestId: { type: String, required: true, maxlength: 80 },
    policyVersion: { type: String, required: true },
    state: { type: String, enum: ['visible', 'hidden', 'deleted'], default: 'visible' },
    moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    moderationReason: { type: String, maxlength: 1000 },
    moderatedAt: Date,
}, { timestamps: true });
schema.index({ user: 1, clientRequestId: 1 }, { unique: true });
schema.index({ targetType: 1, target: 1, state: 1, createdAt: -1, _id: -1 });
schema.index({ parent: 1, state: 1, createdAt: 1 });
module.exports = mongoose.model('FeedComment', schema);
