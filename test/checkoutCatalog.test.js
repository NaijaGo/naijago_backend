'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCheckoutCatalogService, normalizeItems } = require('../services/checkoutCatalogService');
const { createCheckoutInventoryService } = require('../services/checkoutInventoryService');
const P = '111111111111111111111111', O = '222222222222222222222222', V = '333333333333333333333333';
const S = '444444444444444444444444', O2 = '555555555555555555555555', V2 = '666666666666666666666666';
const item = (extra = {}) => ({ product: P, quantity: 1, ...extra });
const product = (extra = {}) => ({ _id: P, name: 'Real shirt', isActive: true, moderationStatus: 'approved', productStatus: 'active',
    sellerType: 'naijago', price: 2000, stockQuantity: 8, productLocation: { latitude: 0, longitude: 0 }, variants: [], ...extra });
const offer = (extra = {}) => ({ _id: O, product: P, sellerType: 'naijago', sellerId: null, status: 'active', isPrimary: true,
    price: 1500, discountPrice: null, stockQuantity: 5, variants: [], ...extra });
function fixture({ products = [product()], offers = [offer()], sellers = [] } = {}) {
    const sessions = [], filters = [];
    const model = (data) => ({ find: (filter) => {
        filters.push(filter);
        return { session(value) { sessions.push(value); return this; }, select() { return this; }, lean: async () => data };
    } });
    return { service: createCheckoutCatalogService({ Product: model(products), ProductOffer: model(offers), User: model(sellers) }), sessions, filters };
}
const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test('checkout rejects malformed identities and non-integer/zero/negative/oversized quantities before database reads', async () => {
    const { service, filters } = fixture();
    for (const quantity of [0, -1, 1.5, '2', NaN, Infinity, 100]) await rejects(service.resolve([item({ quantity })]), 'INVALID_QUANTITY');
    for (const change of [{ product: { $ne: null } }, { offer: 'invalid' }, { variantId: [] }]) await rejects(service.resolve([item(change)]), 'INVALID_ITEM');
    for (const value of [null, {}, [], Array(101).fill(item())]) await rejects(service.resolve(value), 'INVALID_ITEMS');
    assert.equal(filters.length, 0);
    assert.throws(() => normalizeItems([item({ customerNote: {} })]), { code: 'INVALID_NOTE' });
});

test('prices, stock, seller, SKU and zero-coordinate fulfilment come from the catalog, not the client', async () => {
    const { service } = fixture({ offers: [offer({ discountPrice: 0, sku: 'REAL' })] });
    const [line] = await service.resolve([item({ price: 1, authoritativePrice: 1, name: 'Forged', sku: 'FAKE', sellerId: S, vendorLocation: { latitude: 9 } })]);
    assert.equal(line.unitPrice, 0); assert.equal(line.item.sku, 'REAL'); assert.equal(line.sellerName, 'NaijaGo');
    assert.equal(line.sellerId, null); assert.deepEqual(line.sellerLocation, { latitude: 0, longitude: 0 });
    assert.equal(line.item.name, undefined); assert.equal(line.item.price, undefined);
});

test('catalog input IDs remain strict strings and do not accept wrapped or operator-bearing objects', async () => {
    const { service, filters } = fixture();
    for (const field of ['product', 'offer', 'variantId']) {
        for (const value of [{ _id: P }, { $oid: P }, { $ne: null }, { toString: () => P }, [P], 123]) {
            await rejects(service.resolve([item({ [field]: value })]), 'INVALID_ITEM');
        }
    }
    assert.equal(filters.length, 0);
});

test('disabled, foreign, missing and out-of-stock offers cannot fall back to stale product inventory', async () => {
    for (const status of ['disabled', 'draft', 'out_of_stock']) await rejects(fixture({ offers: [offer({ status })] }).service.resolve([item()]), 'OFFER_UNAVAILABLE');
    await rejects(fixture().service.resolve([item({ offer: O2 })]), 'OFFER_UNAVAILABLE');
    await rejects(fixture({ offers: [] }).service.resolve([item({ offer: O })]), 'OFFER_UNAVAILABLE');
    await rejects(fixture({ offers: [offer({ product: S })] }).service.resolve([item({ offer: O })]), 'OFFER_UNAVAILABLE');
    const [legacy] = await fixture({ offers: [] }).service.resolve([item()]);
    assert.equal(legacy.unitPrice, 2000); assert.equal(legacy.item.offer, null);
});

