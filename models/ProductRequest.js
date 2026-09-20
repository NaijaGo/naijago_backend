const mongoose = require('mongoose');

// A sourcing request is never a Product or ProductOffer and cannot be purchased.
const schema = new mongoose.Schema({
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clientRequestId: { type: String, required: true, maxlength: 80 },
    inputHash: { type: String, required: true },
    query: { type: String, required: true, maxlength: 200 },
    criteria: { type: mongoose.Schema.Types.Mixed, default: {} },
    notes: { type: String, default: '', maxlength: 1000 },
    state: { type: String, enum: ['draft', 'requested', 'sourcing', 'matched', 'unavailable', 'cancelled'], default: 'draft' },
    revision: { type: Number, default: 0, min: 0 },
    statusRevision: { type: Number, default: 0, min: 0 },
    submittedAt: Date,
    matchedProduct: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    customerMessage: { type: String, default: '', maxlength: 1000 },
    history: [{ _id: false, state: String, message: { type: String, maxlength: 1000 }, at: Date,
        actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } }],
    preview: {
        state: { type: String, enum: ['not_requested', 'queued', 'generating', 'ready', 'failed', 'uncertain'], default: 'not_requested' },
        generation: { type: Number, default: 0, min: 0, max: 3 },
        job: { type: mongoose.Schema.Types.ObjectId, ref: 'BackgroundJob' },
        publicId: String, format: String, model: String, startedAt: Date, finishedAt: Date,
        code: { type: String, maxlength: 80 }, consentAt: Date,
    },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ owner: 1, clientRequestId: 1 }, { unique: true });
schema.index({ owner: 1, _id: -1 });
schema.index({ state: 1, _id: -1 });
// No TTL: submitted sourcing history must not disappear while being handled.
module.exports = mongoose.model('ProductRequest', schema);
