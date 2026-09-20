const mongoose = require('mongoose');
const Request = require('../models/ProductRequest');
const Product = require('../models/Product');
const ProductOffer = require('../models/ProductOffer');
const User = require('../models/User');
const Job = require('../models/BackgroundJob');
const Usage = require('../models/AiUsageBucket');
const { createBackgroundJobService } = require('./backgroundJobService');
const { createCatalogSearchService, buildSearchPipeline, parseSearchInput } = require('./catalogSearchService');
const { attachPrimaryOffers, vendorPopulateFields } = require('./productCatalogPresentation');
const { buildCategoryFilter } = require('../utils/productFilters');
const { createFeatureReadiness } = require('./featureReadiness');
const { createProductRequestService } = require('./productRequestService');
const { createConceptImageAdapter, createRequestPreviewWorker, createRequestNotificationWorker } = require('./productRequestWorkers');
const images = createConceptImageAdapter({ generate: require('./geminiCatalogService').generateCatalogImage, cloudinary: require('../utils/cloudinary') });
const search = createCatalogSearchService({ Product, ProductOffer, User, enrichProducts: attachPrimaryOffers, categoryFilter: buildCategoryFilter, vendorPopulateFields });
const catalog = {
    hasMatches: async (row) => (await search.search({ ...row.criteria, q: row.query, inStock: 'true', ai: 'false', limit: '1' })).total > 0,
    available: async (productId) => {
        const pipeline = buildSearchPipeline(parseSearchInput({ inStock: 'true', limit: '1' }), {
            offersCollection: ProductOffer.collection.name, usersCollection: User.collection.name,
        });
        pipeline.unshift({ $match: { _id: new mongoose.Types.ObjectId(productId) } });
        const [result] = await Product.aggregate(pipeline).option({ maxTimeMS: 5000 });
        const row = result?.products?.[0];
        if (!row) return null;
        const { __offers: offers, ...product } = row;
        const populated = await Product.populate(product, { path: 'vendor', select: vendorPopulateFields });
        const item = await attachPrimaryOffers(populated, { offers });
        return { ...item, id: String(item._id) };
    },
};
const queue = createBackgroundJobService({ Job, allowedTypes: ['request.preview', 'request.notify'] });
const service = createProductRequestService({ Request, Job, Usage, connection: mongoose.connection, queue, catalog, previewUrl: images.url });
const ready = createFeatureReadiness({ models: [Request, Job, Usage] });
function handlers() {
    return {
        'request.preview': createRequestPreviewWorker({ Request, images, enabled: service.previewEnabled }),
        'request.notify': createRequestNotificationWorker({ Request, User, notifications: require('./notificationService') }),
    };
}
module.exports = { service, ready, handlers };
