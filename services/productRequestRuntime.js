const mongoose = require('mongoose');
const Request = require('../models/ProductRequest');
const Product = require('../models/Product');
const ProductOffer = require('../models/ProductOffer');
const User = require('../models/User');
const Job = require('../models/BackgroundJob');
const Usage = require('../models/AiUsageBucket');
const { createBackgroundJobService } = require('./backgroundJobService');
const { createFeatureReadiness } = require('./adminFeatureReadiness');
const { createProductRequestService } = require('./productRequestService');
const { createConceptImageAdapter, createRequestPreviewWorker, createRequestNotificationWorker } = require('./productRequestWorkers');
const { decorateProductPrices } = require('./productPriceService');
const images = createConceptImageAdapter({ generate: require('./geminiCatalogService').generateCatalogImage, cloudinary: require('../utils/cloudinary') });
const availableStock = { $expr: { $gt: [{ $subtract: ['$stockQuantity', { $ifNull: ['$reservedStockQuantity', 0] }] }, 0] } };
const catalog = {
  async available(productId) {
    const product = await Product.findOne({ _id: productId, isActive: true, productStatus: 'active', moderationStatus: 'approved', ...availableStock }).lean();
    if (!product) return null;
    const offers = await ProductOffer.find({ product: product._id, status: { $in: ['active', 'out_of_stock'] } }).sort({ isPrimary: -1, price: 1, _id: 1 }).lean();
    const eligible = [];
    for (const offer of offers) {
      if (offer.status !== 'active' || offer.stockQuantity - (offer.reservedStockQuantity || 0) <= 0) continue;
      if (offer.sellerType === 'vendor' && !await User.exists({ _id: offer.sellerId, isVendor: true, vendorStatus: 'approved', isTemporarilyClosed: { $ne: true } })) continue;
      eligible.push(offer);
    }
    if (offers.length && !eligible.length) return null;
    if (!offers.length && product.sellerType === 'vendor' && !await User.exists({ _id: product.sellerId || product.vendor, isVendor: true, vendorStatus: 'approved', isTemporarilyClosed: { $ne: true } })) return null;
    const selectedOffer = eligible[0] || null;
    const sellerId = selectedOffer?.sellerId || product.sellerId || product.vendor;
    const seller = sellerId ? await User.findById(sellerId).select('businessName').lean() : null;
    const [priced] = await decorateProductPrices([{ ...product, offers: eligible, selectedOffer,
      price: selectedOffer?.price ?? product.price, discountPrice: selectedOffer?.discountPrice ?? product.discountPrice,
      sellerName: selectedOffer?.sellerType === 'naijago' || product.sellerType === 'naijago' && !selectedOffer ? 'NaijaGo' : seller?.businessName || 'Vendor' }]);
    return { ...priced, id: String(product._id) };
  },
  async hasMatches(row) {
    const { searchCatalog, parseCatalogSearchRequest } = require('./catalogSearchService');
    const result = await searchCatalog(parseCatalogSearchRequest({ ...row.criteria, q: row.query, inStock: 'true', ai: 'false', limit: '30' }));
    for (const product of result.products) if (await this.available(String(product._id))) return true;
    return false;
  },
};
const queue = createBackgroundJobService({ Job, allowedTypes: ['request.preview', 'request.notify'] });
const service = createProductRequestService({ Request, Job, Usage, connection: mongoose.connection, queue, catalog, previewUrl: images.url });
const ready = createFeatureReadiness({ models: [Request, Job, Usage] });
const handlers = () => ({
  'request.preview': createRequestPreviewWorker({ Request, images, enabled: service.previewEnabled }),
  'request.notify': createRequestNotificationWorker({ Request, User, notifications: require('./notificationService') }),
});
module.exports = { service, ready, handlers };
