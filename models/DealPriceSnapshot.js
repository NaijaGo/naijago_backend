const mongoose = require('mongoose');
module.exports = new mongoose.Schema({
  dealId: { type: mongoose.Schema.Types.ObjectId, ref: 'Deal' },
  productOfferId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductOffer', default: null },
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  discountType: { type: String, enum: ['percentage', 'fixed'] },
  discountValue: Number,
  originalPrice: Number,
  finalPrice: Number,
  savingsAmount: Number,
  savingsPercentage: Number,
  startAt: Date,
  endAt: Date,
  resolvedAt: Date,
}, { _id: false });