test('publication and both product-owner and selected-seller approval are enforced', async () => {
    for (const change of [{ isActive: false }, { moderationStatus: 'pending' }, { productStatus: 'disabled' }]) await rejects(fixture({ products: [product(change)] }).service.resolve([item()]), 'PRODUCT_UNAVAILABLE');
    await rejects(fixture({ products: [product({ vendor: S })] }).service.resolve([item()]), 'SELLER_UNAVAILABLE');
    await rejects(fixture({ offers: [offer({ sellerType: 'vendor', sellerId: S })] }).service.resolve([item()]), 'OFFER_UNAVAILABLE');
    const sellers = [{ _id: S, isVendor: true, vendorStatus: 'approved', businessName: 'Low Cost', businessLocation: { latitude: 9, longitude: 7 } }];
    const [line] = await fixture({ sellers, offers: [offer({ sellerType: 'vendor', sellerId: S })] }).service.resolve([item()]);
    assert.equal(line.sellerName, 'Low Cost'); assert.equal(line.sellerId, S); assert.equal(line.sellerLocation.latitude, 9);
});

test('primary offer choice is deterministic and never substitutes another offer when the primary is sold out', async () => {
    const [line] = await fixture({ offers: [offer({ _id: O2, isPrimary: false, price: 1 }), offer()] }).service.resolve([item()]);
    assert.equal(line.item.offer, O);
    await rejects(fixture({ offers: [offer({ status: 'out_of_stock' }), offer({ _id: O2, isPrimary: false })] }).service.resolve([item()]), 'OFFER_UNAVAILABLE');
});

test('combined duplicates count against offer stock while independent sellers do not share inventory', async () => {
    await rejects(fixture().service.resolve([item({ quantity: 3 }), item({ quantity: 3 })]), 'INSUFFICIENT_STOCK');
    const { service } = fixture({ offers: [offer(), offer({ _id: O2, isPrimary: false })] });
    assert.equal((await service.resolve([item({ offer: O, quantity: 5 }), item({ offer: O2, quantity: 5 })])).length, 2);
});

test('legacy size strings, option objects and custom dimensions are verified and retained without untrusted fields', async () => {
    const products = [product({ sizeData: { sizes: [{ value: 'M', label: 'Medium', unit: 'size' }], customDimensions: [{ length: 2, width: 3, height: 4, unit: 'm', label: 'Real' }] } })];
    const { service } = fixture({ products });
    assert.equal((await service.resolve([item({ selectedSize: 'M' })]))[0].item.selectedSize, 'M');
    assert.deepEqual((await service.resolve([item({ selectedSize: { value: 'M', label: 'Fake', price: 1 } })]))[0].item.selectedSize, { value: 'M', label: 'Medium', unit: 'size' });
    const dimensions = { length: 2, width: 3, height: 4, unit: 'm', label: 'Fake', price: 1 };
    assert.deepEqual((await service.resolve([item({ selectedSize: dimensions })]))[0].item.selectedSize, { length: 2, width: 3, height: 4, unit: 'm', label: 'Real' });
    await rejects(service.resolve([item()]), 'SIZE_REQUIRED');
    await rejects(service.resolve([item({ selectedSize: 'XXL' })]), 'SIZE_UNAVAILABLE');
    await rejects(service.resolve([item({ selectedSize: { ...dimensions, length: 9 } })]), 'SIZE_UNAVAILABLE');
});

test('structured variants use offer variant price, SKU and stock with canonical product variant identity', async () => {
    const variants = [{ _id: V, isActive: true, attributes: { size: 'M' }, price: 900, stockQuantity: 99 }];
    const offers = [offer({ variants: [{ _id: O2, productVariantId: V, isActive: true, price: 1700, discountPrice: 1600, stockQuantity: 2, sku: 'M-REAL' }] })];
    const { service } = fixture({ products: [product({ variants })], offers });
    const [line] = await service.resolve([item({ selectedSize: { value: 'M' } })]);
    assert.equal(line.item.variantId, V); assert.equal(line.unitPrice, 1600); assert.equal(line.item.sku, 'M-REAL');
    assert.deepEqual(line.item.variantAttributes, { size: 'M' });
    await rejects(service.resolve([item({ variantId: V, quantity: 2 }), item({ variantId: V })]), 'INSUFFICIENT_STOCK');
    await rejects(service.resolve([item({ variantId: O2 })]), 'VARIANT_UNAVAILABLE');
    await rejects(service.resolve([item({ variantId: V, selectedSize: 'L' })]), 'SIZE_UNAVAILABLE');
    await rejects(service.resolve([item()]), 'VARIANT_UNAVAILABLE');
    await rejects(fixture({ products: [product({ variants })] }).service.resolve([item({ variantId: V })]), 'VARIANT_UNAVAILABLE');
});

