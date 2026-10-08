// Opt-in real database/API lifecycle checks. Never use the application's MONGO_URI.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Product = require('../models/Product');
const ProductOffer = require('../models/ProductOffer');
const MainOrder = require('../models/MainOrder');
const Shipment = require('../models/Shipment');
const { GroupOrder, RecurringPlan, RecurringOccurrence } = require('../models/PlannedOrders');
const service = require('../services/plannedOrderService');
const router = require('../routes/plannedOrderRoutes');

test('real MongoDB Group/Recurring lifecycle without provider payments', {
  skip: !process.env.INVENTORY_TEST_MONGO_URI,
}, async t => {
  const database = 'naijago_planned_test_' + new mongoose.Types.ObjectId();
  const previous = { JWT_SECRET: process.env.JWT_SECRET, PLANNED_ORDERS_ENABLED: process.env.PLANNED_ORDERS_ENABLED };
  let server;
  await mongoose.connect(process.env.INVENTORY_TEST_MONGO_URI, { dbName: database, serverSelectionTimeoutMS: 15000 });
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.ok(hello.setName || hello.msg === 'isdbgrid', 'Transactions require a replica set or mongos');
    await Promise.all([User, Product, ProductOffer, MainOrder, Shipment, GroupOrder, RecurringPlan, RecurringOccurrence].map(model => model.init()));
    process.env.JWT_SECRET = 'dedicated-local-planned-fixture-only';
    process.env.PLANNED_ORDERS_ENABLED = 'true';
    let sequence = 0;
    async function account(vendor = false) {
      sequence++;
      return User.create({ firstName: 'Local', lastName: 'Fixture', email: `planned${sequence}@example.invalid`,
        phoneNumber: '081' + String(sequence).padStart(8, '0'), password: 'fixture-only-password',
        isVendor: vendor, vendorStatus: vendor ? 'approved' : 'none',
        ...(vendor ? { businessName: 'Local Test Shop', businessLocation: { latitude: 9.08, longitude: 7.4 } } : {}) });
    }
    const vendor = await account(true), owner = await account(), member = await account(), stranger = await account();
    const product = await Product.create({ name: 'Local planned fixture', description: 'Test only', category: 'Electronics',
      sellerType: 'vendor', sellerId: vendor._id, vendor: vendor._id, price: 1000, stockQuantity: 30,
      isActive: true, productStatus: 'active', moderationStatus: 'approved', imageUrls: ['https://example.invalid/local-fixture.png'] });
    const offer = await ProductOffer.create({ product: product._id, sellerType: 'vendor', sellerId: vendor._id,
      price: 1000, stockQuantity: 30, isPrimary: true, status: 'active', fulfilmentLocation: { latitude: 9.08, longitude: 7.4 } });
    const destination = { address: 'Local test street', city: 'Abuja', country: 'Nigeria', latitude: 9.09, longitude: 7.41 };
    const items = [{ product: String(product._id), offer: String(offer._id), quantity: 1 }];
    const app = express();
    app.use(express.json());
    app.use('/api/planned-orders', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/planned-orders`;
    async function api(path, { user = owner, method = 'GET', body, status = 200 } = {}) {
      const response = await fetch(base + path, { method, headers: {
        ...(user ? { Authorization: 'Bearer ' + jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json();
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
      return data;
    }
    async function group() {
      return api('/groups', { method: 'POST', status: 201, body: { name: 'Local test group', items, destination,
        participantLimit: 3, cutoffAt: new Date(Date.now() + 3600000).toISOString() } });
    }
    async function plan() {
      return api('/recurring', { method: 'POST', status: 201, body: { name: 'Local weekly plan', items, destination,
        reminderLeadDays: 7, rule: { timeZone: 'Africa/Lagos', frequency: 'weekly',
          startDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10) } } });
    }

    await t.test('config and authenticated ownership protection', async () => {
      assert.deepEqual(await api('/config', { user: null }), { groupOrderingEnabled: true, recurringOrdersEnabled: true,
        scheduledDeliveryEnabled: false, automaticPaymentsEnabled: false });
      await api('/groups', { user: null, status: 401 });
      await api('/recurring', { user: null, status: 401 });
      const created = await group();
      await api('/groups/' + created.group.id, { user: stranger, status: 404 });
      await api('/groups/' + created.group.id + '/invite', { user: stranger, method: 'POST', body: { revision: 0 }, status: 409 });
    });
    await t.test('group joining, invite rotation, revisions, closing and cancellation persist', async () => {
      const created = await group(), id = created.group.id;
      let joined = await api('/groups/join', { user: member, method: 'POST', body: { token: created.inviteToken } });
      assert.equal(joined.memberCount, 2);
      assert.equal(joined.destination, undefined);
      joined = await api('/groups/join', { user: member, method: 'POST', body: { token: created.inviteToken } });
      assert.equal(joined.memberCount, 2);
      let current = await api('/groups/' + id);
      const rotated = await api('/groups/' + id + '/invite', { method: 'POST', body: { revision: current.revision } });
      await api('/groups/join', { user: stranger, method: 'POST', body: { token: created.inviteToken }, status: 409 });
      await api('/groups/' + id + '/items', { user: member, method: 'PUT', body: { revision: current.revision, items }, status: 409 });
      current = await api('/groups/' + id + '/items', { user: member, method: 'PUT', body: { revision: rotated.group.revision, items } });
      current = await api('/groups/' + id + '/control', { method: 'POST', body: { action: 'close', revision: current.revision } });
      assert.equal(current.state, 'closed');
      current = await api('/groups/' + id + '/control', { method: 'POST', body: { action: 'cancel', revision: current.revision } });
      assert.equal((await GroupOrder.findById(id)).state, 'cancelled');
    });
    await t.test('group authoritative quote and unpaid checkout consume approval once', async () => {
      const created = await group(), id = created.group.id;
      await api('/groups/' + id + '/quote', { method: 'POST', body: { revision: 0 }, status: 409 });
      const closed = await api('/groups/' + id + '/control', { method: 'POST', body: { action: 'close', revision: 0 } });
      const quote = await api('/groups/' + id + '/quote', { method: 'POST', body: { revision: closed.revision } });
      assert.equal(quote.quote.totalSubtotal, 1000);
      const checkout = await api('/groups/' + id + '/checkout', { method: 'POST', status: 201,
        body: { revision: closed.revision, approvalToken: quote.approvalToken, paymentMethod: 'Card', totalPrice: 1 } });
      const order = await MainOrder.findById(checkout.orderId);
      assert.equal(order.totalPrice, quote.quote.totalPrice);
      assert.equal(order.isPaid, false);
      assert.equal((await GroupOrder.findById(id)).state, 'ordered');
      await api('/groups/' + id + '/checkout', { method: 'POST', status: 409,
        body: { revision: closed.revision, approvalToken: quote.approvalToken, paymentMethod: 'Card' } });
      assert.equal(await MainOrder.countDocuments(), 1);
      assert.equal((await Product.findById(product._id)).stockQuantity, 30);
      assert.equal((await ProductOffer.findById(offer._id)).stockQuantity, 30);
    });
    await t.test('recurring edits, pause/resume and cancellation use revisions and ownership', async () => {
      let current = await plan(), id = current.id;
      await api('/recurring/' + id, { user: stranger, status: 404 });
      current = await api('/recurring/' + id, { method: 'PUT', body: { revision: current.revision, name: 'Updated local plan' } });
      assert.equal(current.name, 'Updated local plan');
      current = await api('/recurring/' + id + '/control', { method: 'POST', body: { action: 'pause', revision: current.revision } });
      assert.equal(current.state, 'paused');
      await api('/recurring/' + id + '/control', { method: 'POST', body: { action: 'resume', revision: current.revision - 1 }, status: 409 });
      current = await api('/recurring/' + id + '/control', { method: 'POST', body: { action: 'resume', revision: current.revision } });
      current = await api('/recurring/' + id + '/control', { method: 'POST', body: { action: 'cancel', revision: current.revision } });
      assert.equal((await RecurringPlan.findById(id)).state, 'cancelled');
      assert.equal(await RecurringOccurrence.countDocuments({ plan: id, state: 'upcoming' }), 0);
    });
    await t.test('concurrent recurring generation persists one indexed occurrence', async () => {
      const created = await plan();
      await Promise.all([service.generate(created.id), service.generate(created.id)]);
      const rows = await RecurringOccurrence.find({ plan: created.id });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].state, 'upcoming');
      const indexes = await RecurringOccurrence.collection.indexes();
      assert.ok(indexes.some(index => index.unique && index.key.plan === 1 && index.key.sequence === 1));
      await RecurringOccurrence.updateOne({ _id: rows[0]._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      await service.advance();
      assert.equal((await RecurringOccurrence.findById(rows[0]._id)).state, 'missed');
    });
    await t.test('recurring occurrence quote/unpaid order creation, and skip persist safely', async () => {
      const created = await plan();
      await service.generate(created.id);
      const row = await RecurringOccurrence.findOne({ plan: created.id });
      // Only the isolated test fixture is moved to its purchase window; no clock/provider is mocked.
      await RecurringOccurrence.updateOne({ _id: row._id }, { $set: { startAt: new Date(Date.now() - 60000),
        expiresAt: new Date(Date.now() + 3600000), state: 'awaiting_review' } });
      const quote = await api('/occurrences/' + row.id + '/quote', { method: 'POST', body: { revision: row.revision } });
      const checkout = await api('/occurrences/' + row.id + '/checkout', { method: 'POST', status: 201,
        body: { revision: row.revision, approvalToken: quote.approvalToken, paymentMethod: 'Card' } });
      assert.equal((await MainOrder.findById(checkout.orderId)).isPaid, false);
      assert.equal((await RecurringOccurrence.findById(row._id)).state, 'ordered');
      await api('/occurrences/' + row.id + '/control', { method: 'POST', status: 409, body: { revision: row.revision, action: 'skip' } });
      const other = await plan();
      await service.generate(other.id);
      const pending = await RecurringOccurrence.findOne({ plan: other.id });
      const skipped = await api('/occurrences/' + pending.id + '/control', { method: 'POST', body: { revision: pending.revision, action: 'skip' } });
      assert.equal(skipped.state, 'skipped');
    });
    await t.test('pagination, malformed payload and scheduled checkout restrictions', async () => {
      const first = await api('/groups?limit=1');
      assert.equal(first.groups.length, 1);
      assert.ok(first.nextCursor);
      const second = await api('/groups?limit=1&before=' + first.nextCursor);
      assert.notEqual(first.groups[0].id, second.groups[0].id);
      const recurring = await api('/recurring?limit=1');
      assert.equal(recurring.plans.length, 1);
      assert.ok(recurring.nextCursor);
      await api('/groups?limit=0', { status: 400 });
      await api('/groups', { method: 'POST', body: [], status: 400 });
      await api('/groups', { method: 'POST', body: { schedule: { mode: 'scheduled' } }, status: 400 });
      assert.equal((await api('/config', { user: null })).scheduledDeliveryEnabled, false);
      assert.equal((await api('/config', { user: null })).automaticPaymentsEnabled, false);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
