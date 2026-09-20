const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Types } = require('mongoose');
const { openIsolatedTestDatabase } = require('../../scripts/lib/openIsolatedTestDatabase');
const { deriveSearchAttributes, SEARCH_SCHEMA_VERSION } = require('../../utils/catalogSearch');
const { buildCategoryFilter } = require('../../utils/productFilters');
const { createCatalogSearchService } = require('../../services/catalogSearchService');
const { createProductCatalogPresentation, vendorPopulateFields } = require('../../services/productCatalogPresentation');
const { createGeminiSearchService } = require('../../services/geminiSearchService');

// All fixtures live only in per-run collections on the explicitly allowed TEST
// database. No dotenv, default connection, provider credentials or real HTTP.
const id = () => new Types.ObjectId();
const ids = (products) => products.map((product) => String(product._id)).sort();
async function settled(promises) {
    const results = await Promise.allSettled(promises);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    return results.map((result) => result.value);
}
function fixtures() {
    const vendors = ['Needlepoint Atelier', 'Coastal Market', 'Unapproved Store', 'Customer Account'].map((businessName, index) => ({
        _id: id(), businessName, firstName: 'Isolated', lastName: 'Fixture',
        email: 'fixture-' + index + '@example.invalid', phoneNumber: '+234000000000' + index,
        isVendor: index !== 3, vendorStatus: index === 2 ? 'reviewing' : 'approved',
    }));
    const products = [], offers = [], named = {};
    const product = (key, overrides = {}, offer = undefined, legacy = false) => {
        const row = { _id: id(), name: key, description: 'Synthetic isolated integration fixture.',
            category: 'Fashion', subcategory: 'Dresses', gender: 'female', ageGroup: 'adult', productType: 'dress',
            searchTags: [], brand: 'Needlepoint', price: 20000, discountPrice: null, stockQuantity: 4,
            vendor: null, sellerId: null, sellerType: 'naijago', isActive: true, productStatus: 'active',
            moderationStatus: 'approved', averageRating: 4, numReviews: 2, salesCount: 0,
            createdAt: new Date('2026-01-01T00:00:00Z'), ...overrides };
        if (row.vendor) { row.sellerType = 'vendor'; row.sellerId = row.vendor; }
        if (!legacy) row.searchAttributes = deriveSearchAttributes(row);
        products.push(row); named[key] = row;
        if (offer !== undefined) offers.push({ _id: id(), product: row._id, sellerType: row.sellerType,
            sellerId: row.sellerId, price: row.price, discountPrice: null, stockQuantity: 4,
            status: 'active', isPrimary: true, ...offer });
        return row;
    };
    product('classic', { name: 'Everyday Classic', description: 'Breathable linen weave.', vendor: vendors[0]._id,
        price: 999, searchTags: ['women', 'summer'] }, { price: 60000, discountPrice: 45000, stockQuantity: 3 });
    product('top', { name: 'Evening Essential', vendor: vendors[1]._id, productType: 'top', subcategory: 'Tops', price: 25000 }, {});
    product('shirt', { name: 'Oxford Regular', gender: 'male', productType: 'shirt', subcategory: 'Shirts', vendor: vendors[0]._id, price: 30000 }, {});
    product('menshoes', { gender: 'male', productType: 'shoes', subcategory: 'Shoes', price: 48000 }, {});
    product('bag', { name: 'City Carry', productType: 'bag', subcategory: 'Bags', price: 15000 }, {});
    product('unisex', { gender: 'unisex', productType: 'shoes', subcategory: 'Shoes', price: 10000 }, {});
    product('child', { name: 'Playtime', ageGroup: 'child', vendor: vendors[1]._id, price: 9000 }, {});
    product('legacy', { name: 'Women Linen Dress', category: 'Fashion > Women > Dresses', subcategory: '',
        vendor: vendors[0]._id, price: 19000 }, undefined, true);
    product('phone', { name: 'iPhone 15 Pro', brand: 'Apple', category: 'Phones & Tablets', subcategory: 'Smartphones',
        gender: 'unspecified', ageGroup: 'all', productType: 'phone', price: 1000000 }, {});
    product('food', { name: 'Lunch Plate', category: 'Restaurant', subcategory: 'Meals', gender: 'unspecified',
        ageGroup: 'all', productType: '', searchTags: ['jollof'], price: 3000 }, {});
    product('split', { name: 'Hierarchy fixture', category: 'Fashion', subcategory: 'Women > Dresses', searchTags: ['hierarchy'] }, {});
    product('path', { name: 'Hierarchy legacy', category: 'Fashion > Women > Dresses', subcategory: '', searchTags: ['hierarchy'] }, {});
    const neutral = { category: 'Test Equipment', subcategory: '', productType: '', gender: 'unspecified', ageGroup: 'all' };
    product('published', { ...neutral, searchTags: ['eligibility'] }, {});
    for (const [key, change] of [
        ['inactive', { isActive: false }], ['draft', { productStatus: 'draft' }],
        ['disabled', { productStatus: 'disabled' }], ['moderation', { moderationStatus: 'pending' }],
        ['unapproved', { vendor: vendors[2]._id }], ['notvendor', { vendor: vendors[3]._id }], ['deletedvendor', { vendor: id() }],
    ]) product(key, { ...neutral, searchTags: ['eligibility'], ...change }, {});
    product('disabledoffer', { ...neutral, searchTags: ['eligibility'], price: 1, stockQuantity: 99 }, { status: 'disabled' });
    product('badofferseller', { ...neutral, searchTags: ['eligibility'] }, { sellerType: 'vendor', sellerId: vendors[2]._id });
    product('legacybadowner', { ...neutral, name: 'Eligibility legacy', vendor: vendors[2]._id }, undefined, true);
    product('regularprice', { ...neutral, searchTags: ['pricing'], price: 10, discountPrice: 1 }, { price: 500, discountPrice: null, stockQuantity: 2 });
    product('discount', { ...neutral, searchTags: ['pricing'], price: 9000 }, { price: 500, discountPrice: 100, stockQuantity: 5 });
    product('zero', { ...neutral, searchTags: ['pricing'] }, { price: 500, discountPrice: 0 });
    product('nostock', { ...neutral, searchTags: ['pricing'], stockQuantity: 99 }, { price: 200, stockQuantity: 0, status: 'out_of_stock' });
    product('statusnostock', { ...neutral, searchTags: ['pricing'] }, { price: 250, stockQuantity: 8, status: 'out_of_stock' });
    product('legacyprice', { ...neutral, searchTags: ['pricing'], price: 80, discountPrice: 40 }, undefined, true);
    product('dollar', { ...neutral, name: '$price' }, {});
    const primary = product('primary', { ...neutral, searchTags: ['primarychoice'], price: 1 }, { price: 800 });
    offers.push({ _id: id(), product: primary._id, sellerType: 'vendor', sellerId: vendors[0]._id,
        price: 20, discountPrice: null, stockQuantity: 2, status: 'active', isPrimary: false });
    const pageProducts = Array.from({ length: 125 }, (_, index) => product('page-' + index, {
        ...neutral, name: 'Page fixture ' + index, searchTags: ['paginationfixture'], price: 100,
    }, {}));
    return { vendors, products, offers, named, pageProducts };
}