test('parent stock constrains different variants and ambiguous legacy variant mapping is rejected', async () => {
    const variants = [V, V2].map((_id) => ({ _id, isActive: true, attributes: { size: 'M' }, price: 1000, stockQuantity: 5 }));
    const { service } = fixture({ products: [product({ stockQuantity: 3, variants })], offers: [] });
    await rejects(service.resolve([item({ selectedSize: 'M' })]), 'VARIANT_UNAVAILABLE');
    await rejects(service.resolve([item({ variantId: V, quantity: 2 }), item({ variantId: V2, quantity: 2 })]), 'INSUFFICIENT_STOCK');
});

test('invalid catalog price/stock/location fail closed and all reads use the provided transaction', async () => {
    for (const change of [{ price: NaN }, { discountPrice: -1 }, { discountPrice: 1600 }]) await rejects(fixture({ offers: [offer(change)] }).service.resolve([item()]), 'PRICE_UNAVAILABLE');
    await rejects(fixture({ offers: [offer({ stockQuantity: -1 })] }).service.resolve([item()]), 'INSUFFICIENT_STOCK');
    await rejects(fixture({ products: [product({ productLocation: { latitude: 91, longitude: 0 } })] }).service.resolve([item()]), 'LOCATION_UNAVAILABLE');
    const f = fixture(), session = {}; await f.service.resolve([item()], { session });
    assert.deepEqual(f.sessions, [session, session]);
});

test('inventory settlement requires a transaction and decrements the chosen variant atomically', async () => {
    const calls = [], session = { inTransaction: () => true };
    const Product = { findOneAndUpdate: async (...args) => { calls.push(['product', ...args]); return {}; } };
    const ProductOffer = { findOneAndUpdate: async (...args) => { calls.push(['offer', ...args]); return offer({ stockQuantity: 3, variants: [{ productVariantId: V, stockQuantity: 1 }] }); } };
    const { decrement } = createCheckoutInventoryService({ Product, ProductOffer });
    await assert.rejects(decrement({ item: item() }), /active transaction/); assert.equal(calls.length, 0);
    await decrement({ item: item({ offer: O, variantId: V, quantity: 2 }), session, sellerType: 'naijago' });
    assert.deepEqual(calls[0][1], { _id: O, product: P, stockQuantity: { $gte: 2 }, sellerType: 'naijago', sellerId: null,
        variants: { $elemMatch: { productVariantId: V, stockQuantity: { $gte: 2 } } } });
    assert.deepEqual(calls[0][2], { $inc: { stockQuantity: -2, 'variants.$.stockQuantity': -2 } });
    assert.deepEqual(calls[1][2], { $inc: { salesCount: 2 }, $set: { stockQuantity: 3, 'variants.$.stockQuantity': 1 } });
    assert.equal(calls[1][3].session, session);
});

test('secondary offers leave primary stock untouched and inventory mismatches stop settlement', async () => {
    const updates = [], session = { inTransaction: () => true };
    const Product = { findOneAndUpdate: async (filter, update) => { updates.push(update); return {}; } };
    const ProductOffer = { findOneAndUpdate: async () => offer({ isPrimary: false }) };
    await createCheckoutInventoryService({ Product, ProductOffer }).decrement({ item: item({ offer: O }), session });
    assert.deepEqual(updates, [{ $inc: { salesCount: 1 } }]);
    ProductOffer.findOneAndUpdate = async () => null;
    await rejects(createCheckoutInventoryService({ Product, ProductOffer }).decrement({ item: item({ offer: O }), session }), 'INSUFFICIENT_STOCK');
    assert.equal(updates.length, 1);
    Product.findOneAndUpdate = async () => null;
    await rejects(createCheckoutInventoryService({ Product, ProductOffer }).decrement({ item: item({ variantId: V }), session }), 'INSUFFICIENT_STOCK');
});
