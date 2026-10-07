const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  type: { type: String, required: true, enum: ['reservation_expiry', 'preparation_release', 'dispatch_activation', 'missed_window'] },
  reservation: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryReservation' },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'MainOrder' },
  dueAt: { type: Date, required: true },
  state: { type: String, enum: ['queued', 'running', 'completed', 'failed', 'blocked', 'cancelled'], default: 'queued' },
  leaseToken: String,
  leaseOwner: String,
  leaseExpiresAt: Date,
  attempts: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  maxAttempts: { type: Number, default: 5, min: 1, max: 20, validate: Number.isSafeInteger },
  nextAttemptAt: { type: Date, required: true },
  lastError: { type: String, maxlength: 120, default: '' },
  businessKey: { type: String, required: true, unique: true, maxlength: 200 },
  notificationBusinessKey: { type: String, required: true, maxlength: 220 },
}, { timestamps: true });
schema.pre('validate', function validateTarget(next) {
  if (this.type === 'reservation_expiry' && !this.reservation) this.invalidate('reservation', 'Expiry requires a reservation.');
  if (this.type !== 'reservation_expiry' && !this.order) this.invalidate('order', 'Lifecycle job requires an order.');
  next();
});
schema.index({ state: 1, dueAt: 1, nextAttemptAt: 1 });
schema.index({ state: 1, leaseExpiresAt: 1 });
module.exports = mongoose.model('SchedulingJob', schema);
