// Isolated service/HTTP tests with model stubs. These do NOT verify MongoDB.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');
const Deal = require('../models/Deal');
const Product = require('../models/Product');
const Offer = require('../models/ProductOffer');
const User = require('../models/User');
const Shipment = require('../models/Shipment');
const service = require('../services/dealService');
const prices = require('../services/productPriceService');
const { router, adminRouter } = require('../routes/dealRoutes');

const pid = '507f1f77bcf86cd799439011';
const oid = '507f1f77bcf86cd799439012';
const vid = '507f1f77bcf86cd799439013';
const aid = '507f1f77bcf86cd799439014';
const cid = '507f1f77bcf86cd799439015';
const other = '507f1f77bcf86cd799439016';
const did = '507f1f77bcf86cd799439017';
const now = () => new Date();
const beforeNow = () => new Date(Date.now() - 60000);
const afterNow = () => new Date(Date.now() + 3600000);
let product, offer, users, records, indexReady, pipeline, timeout;
let server, base;
const previousSecret = process.env.JWT_SECRET;
const secret = 'isolated-deals-test-key-not-a-production-credential';
const copy = value => value == null ? value : structuredClone(value);
const same = (a, b) => String(a?._id || a) === String(b?._id || b);
function matches(row, filter) {
  return Object.entries(filter).every(([field, value]) => {
    const actual = row[field];
    if (value && typeof value === 'object' && !(value instanceof Date) && !value._bsontype) {
      return Object.entries(value).every(([operator, expected]) => {
        if (operator === '$in') return expected.some(item => same(actual, item));
        if (operator === '$lte') return actual <= expected;
        if (operator === '$gt') return actual > expected;
        throw new Error(`Unsupported test-stub operator: ${operator}`);
      });
    }
    return same(actual, value);
  });
}
function query(value) {
  let skip = 0, limit = Infinity;
  const result = () => copy(Array.isArray(value) ? value.slice(skip, skip + limit) : value);
  return { select() { return this; }, sort() { return this; }, populate() { return this; },
    session() { return this; }, skip(v) { skip = v; return this; }, limit(v) { limit = v; return this; },
    lean() { return this; }, then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); } };
}
function deal(values = {}) {
  return { _id: did, productId: pid, productOfferId: oid, vendorId: vid,
    targetKey: prices.key(pid, oid), discountType: 'percentage', discountValue: 30,
    startAt: beforeNow(), endAt: afterNow(), status: 'pending', featured: false,
    revision: 0, history: [], ...values };
}
function requestBody(values = {}) {
  return { productId: pid, productOfferId: oid, discountType: 'percentage', discountValue: 30,
    startAt: beforeNow().toISOString(), endAt: afterNow().toISOString(), ...values };
}
function context(value = deal({ status: 'approved' })) {
  return { now: now(), deals: new Map([[value.targetKey, value]]),
    vendors: new Set([vid]), offeredProducts: new Set([pid]) };
}
async function api(method, url, body, identity = vid) {
  const response = await fetch(base + url, { method, headers: {
    ...(identity ? { Authorization: `Bearer ${jwt.sign({ id: identity }, secret)}` } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
before(async () => {
  process.env.JWT_SECRET = secret;
  const app = express(); app.use(express.json());
  app.use('/api/deals', router); app.use('/api/admin/deals', adminRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});
beforeEach(t => {
  product = { _id: pid, name: 'Local fixture', imageUrls: ['https://example.com/test.jpg'],
    price: 10000, discountPrice: null, sellerType: 'vendor', sellerId: vid,
    isActive: true, productStatus: 'active', moderationStatus: 'approved', stockQuantity: 10, variants: [] };
  offer = { _id: oid, product: pid, sellerId: vid, sellerType: 'vendor', price: 10000,
    discountPrice: null, status: 'active', stockQuantity: 10, variants: [] };
  users = [{ _id: vid, isVendor: true, vendorStatus: 'approved' }, { _id: aid, isAdmin: true },
    { _id: cid }, { _id: other, isVendor: true, vendorStatus: 'approved' }];
  records = []; indexReady = true; pipeline = null; timeout = null;
  t.mock.method(Product, 'findById', value => query(same(value, pid) ? product : null));
  t.mock.method(Offer, 'findById', value => query(offer && same(value, oid) ? offer : null));
  t.mock.method(Offer, 'find', filter => query(offer && matches(offer, filter) ? [offer] : []));
  t.mock.method(Offer, 'exists', async filter => offer && matches(offer, filter) ? { _id: oid } : null);
  t.mock.method(User, 'findById', value => query(users.find(user => same(user._id, value)) || null));
  t.mock.method(User, 'findOne', filter => query(users.find(user => matches(user, filter)) || null));
  t.mock.method(User, 'find', filter => query(users.filter(user => matches(user, filter))));
  t.mock.method(Deal, 'findOne', filter => query(records.find(row => matches(row, filter)) || null));
  t.mock.method(Deal, 'findById', value => query(records.find(row => same(row._id, value)) || null));
  t.mock.method(Deal, 'find', filter => query(records.filter(row => matches(row, filter))));
  t.mock.method(Deal, 'countDocuments', async filter => records.filter(row => matches(row, filter)).length);
  t.mock.method(Deal, 'create', async values => {
    await new Deal(values).validate();
    const saved = deal(values); records.push(saved); return copy(saved);
  });
  t.mock.method(Deal, 'findOneAndUpdate', async (filter, changes) => {
    const saved = records.find(row => matches(row, filter)); if (!saved) return null;
    // This simulates a duplicate index error; it is NOT a real uniqueness test.
    if (changes.$set.status === 'approved' && records.some(row => row !== saved && row.targetKey === saved.targetKey && row.status === 'approved')) {
      throw Object.assign(new Error('Stub duplicate'), { code: 11000 });
    }
    Object.assign(saved, changes.$set); saved.revision += changes.$inc.revision;
    saved.history.push(changes.$push.history); return copy(saved);
  });
  t.mock.method(Deal.collection, 'listIndexes', () => ({ toArray: async () => indexReady
    ? [{ key: { targetKey: 1 }, unique: true, partialFilterExpression: { status: 'approved' } }] : [] }));
});

test('HTTP: approved vendor submits pending Deal with server-derived ownership', async () => {
  const result = await api('POST', '/api/deals', requestBody());
  assert.equal(result.status, 201); assert.equal(result.data.deal.status, 'pending');
  assert.equal(result.data.deal.vendorId, vid); assert.equal(result.data.deal.featured, false);
});
test('HTTP: authentication and customer/admin-role authorization enforced', async () => {
  assert.equal((await api('GET', '/api/deals/mine', undefined, null)).status, 401);
  assert.equal((await api('POST', '/api/deals', requestBody(), cid)).status, 403);
  assert.equal((await api('GET', '/api/admin/deals', undefined, vid)).status, 403);
  users[0].vendorStatus = 'pending';
  assert.equal((await api('POST', '/api/deals', requestBody())).status, 403);
});
test('HTTP: another vendor cannot create or edit the selected offer Deal', async () => {
  assert.equal((await api('POST', '/api/deals', requestBody(), other)).status, 403);
  records.push(deal());
  assert.equal((await api('PATCH', `/api/deals/${did}`, { discountValue: 20 }, other)).status, 404);
});
test('HTTP: vendor cannot set approval, featured, vendor ID or client price', async () => {
  for (const fields of [{ status: 'approved' }, { featured: true }, { vendorId: other }, { price: 1 }, { finalPrice: 1 }]) {
    const result = await api('POST', '/api/deals', requestBody(fields));
    assert.ok([400, 403].includes(result.status));
  }
  assert.equal(records.length, 0);
});
test('HTTP: Admin approves pending Deal and records audit actor/date', async () => {
  records.push(deal());
  const result = await api('PATCH', `/api/admin/deals/${did}/moderation`, { action: 'approve' }, aid);
  assert.equal(result.status, 200); assert.equal(result.data.deal.status, 'approved');
  assert.equal(result.data.deal.approvedBy, aid); assert.ok(result.data.deal.approvedAt);
  assert.equal(result.data.deal.history[0].actor, aid);
});
test('HTTP: Admin rejection requires reason and prevents publication', async () => {
  records.push(deal());
  assert.equal((await api('PATCH', `/api/admin/deals/${did}/moderation`, { action: 'reject' }, aid)).status, 400);
  const result = await api('PATCH', `/api/admin/deals/${did}/moderation`, { action: 'reject', reason: 'Incorrect offer' }, aid);
  assert.equal(result.status, 200); assert.equal(result.data.deal.status, 'rejected');
  assert.equal(result.data.deal.moderationReason, 'Incorrect offer');
});
test('HTTP: Admin pauses/unpauses approved unedited Deal', async () => {
  records.push(deal({ status: 'approved', approvedAt: beforeNow() }));
  assert.equal((await api('PATCH', `/api/admin/deals/${did}/moderation`, { action: 'pause' }, aid)).data.deal.status, 'paused');
  assert.equal((await api('PATCH', `/api/admin/deals/${did}/moderation`, { action: 'unpause' }, aid)).data.deal.status, 'approved');
});
test('HTTP: feature/unfeature is Admin-only and requires approval', async () => {
  records.push(deal());
  assert.equal((await api('PATCH', `/api/admin/deals/${did}/moderation`, { action: 'feature' }, aid)).status, 409);
  records[0].status = 'approved';
  assert.equal((await api('PATCH', `/api/admin/deals/${did}/moderation`, { action: 'feature' }, aid)).data.deal.featured, true);
  assert.equal((await api('PATCH', `/api/admin/deals/${did}/moderation`, { action: 'unfeature' }, aid)).data.deal.featured, false);
});
test('service: edited paused Deal loses approval and cannot be unpaused', async () => {
  records.push(deal({ status: 'paused', approvedAt: beforeNow(), approvedBy: aid }));
  const edited = await service.update(did, { discountValue: 25 }, users[0]);
  assert.equal(edited.status, 'pending'); assert.equal(edited.approvedAt, null);
  await assert.rejects(service.moderate(did, { action: 'unpause' }, users[1]), { statusCode: 409 });
});
test('service: approval fails closed without required index metadata', async () => {
  records.push(deal()); indexReady = false;
  await assert.rejects(service.moderate(did, { action: 'approve' }, users[1]), { statusCode: 503 });
  assert.equal(records[0].status, 'pending');
});
test('HTTP: duplicate-index error is translated to controlled 409', async () => {
  records.push(deal(), deal({ _id: other, status: 'approved' }));
  assert.equal((await api('PATCH', `/api/admin/deals/${did}/moderation`, { action: 'approve' }, aid)).status, 409);
});
test('service: revision comparison rejects concurrent stale edit', async t => {
  records.push(deal({ status: 'draft' }));
  t.mock.method(Deal, 'findOneAndUpdate', async filter => { assert.equal(filter.revision, 0); return null; });
  await assert.rejects(service.update(did, { discountValue: 20 }, users[0]), { statusCode: 409 });
});
test('HTTP: managed list pagination and own-vendor isolation', async () => {
  records.push(...Array.from({ length: 5 }, (_, index) => deal({ _id: new mongoose.Types.ObjectId().toString(), vendorId: index === 4 ? other : vid })));
  const result = await api('GET', '/api/deals/mine?page=2&limit=2');
  assert.equal(result.status, 200); assert.equal(result.data.total, 4);
  assert.equal(result.data.page, 2); assert.equal(result.data.deals.length, 2); assert.equal(result.data.hasMore, false);
  assert.ok(result.data.deals.every(row => row.vendorId === vid));
});
test('HTTP: malformed IDs and unsafe pagination return 400', async () => {
  for (const url of ['/api/deals/mine?page=0', '/api/deals/mine?limit=51', '/api/deals/mine?page=Infinity', '/api/deals/not-an-id']) {
    assert.equal((await api('GET', url)).status, 400);
  }
});
test('HTTP: invalid discount values rejected before any creation', async () => {
  for (const fields of [{ discountValue: 0 }, { discountValue: -1 }, { discountValue: 101 },
    { discountValue: '30' }, { discountValue: null }, { discountValue: 1.234 },
    { discountType: 'bogo' }, { discountType: 'fixed', discountValue: 10001 }]) {
    assert.equal((await api('POST', '/api/deals', requestBody(fields))).status, 400);
  }
  assert.equal(records.length, 0);
});
test('HTTP: invalid dates, date order, missing timezone and expiry rejected', async () => {
  for (const fields of [{ endAt: beforeNow().toISOString() }, { startAt: 'invalid' },
    { startAt: '2026-10-10T09:00:00' }, { endAt: 'invalid' },
    { startAt: afterNow().toISOString(), endAt: beforeNow().toISOString() }]) {
    assert.equal((await api('POST', '/api/deals', requestBody(fields))).status, 400);
  }
});
test('service: future Deal may be approved but expired Deal may not', async () => {
  records.push(deal({ startAt: new Date(Date.now() + 60000) }));
  assert.equal((await service.moderate(did, { action: 'approve' }, users[1])).status, 'approved');
  records[0].status = 'pending'; records[0].startAt = new Date(Date.now() - 120000); records[0].endAt = beforeNow();
  await assert.rejects(service.moderate(did, { action: 'approve' }, users[1]), { statusCode: 400 });
});
test('service: missing/wrong product and offer, unavailable target and variants fail closed', async () => {
  await assert.rejects(service.create(requestBody({ productId: other }), users[0]), { statusCode: 404 });
  offer.product = other;
  await assert.rejects(service.create(requestBody(), users[0]), { statusCode: 403 });
  offer.product = pid; offer.status = 'disabled';
  await assert.rejects(service.create(requestBody(), users[0]), { statusCode: 400 });
  offer.status = 'active'; product.variants = [{ stockQuantity: 10 }];
  await assert.rejects(service.create(requestBody(), users[0]), /Variant\/size/);
  product.variants = []; product.sizeData = { type: 'clothing' };
  await assert.rejects(service.create(requestBody(), users[0]), /Variant\/size/);
  product.sizeData = null; offer.variants = [{ stockQuantity: 10 }];
  await assert.rejects(service.create(requestBody(), users[0]), /Variant\/size/);
});
test('service: ProductOffer must be selected when offers exist; legacy aggregate permitted otherwise', async () => {
  await assert.rejects(service.create(requestBody({ productOfferId: null }), users[0]), /Select the vendor ProductOffer/);
  offer = null;
  const result = await service.create(requestBody({ productOfferId: null }), users[0]);
  assert.equal(result.targetKey, `${pid}:aggregate`);
});
test('pricing: percentage/fixed discounts and zero-price boundary', () => {
  assert.equal(prices.calculateDealPrice(10000, { discountType: 'percentage', discountValue: 30 }), 7000);
  assert.equal(prices.calculateDealPrice(10000, { discountType: 'fixed', discountValue: 1250 }), 8750);
  assert.equal(prices.calculateDealPrice(10000, { discountType: 'percentage', discountValue: 100 }), 0);
  assert.equal(prices.calculateDealPrice(10000, { discountType: 'fixed', discountValue: 10000 }), 0);
  for (const value of [NaN, Infinity, -1, 0]) assert.equal(prices.calculateDealPrice(10000, { discountType: 'fixed', discountValue: value }), null);
  assert.equal(prices.calculateDealPrice(100, { discountType: 'fixed', discountValue: 101 }), null);
});
test('pricing: no stacking; lower of legacy and timed price wins', () => {
  offer.discountPrice = 8000;
  assert.equal(prices.resolveProductPrice(product, offer, context()).finalPrice, 7000);
  offer.discountPrice = 6000;
  const result = prices.resolveProductPrice(product, offer, context());
  assert.equal(result.finalPrice, 6000); assert.equal(result.dealSnapshot, null);
});
test('pricing: no Deal preserves product/offer precedence including zero discount', () => {
  product.discountPrice = 5000;
  assert.equal(prices.resolveProductPrice(product, null, null).finalPrice, 5000);
  assert.equal(prices.resolveProductPrice(product, offer, null).finalPrice, 10000);
  offer.discountPrice = 0;
  assert.equal(prices.resolveProductPrice(product, offer, null).finalPrice, 0);
});
test('pricing: expired/future/rejected/paused Deals excluded by loader query', async () => {
  for (const values of [{ endAt: beforeNow() }, { startAt: afterNow() }, { status: 'rejected' }, { status: 'paused' }]) {
    records = [deal({ status: 'approved', ...values })];
    const loaded = await prices.loadDealContext([pid]);
    assert.equal(loaded.deals.size, 0);
    assert.equal(prices.resolveProductPrice(product, offer, loaded).finalPrice, 10000);
  }
});
test('pricing: seller approval/ownership and changed variants suppress Deal', () => {
  const loaded = context(); loaded.vendors.clear();
  assert.equal(prices.resolveProductPrice(product, offer, loaded).finalPrice, 10000);
  offer.sellerId = other;
  assert.equal(prices.resolveProductPrice(product, offer, context()).finalPrice, 10000);
  offer.sellerId = vid; product.variants = [{}];
  assert.equal(prices.resolveProductPrice(product, offer, context()).finalPrice, 10000);
});
test('pricing: duplicate active target rows fail closed', async () => {
  records = [deal({ status: 'approved' }), deal({ _id: other, status: 'approved' })];
  await assert.rejects(prices.loadDealContext([pid]), { code: 'DEAL_PRICING_UNAVAILABLE' });
});
test('pricing: transaction session forwarded to all reads without parallel queries', async t => {
  const session = {}; const calls = [];
  function tracked(name, rows) { return { session(value) { assert.equal(value, session); calls.push(name); return this; }, select() { return this; },
    lean() { return { session(value) { assert.equal(value, session); calls.push(name); return Promise.resolve(rows); }, then(resolve) { return Promise.resolve(rows).then(resolve); } }; } }; }
  t.mock.method(Deal, 'find', () => tracked('deals', [deal({ status: 'approved' })]));
  t.mock.method(Offer, 'find', () => tracked('offers', [offer]));
  t.mock.method(User, 'find', () => tracked('vendors', [users[0]]));
  await prices.loadDealContext([pid], { session });
  assert.deepEqual(calls, ['deals', 'offers', 'vendors']);
});
test('pricing: applied snapshot and client price are derived from stored records', () => {
  product.finalPrice = 1; offer.finalPrice = 1;
  const result = prices.resolveProductPrice(product, offer, context());
  assert.equal(result.finalPrice, 7000); assert.equal(result.dealSnapshot.dealId, did);
  assert.equal(result.dealSnapshot.originalPrice, 10000); assert.equal(result.dealSnapshot.savingsAmount, 3000);
});
test('Mongoose: Deal schema validations/index declaration and item snapshot serialization', async () => {
  const document = new Deal(deal()); await document.validate();
  assert.equal(document.targetKey, `${pid}:${oid}`);
  for (const values of [{ discountValue: Infinity }, { discountValue: -1 }, { endAt: beforeNow() }]) {
    await assert.rejects(new Deal(deal(values)).validate());
  }
  assert.ok(Deal.schema.indexes().some(([fields, options]) => fields.targetKey === 1 && options.unique && options.partialFilterExpression.status === 'approved'));
  const itemSchema = Shipment.schema.path('items').schema;
  const Item = mongoose.models.DealTestShipmentItem || mongoose.model('DealTestShipmentItem', itemSchema);
  const snapshot = prices.resolveProductPrice(product, offer, context()).dealSnapshot;
  const item = new Item({ product: pid, offer: oid, name: 'Fixture', image: 'test.jpg', quantity: 2, price: 7000, dealSnapshot: snapshot });
  await item.validate();
  assert.equal(String(item.toObject().dealSnapshot.dealId), did);
  assert.equal(item.toObject().dealSnapshot.finalPrice, item.price);
});
test('HTTP: public list/detail response, pagination and privacy using stub aggregation output', async t => {
  const row = { ...deal({ status: 'approved' }), regularPrice: 10000, pricingProduct: product, pricingOffer: offer,
    product: { _id: pid, name: 'Fixture' }, vendor: { _id: vid, businessName: 'Fixture vendor' } };
  t.mock.method(Deal, 'aggregate', stages => { pipeline = stages; return { option(options) {
    assert.deepEqual(options, { maxTimeMS: 10000 }); timeout = options.maxTimeMS; return Promise.resolve([{ rows: [row], count: [{ total: 3 }] }]);
  } }; });
  const result = await api('GET', '/api/deals?page=2&limit=1', undefined, null);
  assert.equal(result.status, 200); assert.equal(result.data.page, 2); assert.equal(result.data.hasMore, true);
  assert.equal(result.data.deals[0].finalPrice, 7000); assert.equal(result.data.deals[0].savingsAmount, 3000);
  assert.ok(result.data.serverTime); assert.equal(timeout, 10000);
  assert.equal(result.data.deals[0].pricingProduct, undefined); assert.equal(result.data.deals[0].pricingOffer, undefined);
  const facet = pipeline.find(stage => stage.$facet).$facet;
  assert.deepEqual(facet.rows.slice(0, 2), [{ $skip: 1 }, { $limit: 1 }]);
  assert.equal(pipeline[0].$match.status, 'approved');
  assert.ok(pipeline[0].$match.startAt.$lte instanceof Date); assert.ok(pipeline[0].$match.endAt.$gt instanceof Date);
  assert.ok(pipeline.some(stage => stage.$match?.['product.moderationStatus'] === 'approved'));
  const detail = await api('GET', `/api/deals/${did}`, undefined, null);
  assert.equal(detail.status, 200); assert.equal(detail.data.deal._id, did);
  assert.equal(String(pipeline[0].$match._id), did);
});
test('HTTP: public empty detail is 404 and empty feed is successful', async t => {
  t.mock.method(Deal, 'aggregate', () => ({ option: async options => { assert.deepEqual(options, { maxTimeMS: 10000 }); return [{ rows: [], count: [] }]; } }));
  assert.equal((await api('GET', `/api/deals/${did}`, undefined, null)).status, 404);
  const result = await api('GET', '/api/deals', undefined, null);
  assert.equal(result.status, 200); assert.deepEqual(result.data.deals, []); assert.equal(result.data.total, 0);
});
test('checkout source wiring: summary and final creation use shared resolver and replace client snapshot', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/orderRoutes.js'), 'utf8');
  const summary = source.slice(source.indexOf('const calculateOrderSummary'), source.indexOf('const createMainOrder'));
  const creation = source.slice(source.indexOf('const createMainOrder'), source.indexOf("router.post('/', protect, createMainOrder)"));
  for (const section of [summary, creation]) {
    assert.match(section, /resolveProductPrice\(product, selectedOffer, dealContext\)/);
    assert.match(section, /dealSnapshot: itemPricing\.dealSnapshot/);
  }
  assert.match(creation, /loadDealContext\([\s\S]*?\{ session \}/);
  assert.match(creation, /code: 'DEAL_EXPIRED'/);
  assert.ok(creation.indexOf("code: 'DEAL_EXPIRED'") < creation.indexOf('new MainOrder'));
  assert.match(creation, /dealSnapshot: item\.dealSnapshot \|\| undefined/);
  assert.match(creation, /req\.plannedOrderContext \? null/);
});
test('checkout item builder: authoritative Deal price/snapshot survives malicious submitted price', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/orderRoutes.js'), 'utf8');
  const functionSource = source.match(/function buildOrderItemFromProduct\(item, product\) \{[\s\S]*?\r?\n\}/)[0];
  const build = vm.runInNewContext(`(${functionSource})`);
  const resolved = prices.resolveProductPrice(product, offer, context());
  const item = build({ ...{ product: pid, quantity: 1, price: 1, dealSnapshot: { finalPrice: 1 } },
    authoritativePrice: resolved.finalPrice, dealSnapshot: resolved.dealSnapshot }, product);
  assert.equal(item.price, 7000); assert.equal(item.dealSnapshot.finalPrice, 7000);
  assert.equal(item.dealSnapshot.dealId, did);
});

// Execute the actual handler bodies in an isolated VM. All delivery/settings,
// persistence and transaction dependencies are stubs, never a database.
function checkoutHarness(t) {
  const source = process.env.DEALS_TEST_COMMITTED_CHECKOUT === '1'
    ? require('node:child_process').execFileSync('git', ['show', 'HEAD:routes/orderRoutes.js'], { encoding: 'utf8' })
    : fs.readFileSync(path.join(__dirname, '../routes/orderRoutes.js'), 'utf8');
  const writes = [], transitions = [], errors = [];
  users[0].businessName = 'Fixture vendor'; users[0].pickupEnabled = true;
  users[0].businessLocation = { latitude: 9.1, longitude: 7.4, formattedAddress: 'Fixture address' };
  product.category = 'Home Appliances'; product.vendor = users[0];
  offer.sellerId = users[0]; offer.isPrimary = true; offer.fulfilmentLocation = users[0].businessLocation;
  t.mock.method(Offer, 'findOne', filter => query(matches(offer, filter) ? offer : null));
  const session = { startTransaction() { transitions.push('start'); },
    async commitTransaction() { transitions.push('commit'); },
    async abortTransaction() { transitions.push('abort'); }, endSession() { transitions.push('end'); } };
  class OrderStub {
    constructor(values) { Object.assign(this, values); this._id = new mongoose.Types.ObjectId(); }
    async save() { writes.push({ type: 'order', value: this }); return this; }
  }
  class ShipmentStub {
    constructor(values) { Object.assign(this, values); this._id = new mongoose.Types.ObjectId(); }
    async save() { writes.push({ type: 'shipment', value: this }); return this; }
    static countDocuments() { return query(0); }
  }
  const sandbox = { ...require('../utils/checkoutLocation'), ...require('../utils/addressCoordinates'), hasValidCoordinates: location => !require('../utils/addressCoordinates').validateCoordinates(location?.latitude, location?.longitude, {required:true}).error, Date, Map, Set, Number, String, Math, Object, Array, parseFloat,
    console: { error: (...args) => errors.push(args.join(' ')) }, Product, ProductOffer: Offer, User,
    MainOrder: OrderStub, Shipment: ShipmentStub, mongoose: { startSession: async () => session },
    loadDealContext: prices.loadDealContext, resolveProductPrice: prices.resolveProductPrice,
    inventory: require('../services/inventoryService'),
    assertImmediateOrderRequest: async () => {},
    getDeliveryFeeSettings: async () => ({ deliveryPricing: { mode: 'zone' }, freeDeliveryCampaign: { enabled: false } }),
    getCostLowCommissionConfig: async () => ({}),
    calculateItemCommission: () => ({ commissionRate: 0, itemCommission: 0 }),
    buildDeliveryFeeQuote: () => ({ amount: 500, source: 'test-zone', zone: null }),
    resolveCampaignRouteDistance: async () => 0,
    evaluateFreeDeliveryCampaign: require('../services/freeDeliveryCampaignService').evaluateFreeDeliveryCampaign,
    buildSubscriptionDeliveryDiscount: () => ({ eligible: false }),
    resolvePickupLocation: ({ offerLocation, sellerLocation, productLocation }) => offerLocation || sellerLocation || productLocation,
    buildPickupSequence: () => [], evaluateDispatchReadiness: () => ({ readyForDispatch: false }),
  };
  vm.createContext(sandbox);
  for (const name of ['isMedicineProduct', 'isRestrictedMedicine', 'isRestaurantProduct', 'buildOrderItemFromProduct', 'calculateDistance']) {
    const fn = source.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\r?\\n\\}`));
    assert.ok(fn, `Actual helper ${name} must exist`);
    vm.runInContext(fn[0], sandbox);
  }
  function handler(name) {
    const start = source.indexOf(`const ${name} = async (req, res) => {`);
    const end = source.indexOf('\n};', start);
    assert.ok(start >= 0 && end > start);
    return vm.runInContext(`(${source.slice(start, end + 3).replace(`const ${name} = `, '').replace(/;$/, '')})`, sandbox);
  }
  async function run(name, body) {
    const response = { statusCode: 200, status(value) { this.statusCode = value; return this; },
      json(value) { this.data = value; return this; } };
    await handler(name)({ body, user: users[2] }, response);
    return response;
  }
  const address = { address: 'Fixture address', city: 'Abuja', country: 'Nigeria' };
  const location = { latitude: 9.1, longitude: 7.4 };
  function orderBody(method = 'delivery') {
    return { shippingAddress: address, userLocation: location, paymentMethod: 'Squad', totalPrice: 1,
      shipmentSummaries: [{ vendorId: vid, sellerId: vid, sellerType: 'vendor', fulfillmentMethod: method,
        items: [{ product: pid, offer: oid, quantity: 2, price: 1, dealSnapshot: { finalPrice: 1 } }] }] };
  }
  return { run, writes, transitions, errors, orderBody,
    summaryBody: { shippingAddress: address, userLocation: location,
      cartItems: [{ product: pid, offer: oid, quantity: 2, price: 1 }] } };
}
test('actual summary handler: active Deal sets subtotal and server snapshot', async t => {
  records = [deal({ status: 'approved' })];
  const harness = checkoutHarness(t);
  const result = await harness.run('calculateOrderSummary', harness.summaryBody);
  assert.equal(result.statusCode, 200, harness.errors.join('\n'));
  assert.equal(result.data.totalSubtotal, 14000);
  assert.equal(result.data.shipmentSummaries[0].items[0].dealSnapshot.dealId, did);
  assert.equal(harness.writes.length, 0);
});
test('actual final handler: delivery order revalidates Deal and creates authoritative amount', async t => {
  records = [deal({ status: 'approved' })];
  const harness = checkoutHarness(t);
  const result = await harness.run('createMainOrder', harness.orderBody());
  assert.equal(result.statusCode, 201, harness.errors.join('\n'));
  assert.equal(result.data.totalPrice, 14500);
  assert.equal(harness.writes.find(write => write.type === 'shipment').value.sellerName, users[0].businessName);
});
test('actual final handler: customer pickup retains Deal price and writes item snapshot to stub', async t => {
  records = [deal({ status: 'approved' })];
  const harness = checkoutHarness(t);
  const result = await harness.run('createMainOrder', harness.orderBody('pickup'));
  assert.equal(result.statusCode, 201, harness.errors.join('\n'));
  assert.equal(result.data.totalPrice, 14000);
  const item = harness.writes.find(write => write.type === 'shipment').value.items[0];
  assert.equal(harness.writes.find(write => write.type === 'shipment').value.sellerName, users[0].businessName);
  assert.equal(item.price, 7000); assert.equal(item.dealSnapshot.dealId, did);
  assert.ok(harness.transitions.includes('commit'));
});
test('actual final handler: expiry between summary and creation removes discount', async t => {
  records = [deal({ status: 'approved' })];
  const harness = checkoutHarness(t);
  const summary = await harness.run('calculateOrderSummary', harness.summaryBody);
  assert.equal(summary.data.totalSubtotal, 14000);
  records[0].endAt = beforeNow();
  const result = await harness.run('createMainOrder', harness.orderBody('pickup'));
  assert.equal(result.statusCode, 201, harness.errors.join('\n'));
  assert.equal(result.data.totalPrice, 20000);
  assert.equal(harness.writes.find(write => write.type === 'shipment').value.items[0].dealSnapshot, undefined);
});
test('actual final handler: delivery without Deals retains existing price and seller name', async t => {
  const harness = checkoutHarness(t);
  const result = await harness.run('createMainOrder', harness.orderBody());
  assert.equal(result.statusCode, 201, harness.errors.join('\n'));
  assert.equal(result.data.totalPrice, 20500);
  const shipment = harness.writes.find(write => write.type === 'shipment').value;
  assert.equal(shipment.sellerName, users[0].businessName);
  assert.equal(shipment.items[0].price, 10000);
  assert.equal(shipment.items[0].dealSnapshot, undefined);
});

test('location: summary and final creation reject invalid destination before writes/session', async t => {
 const h=checkoutHarness(t);
 for(const userLocation of [{latitude:0,longitude:0},{latitude:null,longitude:7},{latitude:91,longitude:7}]) {
  for(const handler of ['calculateOrderSummary','createMainOrder']) {
   const body=handler==='calculateOrderSummary'?h.summaryBody:h.orderBody();
   const result=await h.run(handler,{...body,userLocation});assert.equal(result.statusCode,400);
  }
 }
 assert.equal(h.writes.length,0);assert.equal(h.transitions.length,0);
});
test('location: final order retains selected coordinates and structured optional-postal address', async t => {
 const h=checkoutHarness(t);const body=h.orderBody();body.shippingAddress={address:'3rd Avenue',street:'Avenue',area:'Gwarinpa',landmark:'Gate',city:'Abuja',state:'FCT',country:'Nigeria'};
 const summary=await h.run('calculateOrderSummary',{...h.summaryBody,shippingAddress:body.shippingAddress});assert.equal(summary.statusCode,200);
 const result=await h.run('createMainOrder',body);assert.equal(result.statusCode,201,h.errors.join('\n'));
 const order=h.writes.find(w=>w.type==='order').value;assert.equal(order.userLocation.latitude,body.userLocation.latitude);assert.equal(order.userLocation.longitude,body.userLocation.longitude);assert.equal(order.shippingAddress.area,'Gwarinpa');assert.equal(order.shippingAddress.state,'FCT');assert.equal(order.shippingAddress.postalCode,'');
});
