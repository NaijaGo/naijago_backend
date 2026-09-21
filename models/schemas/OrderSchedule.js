'use strict';
const mongoose = require('mongoose');

// Optional on historical/immediate orders. Only the server can construct this
// snapshot from a capacity reservation in the order-creation transaction.
const OrderScheduleSchema = new mongoose.Schema({
    mode: { type: String, enum: ['scheduled'], required: true },
    reservation: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryReservation', required: true },
    state: { type: String, enum: ['held', 'confirmed', 'expired', 'released', 'needs_attention'], required: true },
    timeZone: { type: String, enum: ['Africa/Lagos'], required: true },
    areaKey: { type: String, required: true, match: /^[a-zA-Z0-9_-]{1,120}$/ },
    policyRevision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    dispatchAt: { type: Date, required: true },
    changeCutoffAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    confirmedAt: Date,
}, { _id: false });

OrderScheduleSchema.pre('validate', function(next) {
    const dates = ['startAt', 'endAt', 'dispatchAt', 'changeCutoffAt', 'expiresAt'];
    if (dates.every((key) => this[key] instanceof Date && Number.isFinite(+this[key])) &&
        (this.endAt <= this.startAt || this.endAt - this.startAt > 86400000 || this.dispatchAt > this.startAt ||
            this.changeCutoffAt > this.dispatchAt || this.expiresAt > this.changeCutoffAt)) {
        this.invalidate('startAt', 'The delivery reservation timestamps are inconsistent.');
    }
    if (this.state === 'confirmed' && !this.confirmedAt) this.invalidate('confirmedAt', 'A confirmed reservation needs a confirmation time.');
    next();
});

module.exports = OrderScheduleSchema;
