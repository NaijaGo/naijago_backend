const mongoose = require('mongoose');
const { DEFAULTS } = require('../config/scheduledDelivery');
const { calendarDate, validateServiceDate } = require('../utils/schedulingTime');

const count = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const schema = new mongoose.Schema({
  serviceDate: { type: String, required: true, validate: (value) => {
    try { validateServiceDate(value); return true; } catch { return false; }
  } },
  startAt: { type: Date, required: true },
  endAt: { type: Date, required: true },
  timeZone: { type: String, enum: [DEFAULTS.defaultTimeZone], default: DEFAULTS.defaultTimeZone },
  capacity: { ...count, min: 1 },
  reserved: { ...count, default: 0 },
  confirmed: { ...count, default: 0 },
  eligibility: {
    // Stable server-defined scope identity; additional eligibility dimensions can be added later.
    scopeKey: { type: String, required: true, trim: true, maxlength: 120 },
    areas: [{ type: String, trim: true, maxlength: 120 }],
    vendors: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    categories: [{ type: String, trim: true, maxlength: 120 }],
  },
  status: { type: String, enum: ['open', 'closed', 'cancelled'], default: 'open' },
  revision: { ...count, default: 0 },
}, { timestamps: true });

schema.pre('validate', function validateWindow(next) {
  if (this.startAt && this.endAt && this.endAt <= this.startAt) this.invalidate('endAt', 'End must follow start.');
  if (this.startAt && this.serviceDate && calendarDate(this.startAt, this.timeZone) !== this.serviceDate) {
    this.invalidate('serviceDate', 'Service date must match the Lagos start date.');
  }
  if (this.reserved + this.confirmed > this.capacity) this.invalidate('capacity', 'Window capacity exceeded.');
  next();
});
schema.index({ serviceDate: 1, status: 1, startAt: 1 });
schema.index({ endAt: 1, status: 1 });
schema.index({ 'eligibility.areas': 1, serviceDate: 1 });
schema.index({ 'eligibility.scopeKey': 1, startAt: 1, endAt: 1 }, { unique: true });
module.exports = mongoose.model('DeliveryWindow', schema);
