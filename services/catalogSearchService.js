const mongoose = require('mongoose');
const { readIntent, buildIntentFilter, collectionForIntent, escapeRegex, PRODUCT_TYPES } = require('../utils/catalogSearch');

class SearchInputError extends Error { constructor(message) { super(message); this.status = 400; } }
const scalar = (value, name, max = 200) => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > max) throw new SearchInputError(`Invalid ${name}.`);
    return value.trim();
};
const number = (value, name, max = 1000000000) => {
    if (value === undefined || value === '') return null;
    const parsed = Number(scalar(value, name, 20));
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) throw new SearchInputError(`Invalid ${name}.`);
    return parsed;
};

function parseSearchInput(input) {
    const q = scalar(input.q ?? input.query, 'search', 200);
    const intent = readIntent(q);
    const gender = scalar(input.gender, 'gender', 20);
    const ageGroup = scalar(input.ageGroup, 'age group', 20);
    const productType = scalar(input.productType, 'product type', 60);
    if (gender && !['female', 'male', 'unisex'].includes(gender)) throw new SearchInputError('Invalid gender filter.');
    if (ageGroup && !['adult', 'child', 'all'].includes(ageGroup)) throw new SearchInputError('Invalid age filter.');
    if (productType && !PRODUCT_TYPES.some(([key]) => key === productType)) throw new SearchInputError('Invalid product type.');
    if (gender) intent.gender = gender;
    if (ageGroup) intent.ageGroup = ageGroup === 'all' ? null : ageGroup;
    if (productType) intent.productTypes = [productType];
    const minPrice = number(input.minPrice, 'minimum price');
    const maxPrice = number(input.maxPrice, 'maximum price');
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) throw new SearchInputError('Minimum price cannot exceed maximum price.');
    const vendor = scalar(input.vendor, 'vendor', 24);
    if (vendor && !mongoose.isObjectIdOrHexString(vendor)) throw new SearchInputError('Invalid vendor.');
    const page = number(input.page, 'page', 1000) ?? 1;
    const limit = number(input.limit, 'page size', 100) ?? 30;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1) throw new SearchInputError('Invalid pagination.');
    const sort = scalar(input.sort, 'sort', 30) || 'relevance';
    if (!['relevance', 'newest', 'price_low', 'price_high', 'popular', 'most_sold', 'rating', 'best_rated'].includes(sort)) throw new SearchInputError('Invalid sort.');
    return { q, intent, minPrice, maxPrice, vendor, page, limit, sort,
        category: scalar(input.category, 'category'), subcategory: scalar(input.subcategory, 'subcategory'),
        brand: scalar(input.brand, 'brand', 120), minRating: number(input.minRating, 'rating', 5),
        inStock: scalar(input.inStock, 'stock filter', 5) === 'true' };
}

