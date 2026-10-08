const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productOfferId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductOffer', default: null },
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  targetKey: { type: String, required: true },
  discountType: { type: String, enum: ['percentage', 'fixed'], required: true },
  discountValue: { type: Number, required: true, min: 0 },
  startAt: { type: Date, required: true },
  endAt: { type: Date, required: true },
  status: { type: String, enum: ['draft', 'pending', 'approved', 'rejected', 'paused'], default: 'draft' },
  featured: { type: Boolean, default: false },
  moderationReason: { type: String, trim: true, maxlength: 500, default: '' },
  approvedAt: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  pausedAt: Date,
  pausedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  history: [{ _id: false, action: String, reason: String,
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, at: Date }],
  revision: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

schema.pre('validate', function validateDeal(next) {
  if (!Number.isFinite(this.discountValue) || this.discountValue <= 0 ||
      (this.discountType === 'percentage' && this.discountValue > 100)) {
    return next(new Error('Discount must be positive; percentage cannot exceed 100.'));
  }
  if (!(this.endAt > this.startAt)) return next(new Error('Deal end must be after its start.'));
  this.targetKey = `${this.productId}:${this.productOfferId || 'aggregate'}`;
  next();
});
schema.index({ targetKey: 1 }, { unique: true, partialFilterExpression: { status: 'approved' }, name: 'one_approved_deal_per_target' });
schema.index({ status: 1, startAt: 1, endAt: 1 });
schema.index({ vendorId: 1, createdAt: -1, _id: -1 });
schema.index({ productId: 1, productOfferId: 1 });
module.exports = mongoose.model('Deal', schema);
