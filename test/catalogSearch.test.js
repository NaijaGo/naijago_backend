const test = require('node:test');
const assert = require('node:assert/strict');
const { readIntent, deriveSearchAttributes, buildIntentFilter, collectionForIntent, escapeRegex } = require('../utils/catalogSearch');
const { createCatalogSearchService, parseSearchInput, buildSearchPipeline } = require('../services/catalogSearchService');
const Product = require('../models/Product');

test('broad female fashion synonyms produce one structured collection', () => {
    for (const q of ['female clothes', 'women clothing', 'ladies wear', 'female fashion', 'women clothes']) {
        const intent = readIntent(q);
        assert.equal(intent.gender, 'female', q);
        assert.equal(intent.categoryFamily, 'fashion', q);
        assert.deepEqual(intent.terms, [], q);
        assert.equal(collectionForIntent(intent).title, 'Women Fashion');
    }
});
test('specific types and unknown brand/model words retain their meaning', () => {
    for (const [q, gender, type] of [['female dresses', 'female', 'dress'], ['men shoes', 'male', 'shoes'], ['female bags', 'female', 'bag'], ['men shirts', 'male', 'shirt'], ['men t-shirts', 'male', 't_shirt']]) {
        const intent = readIntent(q);
        assert.equal(intent.gender, gender);
        assert.deepEqual(intent.productTypes, [type], q);
    }
    assert.deepEqual(readIntent('iPhone 15 Pro').terms, ['iphone', '15', 'pro']);
    assert.equal(readIntent('food').categoryFamily, 'food');
    assert.equal(readIntent('electronics').categoryFamily, 'electronics');
});
test('children are not silently classified as adult fashion', () => {
    assert.equal(readIntent('girls dresses').ageGroup, 'child');
    assert.equal(readIntent('women dresses').ageGroup, 'adult');
    assert.equal(readIntent('female dresses').ageGroup, null);
    assert.equal(readIntent('boys shirts').gender, 'male');
});

test('View all broadens types without dropping audience, literal terms or price filters', () => {
    const input = parseSearchInput({ q: 'red female dresses', productType: 'all', maxPrice: '50000' });
    assert.deepEqual(input.intent.productTypes, []);
    assert.equal(input.intent.gender, 'female');
    assert.equal(input.intent.categoryFamily, 'fashion');
    assert.deepEqual(input.intent.terms, ['red']);
    assert.equal(input.maxPrice, 50000);
    assert.deepEqual(parseSearchInput({ q: 'female dresses' }).intent.productTypes, ['dress']);
});
test('search attributes derive from taxonomy and tags, not an exact title phrase', () => {
    const attributes = deriveSearchAttributes({ name: 'Long Sleeve Classic', category: 'Fashion', subcategory: 'Dresses', searchTags: ['women', 'cotton'], brand: 'Sample Brand' });
    assert.equal(attributes.categoryFamily, 'fashion');
    assert.equal(attributes.gender, 'female');
    assert.deepEqual(attributes.productTypes, ['dress']);
    assert.ok(attributes.tokens.includes('cotton'));
    assert.equal(deriveSearchAttributes({ name: 'Dress', category: 'Fashion', gender: 'unisex', productType: 'dresses' }).gender, 'unisex');
});
test('gender matching uses boundaries and regex input is literal', () => {
    const query = buildIntentFilter(readIntent('men shoes'));
    const text = JSON.stringify(query);
    assert.match(text, /searchAttributes.gender/);
    const pattern = query.$and[1].$or[1].$and[1].$or[0].name;
    const regex = new RegExp(pattern.$regex, pattern.$options);
    assert.equal(regex.test('Women fashion'), false);
    assert.equal(regex.test('Men fashion'), true);
    assert.equal(new RegExp(escapeRegex('a.*(b)')).test('aXXXb'), false);
});
test('filters validate before a database call and combine with intent', () => {
    assert.throws(() => parseSearchInput({ q: { $ne: '' } }));
    assert.throws(() => parseSearchInput({ q: 'dress', minPrice: '5000', maxPrice: '100' }));
    assert.throws(() => parseSearchInput({ q: 'dress', vendor: 'invalid' }));
    assert.throws(() => parseSearchInput({ q: 'dress', page: '1.5' }));
    const input = parseSearchInput({ q: 'female clothes', productType: 'shoes', minPrice: '10000', maxPrice: '50000', sort: 'price_low', inStock: 'true' });
    const pipeline = buildSearchPipeline(input);
    assert.equal(pipeline[0].$match.isActive, true);
    assert.equal(pipeline[0].$match.moderationStatus, 'approved');
    assert.equal(pipeline[0].$match.productStatus, 'active');
    assert.deepEqual(pipeline.find((stage) => stage.$match?.__searchPrice).$match.__searchPrice, { $gte: 10000, $lte: 50000 });
    assert.equal(pipeline.at(-1).$facet.products[0].$sort.__searchPrice, 1);
    assert.ok(pipeline.some((stage) => stage.$lookup?.from === 'productoffers'));
});
test('product validation stores the same versioned search attributes', async () => {
    const product = new Product({ name: 'Blue Linen Shirt', description: 'Long sleeve', category: 'Fashion', subcategory: 'Mens Fashion', gender: 'male', ageGroup: 'adult', productType: 'shirt', price: 20000, stockQuantity: 1 });
    await product.validate();
    assert.equal(product.searchAttributes.version, 1);
    assert.equal(product.searchAttributes.gender, 'male');
    assert.deepEqual([...product.searchAttributes.productTypes], ['shirt']);
    product.gender = 'female';
    await product.validate();
    assert.equal(product.searchAttributes.gender, 'female');
});

