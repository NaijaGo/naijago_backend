const mongoose = require('mongoose');
const { STATES } = require('../utils/imageRefinementPolicy');
const asset = new mongoose.Schema({ publicId: String, format: String, version: Number }, { _id: false });
const schema = new mongoose.Schema({
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    sourceUrl: { type: String, required: true, maxlength: 2000 },
    sourceKey: { type: String, required: true },
    productName: { type: String, required: true },
    state: { type: String, enum: STATES, required: true, default: 'queued' },
    generation: { type: Number, min: 1, max: 3, default: 1 },
    revision: { type: Number, default: 0 },
    profile: { type: String, enum: ['standard', 'relight'], default: 'standard' },
    sandbox: { type: Boolean, required: true },
    budgetDay: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    original: { type: asset, default: undefined },
    candidate: { type: asset, default: undefined },
    published: { type: asset, default: undefined },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'BackgroundJob' },
    code: { type: String, default: '' },
    history: [{ action: String, generation: Number, at: { type: Date, default: Date.now },
        actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, reason: { type: String, maxlength: 1000 }, candidate: asset }],
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ product: 1, sourceKey: 1 }, { unique: true });
schema.index({ state: 1, _id: -1 });
schema.set('autoCreate', false);
schema.set('autoIndex', false);
module.exports = mongoose.model('ImageRefinement', schema);
