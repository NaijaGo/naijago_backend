const Deal = require('../models/Deal');
const User = require('../models/User');
const ProductOffer = require('../models/ProductOffer');

const id = (value) => String(value?._id || value || '');
const key = (product, offer) => `${id(product)}:${id(offer) || 'aggregate'}`;
const money = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const error = (message) => Object.assign(new Error(message), { statusCode: 503, code: 'DEAL_PRICING_UNAVAILABLE' });

function calculateDealPrice(regularPrice, deal) {
  if (!Number.isFinite(regularPrice) || regularPrice < 0 || !Number.isFinite(deal.discountValue) || deal.discountValue <= 0) return null;
  if (deal.discountType === 'percentage' && deal.discountValue <= 100) {
    return money(regularPrice * (1 - deal.discountValue / 100));
  }
  if (deal.discountType === 'fixed' && deal.discountValue <= regularPrice) return money(regularPrice - deal.discountValue);
  return null;
}

// A request-scoped, batched read. Checkout uses its existing transaction session.
async function loadDealContext(productIds, { session = null, now = new Date() } = {}) {
  productIds = [...new Set(productIds.map(id).filter(value => /^[a-f\d]{24}$/i.test(value)))];
  if (!productIds.length) return { now, deals: new Map(), vendors: new Set(), offeredProducts: new Set() };
  const withSession = (query) => session ? query.session(session) : query;
  // MongoDB does not support parallel operations within one transaction session.
  const deals = await withSession(Deal.find({ productId: { $in: productIds }, status: 'approved', startAt: { $lte: now }, endAt: { $gt: now } }).lean());
  if (!deals.length) return { now, deals: new Map(), vendors: new Set(), offeredProducts: new Set() };
  const offers = await withSession(ProductOffer.find({ product: { $in: productIds }, status: { $in: ['active', 'out_of_stock'] } }).select('product').lean());
  const vendors = deals.length ? await withSession(User.find({ _id: { $in: deals.map(deal => deal.vendorId) },
    isVendor: true, vendorStatus: 'approved' }).select('_id').lean()) : [];
  const byTarget = new Map();
  for (const deal of deals) {
    if (byTarget.has(deal.targetKey)) throw error('Deal pricing is temporarily unavailable.');
    byTarget.set(deal.targetKey, deal);
  }
  return { now, deals: byTarget, vendors: new Set(vendors.map(id)), offeredProducts: new Set(offers.map(offer => id(offer.product))) };
}

function resolveProductPrice(product, offer, context) {
  const originalPrice = Number(offer?.price ?? product.price);
  const legacyPrice = Number(offer?.discountPrice ?? offer?.price ?? product.discountPrice ?? product.price);
  if (!Number.isFinite(originalPrice) || originalPrice < 0 || !Number.isFinite(legacyPrice) || legacyPrice < 0) {
    throw error('Product pricing is temporarily unavailable.');
  }
  const result = { originalPrice, finalPrice: legacyPrice, dealSnapshot: null };
  const deal = context?.deals.get(key(product._id, offer?._id));
  if (!deal || (!offer && context.offeredProducts.has(id(product._id))) ||
      !context.vendors.has(id(deal.vendorId)) || product.isActive !== true ||
      product.productStatus !== 'active' || product.moderationStatus !== 'approved' ||
      (product.variants || []).length || product.sizeData?.type || (offer?.variants || []).length ||
      (offer && (offer.status !== 'active' || id(offer.product) !== id(product._id)))) return result;
  const seller = offer ? offer.sellerId : (product.sellerId || product.vendor);
  if (id(seller) !== id(deal.vendorId) || (offer?.sellerType || product.sellerType) !== 'vendor') return result;
  const finalPrice = calculateDealPrice(originalPrice, deal);
  if (finalPrice == null || finalPrice >= legacyPrice) return result;
  const savingsAmount = money(originalPrice - finalPrice);
  return { originalPrice, finalPrice, dealSnapshot: {
    dealId: deal._id, productOfferId: offer?._id || null, vendorId: deal.vendorId,
    discountType: deal.discountType, discountValue: deal.discountValue,
    originalPrice, finalPrice, savingsAmount,
    savingsPercentage: originalPrice > 0 ? money(savingsAmount / originalPrice * 100) : 0,
    startAt: deal.startAt, endAt: deal.endAt, resolvedAt: context.now,
  } };
}

async function decorateProductPrices(products) {
  const list = Array.isArray(products) ? products : [products];
  const context = await loadDealContext(list.filter(Boolean).map(product => product._id));
  const enriched = list.map(product => {
    if (!product) return product;
    const pricing = resolveProductPrice(product, product.selectedOffer, context);
    return { ...product, originalPrice: pricing.originalPrice, effectivePrice: pricing.finalPrice,
      deal: pricing.dealSnapshot,
      offers: product.offers?.map(offer => {
        const price = resolveProductPrice(product, offer, context);
        return { ...offer, originalPrice: price.originalPrice, effectivePrice: price.finalPrice, deal: price.dealSnapshot };
      }) };
  });
  return Array.isArray(products) ? enriched : enriched[0];
}
module.exports = { id, key, calculateDealPrice, loadDealContext, resolveProductPrice, decorateProductPrices };
