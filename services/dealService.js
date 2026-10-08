const mongoose = require('mongoose');
const Deal = require('../models/Deal');
const Product = require('../models/Product');
const ProductOffer = require('../models/ProductOffer');
const User = require('../models/User');
const prices = require('./productPriceService');

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
function objectId(value, name = 'ID') {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw fail(400, `Invalid ${name}.`);
  return value;
}
function bodyObject(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(field => !allowed.includes(field))) throw fail(400, 'Invalid Deal request fields.');
}
function pagination(input = {}) {
  for (const field of ['page', 'limit']) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || !/^\d+$/.test(input[field]))) {
      throw fail(400, 'Pagination must use positive integer query parameters.');
    }
  }
  const page = input.page === undefined ? 1 : Number(input.page);
  const limit = input.limit === undefined ? 20 : Number(input.limit);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw fail(400, 'Use page 1–1000 and limit 1–50.');
  }
  return { page, limit, skip: (page - 1) * limit };
}
async function requireVendor(user) {
  if (!user?.isVendor || user.vendorStatus !== 'approved') throw fail(403, 'Only approved vendors can submit Deals.');
}
async function target(deal) {
  objectId(String(deal.productId), 'product ID');
  if (deal.productOfferId) objectId(String(deal.productOfferId), 'offer ID');
  const [product, offer, vendor] = await Promise.all([
    Product.findById(deal.productId).lean(),
    deal.productOfferId ? ProductOffer.findById(deal.productOfferId).lean() : null,
    User.findOne({ _id: deal.vendorId, isVendor: true, vendorStatus: 'approved' }).select('_id').lean(),
  ]);
  if (!product || !vendor || (deal.productOfferId && !offer)) throw fail(404, 'Approved vendor, product or offer not found.');
  if (product.isActive !== true || product.productStatus !== 'active' || product.moderationStatus !== 'approved') {
    throw fail(400, 'Deals require an active approved product.');
  }
  if (offer) {
    if (prices.id(offer.product) !== prices.id(product._id) || offer.sellerType !== 'vendor' ||
        prices.id(offer.sellerId) !== prices.id(deal.vendorId)) throw fail(403, 'This vendor does not own that product offer.');
    if (offer.status !== 'active') throw fail(400, 'Deals require an active offer.');
  } else {
    if (product.sellerType !== 'vendor' || prices.id(product.sellerId || product.vendor) !== prices.id(deal.vendorId)) {
      throw fail(403, 'This vendor does not own that product.');
    }
    if (await ProductOffer.exists({ product: product._id, status: { $in: ['active', 'out_of_stock'] } })) {
      throw fail(400, 'Select the vendor ProductOffer for this Deal.');
    }
  }
  if ((product.variants || []).length || product.sizeData?.type || (offer?.variants || []).length) {
    throw fail(400, 'Variant/size Deals are not supported in Stage 1.');
  }
  if (prices.calculateDealPrice(Number(offer?.price ?? product.price), deal) == null) throw fail(400, 'Discount exceeds the product price or is invalid.');
  return { product, offer };
}
function validateFields(deal) {
  if (!['percentage', 'fixed'].includes(deal.discountType) || typeof deal.discountValue !== 'number' ||
      !Number.isFinite(deal.discountValue) || deal.discountValue <= 0 ||
      deal.discountValue > (deal.discountType === 'percentage' ? 100 : 1e9)) throw fail(400, 'Use a positive discount; percentage must be at most 100.');
  if (Math.round(deal.discountValue * 100) / 100 !== deal.discountValue) throw fail(400, 'Discount values support at most two decimal places.');
  for (const field of ['startAt', 'endAt']) {
    if (!(deal[field] instanceof Date) || !Number.isFinite(deal[field].getTime())) throw fail(400, 'Use valid Deal dates.');
  }
  if (!(deal.endAt > deal.startAt)) throw fail(400, 'Deal end must be after its start.');
  if (deal.endAt <= new Date()) throw fail(400, 'An expired Deal cannot be submitted or activated.');
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw fail(400, 'Supply ISO timestamps with an explicit timezone.');
  return new Date(value);
}
async function create(body, user) {
  await requireVendor(user);
  bodyObject(body, ['productId', 'productOfferId', 'discountType', 'discountValue', 'startAt', 'endAt', 'status']);
  objectId(body.productId, 'product ID');
  if (body.productOfferId != null) objectId(body.productOfferId, 'offer ID');
  const values = { productId: body.productId, productOfferId: body.productOfferId || null,
    vendorId: user._id, targetKey: prices.key(body.productId, body.productOfferId),
    discountType: body.discountType, discountValue: body.discountValue,
    startAt: date(body.startAt), endAt: date(body.endAt), status: body.status ?? 'pending' };
  if (!['draft', 'pending'].includes(values.status)) throw fail(403, 'Vendors cannot approve Deals.');
  validateFields(values);
  await target(values);
  return Deal.create({ ...values, history: [{ action: values.status, actor: user._id, at: new Date() }] });
}
async function update(id, body, user) {
  await requireVendor(user);
  objectId(id, 'Deal ID');
  bodyObject(body, ['discountType', 'discountValue', 'startAt', 'endAt', 'status', 'action']);
  const existing = await Deal.findOne({ _id: id, vendorId: user._id }).lean();
  if (!existing) throw fail(404, 'Deal not found.');
  let changes;
  if (body.action === 'pause') {
    if (Object.keys(body).length !== 1 || !['approved', 'pending'].includes(existing.status)) throw fail(409, 'This Deal cannot be paused.');
    changes = { status: 'paused', featured: false, pausedAt: new Date(), pausedBy: user._id };
  } else {
    if (body.action !== undefined || !Object.keys(body).length) throw fail(400, 'Invalid Deal edit.');
    if (!['draft', 'rejected', 'paused'].includes(existing.status)) throw fail(409, 'Pause an approved Deal before editing it.');
    changes = { ...body, status: body.status ?? 'pending', featured: false, moderationReason: '', approvedAt: null, approvedBy: null };
    if (!['draft', 'pending'].includes(changes.status)) throw fail(403, 'Vendors cannot approve Deals.');
    if (body.startAt !== undefined) changes.startAt = date(body.startAt);
    if (body.endAt !== undefined) changes.endAt = date(body.endAt);
    const candidate = { ...existing, ...changes };
    validateFields(candidate);
    await target(candidate);
  }
  const result = await Deal.findOneAndUpdate({ _id: id, vendorId: user._id, revision: existing.revision },
    { $set: changes, $inc: { revision: 1 },
      $push: { history: { action: changes.status, actor: user._id, at: new Date() } } }, { new: true, runValidators: true });
  if (!result) throw fail(409, 'Deal changed. Reload before editing.');
  return result;
}
async function approvalIndexReady() {
  let indexes;
  try { indexes = await Deal.collection.listIndexes().toArray(); }
  catch (_) { throw fail(503, 'Deal approval requires its database indexes to be provisioned.'); }
  if (!indexes.some(index => index.unique === true && index.key.targetKey === 1 &&
      Object.keys(index.key).length === 1 && index.partialFilterExpression?.status === 'approved')) {
    throw fail(503, 'Deal approval requires its unique target index.');
  }
}
async function moderate(id, body, user) {
  if (!user?.isAdmin) throw fail(403, 'Admin authorization required.');
  objectId(id, 'Deal ID');
  bodyObject(body, ['action', 'reason']);
  const reason = body.reason ?? '';
  if (typeof reason !== 'string' || reason.trim().length > 500) throw fail(400, 'Invalid moderation reason.');
  const existing = await Deal.findById(id).lean();
  if (!existing) throw fail(404, 'Deal not found.');
  const changes = {};
  switch (body.action) {
    case 'approve':
    case 'unpause':
      if (body.action === 'approve' ? existing.status !== 'pending' : existing.status !== 'paused' || !existing.approvedAt) {
        throw fail(409, 'Deal is not eligible for this approval action.');
      }
      validateFields(existing);
      await target(existing);
      await approvalIndexReady();
      Object.assign(changes, { status: 'approved', approvedAt: new Date(), approvedBy: user._id, moderationReason: reason.trim() });
      break;
    case 'reject':
      if (!reason.trim()) throw fail(400, 'A rejection reason is required.');
      Object.assign(changes, { status: 'rejected', featured: false, moderationReason: reason.trim() });
      break;
    case 'pause':
      if (existing.status !== 'approved') throw fail(409, 'Only approved Deals can be paused.');
      Object.assign(changes, { status: 'paused', featured: false, pausedAt: new Date(), pausedBy: user._id, moderationReason: reason.trim() });
      break;
    case 'feature':
    case 'unfeature':
      if (existing.status !== 'approved') throw fail(409, 'Only approved Deals can be featured.');
      if (body.action === 'feature') { validateFields(existing); await target(existing); }
      changes.featured = body.action === 'feature';
      break;
    default: throw fail(400, 'Unknown moderation action.');
  }
  const result = await Deal.findOneAndUpdate({ _id: id, revision: existing.revision },
    { $set: changes, $inc: { revision: 1 }, $push: { history: {
      action: body.action, reason: reason.trim(), actor: user._id, at: new Date(),
    } } }, { new: true, runValidators: true });
  if (!result) throw fail(409, 'Deal changed. Reload before moderating.');
  return result;
}
async function listManaged(query, user, admin = false) {
  const { page, limit, skip } = pagination(query);
  const filter = admin ? {} : { vendorId: user._id };
  if (query.status !== undefined) {
    if (!['draft', 'pending', 'approved', 'rejected', 'paused'].includes(query.status)) throw fail(400, 'Invalid Deal status.');
    filter.status = query.status;
  }
  const [deals, total] = await Promise.all([Deal.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), Deal.countDocuments(filter)]);
  return { deals, total, page, limit, hasMore: page * limit < total };
}