test('search lookups use injected collections and verify owners and offer sellers', () => {
    const input = parseSearchInput({ q: '$price', vendor: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    const pipeline = buildSearchPipeline(input, { offersCollection: 'isolated_offers', usersCollection: 'isolated_users' });
    const owner = pipeline.find((stage) => stage.$lookup?.as === '__ownerApproval').$lookup;
    assert.equal(owner.from, 'isolated_users');
    assert.deepEqual(owner.pipeline[0].$match, { isVendor: true, vendorStatus: 'approved' });
    const offers = pipeline.find((stage) => stage.$lookup?.as === '__offers').$lookup;
    assert.equal(offers.from, 'isolated_offers');
    assert.equal(String(offers.pipeline[0].$match.sellerId), input.vendor);
    assert.equal(offers.pipeline.find((stage) => stage.$lookup).$lookup.from, 'isolated_users');
    assert.ok(pipeline.find((stage) => stage.$lookup?.as === '__anyOffers'));
    assert.ok(pipeline.find((stage) => stage.$match?.$or?.some((clause) => clause['__anyOffers.0'])));
    const relevance = pipeline.find((stage) => stage.$set?.__relevance).$set.__relevance;
    assert.deepEqual(relevance.$add[0].$cond[0].$eq[1], { $literal: '$price' });
    assert.equal(pipeline.at(-1).$facet.products.at(-1).$unset.includes('__offers'), false);
});

test('search passes aggregate offer snapshots into presentation without leaking internal fields', async () => {
    const offer = { _id: 'offer', product: 'product', price: 500, stockQuantity: 2 };
    let presented = false;
    const service = createCatalogSearchService({
        Product: {
            aggregate() { return { option: async () => [{ products: [{ _id: 'product', __offers: [offer] }], totals: [{ count: 1 }] }] }; },
            populate: async (rows) => rows,
        },
        ProductOffer: { collection: { name: 'isolated_offers' } },
        User: { collection: { name: 'isolated_users' } },
        categoryFilter: () => ({}), vendorPopulateFields: '',
        async enrichProducts(rows, { offers }) {
            presented = true;
            assert.deepEqual(offers, [offer]);
            assert.deepEqual(rows, [{ _id: 'product' }]);
            return rows;
        },
    });
    const result = await service.search({});
    assert.equal(presented, true);
    assert.equal(result.total, 1);
});
