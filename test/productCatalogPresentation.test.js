const test = require('node:test');
const assert = require('node:assert/strict');
const ProductOffer = require('../models/ProductOffer');
const { attachPrimaryOffers, createProductCatalogPresentation } = require('../services/productCatalogPresentation');

test('presentation preserves real offers, discounts, stock and NaijaGo seller identity', async (t) => {
    let queries = 0;
    t.mock.method(ProductOffer, 'find', () => { queries++; return { populate() { return this; }, sort() { return this; }, lean: async () => [
        { _id: 'offer1', product: 'p1', isPrimary: true, sellerType: 'naijago', sellerId: null, price: 100, discountPrice: 80, stockQuantity: 7 },
        { _id: 'offer2', product: 'p2', isPrimary: true, sellerType: 'vendor', sellerId: { _id: 'v2', businessName: 'Real store' }, price: 300, discountPrice: null, stockQuantity: 0 },
    ] }; });
    const products = await attachPrimaryOffers([
        { _id: 'p1', price: 999, vendor: { _id: 'oldvendor' } },
        { _id: 'p2', price: 999, discountPrice: 10, stockQuantity: 8 },
        { _id: 'p3', sellerType: 'naijago', price: 50, stockQuantity: 2 },
    ]);
    assert.equal(products[0].sellerName, 'NaijaGo');
    assert.equal(products[0].sellerId, null);
    assert.equal(products[0].effectivePrice, 80);
    assert.equal(products[0].stockQuantity, 7);
    assert.equal(products[1].sellerName, 'Real store');
    assert.equal(products[1].sellerId, 'v2');
    assert.equal(products[1].effectivePrice, 300);
    assert.equal(products[1].discountPrice, null);
    assert.equal(products[1].stockQuantity, 0);
    assert.equal(products[2].sellerName, 'NaijaGo');
    assert.equal(products[2].effectivePrice, 50);
    assert.deepEqual(await attachPrimaryOffers([]), []);
    assert.equal(queries, 1);
});

test('preloaded search offers preserve the filtered snapshot without another offer query', async () => {
    let populations = 0;
    const Offer = {
        find() { assert.fail('Search must not re-fetch offers after filtering.'); },
        async populate(offers, options) {
            populations++;
            assert.equal(options.path, 'sellerId');
            return offers.map((offer) => ({ ...offer, sellerId: { _id: 'v1', businessName: 'Approved store' } }));
        },
    };
    const { attachPrimaryOffers: present } = createProductCatalogPresentation({ Offer });
    const product = { _id: 'p1', price: 999, discountPrice: 1, stockQuantity: 99 };
    const [result] = await present([product], { offers: [
        { _id: 'chosen', product: 'p1', sellerType: 'vendor', sellerId: 'v1', price: 120,
            discountPrice: null, stockQuantity: 2, isPrimary: true },
    ] });
    assert.equal(result.effectivePrice, 120);
    assert.equal(result.discountPrice, null);
    assert.equal(result.stockQuantity, 2);
    assert.equal(result.selectedOffer._id, 'chosen');
    assert.equal(result.sellerName, 'Approved store');
    const [legacy] = await present([product], { offers: [] });
    assert.equal(legacy.selectedOffer, null);
    assert.equal(legacy.effectivePrice, 1);
    assert.equal(populations, 2);
});
