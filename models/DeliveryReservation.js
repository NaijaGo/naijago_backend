const mongoose = require('mongoose');
const { RESERVATION_STATES } = require('../config/scheduledDelivery');

const allocationSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  offer: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductOffer', default: null },
  variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
  selectedSize: { type: String, trim: true, maxlength: 120, default: '' },
  quantity: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
}, { _id: false });
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'MainOrder', default: null },
  window: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryWindow', required: true },
  windowSnapshot: {
    serviceDate: String, startAt: Date, endAt: Date, timeZone: String, revision: Number,
  },
  inventoryAllocations: { type: [allocationSchema], required: true,
    validate: (items) => items.length > 0 && items.length <= 100 },
  state: { type: String, enum: RESERVATION_STATES, default: 'held' },
  expiresAt: { type: Date, required: true },
  idempotencyKey: { type: String, required: true, trim: true, maxlength: 120 },
  requestHash: { type: String, required: true },
  revision: { type: Number, default: 0, min: 0, validate: Number.isSafeInteger },
  history: [{
    _id: false, from: String, to: String, reason: String,
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    at: { type: Date, default: Date.now },
  }],
}, { timestamps: true });
schema.index({ user: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ state: 1, expiresAt: 1 });
schema.index({ window: 1, state: 1 });
schema.index({ order: 1 }, { unique: true, partialFilterExpression: { order: { $type: 'objectId' } } });
// No TTL: release is an explicit transactional operation, never document deletion.
module.exports = mongoose.model('DeliveryReservation', schema);
