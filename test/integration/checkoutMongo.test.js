'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { openIsolatedTestDatabase } = require('../../scripts/lib/openIsolatedTestDatabase');
const { createCheckoutCatalogService } = require('../../services/checkoutCatalogService');
const { createCheckoutInventoryService } = require('../../services/checkoutInventoryService');

test('isolated Mongo: authoritative checkout, variant inventory races and settlement rollback', {
    skip: !process.env.NAIJAGO_TEST_MONGO_URI, timeout: 180000,
}, async (t) => {
    const { connection, models } = await openIsolatedTestDatabase(t, ['Product', 'ProductOffer', 'User']);
    const { Product, ProductOffer, User } = models;
    const catalog = createCheckoutCatalogService(models), inventory = createCheckoutInventoryService(models);
    const seller = new Types.ObjectId();
    await User.collection.insertOne({ _id: seller, isVendor: true, vendorStatus: 'approved', businessName: 'Synthetic shop',
        businessLocation: { latitude: 9, longitude: 7 } });
    async function fixture() {
        const productId = new Types.ObjectId(), offerId = new Types.ObjectId(), variantId = new Types.ObjectId();
        await Product.collection.insertOne({ _id: productId, name: 'Synthetic inventory fixture', category: 'Fashion', description: 'TEST ONLY',
            isActive: true, moderationStatus: 'approved', productStatus: 'active', sellerType: 'naijago', sellerId: null, vendor: null,
            price: 9999, stockQuantity: 999, salesCount: 0, productLocation: { latitude: 0, longitude: 0 },
            variants: [{ _id: variantId, isActive: true, attributes: { size: 'M' }, price: 9999, stockQuantity: 999 }] });
        await ProductOffer.collection.insertOne({ _id: offerId, product: productId, sellerType: 'naijago', sellerId: null, status: 'active', isPrimary: true,
            price: 2000, discountPrice: null, stockQuantity: 8,
            variants: [{ _id: new Types.ObjectId(), productVariantId: variantId, isActive: true, price: 2500, discountPrice: 2000, stockQuantity: 2 }] });
        return { productId, offerId, variantId, item: { product: String(productId), offer: String(offerId), variantId: String(variantId), quantity: 1 } };
    }
    await t.test('real catalog queries prefer offer prices and reject combined variant quantities', async () => {
        const f = await fixture();
        const [line] = await catalog.resolve([{ ...f.item, price: 1 }]);
        assert.equal(line.unitPrice, 2000); assert.equal(line.item.variantId, String(f.variantId));
        await assert.rejects(catalog.resolve([{ ...f.item, quantity: 2 }, f.item]), { code: 'INSUFFICIENT_STOCK' });
        await ProductOffer.updateOne({ _id: f.offerId }, { $set: { status: 'disabled' } });
        await assert.rejects(catalog.resolve([f.item]), { code: 'OFFER_UNAVAILABLE' });
    });
    await t.test('competing variant settlements cannot oversell and primary mirrors follow authoritative offer stock', async () => {
        const f = await fixture();
        const results = await Promise.allSettled(Array.from({ length: 4 }, () => connection.transaction((session) => inventory.decrement({ item: f.item, session, sellerType: 'naijago' }))));
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
        for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'INSUFFICIENT_STOCK');
        const offer = await ProductOffer.findById(f.offerId), product = await Product.findById(f.productId);
        assert.equal(offer.stockQuantity, 6); assert.equal(offer.variants[0].stockQuantity, 0);
        assert.equal(product.stockQuantity, 6); assert.equal(product.variants[0].stockQuantity, 0); assert.equal(product.salesCount, 2);
    });
    await t.test('a later settlement failure rolls back offer stock, variant stock and sales together', async () => {
        const f = await fixture();
        await assert.rejects(connection.transaction(async (session) => {
            await inventory.decrement({ item: f.item, session }); throw new Error('synthetic-settlement-failure');
        }), /synthetic-settlement-failure/);
        const offer = await ProductOffer.findById(f.offerId), product = await Product.findById(f.productId);
        assert.equal(offer.stockQuantity, 8); assert.equal(offer.variants[0].stockQuantity, 2);
        assert.equal(product.stockQuantity, 999); assert.equal(product.variants[0].stockQuantity, 999); assert.equal(product.salesCount, 0);
    });
    await t.test('secondary seller stock is independent and forged seller/variant identities cannot decrement inventory', async () => {
        const f = await fixture(), other = new Types.ObjectId();
        await ProductOffer.collection.insertOne({ _id: other, product: f.productId, sellerType: 'vendor', sellerId: seller, status: 'active', isPrimary: false,
            price: 3000, stockQuantity: 2, variants: [{ _id: new Types.ObjectId(), productVariantId: f.variantId, isActive: true, price: 3000, stockQuantity: 2 }] });
        const item = { ...f.item, offer: String(other) };
        await connection.transaction((session) => inventory.decrement({ item, session, sellerType: 'vendor', sellerId: seller }));
        assert.equal((await ProductOffer.findById(other)).stockQuantity, 1);
        assert.equal((await ProductOffer.findById(f.offerId)).stockQuantity, 8);
        assert.equal((await Product.findById(f.productId)).stockQuantity, 999);
        await assert.rejects(connection.transaction((session) => inventory.decrement({ item, session, sellerType: 'vendor', sellerId: new Types.ObjectId() })), { code: 'INSUFFICIENT_STOCK' });
        await assert.rejects(connection.transaction((session) => inventory.decrement({ item: { ...item, variantId: String(new Types.ObjectId()) }, session })), { code: 'INSUFFICIENT_STOCK' });
        assert.equal((await ProductOffer.findById(other)).stockQuantity, 1); assert.equal((await Product.findById(f.productId)).salesCount, 1);
    });
    await t.test('legacy no-offer variants retain atomic stock protection', async () => {
        const productId = new Types.ObjectId(), variantId = new Types.ObjectId();
        await Product.collection.insertOne({ _id: productId, stockQuantity: 2, salesCount: 0, variants: [{ _id: variantId, stockQuantity: 1 }] });
        const item = { product: String(productId), variantId: String(variantId), quantity: 1 };
        await connection.transaction((session) => inventory.decrement({ item, session }));
        await assert.rejects(connection.transaction((session) => inventory.decrement({ item, session })), { code: 'INSUFFICIENT_STOCK' });
        const product = await Product.findById(productId);
        assert.equal(product.stockQuantity, 1); assert.equal(product.variants[0].stockQuantity, 0); assert.equal(product.salesCount, 1);
    });
});
