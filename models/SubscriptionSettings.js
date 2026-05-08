const mongoose = require('mongoose');

const SubscriptionPlanSchema = new mongoose.Schema({
  id: {
    type: String,
    enum: ['student', 'standard', 'premium'],
    required: true,
  },
  name: { type: String, required: true, trim: true },
  price: { type: Number, required: true, min: 0 },
  deliveries: { type: Number, required: true, min: 0 },
  minimumOrderValue: { type: Number, required: true, min: 0 },
  deliveryScope: {
    type: String,
    enum: ['same_zone', 'city_errands'],
    required: true,
  },
  deliveryScopeLabel: { type: String, required: true, trim: true },
  validHours: {
    start: { type: String, default: '09:00' },
    end: { type: String, default: '18:00' },
  },
  benefits: { type: [String], default: [] },
  isActive: { type: Boolean, default: true },
}, { _id: false });

const SubscriptionSettingsSchema = new mongoose.Schema({
  key: {
    type: String,
    default: 'naijago',
    unique: true,
  },
  plans: {
    type: [SubscriptionPlanSchema],
    default: [],
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
}, { timestamps: true });

module.exports = mongoose.model('SubscriptionSettings', SubscriptionSettingsSchema);
