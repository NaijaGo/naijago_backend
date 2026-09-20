const mongoose = require('mongoose');
const fields = require('./schemas/plannedOrderFields');
const { normalizeRecurrence } = require('../utils/orderPlanningPolicy');
const rule = new mongoose.Schema({
    timeZone: { type: String, enum: ['Africa/Lagos'], required: true }, startDate: { type: String, required: true },
    frequency: { type: String, enum: ['weekly', 'biweekly', 'monthly', 'custom_days'], required: true },
    intervalDays: { type: Number, default: null }, windowStart: { type: String, required: true }, windowEnd: { type: String, required: true },
    endDate: { type: String, default: null }, maxOccurrences: { type: Number, default: null },
    paymentMode: { type: String, enum: ['reminder_to_pay'], default: 'reminder_to_pay' },
}, { _id: false });
const schema = new mongoose.Schema({
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, maxlength: 80 },
    items: { type: [fields.item], validate: (value) => value.length > 0 && value.length <= 100 },
    destination: { type: fields.destination, required: true, select: false },
    rule: { type: rule, required: true },
    state: { type: String, enum: ['active', 'paused', 'cancelled', 'completed'], default: 'active' },
    pauseUntil: { type: Date, default: null }, nextIndex: { type: Number, min: 0, max: 1000, default: 0, validate: Number.isSafeInteger },
    reminderLeadDays: { type: Number, min: 1, max: 7, default: 3, validate: Number.isSafeInteger },
    nextGenerateAt: { type: Date, required: true }, revision: { type: Number, default: 0, min: 0 },
    substitutionPreference: { type: String, enum: ['do_not_replace', 'ask_first', 'equivalent_with_approval'], default: 'do_not_replace' },
    priceApprovalPercent: { type: Number, min: 0, max: 100, default: 0 },
    priceApprovalKobo: { type: Number, min: 0, default: 0, validate: Number.isSafeInteger },
    history: { type: [fields.history], default: [] },
}, { timestamps: true });
schema.index({ owner: 1, createdAt: -1 }); schema.index({ state: 1, nextGenerateAt: 1 });
schema.pre('validate', function() { if (this.rule) { try { normalizeRecurrence(this.rule.toObject()); } catch (error) { this.invalidate('rule', error.message); } } });
module.exports = mongoose.model('RecurringPlan', schema);
