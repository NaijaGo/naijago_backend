const mongoose = require('mongoose');
const Product = require('../models/Product');
const User = require('../models/User');
const { buildEffectivePriceExpression, escapeRegex } = require('../utils/productFilters');

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
const MAX_PAGE = 1000;
const MAX_QUERY_LENGTH = 160;
const SEARCH_STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'at', 'buy', 'can', 'for', 'from', 'i', 'in', 'is', 'me', 'near', 'of', 'on', 'the', 'to', 'where', 'with']);
const SEARCHABLE_PRODUCT_FIELDS = [
  'name', 'description', 'brand', 'category', 'subcategory',
  'searchTags', 'restaurantName',
];

class SearchInputError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

function parseInteger(value, fallback, label, { maximum, clamp = false } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new SearchInputError(`Invalid ${label}.`);
  }
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new SearchInputError(`Invalid ${label}.`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new SearchInputError(`Invalid ${label}.`);
  if (maximum && parsed > maximum) {
    if (clamp) return maximum;
    throw new SearchInputError(`${label} is too large.`);
  }
  return parsed;
}

function parseOptionalNumber(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new SearchInputError(`Invalid ${label}.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new SearchInputError(`Invalid ${label}.`);
  }
  return parsed;
}

function parseCatalogSearchRequest(query = {}) {
  if (Array.isArray(query.q) || (query.q !== undefined && typeof query.q !== 'string')) {
    throw new SearchInputError('Search query must be a single text value.');
  }
  const searchText = String(query.q || '').trim();
  if (searchText.length > MAX_QUERY_LENGTH) {
    throw new SearchInputError(`Search query must be ${MAX_QUERY_LENGTH} characters or fewer.`);
  }

  const page = parseInteger(query.page, 1, 'page', { maximum: MAX_PAGE });
  const limit = parseInteger(query.limit, DEFAULT_LIMIT, 'limit', { maximum: MAX_LIMIT, clamp: true });
  const minPrice = parseOptionalNumber(query.minPrice, 'minimum price');
  const maxPrice = parseOptionalNumber(query.maxPrice, 'maximum price');
  if (minPrice !== null && maxPrice !== null && maxPrice < minPrice) {
    throw new SearchInputError('Maximum price must be greater than or equal to minimum price.');
  }
  const minRating = parseOptionalNumber(query.minRating, 'minimum rating', { maximum: 5 });
  const vendor = query.vendor === undefined || query.vendor === '' ? null : String(query.vendor);
  if (vendor && !mongoose.isValidObjectId(vendor)) throw new SearchInputError('Invalid vendor ID.');

  return {
    query: searchText,
    page,
    limit,
    category: typeof query.category === 'string' ? query.category.trim().slice(0, MAX_QUERY_LENGTH) : '',
    productType: typeof query.productType === 'string' && query.productType !== 'all'
      ? query.productType.trim().slice(0, MAX_QUERY_LENGTH)
      : '',
    vendor,
    allowSmartMatching: String(query.ai || '').toLowerCase() === 'true',
    minPrice,
    maxPrice,
    minRating: minRating || 0,
    inStock: String(query.inStock || '').toLowerCase() === 'true',
    sort: ['relevance', 'newest', 'popular', 'best_rated', 'price_low', 'price_high'].includes(String(query.sort || ''))
      ? String(query.sort)
      : 'relevance',
  };
}

function buildCategoryFilter(value) {
  const category = String(value || '').trim();
  if (!category) return null;
  const escaped = escapeRegex(category);
  const parts = category.split('>').map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    const parent = escapeRegex(parts[0]);
    const child = escapeRegex(parts.slice(1).join(' > '));
    return {
      $or: [
        { category: { $regex: `^${escaped}(?:$|\\s*>\\s*)`, $options: 'i' } },
        { category: { $regex: `^${parent}$`, $options: 'i' }, subcategory: { $regex: `^${child}$`, $options: 'i' } },
      ],
    };
  }
  return {
    $or: [
      { category: { $regex: `^${escaped}(?:$|\\s*>\\s*)`, $options: 'i' } },
      { subcategory: { $regex: `^${escaped}$`, $options: 'i' } },
    ],
  };
}

function buildSort(sort) {
  switch (sort) {
    case 'newest': return { createdAt: -1, _id: -1 };
    case 'popular': return { salesCount: -1, createdAt: -1, _id: -1 };
    case 'best_rated': return { averageRating: -1, numReviews: -1, createdAt: -1, _id: -1 };
    case 'price_low': return { price: 1, createdAt: -1, _id: -1 };
    case 'price_high': return { price: -1, createdAt: -1, _id: -1 };
    default: return { createdAt: -1, _id: -1 };
  }
}

async function findMatchingVendorIds(query, UserModel) {
  if (!query) return [];
  const terms = [...new Set(String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 2 && !SEARCH_STOP_WORDS.has(term)))];
  if (!terms.length) return [];
  const fieldQueries = ['businessName', 'firstName', 'lastName'].flatMap((field) =>
    terms.map((term) => ({ [field]: { $regex: escapeRegex(term), $options: 'i' } })),
  );
  const vendors = await UserModel.find({
    isVendor: true,
    vendorStatus: 'approved',
    $or: fieldQueries,
  }).select('_id').limit(100).lean();
  return vendors.map((vendor) => vendor._id);
}

async function searchCatalog(input, {
  ProductModel = Product,
  UserModel = User,
  attachOffers = async (items) => items,
} = {}) {
  const { query, page, limit, category, productType, vendor, minPrice, maxPrice, minRating, inStock, sort } = input;
  if (!query && !vendor) return { products: [], total: 0, page, limit, hasMore: false };

  const and = [{ isActive: true }];
  if (query) {
    const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length >= 2 && !SEARCH_STOP_WORDS.has(term)))];
    const searchPatterns = [query, ...terms].map(escapeRegex);
    const searchOr = searchPatterns.flatMap((pattern) =>
      SEARCHABLE_PRODUCT_FIELDS.map((field) => ({ [field]: { $regex: pattern, $options: 'i' } })),
    );
    if (!vendor) {
      const matchingVendorIds = await findMatchingVendorIds(query, UserModel);
      if (matchingVendorIds.length) searchOr.push({ vendor: { $in: matchingVendorIds } }, { sellerId: { $in: matchingVendorIds } });
    }
    and.push({ $or: searchOr });
  }
  if (vendor) and.push({ $or: [{ vendor }, { sellerId: vendor }] });
  const categoryFilter = buildCategoryFilter(category);
  if (categoryFilter) and.push(categoryFilter);
  const typeFilter = buildCategoryFilter(productType);
  if (typeFilter) and.push(typeFilter);

  const effectivePriceExpression = buildEffectivePriceExpression(minPrice, maxPrice);
  if (effectivePriceExpression) and.push({ $expr: effectivePriceExpression });
  if (minRating > 0) and.push({ averageRating: { $gte: minRating } });
  if (inStock) and.push({ stockQuantity: { $gt: 0 } });

  const filter = { $and: and };
  const skip = (page - 1) * limit;
  const [products, total] = await Promise.all([
    ProductModel.find(filter)
      .populate('vendor', 'businessName businessLocation phoneNumber businessLogoUrl businessWhatsAppNumber businessSupportPhone deliveryRadiusKm prepTimeMinutes isTemporarilyClosed temporaryClosureReason operatingHours')
      .sort(buildSort(sort))
      .skip(skip)
      .limit(limit)
      .lean(),
    ProductModel.countDocuments(filter),
  ]);
  const enrichedProducts = await attachOffers(products);
  return {
    products: enrichedProducts,
    total,
    page,
    limit,
    hasMore: skip + products.length < total,
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_PAGE,
  MAX_QUERY_LENGTH,
  SearchInputError,
  parseCatalogSearchRequest,
  buildCategoryFilter,
  buildSort,
  findMatchingVendorIds,
  searchCatalog,
};