function buildSearchPipeline(input, { vendorIdsByTerm = {}, categoryFilter = {}, offersCollection = 'productoffers' } = {}) {
    const match = { isActive: true, moderationStatus: 'approved', productStatus: 'active',
        ...buildIntentFilter(input.intent, { vendorIdsByTerm }) };
    match.$and ||= [];
    if (Object.keys(categoryFilter).length) match.$and.push(categoryFilter);
    if (input.subcategory) match.subcategory = { $regex: `^${escapeRegex(input.subcategory)}$`, $options: 'i' };
    if (input.brand) match.brand = { $regex: `^${escapeRegex(input.brand)}$`, $options: 'i' };
    if (input.vendor) match.vendor = new mongoose.Types.ObjectId(input.vendor);
    if (input.minRating !== null) match.averageRating = { $gte: input.minRating };
    if (!match.$and.length) delete match.$and;
    // Stopword-only requests must not silently turn into an entire-catalog search.
    if (input.q && !input.intent.terms.length && !input.intent.categoryFamily && !input.intent.gender && !input.intent.productTypes.length) match._id = null;
    const offerPrice = { $ifNull: ['$__offer.price', '$price'] };
    const offerDiscount = { $ifNull: ['$__offer.discountPrice', { $cond: [{ $eq: [{ $type: '$__offer' }, 'missing'] }, '$discountPrice', null] }] };
    const title = { $toLower: { $ifNull: ['$name', ''] } };
    const text = input.q.toLowerCase();
    const pipeline = [
        { $match: match },
        { $lookup: { from: offersCollection, let: { productId: '$_id' }, pipeline: [
            { $match: { $expr: { $eq: ['$product', '$$productId'] }, status: { $in: ['active', 'out_of_stock'] } } },
            { $sort: { isPrimary: -1, price: 1, _id: 1 } }, { $limit: 1 },
        ], as: '__offers' } },
        { $set: { __offer: { $arrayElemAt: ['$__offers', 0] } } },
        { $set: {
            __searchPrice: { $cond: [{ $and: [{ $ne: [offerDiscount, null] }, { $gte: [offerDiscount, 0] }, { $lt: [offerDiscount, offerPrice] }] }, offerDiscount, offerPrice] },
            __searchStock: { $ifNull: ['$__offer.stockQuantity', '$stockQuantity'] },
            __relevance: { $add: [
                { $cond: [{ $eq: [title, text] }, 10, 0] },
                { $cond: [{ $eq: [{ $indexOfCP: [title, text] }, 0] }, 5, 0] },
                { $cond: [{ $eq: [{ $toLower: { $ifNull: ['$brand', ''] } }, text] }, 3, 0] },
            ] },
        } },
    ];
    const price = {};
    if (input.minPrice !== null) price.$gte = input.minPrice;
    if (input.maxPrice !== null) price.$lte = input.maxPrice;
    if (Object.keys(price).length) pipeline.push({ $match: { __searchPrice: price } });
    if (input.inStock) pipeline.push({ $match: { __searchStock: { $gt: 0 }, '__offer.status': { $ne: 'out_of_stock' } } });
    const sorts = {
        price_low: { __searchPrice: 1 }, price_high: { __searchPrice: -1 },
        popular: { salesCount: -1 }, most_sold: { salesCount: -1 },
        rating: { averageRating: -1, numReviews: -1 }, best_rated: { averageRating: -1, numReviews: -1 },
        relevance: { __relevance: -1 }, newest: {},
    };
    pipeline.push({ $facet: {
        products: [{ $sort: { ...sorts[input.sort], createdAt: -1, _id: -1 } },
            { $skip: (input.page - 1) * input.limit }, { $limit: input.limit },
            { $unset: ['__offers', '__offer', '__searchPrice', '__searchStock', '__relevance'] }],
        totals: [{ $count: 'count' }],
        types: [{ $unwind: '$searchAttributes.productTypes' }, { $group: { _id: '$searchAttributes.productTypes', count: { $sum: 1 } } }],
    } });
    return pipeline;
}

function createCatalogSearchService({ Product, ProductOffer, User, enrichProducts, categoryFilter, vendorPopulateFields }) {
    async function search(query) {
        const input = parseSearchInput(query);
        const vendorIdsByTerm = {};
        // Resolve store names to IDs; never interpolate user input as a regex.
        await Promise.all(input.intent.terms.map(async (term) => {
            const users = await User.find({ isVendor: true, vendorStatus: 'approved',
                businessName: { $regex: escapeRegex(term), $options: 'i' } }).select('_id').limit(100).maxTimeMS(1500).lean();
            vendorIdsByTerm[term] = users.map((user) => user._id);
        }));
        const pipeline = buildSearchPipeline(input, { vendorIdsByTerm,
            categoryFilter: input.category ? categoryFilter(input.category) : {},
            offersCollection: ProductOffer.collection.name });
        const [result] = await Product.aggregate(pipeline).option({ maxTimeMS: 5000 });
        const populated = await Product.populate(result?.products || [], { path: 'vendor', select: vendorPopulateFields });
        const total = result?.totals?.[0]?.count || 0;
        const collection = collectionForIntent(input.intent);
        const counts = new Map((result?.types || []).map((type) => [type._id, type.count]));
        if (collection) collection.chips = collection.chips.map((chip) => ({ ...chip, count: counts.get(chip.key) || 0 }));
        return { query: input.q, intent: input.intent, collection, products: await enrichProducts(populated),
            page: input.page, limit: input.limit, total, hasMore: input.page * input.limit < total,
            interpretation: 'catalog_attributes' };
    }
    return { search };
}

module.exports = { createCatalogSearchService, parseSearchInput, buildSearchPipeline, SearchInputError };
