const mongoose = require('mongoose');
const { DEFAULTS, SCHEDULE_STATES } = require('../config/scheduledDelivery');

const schema = new mongoose.Schema({
  mode: { type: String, enum: ['now', 'scheduled'], required: true },
  window: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryWindow' },
  startAt: Date, endAt: Date,
  timeZone: { type: String, enum: [DEFAULTS.defaultTimeZone], default: DEFAULTS.defaultTimeZone },
  preparationAt: Date, preparationDeadline: Date, dispatchAt: Date, dispatchDeadline: Date,
  state: { type: String, enum: SCHEDULE_STATES, default: 'pending' },
  reservation: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryReservation' },
  revision: { type: Number, min: 0, default: 0, validate: Number.isSafeInteger },
  changeHistory: [{
    _id: false, action: String, reason: String,
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
    previous: mongoose.Schema.Types.Mixed, next: mongoose.Schema.Types.Mixed,
  }],
}, { _id: false });
schema.pre('validate', function validateSchedule(next) {
  if (this.mode === 'scheduled') {
    for (const field of ['window', 'startAt', 'endAt', 'preparationAt', 'preparationDeadline', 'dispatchAt', 'dispatchDeadline', 'reservation']) {
      if (!this[field]) this.invalidate(field, 'Scheduled order requires a complete snapshot.');
    }
    if (this.endAt <= this.startAt || this.dispatchDeadline <= this.dispatchAt ||
        this.dispatchAt > this.startAt || this.dispatchDeadline > this.endAt ||
        this.preparationAt > this.preparationDeadline || this.preparationDeadline > this.dispatchAt) {
      this.invalidate('dispatchAt', 'Invalid schedule timing order.');
    }
  }
  next();
});
module.exports = schema;