// Database filtering precedes pagination: unavailable products do not create empty pages.
async function listActive(query = {}, requestedId = null) {
  const { page, limit, skip } = pagination(query);
  const now = new Date();
  const match = { status: 'approved', startAt: { $lte: now }, endAt: { $gt: now } };
  if (requestedId) match._id = new mongoose.Types.ObjectId(objectId(requestedId, 'Deal ID'));
  const available = prefix => ({ $gt: [{ $subtract: [`$${prefix}.stockQuantity`, { $ifNull: [`$${prefix}.reservedStockQuantity`, 0] }] }, 0] });
  // Match the existing immediate-checkout restaurant hours, including overnight windows.
  const minute = (field, fallback) => ({ $let: { vars: { text: { $cond: [
    { $regexMatch: { input: { $ifNull: [field, ''] }, regex: /^\d{2}:\d{2}$/ } }, field, fallback,
  ] } }, in: { $add: [
    { $multiply: [{ $toInt: { $arrayElemAt: [{ $split: ['$$text', ':'] }, 0] } }, 60] },
    { $toInt: { $arrayElemAt: [{ $split: ['$$text', ':'] }, 1] } },
  ] } } });
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const withinWindow = (start, end) => ({ $or: [
    { $eq: [start, end] },
    { $and: [{ $lt: [start, end] }, { $gte: [currentMinute, start] }, { $lte: [currentMinute, end] }] },
    { $and: [{ $gt: [start, end] }, { $or: [{ $gte: [currentMinute, start] }, { $lte: [currentMinute, end] }] }] },
  ] });
  const [result] = await Deal.aggregate([
    { $match: match },
    { $lookup: { from: Product.collection.name, localField: 'productId', foreignField: '_id', as: 'product' } }, { $unwind: '$product' },
    { $lookup: { from: User.collection.name, localField: 'vendorId', foreignField: '_id', as: 'vendor' } }, { $unwind: '$vendor' },
    { $lookup: { from: ProductOffer.collection.name, localField: 'productOfferId', foreignField: '_id', as: 'offer' } },
    { $unwind: { path: '$offer', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: ProductOffer.collection.name, let: { product: '$productId' }, pipeline: [
      { $match: { $expr: { $eq: ['$product', '$$product'] }, status: { $in: ['active', 'out_of_stock'] } } }, { $limit: 1 },
    ], as: 'existingOffers' } },
    { $set: { restaurant: { $and: [
      { $not: [{ $regexMatch: { input: { $ifNull: ['$product.category', ''] }, regex: /restaurant equipment/i } }] },
      { $regexMatch: { input: { $ifNull: ['$product.category', ''] }, regex: /^(restaurant$|restaurant >)|meal|fast food|local dishes|pastries|drinks|catering/i } },
    ] }, vendorHours: { $filter: { input: { $ifNull: ['$vendor.operatingHours', []] }, as: 'hours',
      cond: { $eq: ['$$hours.day', ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getDay()]] } } } } },
    { $set: { vendorHours: { $arrayElemAt: ['$vendorHours', 0] },
      productStartMinute: minute('$product.orderStartTime', '09:00'), productEndMinute: minute('$product.orderEndTime', '19:00') } },
    { $set: { vendorStartMinute: minute('$vendorHours.openTime', '09:00'),
      vendorEndMinute: minute({ $ifNull: ['$vendorHours.lastOrderTime', '$vendorHours.closeTime'] }, '19:00') } },
    { $match: { $expr: { $or: [{ $eq: ['$restaurant', false] }, { $and: [
      withinWindow('$productStartMinute', '$productEndMinute'),
      { $or: [{ $eq: [{ $ifNull: ['$vendorHours', null] }, null] }, { $and: [
        { $ne: ['$vendorHours.isOpen', false] }, withinWindow('$vendorStartMinute', '$vendorEndMinute'),
      ] }] },
    ] }] } } },
    { $match: { 'product.isActive': true, 'product.productStatus': 'active', 'product.moderationStatus': 'approved',
      'vendor.isVendor': true, 'vendor.vendorStatus': 'approved', 'vendor.isTemporarilyClosed': { $ne: true },
      'product.requiresPrescription': { $ne: true }, 'product.requiresPharmacistApproval': { $ne: true },
      'product.medicineAccess': { $nin: ['prescription', 'pharmacist_approval', 'restricted'] },
      'product.variants.0': { $exists: false }, 'product.sizeData.type': { $in: [null, ''] }, 'offer.variants.0': { $exists: false },
      $expr: { $and: [available('product'), { $or: [
        { $and: [{ $eq: ['$productOfferId', null] }, { $eq: [{ $size: '$existingOffers' }, 0] },
          { $eq: ['$product.sellerType', 'vendor'] }, { $eq: [{ $ifNull: ['$product.sellerId', '$product.vendor'] }, '$vendorId'] }] },
        { $and: [{ $ne: ['$productOfferId', null] }, { $eq: ['$offer.product', '$productId'] },
          { $eq: ['$offer.status', 'active'] }, { $eq: ['$offer.sellerType', 'vendor'] }, { $eq: ['$offer.sellerId', '$vendorId'] }, available('offer')] },
      ] }] } } },
    { $set: { regularPrice: { $ifNull: ['$offer.price', '$product.price'] },
      legacyPrice: { $ifNull: ['$offer.discountPrice', { $ifNull: ['$offer.price', { $ifNull: ['$product.discountPrice', '$product.price'] }] }] } } },
    { $set: { candidatePrice: { $cond: [{ $eq: ['$discountType', 'percentage'] },
      { $multiply: ['$regularPrice', { $subtract: [1, { $divide: ['$discountValue', 100] }] }] }, { $subtract: ['$regularPrice', '$discountValue'] }] } } },
    { $match: { $expr: { $gte: ['$candidatePrice', 0] } } },
    { $set: { candidatePrice: { $divide: [{ $floor: { $add: [{ $multiply: ['$candidatePrice', 100] }, 0.5] } }, 100] } } },
    { $match: { $expr: { $and: [{ $gt: ['$discountValue', 0] }, { $gte: ['$candidatePrice', 0] },
      { $lt: ['$candidatePrice', '$legacyPrice'] }, { $or: [{ $eq: ['$discountType', 'fixed'] },
        { $and: [{ $eq: ['$discountType', 'percentage'] }, { $lte: ['$discountValue', 100] }] }] }] } } },
    { $sort: { featured: -1, endAt: 1, _id: 1 } },
    { $facet: { rows: [{ $skip: skip }, { $limit: limit }, { $project: {
      _id: 1, productId: 1, productOfferId: 1, vendorId: 1, discountType: 1, discountValue: 1,
      startAt: 1, endAt: 1, featured: 1, targetKey: 1, regularPrice: 1,
      pricingProduct: '$product', pricingOffer: '$offer',
      product: { _id: '$product._id', name: '$product.name', imageUrls: '$product.imageUrls', category: '$product.category' },
      vendor: { _id: '$vendor._id', businessName: '$vendor.businessName', businessLogoUrl: '$vendor.businessLogoUrl' },
    } }], count: [{ $count: 'total' }] } },
  ]).option({ maxTimeMS: 10000 });
  const rows = result?.rows || [];
  const context = { now, deals: new Map(rows.map(deal => [deal.targetKey, deal])),
    vendors: new Set(rows.map(deal => prices.id(deal.vendorId))),
    offeredProducts: new Set(rows.filter(deal => deal.productOfferId).map(deal => prices.id(deal.productId))) };
  const deals = rows.map(deal => {
    const pricing = prices.resolveProductPrice(deal.pricingProduct, deal.pricingOffer, context);
    if (!pricing.dealSnapshot) throw fail(503, 'Deal pricing is temporarily unavailable.');
    const finalPrice = pricing.finalPrice;
    const { targetKey, regularPrice, pricingProduct, pricingOffer, ...publicDeal } = deal;
    return { ...publicDeal, originalPrice: regularPrice, finalPrice,
      savingsAmount: Math.round((regularPrice - finalPrice) * 100) / 100,
      savingsPercentage: regularPrice > 0 ? Math.round((regularPrice - finalPrice) / regularPrice * 10000) / 100 : 0 };
  });
  const total = result?.count[0]?.total || 0;
  return { deals, total, page, limit, hasMore: page * limit < total, serverTime: now };
}
module.exports = { create, update, moderate, listManaged, listActive, requireVendor };
