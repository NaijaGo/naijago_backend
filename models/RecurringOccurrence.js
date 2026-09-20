const mongoose = require('mongoose');
const fields = require('./schemas/plannedOrderFields');
const schema = new mongoose.Schema({
    plan: { type: mongoose.Schema.Types.ObjectId, ref: 'RecurringPlan', required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    number: { type: Number, min: 1, max: 1000, required: true, validate: Number.isSafeInteger },
    planRevision: { type: Number, required: true }, revision: { type: Number, default: 0 },
    startAt: { type: Date, required: true }, endAt: { type: Date, required: true },
    items: { type: [fields.item], required: true }, destination: { type: fields.destination, required: true, select: false },
    state: { type: String, enum: ['awaiting_review', 'needs_attention', 'checkout', 'ordered', 'skipped', 'expired', 'cancelled'], default: 'awaiting_review' },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'MainOrder', default: null },
    attentionCode: { type: String, default: '', maxlength: 80 },
    estimatedTotalKobo: { type: Number, default: null, min: 0, validate: (value) => value == null || Number.isSafeInteger(value) },
    estimatedAt: { type: Date, default: null },
    history: { type: [fields.history], default: [] },
}, { timestamps: true });
schema.index({ plan: 1, number: 1 }, { unique: true });
schema.index({ owner: 1, startAt: -1 }); schema.index({ state: 1, startAt: 1 });
module.exports = mongoose.model('RecurringOccurrence', schema);
