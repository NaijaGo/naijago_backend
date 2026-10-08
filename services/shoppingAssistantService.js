const Product = require('../models/Product');
const User = require('../models/User');
const { interpretShoppingRequest } = require('./geminiCatalogService');
const { parseCatalogSearchRequest, searchCatalog } = require('./catalogSearchService');
const { decorateProductPrices } = require('./productPriceService');

const identity = value => String(value?._id || value || '');
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
let running = 0;

function parseRequest(body) {
  if (!body || Array.isArray(body) || typeof body !== 'object' ||
      Object.keys(body).some(key => key !== 'message') || typeof body.message !== 'string' ||
      body.message.trim().length < 2 || body.message.trim().length > 500) {
    throw fail(400, 'Describe what you need in 2–500 characters.');
  }
  return body.message.trim();
}

function budgetFromText(message) {
  if (/[$€£]/.test(message)) return { maxPrice: null, ambiguous: true };
  const amount = '(\\d[\\d,]*(?:\\.\\d{1,2})?)\\s*(k|thousand)?(?![\\d,]|\\.\\d)';
  const marked = new RegExp(`(?:₦|NGN|naira)\\s*${amount}|${amount}\\s*naira`, 'gi');
  const upper = new RegExp(`(?:under|below|up to|within|budget(?: of| is)?|maximum(?: of| is)?|max)\\s*(?:₦|NGN|naira|N\\s*)?${amount}`, 'gi');
  const matches = [...message.matchAll(upper)].filter(match => !/^(?:people|persons?|hours?|days?|items?|units?|pieces?)\b/i.test(message.slice(match.index + match[0].length).trimStart()));
  const fallback = matches.length ? matches : [...message.matchAll(marked)];
  if (!fallback.length && /₦|NGN|naira|\bbudget\b|\d+\s*k\b/i.test(message)) return { maxPrice: null, ambiguous: true };
  const values = fallback.map(match => {
    const text = match[1] || match[3]; const scale = match[2] || match[4];
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return NaN;
    return Number(text.replace(/,/g, '')) * (scale ? 1000 : 1);
  });
  const distinct = [...new Set(values)];
  if (distinct.some(value => !Number.isFinite(value) || value <= 0 || value > 1e9) || distinct.length > 1) return { maxPrice: null, ambiguous: true };
  return { maxPrice: distinct[0] ?? null, ambiguous: false };
}

