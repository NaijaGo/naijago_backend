const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    // One row for each area/vendor/rider-pool constraint in a concrete window.
    // Every applicable resource must be reserved in the same transaction.
    resourceKey: { type: String, required: true, maxlength: 160 },
    startAt: { type: Date, required: true }, endAt: { type: Date, required: true },
    timeZone: { type: String, enum: ['Africa/Lagos'], default: 'Africa/Lagos' },
    capacity: { type: Number, required: true, min: 1, max: 10000, validate: Number.isSafeInteger },
    used: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
    enabled: { type: Boolean, default: false },
    policyRevision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
}, { timestamps: true });
schema.index({ resourceKey: 1, startAt: 1, endAt: 1 }, { unique: true });
schema.index({ enabled: 1, startAt: 1 });
schema.pre('validate', function() {
    if (this.endAt <= this.startAt) this.invalidate('endAt', 'Window end must follow its start.');
    if (this.used > this.capacity) this.invalidate('capacity', 'Capacity cannot be below current reservations.');
});
module.exports = mongoose.model('DeliveryWindow', schema);
