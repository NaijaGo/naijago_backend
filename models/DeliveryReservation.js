const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'MainOrder', required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    windowIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryWindow' }], required: true,
        validate: (value) => value.length >= 1 && value.length <= 22 },
    fingerprint: { type: String, required: true },
    state: { type: String, enum: ['held', 'confirmed', 'released', 'expired'], default: 'held', required: true },
    timeZone: { type: String, enum: ['Africa/Lagos'], default: 'Africa/Lagos', required: true },
    startAt: { type: Date, required: true }, endAt: { type: Date, required: true },
    dispatchAt: { type: Date, required: true }, changeCutoffAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true }, confirmedAt: Date, releasedAt: Date,
    policyRevision: { type: Number, required: true },
}, { timestamps: true });
schema.index({ order: 1 }, { unique: true });
schema.index({ state: 1, expiresAt: 1 });
// Never TTL-delete reservations: release must decrement every capacity counter.
module.exports = mongoose.model('DeliveryReservation', schema);
