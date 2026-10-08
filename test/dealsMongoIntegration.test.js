// Opt-in real MongoDB verification. Never falls back to MONGO_URI.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const Deal = require('../models/Deal');
const Product = require('../models/Product');
const Offer = require('../models/ProductOffer');
const User = require('../models/User');
const Shipment = require('../models/Shipment');
const MainOrder = require('../models/MainOrder');
const service = require('../services/dealService');
const prices = require('../services/productPriceService');
const { router, adminRouter } = require('../routes/dealRoutes');

test('real MongoDB Deals persistence, aggregation, indexes and Admin API', {
  skip: !process.env.INVENTORY_TEST_MONGO_URI,
}, async t => {
  const database = 'naijago_deals_test_' + Date.now() + '_' + new mongoose.Types.ObjectId();
  const originalSecret = process.env.JWT_SECRET;
  let server;
  await mongoose.connect(process.env.INVENTORY_TEST_MONGO_URI, { dbName: database, serverSelectionTimeoutMS: 15000 });
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.ok(hello.setName || hello.msg === 'isdbgrid', 'A real replica set or mongos is required');
    await Promise.all([Deal, Product, Offer, User, Shipment, MainOrder].map(model => model.init()));
    let counter = 0;
    async function user(role) {
      counter++;
      return User.create({ firstName: 'Database', lastName: 'Fixture',
        email: 'fixture' + counter + '@example.invalid', phoneNumber: '080' + String(counter).padStart(8, '0'),
        password: 'local-test-only-password', isAdmin: role === 'admin',
        isVendor: role === 'vendor', vendorStatus: role === 'vendor' ? 'approved' : 'none',
        businessName: role === 'vendor' ? 'Dedicated Test Vendor ' + counter : undefined });
    }
    const vendor = await user('vendor'), other = await user('vendor'), admin = await user('admin'), customer = await user('customer');
    async function fixture(owner = vendor, override = {}) {
      const product = await Product.create({ name: 'Dedicated database product', description: 'Test data only',
        price: 1000, stockQuantity: 10, category: 'Electronics', sellerType: 'vendor', sellerId: owner._id,
        productStatus: 'active', moderationStatus: 'approved' });
      const offer = await Offer.create({ product: product._id, sellerType: 'vendor', sellerId: owner._id,
        price: 1000, stockQuantity: 10, status: 'active' });
      const body = { productId: String(product._id), productOfferId: String(offer._id), discountType: 'percentage',
        discountValue: 20, startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString(), ...override };
      return { product, offer, body, owner };
    }
    async function pending(f) { return service.create(f.body, f.owner); }
    async function approved(f) { const deal = await pending(f); return service.moderate(String(deal._id), { action: 'approve' }, admin); }
    const publicIds = async () => (await service.listActive({ limit: '50' })).deals.map(row => String(row._id));
    process.env.JWT_SECRET = 'dedicated-local-deals-integration-key';
    const app = express(); app.use(express.json()); app.use('/api/deals', router); app.use('/api/admin/deals', adminRouter);
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    async function api(path, actor, method = 'GET', body) {
      const headers = actor ? { Authorization: 'Bearer ' + jwt.sign({ id: String(actor._id) }, process.env.JWT_SECRET) } : {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: response.headers.get('content-type')?.includes('application/json') ? await response.json() : { text: await response.text() } };
    }
    await t.test('persistence retains references, dates, pricing fields and audit metadata', async () => {
      const f = await fixture(); const deal = await approved(f); const stored = await Deal.findById(deal._id).lean();
      assert.equal(String(stored.productId), String(f.product._id)); assert.equal(String(stored.productOfferId), String(f.offer._id));
      assert.equal(String(stored.vendorId), String(vendor._id)); assert.equal(stored.discountValue, 20);
      assert.equal(stored.startAt.toISOString(), f.body.startAt); assert.equal(stored.endAt.toISOString(), f.body.endAt);
      assert.equal(stored.status, 'approved'); assert.equal(String(stored.approvedBy), String(admin._id)); assert.ok(stored.approvedAt instanceof Date);
    });
    await t.test('actual unique approved-target index rejects duplicate approvals', async () => {
      const indexes = await Deal.collection.indexes(); const index = indexes.find(row => row.name === 'one_approved_deal_per_target');
      assert.equal(index.unique, true); assert.deepEqual(index.key, { targetKey: 1 }); assert.deepEqual(index.partialFilterExpression, { status: 'approved' });
      const f = await fixture(); await approved(f); const duplicate = await pending(f);
      await assert.rejects(service.moderate(String(duplicate._id), { action: 'approve' }, admin), { code: 11000 });
      assert.equal(await Deal.countDocuments({ targetKey: String(f.product._id) + ':' + f.offer._id, status: 'approved' }), 1);
    });
    await t.test('real aggregation filters inactive, expired, future, rejected and paused Deals', async () => {
      const active = await approved(await fixture());
      const future = await approved(await fixture(vendor, { startAt: new Date(Date.now() + 600000).toISOString() }));
      const expired = await approved(await fixture()); await Deal.updateOne({ _id: expired._id }, { $set: { startAt: new Date(Date.now() - 120000), endAt: new Date(Date.now() - 60000) } });
      const paused = await approved(await fixture()); await service.moderate(String(paused._id), { action: 'pause' }, admin);
      const rejected = await pending(await fixture()); await service.moderate(String(rejected._id), { action: 'reject', reason: 'Test rejection' }, admin);
      const inactiveFixture = await fixture(); const inactive = await approved(inactiveFixture); await Product.updateOne({ _id: inactiveFixture.product._id }, { $set: { isActive: false } });
      const ids = await publicIds(); assert.ok(ids.includes(String(active._id)));
      for (const deal of [future, expired, paused, rejected, inactive]) assert.ok(!ids.includes(String(deal._id)));
    });
    await t.test('aggregation joins, counts, ordering, pagination and empty detail are real', async () => {
      const featured = await approved(await fixture()); await service.moderate(String(featured._id), { action: 'feature' }, admin);
      const first = await service.listActive({ page: '1', limit: '2' }); const second = await service.listActive({ page: '2', limit: '2' });
      assert.ok(first.total >= 3); assert.equal(first.hasMore, true); assert.equal(String(first.deals[0]._id), String(featured._id));
      assert.ok(first.deals.every(row => row.product.name && row.vendor.businessName && row.finalPrice === 800));
      assert.ok(second.deals.every(row => !first.deals.some(previous => String(previous._id) === String(row._id))));
      const empty = await service.listActive({}, String(new mongoose.Types.ObjectId())); assert.deepEqual(empty.deals, []); assert.equal(empty.total, 0);
    });
    await t.test('managed vendor filtering and public product/offer detail match persisted data', async () => {
      const f = await fixture(other); const deal = await approved(f);
      const mine = await service.listManaged({}, other); assert.ok(mine.deals.length); assert.ok(mine.deals.every(row => String(row.vendorId) === String(other._id)));
      const detail = await api('/api/deals/' + deal._id); assert.equal(detail.status, 200);
      assert.equal(detail.data.deal.productId, String(f.product._id)); assert.equal(detail.data.deal.productOfferId, String(f.offer._id));
    });
    await t.test('no stacking, reserved stock filtering and stored shipment snapshot', async () => {
      const f = await fixture(vendor, { discountType: 'fixed', discountValue: 250 }); const deal = await approved(f);
      let context = await prices.loadDealContext([f.product._id]); let result = prices.resolveProductPrice(f.product, f.offer, context);
      assert.equal(result.finalPrice, 750); assert.equal(String(result.dealSnapshot.dealId), String(deal._id));
      const order = await MainOrder.create({ user: customer._id, paymentMethod: 'Wallet',
        shippingAddress: { address: 'Test address', city: 'Test city', country: 'NG' },
        userLocation: { latitude: 9, longitude: 7 }, totalSubtotal: 750, totalPrice: 750 });
      const shipment = await Shipment.create({ mainOrder: order._id, sellerType: 'vendor', sellerId: vendor._id,
        vendor: vendor._id, subtotal: 750, items: [{ product: f.product._id, offer: f.offer._id,
          name: f.product.name, image: 'https://example.invalid/test.png', quantity: 1,
          price: result.finalPrice, dealSnapshot: result.dealSnapshot }] });
      const stored = await Shipment.findById(shipment._id).lean(); assert.equal(stored.items[0].price, 750);
      assert.equal(String(stored.items[0].dealSnapshot.dealId), String(deal._id));
      await Offer.updateOne({ _id: f.offer._id }, { $set: { discountPrice: 600 } }); const offer = await Offer.findById(f.offer._id);
      result = prices.resolveProductPrice(f.product, offer, context); assert.equal(result.finalPrice, 600); assert.equal(result.dealSnapshot, null);
      await Offer.updateOne({ _id: f.offer._id }, { $set: { discountPrice: null, reservedStockQuantity: 10 } }); assert.ok(!(await publicIds()).includes(String(deal._id)));
    });
    await t.test('concurrent creates and approvals preserve the single approved target', async () => {
      const f = await fixture(); const deals = await Promise.all([pending(f), pending(f)]); assert.notEqual(String(deals[0]._id), String(deals[1]._id));
      const results = await Promise.allSettled(deals.map(deal => service.moderate(String(deal._id), { action: 'approve' }, admin)));
      assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.code, 11000);
    });
    await t.test('concurrent vendor edits use revision protection', async () => {
      const f = await fixture(); const deal = await pending(f); await service.update(String(deal._id), { action: 'pause' }, vendor);
      const results = await Promise.allSettled([10, 15].map(discountValue => service.update(String(deal._id), { discountValue, status: 'draft' }, vendor)));
      assert.ok(results.some(row => row.status === 'fulfilled'));
      for (const row of results.filter(row => row.status === 'rejected')) assert.equal(row.reason.statusCode, 409);
      const stored = await Deal.findById(deal._id); assert.ok([10, 15].includes(stored.discountValue)); assert.equal(stored.approvedAt, null);
    });
    await t.test('concurrent moderation preserves valid state and auditable revisions', async () => {
      const f = await fixture(); const deal = await approved(f); const initial = deal.revision;
      const results = await Promise.allSettled(['feature', 'pause'].map(action => service.moderate(String(deal._id), { action }, admin)));
      assert.ok(results.some(row => row.status === 'fulfilled')); for (const row of results.filter(row => row.status === 'rejected')) assert.equal(row.reason.statusCode, 409);
      let stored = await Deal.findById(deal._id); assert.ok(['approved', 'paused'].includes(stored.status)); if (stored.status === 'paused') assert.equal(stored.featured, false);
      assert.equal(stored.revision, initial + results.filter(row => row.status === 'fulfilled').length);
      if (stored.status === 'approved') await service.moderate(String(deal._id), { action: 'pause' }, admin);
      const unpause = await Promise.allSettled([1, 2].map(() => service.moderate(String(deal._id), { action: 'unpause' }, admin)));
      assert.ok(unpause.some(row => row.status === 'fulfilled')); stored = await Deal.findById(deal._id); assert.equal(stored.status, 'approved');
      const flags = await Promise.allSettled(['feature', 'unfeature'].map(action => service.moderate(String(deal._id), { action }, admin)));
      for (const row of flags.filter(row => row.status === 'rejected')) assert.equal(row.reason.statusCode, 409);
      stored = await Deal.findById(deal._id); assert.equal(stored.status, 'approved'); assert.equal(typeof stored.featured, 'boolean');
    });
    await t.test('real authenticated ownership and malformed inputs cannot persist changes', async () => {
      const f = await fixture(); const before = await Deal.countDocuments();
      assert.equal((await api('/api/deals', other, 'POST', f.body)).status, 403);
      assert.equal((await api('/api/deals', vendor, 'POST', { ...f.body, discountValue: 101 })).status, 400);
      assert.equal((await api('/api/deals', vendor, 'POST', { ...f.body, finalPrice: 1 })).status, 400);
      assert.equal(await Deal.countDocuments(), before);
      const deal = await pending(f); const id = String(deal._id);
      assert.equal((await api('/api/admin/deals/' + id + '/moderation', admin, 'PATCH', { action: 'reject' })).status, 400);
      const results = await Promise.all([1, 2].map(() => api('/api/admin/deals/' + id + '/moderation', admin, 'PATCH', { action: 'approve' })));
      assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
      assert.equal((await Deal.findById(id)).status, 'approved');
    });
    await t.test('legacy saved addresses remain valid without postal, state, area or coordinates', async () => {
      customer.deliveryAddresses.push({ address: 'Legacy address', city: 'Abuja', country: 'Nigeria' });
      await customer.save(); const saved = await User.findById(customer._id);
      const address = saved.deliveryAddresses[0];
      for (const field of ['postalCode', 'state', 'street', 'area', 'landmark']) assert.equal(address[field], '');
      assert.equal(address.latitude, undefined); assert.equal(address.longitude, undefined);
    });
    await t.test('authenticated Admin workflow writes MongoDB and Vendor reads reflect moderation', async () => {
      const f = await fixture(); const created = await api('/api/deals', vendor, 'POST', f.body); assert.equal(created.status, 201); const id = created.data.deal._id;
      assert.equal((await api('/api/admin/deals')).status, 401); assert.equal((await api('/api/admin/deals', vendor)).status, 403);
      const listed = await api('/api/admin/deals?status=pending', admin); assert.equal(listed.status, 200); assert.ok(listed.data.deals.some(row => row._id === id));
      for (const [action, status, featured] of [['approve','approved',false], ['feature','approved',true], ['unfeature','approved',false], ['pause','paused',false], ['unpause','approved',false], ['reject','rejected',false]]) {
        const response = await api('/api/admin/deals/' + id + '/moderation', admin, 'PATCH', { action, ...(action === 'reject' ? { reason: 'Test-only rejection' } : {}) }); assert.equal(response.status, 200);
        const stored = await Deal.findById(id); assert.equal(stored.status, status); assert.equal(stored.featured, featured);
        const own = await api('/api/deals/mine', vendor); assert.equal(own.status, 200); assert.equal(own.data.deals.find(row => row._id === id).status, status);
      }
      assert.equal((await api('/api/admin/deals', admin, 'POST', f.body)).status, 404);
      assert.equal((await api('/api/admin/deals/' + id, admin, 'PATCH', { discountValue: 10 })).status, 404);
    });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
    assert.equal(mongoose.connection.name, database); assert.ok(database.startsWith('naijago_deals_test_'));
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});
