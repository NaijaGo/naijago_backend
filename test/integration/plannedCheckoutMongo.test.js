'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { openIsolatedTestDatabase } = require('../../scripts/lib/openIsolatedTestDatabase');
const { loadCheckoutForTests } = require('../../scripts/lib/loadCheckoutForTests');
const { createPlannedOrderServices } = require('../../services/plannedOrderServiceFactory');
const { createBackgroundJobService } = require('../../services/backgroundJobService');
const oid = () => new Types.ObjectId();

test('isolated Mongo: real planned receipts, source identity and transactional checkout rollback', {
    skip: !process.env.NAIJAGO_TEST_MONGO_URI, timeout: 300000,
}, async (t) => {
    const { connection, models } = await openIsolatedTestDatabase(t,
        ['Product', 'ProductOffer', 'User', 'AppSetting', 'MainOrder', 'Shipment', 'GroupOrder', 'BackgroundJob']);
    const { Product, ProductOffer, User, AppSetting, MainOrder, Shipment, GroupOrder, BackgroundJob } = models;
    const now = () => new Date('2100-01-01T08:00:00Z'), owner = oid(), seller = oid();
    await User.collection.insertMany([{ _id: owner }, { _id: seller, isVendor: true, vendorStatus: 'approved', businessName: 'Synthetic shop',
        businessLocation: { latitude: 9, longitude: 7, formattedAddress: 'Synthetic shop only' } }]);
    await AppSetting.create({ key: 'cost_low_store', costLowStore: { vendorId: seller, commissionKoboPerUnit: 5700 } });
    const queue = createBackgroundJobService({ Job: BackgroundJob, allowedTypes: ['group.notify', 'recurring.notify'], now });
    const checkout = loadCheckoutForTests({ models, connection });
    const dependencies = { models, connection, queue, ...checkout, signingSecret: 'synthetic-only-planned-checkout-test-key', now };
    const services = createPlannedOrderServices(dependencies);
    async function fixture() {
        const productId = oid(), offerId = oid(), variantId = oid();
        await Product.collection.insertOne({ _id: productId, name: 'Synthetic shirt', description: 'Test only', category: 'Fashion',
            imageUrls: ['https://example.invalid/synthetic.jpg'], isActive: true, moderationStatus: 'approved', productStatus: 'active',
            sellerType: 'vendor', sellerId: seller, vendor: seller, price: 9000, stockQuantity: 80,
            variants: [{ _id: variantId, isActive: true, attributes: { size: 'M' }, stockQuantity: 80, price: 9000 }] });
        await ProductOffer.collection.insertOne({ _id: offerId, product: productId, sellerType: 'vendor', sellerId: seller,
            status: 'active', isPrimary: true, price: 1000, stockQuantity: 4,
            variants: [{ _id: oid(), productVariantId: variantId, isActive: true, price: 1000, stockQuantity: 4, sku: 'TEST-M' }] });
        const item = { product: String(productId), offer: String(offerId), selectedSize: 'M', quantity: 1 };
        const group = await services.groups.create({ actor: String(owner), displayName: 'Owner', input: { name: 'Synthetic cart', sellerType: 'vendor', sellerId: String(seller),
            anchorItem: item, cutoffAt: '2100-01-01T12:00:00Z', destinationLabel: 'Reception',
            destination: { address: 'Private synthetic destination', city: 'Abuja', postalCode: '900001', country: 'NG', phoneNumber: 'synthetic-only', latitude: 9.1, longitude: 7.1 } } });
        const groupId = group.group.id, guest = String(oid());
        let current = await services.groups.join({ token: group.inviteToken, actor: guest, displayName: 'Guest' });
        current = await services.groups.edit({ groupId, actor: guest, revision: current.revision, items: [item] });
        current = await services.groups.edit({ groupId, actor: String(owner), revision: current.revision, items: [item] });
        current = await services.groups.control({ groupId, actor: String(owner), revision: current.revision, action: 'close' });
        const args = { groupId, actor: String(owner), revision: current.revision, paymentMethod: 'Card' };
        const quote = await services.groups.quote(args);
        return { args: { ...args, approvalToken: quote.approvalToken }, productId, offerId, variantId, guest, quote };
    }
    await t.test('concurrent checkouts create one receipt, one fee/shipment and one notification without consuming stock', async () => {
        const f = await fixture();
        const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => services.checkoutGroup(f.args)));
        for (const result of outcomes) if (result.status === 'rejected') throw result.reason;
        assert.equal(new Set(outcomes.map((result) => result.value.orderId)).size, 1);
        const orders = await MainOrder.find({ 'planning.sourceId': f.args.groupId }); assert.equal(orders.length, 1);
        const order = orders[0], shipments = await Shipment.find({ mainOrder: order._id });
        assert.equal(shipments.length, 1); assert.equal(order.isPaid, false); assert.equal(order.mainOrderStatus, 'pending_payment');
        assert.equal(order.totalPrice, 2500); assert.equal(order.totalShippingPrice, 500); assert.equal(order.totalPlatformFees, 114);
        assert.equal(shipments[0].items.length, 2); assert.ok(shipments[0].items.every((item) => item.selectedSize === 'M' && String(item.variantId) === String(f.variantId)));
        assert.equal(String((await GroupOrder.findById(f.args.groupId)).order), String(order._id));
        assert.equal(await BackgroundJob.countDocuments({ 'payload.groupId': f.args.groupId, 'payload.event': 'checkout_started' }), 1);
        assert.equal((await ProductOffer.findById(f.offerId)).stockQuantity, 4);
    });
    await t.test('stale approval and non-owner checkout cannot create or link a receipt', async () => {
        const f = await fixture();
        await assert.rejects(services.checkoutGroup({ ...f.args, actor: f.guest }), { code: 'OWNER_REQUIRED' });
        await ProductOffer.updateOne({ _id: f.offerId }, { $set: { 'variants.0.price': 1100 } });
        await assert.rejects(services.checkoutGroup(f.args), { code: 'QUOTE_CHANGED' });
        assert.equal(await MainOrder.countDocuments({ 'planning.sourceId': f.args.groupId }), 0);
        assert.equal((await GroupOrder.findById(f.args.groupId)).state, 'closed');
    });
    await t.test('outbox failure rolls back the actual receipt, shipments and source claim', async () => {
        const f = await fixture(), beforeShipments = await Shipment.countDocuments({});
        const broken = createPlannedOrderServices({ ...dependencies, queue: { enqueue: async () => { throw new Error('synthetic-outbox-failure'); } } });
        await assert.rejects(broken.checkoutGroup(f.args), /synthetic-outbox-failure/);
        assert.equal(await MainOrder.countDocuments({ 'planning.sourceId': f.args.groupId }), 0);
        assert.equal(await Shipment.countDocuments({}), beforeShipments);
        const group = await GroupOrder.findById(f.args.groupId); assert.equal(group.state, 'closed'); assert.equal(group.order, null);
        const retried = await services.checkoutGroup(f.args); assert.equal(retried.reused, false);
    });
    await t.test('unique source index rejects a second planned receipt while ordinary historical orders remain valid', async () => {
        const f = await fixture(), created = await services.checkoutGroup(f.args);
        const record = (await MainOrder.findById(created.orderId)).toObject(); delete record._id;
        await assert.rejects(MainOrder.collection.insertOne({ ...record, _id: oid() }), { code: 11000 });
        delete record.planning;
        const result = await MainOrder.collection.insertMany([{ ...record, _id: oid() }, { ...record, _id: oid() }]);
        assert.equal(result.insertedCount, 2);
    });
    await t.test('scheduled checkout cannot silently become an immediate delivery even if a supplied availability adapter approves', async () => {
        const f = await fixture();
        await GroupOrder.updateOne({ _id: f.args.groupId }, { $set: { schedule: { mode: 'scheduled', timeZone: 'Africa/Lagos',
            startAt: new Date('2100-01-02T08:00:00Z'), endAt: new Date('2100-01-02T11:00:00Z') } } });
        const testingSchedule = createPlannedOrderServices({ ...dependencies, checkSchedule: async () => ({ eligible: true }) });
        const fresh = await testingSchedule.groups.quote(f.args);
        await assert.rejects(testingSchedule.checkoutGroup({ ...f.args, approvalToken: fresh.approvalToken }), { code: 'SCHEDULE_UNAVAILABLE' });
        assert.equal(await MainOrder.countDocuments({ 'planning.sourceId': f.args.groupId }), 0);
        assert.equal((await GroupOrder.findById(f.args.groupId)).state, 'closed');
    });
});
