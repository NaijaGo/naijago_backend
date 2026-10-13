const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  riderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rider', required: true, immutable: true },
  day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, immutable: true },
  timezone: { type: String, default: 'Africa/Lagos', immutable: true },
  amount: { type: Number, required: true, enum: [10000], immutable: true },
  threshold: { type: Number, required: true, enum: [20], immutable: true },
  completedOrderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MainOrder' }],
  state: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  requestedAt: { type: Date, required: true, immutable: true },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  reviewReason: { type: String, maxlength: 500 },
}, { autoIndex: false, autoCreate: false });
schema.index({ riderId: 1, day: 1 }, { unique: true, name: 'rider_bonus_day_unique' });
schema.index({ state: 1, requestedAt: -1 }, { name: 'pending_bonus_review' });
module.exports = mongoose.model('RiderDailyBonus', schema);
