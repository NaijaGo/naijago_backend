const test = require('node:test');
const assert = require('node:assert/strict');
const ProductOffer = require('../models/ProductOffer');
const { attachPrimaryOffers } = require('../services/productCatalogPresentation');

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
