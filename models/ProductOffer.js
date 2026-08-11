const mongoose = require('mongoose');

const offerVariantSchema = new mongoose.Schema({
  productVariantId: { type: mongoose.Schema.Types.ObjectId, default: null },
  sku: { type: String, trim: true, uppercase: true },
  price: { type: Number, required: true, min: 0 },
  discountPrice: { type: Number, default: null, min: 0 },
  stockQuantity: { type: Number, required: true, min: 0, default: 0 },
  isActive: { type: Boolean, default: true },
}, { _id: true });

const productOfferSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
    index: true,
  },
  sellerType: {
    type: String,
    enum: ['naijago', 'vendor'],
    required: true,
    default: 'naijago',
    index: true,
  },
  sellerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },
  sku: { type: String, trim: true, uppercase: true },
  price: { type: Number, required: true, min: 0 },
  discountPrice: { type: Number, default: null, min: 0 },
  stockQuantity: { type: Number, required: true, min: 0, default: 0 },
  status: {
    type: String,
    enum: ['active', 'out_of_stock', 'disabled', 'draft'],
    default: 'draft',
    index: true,
  },
  fulfilmentLocation: {
    latitude: Number,
    longitude: Number,
    formattedAddress: { type: String, trim: true },
  },
  variants: [offerVariantSchema],
  isPrimary: { type: Boolean, default: false, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

productOfferSchema.pre('validate', function validateOffer(next) {
  if (this.sellerType === 'naijago') this.sellerId = null;
  if (this.sellerType === 'vendor' && !this.sellerId) {
    return next(new Error('Vendor offers require a sellerId.'));
  }
  if (this.discountPrice != null && this.discountPrice >= this.price) {
    return next(new Error('Discount price must be lower than the regular price.'));
  }
  if (this.stockQuantity <= 0 && this.status === 'active') this.status = 'out_of_stock';
  next();
});

// `sellerKey` allows a nullable NaijaGo seller while still enforcing one offer
// per seller/product pair.
productOfferSchema.virtual('sellerKey').get(function getSellerKey() {
  return this.sellerType === 'naijago' ? 'naijago' : String(this.sellerId || '');
});

productOfferSchema.index({ product: 1, sellerType: 1, sellerId: 1 }, { unique: true });
productOfferSchema.index({ sellerType: 1, sellerId: 1, status: 1, updatedAt: -1 });
productOfferSchema.index({ product: 1, status: 1, isPrimary: -1, price: 1 });
productOfferSchema.index({ sku: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('ProductOffer', productOfferSchema);