test('isolated Mongo: catalog search, offer truth, pagination and AI budgets', {
    skip: !process.env.NAIJAGO_TEST_MONGO_URI, timeout: 300000,
}, async (t) => {
    const { models } = await openIsolatedTestDatabase(t, ['User', 'Product', 'ProductOffer', 'AiUsageBucket', 'SearchIntentCache']);
    const { User, Product, ProductOffer, AiUsageBucket: Usage, SearchIntentCache: Cache } = models;
    const data = fixtures(), { named, vendors } = data;
    // Raw fixture inserts deliberately include old/inconsistent records so the
    // read path is tested, not merely the save hook that repairs new records.
    await User.collection.insertMany(data.vendors);
    await Product.collection.insertMany(data.products);
    await ProductOffer.collection.insertMany(data.offers);
    const { attachPrimaryOffers } = createProductCatalogPresentation({ Offer: ProductOffer });
    const createSearch = (overrides = {}) => createCatalogSearchService({ Product, ProductOffer, User,
        enrichProducts: attachPrimaryOffers, categoryFilter: buildCategoryFilter, vendorPopulateFields, ...overrides });
    const service = createSearch();
    const search = (query) => service.search({ ai: 'false', ...query });
    const expectRows = (result, keys) => assert.deepEqual(ids(result.products), keys.map((key) => String(named[key]._id)).sort());

    await t.test('broad synonyms use attributes across vendors; adults and children stay distinct', async () => {
        for (const q of ['women clothes', 'ladies wear', 'women clothing']) {
            const result = await search({ q });
            expectRows(result, ['classic', 'top', 'bag', 'unisex', 'legacy', 'split', 'path']);
            assert.equal(result.collection.title, 'Women Fashion');
            assert.equal(result.total, 7);
            assert.equal(result.collection.chips.find((chip) => chip.key === 'dress').count, 3);
        }
        expectRows(await search({ q: 'girls dresses' }), ['child']);
        expectRows(await search({ q: 'men clothes' }), ['shirt', 'menshoes', 'unisex']);
        expectRows(await search({ q: 'female dresses' }), ['classic', 'child', 'legacy', 'split', 'path']);
        expectRows(await search({ q: 'men shoes' }), ['menshoes', 'unisex']);
        expectRows(await search({ q: 'female bags' }), ['bag']);
        expectRows(await search({ q: 'men shirts' }), ['shirt']);
    });
    await t.test('brand, descriptions, tags, store names and both category storage formats match', async () => {
        expectRows(await search({ q: 'breathable linen' }), ['classic']);
        expectRows(await search({ q: 'summer' }), ['classic']);
        expectRows(await search({ q: 'Coastal Market', gender: 'female', ageGroup: 'adult' }), ['top']);
        expectRows(await search({ q: 'Apple', brand: 'Apple' }), ['phone']);
        expectRows(await search({ q: 'iPhone 15 Pro' }), ['phone']);
        expectRows(await search({ q: 'electronics' }), ['phone']);
        expectRows(await search({ q: 'food' }), ['food']);
        expectRows(await search({ q: 'hierarchy', category: 'Fashion > Women > Dresses' }), ['split', 'path']);
        expectRows(await search({ q: 'women clothes', category: 'Fashion', subcategory: 'Tops' }), ['top']);
        const filtered = await search({ q: 'women clothes', vendor: String(vendors[0]._id), brand: 'Needlepoint',
            minPrice: '40000', maxPrice: '50000', minRating: '4', inStock: 'true' });
        expectRows(filtered, ['classic']);
        assert.equal(filtered.products[0].effectivePrice, 45000);
        assert.equal(filtered.products[0].sellerName, vendors[0].businessName);
    });
    await t.test('unapproved owners, unpublished products and disabled/ineligible offers stay hidden', async () => {
        expectRows(await search({ q: 'eligibility' }), ['published']);
        expectRows(await search({ q: 'Unapproved Store' }), []);
        expectRows(await search({ vendor: String(vendors[2]._id) }), []);
        const all = await search({ q: 'pricing' });
        for (const row of all.products) {
            assert.equal(row.sellerName, 'NaijaGo');
            assert.equal(Object.keys(row).some((key) => key.startsWith('__')), false);
        }
    });
    await t.test('offer price, null/zero discounts, stock and primary choice govern filters and sorting', async () => {
        const result = await search({ q: 'pricing', sort: 'price_low' });
        assert.deepEqual(result.products.map((row) => row.effectivePrice), [0, 40, 100, 200, 250, 500]);
        const regular = result.products.find((row) => String(row._id) === String(named.regularprice._id));
        assert.equal(regular.discountPrice, null);
        assert.equal(regular.stockQuantity, 2);
        expectRows(await search({ q: 'pricing', maxPrice: '100', inStock: 'true' }), ['zero', 'legacyprice', 'discount']);
        expectRows(await search({ q: 'pricing', minPrice: '150', maxPrice: '300', inStock: 'true' }), []);
        expectRows(await search({ q: 'primarychoice', maxPrice: '100' }), []);
        assert.equal((await search({ q: 'primarychoice' })).products[0].effectivePrice, 800);
        assert.deepEqual((await search({ q: 'pricing', sort: 'price_high' })).products.map((row) => row.effectivePrice), [500, 250, 200, 100, 40, 0]);
    });
    await t.test('offer changes after aggregation cannot replace the displayed filtered snapshot', async () => {
        const offer = data.offers.find((row) => String(row.product) === String(named.classic._id));
        const concurrent = createSearch({ enrichProducts: async (products, options) => {
            await ProductOffer.updateOne({ _id: offer._id }, { $set: { price: 200000, discountPrice: null, stockQuantity: 0 } });
            return attachPrimaryOffers(products, options);
        } });
        try {
            const result = await concurrent.search({ q: 'summer', maxPrice: '50000', inStock: 'true', ai: 'false' });
            expectRows(result, ['classic']);
            assert.equal(result.products[0].effectivePrice, 45000);
            assert.equal(result.products[0].stockQuantity, 3);
            assert.equal((await search({ q: 'summer', maxPrice: '50000', inStock: 'true' })).total, 0);
        } finally {
            await ProductOffer.updateOne({ _id: offer._id }, { $set: { price: offer.price, discountPrice: offer.discountPrice, stockQuantity: offer.stockQuantity } });
        }
    });
    await t.test('pagination counts all 125 products and stable ties do not duplicate or omit rows', async () => {
        const first = await search({ q: 'paginationfixture', limit: '100', sort: 'price_low' });
        const second = await search({ q: 'paginationfixture', page: '2', limit: '100', sort: 'price_low' });
        assert.equal(first.total, 125); assert.equal(second.total, 125);
        assert.equal(first.products.length, 100); assert.equal(second.products.length, 25);
        assert.equal(first.hasMore, true); assert.equal(second.hasMore, false);
        assert.deepEqual(ids([...first.products, ...second.products]), ids(data.pageProducts));
        assert.deepEqual((await search({ q: 'paginationfixture', limit: '100', sort: 'price_low' })).products.map((row) => String(row._id)), first.products.map((row) => String(row._id)));
        assert.equal((await search({ q: 'paginationfixture', page: '3', limit: '100' })).products.length, 0);
    });
    await t.test('literal dollar queries work; stopword/unknown queries do not expose the whole catalog', async () => {
        expectRows(await search({ q: '$price' }), ['dollar', 'regularprice', 'legacyprice']);
        expectRows(await search({ q: 'please show me' }), []);
        expectRows(await search({ q: 'no-such-product-zyx' }), []);
        expectRows(await search({ q: 'Apple', brand: 'Apple.*' }), []);
    });
    await t.test('AI interpretation reruns real publication, vendor, stock and budget filters', async () => {
        let calls = 0;
        const smart = createSearch({ aiSearch: { async interpret() { calls++; return {
            categoryFamily: 'fashion', gender: 'male', ageGroup: 'child', productTypes: ['dress'], terms: ['linen'], confidence: 0.95,
        }; } } });
        const result = await smart.search({ q: 'frock', gender: 'female', ageGroup: 'adult', vendor: String(vendors[0]._id),
            minPrice: '40000', maxPrice: '50000', inStock: 'true' }, { actorKey: 'synthetic-actor' });
        expectRows(result, ['classic']); assert.equal(result.interpretation, 'gemini_intent');
        assert.equal(calls, 1);
        expectRows(await smart.search({ q: 'frock', gender: 'female', ageGroup: 'adult', maxPrice: '10' }, { actorKey: 'synthetic-actor' }), []);
        await smart.search({ q: 'iPhone' }, { actorKey: 'synthetic-actor' });
        await smart.search({ q: 'frock', ai: 'false' }, { actorKey: 'synthetic-actor' });
        await smart.search({ q: 'frock' });
        assert.equal(calls, 2);
    });

    let scenario = 0;
    const valid = { categoryFamily: 'fashion', gender: 'female', ageGroup: '', productTypes: ['dress'], terms: ['linen'], confidence: 0.95 };
    function aiFixture(overrides = {}, fail = false) {
        scenario++;
        let date = new Date(Date.now() + scenario * 86400000), calls = 0;
        const env = { SMART_SEARCH_AI_ENABLED: 'true', GEMINI_API_KEY: 'isolated-fake-key-' + scenario,
            GEMINI_SEARCH_MODEL: 'simulated-model', GEMINI_SEARCH_DAILY_LIMIT: '20', GEMINI_SEARCH_USER_DAILY_LIMIT: '20', ...overrides };
        const http = { async post() {
            calls++;
            if (fail) throw new Error('Simulated provider failure');
            return { data: { candidates: [{ content: { parts: [{ text: JSON.stringify(valid) }] } }] } };
        } };
        const keyFor = (query) => crypto.createHmac('sha256', env.GEMINI_API_KEY)
            .update('intent-v1:' + SEARCH_SCHEMA_VERSION + ':' + env.GEMINI_SEARCH_MODEL + ':' + query).digest('hex');
        return { ...createGeminiSearchService({ Cache, Usage, http, env, now: () => date }),
            calls: () => calls, date: () => date, advance: (milliseconds) => { date = new Date(date.getTime() + milliseconds); }, keyFor };
    }
    await t.test('real cache claims coalesce identical requests and cached results spend no quota', async () => {
        const ai = aiFixture();
        const query = 'linen frock';
        const results = await settled(Array.from({ length: 8 }, () => ai.interpret({ query, actorKey: 'test-actor' })));
        assert.equal(ai.calls(), 1); assert.ok(results.some(Boolean));
        assert.equal((await ai.interpret({ query, actorKey: 'another-actor' })).gender, 'female');
        assert.equal(ai.calls(), 1);
        const cached = await Cache.findById(ai.keyFor(query)).lean();
        assert.equal(cached.state, 'ready'); assert.equal(cached.leaseToken, undefined);
        assert.equal(cached._id.includes(query), false);
        const buckets = await Usage.find({ _id: { $regex: '^search:' + ai.date().toISOString().slice(0, 10) + ':' } }).lean();
        assert.equal(buckets.length, 2); assert.ok(buckets.every((bucket) => bucket.used === 1));
        assert.ok(buckets.every((bucket) => !bucket._id.includes('test-actor')));
    });
    await t.test('real concurrent global quota reservations cannot exceed the configured budget', async () => {
        const ai = aiFixture({ GEMINI_SEARCH_DAILY_LIMIT: '2' });
        await settled(['linen', 'cotton', 'silk', 'red', 'blue', 'green'].map((word, index) => ai.interpret({ query: word + ' frock', actorKey: 'actor-' + index })));
        assert.equal(ai.calls(), 2);
        assert.equal((await Usage.findById('search:' + ai.date().toISOString().slice(0, 10) + ':global').lean()).used, 2);
    });
    await t.test('real concurrent per-actor reservations cannot exceed the configured budget', async () => {
        const ai = aiFixture({ GEMINI_SEARCH_USER_DAILY_LIMIT: '2' });
        await settled(['linen', 'cotton', 'silk', 'red', 'blue', 'green'].map((word) => ai.interpret({ query: word + ' frock', actorKey: 'same-actor' })));
        assert.equal(ai.calls(), 2);
        assert.equal((await Usage.findById('search:' + ai.date().toISOString().slice(0, 10) + ':global').lean()).used, 2);
    });
    await t.test('provider failures release leases and cool down retries; expired leases can be recovered', async () => {
        const failed = aiFixture({}, true), query = 'linen frock';
        assert.equal(await failed.interpret({ query, actorKey: 'actor' }), null);
        assert.equal(await failed.interpret({ query, actorKey: 'actor' }), null);
        assert.equal(failed.calls(), 1);
        const row = await Cache.findById(failed.keyFor(query)).lean();
        assert.equal(row.state, 'ready'); assert.equal(row.leaseToken, undefined);
        failed.advance(61000);
        assert.equal(await failed.interpret({ query, actorKey: 'actor' }), null);
        assert.equal(failed.calls(), 2);
        const recovered = aiFixture();
        await Cache.create({ _id: recovered.keyFor(query), state: 'working', result: null, leaseToken: 'stale-token',
            leaseUntil: new Date(recovered.date().getTime() - 1000), expiresAt: new Date(recovered.date().getTime() + 60000) });
        assert.equal((await recovered.interpret({ query, actorKey: 'actor' })).gender, 'female');
        assert.equal(recovered.calls(), 1);
        const stale = await Cache.updateOne({ _id: recovered.keyFor(query), leaseToken: 'stale-token' }, { $set: { result: null } });
        assert.equal(stale.matchedCount, 0);
    });
});