async function suggest(body, { attachOffers }) {
  const message = parseRequest(body);
  const budget = budgetFromText(message);
  const response = { products: [], maxPrice: budget.maxPrice, question: null,
    message: '', budgetScope: 'per_listing', deliveryIncluded: false,
    notice: 'Suggestions are individual NaijaGo listings, not a combined basket quote. Review quantities, options, stock and delivery at checkout. Prices may change before checkout.',
    source: 'naijago_catalog', limitedResults: false };
  if (budget.ambiguous) return { ...response, question: 'What is your maximum budget in naira? Edit the request to include one clear budget.' };
  if (running >= 4) throw fail(429, 'The shopping assistant is busy. Please try again shortly.');
  running++;
  try {
    let intent;
    try { intent = await interpretShoppingRequest(message); }
    catch (_) { throw fail(503, 'The shopping assistant is temporarily unavailable. You can still use normal search.'); }
    if (intent.clarification !== 'none' || !intent.queries.length) return { ...response,
      question: intent.clarification === 'category' ? 'What type of product would you like? Add a category to your request.' : 'What would you like to buy? Add a product or category to your request.' };
    // Bounded, read-only catalog retrieval. Budget filtering follows authoritative
    // price decoration so an active Deal can qualify without changing search/checkout.
    const byId = new Map();
    for (const query of intent.queries) {
      const input = parseCatalogSearchRequest({ q: query, limit: '50', inStock: 'true' });
      const result = await searchCatalog(input, { attachOffers, priceProducts: decorateProductPrices });
      response.limitedResults ||= result.hasMore;
      for (const product of result.products) byId.set(identity(product._id), product);
    }
    const candidates = [...byId.values()];
    if (!candidates.length) return { ...response, message: 'No suitable NaijaGo listings were found. Try another product or category.' };
    const [parents, vendors] = await Promise.all([
      Product.find({ _id: { $in: candidates.map(product => product._id) } }).select('_id stockQuantity reservedStockQuantity').lean(),
      User.find({ isVendor: true, vendorStatus: 'approved', isTemporarilyClosed: { $ne: true }, _id: { $in: candidates.flatMap(product => [product.vendor?._id || product.vendor, ...(product.offers || []).map(offer => offer.sellerId?._id || offer.sellerId)]).filter(Boolean) } }).select('_id').lean(),
    ]);
    const parentStock = new Map(parents.map(product => [identity(product._id), product]));
    const eligibleVendors = new Set(vendors.map(vendor => identity(vendor._id)));
    const available = item => Number.isSafeInteger(item?.stockQuantity) && Number.isSafeInteger(item?.reservedStockQuantity ?? 0) &&
      item.stockQuantity >= 0 && (item.reservedStockQuantity ?? 0) >= 0 && item.stockQuantity - (item.reservedStockQuantity ?? 0) > 0;
    const budgetAllows = value => Number.isFinite(value) && value >= 0 && (budget.maxPrice == null || value <= budget.maxPrice);
    for (const product of candidates) {
      const relevant = sellerName => {
        const searchable = [product.name, product.description, product.brand, product.category, product.subcategory, product.restaurantName, sellerName, ...(Array.isArray(product.searchTags) ? product.searchTags : [])].filter(value => typeof value === 'string').join(' ').toLowerCase();
        return intent.queries.some(query => {
          const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 2 && !['and', 'for', 'with', 'the', 'of'].includes(term));
          return terms.length > 0 && terms.every(term => searchable.includes(term));
        });
      };
      if (product.isActive !== true || product.productStatus !== 'active' || product.moderationStatus !== 'approved' || !available(parentStock.get(identity(product._id)))) continue;
      const offers = Array.isArray(product.offers) ? product.offers : [];
      if (offers.length) {
        const ordered = [...offers].sort((a, b) => (identity(a._id) === identity(product.selectedOffer?._id) ? -1 : 0) - (identity(b._id) === identity(product.selectedOffer?._id) ? -1 : 0));
        const offer = ordered.find(row => row.status === 'active' && available(row) && budgetAllows(row.effectivePrice) && relevant(row.sellerType === 'naijago' ? 'NaijaGo' : row.sellerId?.businessName) &&
          (row.sellerType === 'naijago' || (row.sellerType === 'vendor' && eligibleVendors.has(identity(row.sellerId)))));
        if (!offer) continue;
        response.products.push({ ...product, selectedOffer: offer, sellerType: offer.sellerType, sellerId: identity(offer.sellerId),
          sellerName: offer.sellerType === 'naijago' ? 'NaijaGo' : offer.sellerId?.businessName || product.sellerName,
          vendor: offer.sellerType === 'vendor' ? offer.sellerId : product.vendor, price: offer.price,
          discountPrice: offer.discountPrice ?? null, effectivePrice: offer.effectivePrice, deal: offer.deal ?? null,
          stockQuantity: offer.stockQuantity });
      } else if (budgetAllows(product.effectivePrice) && relevant(product.sellerName || product.vendor?.businessName) && (product.sellerType === 'naijago' || eligibleVendors.has(identity(product.sellerId || product.vendor)))) {
        response.products.push(product);
      }
      if (response.products.length >= 12) { response.limitedResults = true; break; }
    }
    response.message = response.products.length ? 'Here are matching NaijaGo listings. Review the options before adding to your cart.' : 'No suitable NaijaGo listings were found within these filters. Try another product, category or budget.';
    return response;
  } finally { running--; }
}

module.exports = { suggest };
