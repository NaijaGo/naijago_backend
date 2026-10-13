// Actual JWT middleware, role authorization and product/moderation handlers.
// All persistence is mocked; no database, uploads or provider calls are allowed.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const ProductOffer = require('../models/ProductOffer');
const User = require('../models/User');
const Shipment = require('../models/Shipment');
const Rider = require('../models/Rider');
const taxonomy = require('../services/catalogTaxonomyService');
const products = require('../routes/productRoutes');
const admin = require('../routes/adminRoutes');
const uid = '000000000000000000000001', pid = '000000000000000000000002';

async function fixture(t, { account = {}, seller = {}, product = {} } = {}) {
  const user = { _id: uid, role: 'user', isAdmin: false, isVendor: true, vendorStatus: 'approved', ...account };
  const owner = { ...user, ...seller };
  const doc = Product.hydrate({ _id: pid, name: 'Fixture', description: 'Fixture', price: 1,
    stockQuantity: 1, category: 'Fashion', subcategory: 'Footwear', sellerType: 'vendor',
    sellerId: uid, vendor: uid, productStatus: 'active', moderationStatus: 'approved', ...product });
  const saved = [], offers = [];
  const secret = 'category-auth-local-fixture-only';
  const prior = process.env.JWT_SECRET; process.env.JWT_SECRET = secret;
  t.after(() => { if (prior === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prior; });
  const query = value => ({ select() { return this; }, session() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
    lean: async () => ({ stockQuantity: doc.stockQuantity, reservedStockQuantity: doc.reservedStockQuantity, inventoryRevision: doc.inventoryRevision }) });
  t.mock.method(mongoose, 'connect', async () => assert.fail('Database connections are forbidden.'));
  t.mock.method(User, 'findById', id => query(String(id) === uid ? user : owner));
  t.mock.method(User, 'findOne', () => query(owner));
  // Seller lookup is intentionally distinct from the authenticated actor.
  if (Object.keys(seller).length) {
    doc.sellerId = '000000000000000000000003'; doc.vendor = doc.sellerId;
  }
  t.mock.method(Rider, 'findById', () => query(null));
  t.mock.method(Product, 'findById', () => query(doc));
  t.mock.method(Shipment, 'exists', async () => false);
  t.mock.method(taxonomy, 'databaseReadiness', async () => false);
  t.mock.method(Product.prototype, 'save', async function () { await this.validate(); saved.push(this.toObject()); this.$__reset(); return this; });
  t.mock.method(Product.prototype, 'populate', async function () { return this; });
  t.mock.method(ProductOffer, 'findOne', () => query({ _id: pid }));
  t.mock.method(ProductOffer, 'updateOne', async (_f, update) => offers.push(update));
  t.mock.method(ProductOffer, 'updateMany', async (_f, update) => offers.push(update));
  t.mock.method(Product, 'startSession', async () => { let active = false; return {
    startTransaction() { active = true; }, inTransaction: () => active, commitTransaction: async () => { active = false; },
    abortTransaction: async () => { active = false; }, endSession: async () => {} }; });
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.files = {}; next(); });
  app.use('/api/products', products); app.use('/api/admin', admin);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); assert.equal(mongoose.connect.mock.callCount(), 0); assert.equal(mongoose.connection.readyState, 0); });
  async function request(path, body, method = 'PUT', token = jwt.sign({ id: uid }, secret)) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  return { request, saved, offers };
}
test('admin cannot reassign medicine to an approved non-pharmacist before inventory mutation', async t => {
  const f = await fixture(t, { account: { isAdmin: true }, seller: { role: 'user' },
    product: { category: 'Health & Beauty', subcategory: 'Medicine' } });
  const inventory = require('../services/inventoryService');
  t.mock.method(inventory, 'assertNoHolds', async () => assert.fail('Unsafe reassignment must not touch inventory.'));
  const result = await f.request(`/api/products/${pid}/seller`, { sellerType: 'vendor', sellerId: '000000000000000000000003' }, 'PATCH');
  assert.equal(result.status, 400); assert.equal(f.saved.length, 0); assert.equal(f.offers.length, 0);
});
test('admin edits and restoration cannot publish medicine for an ineligible seller', async t => {
  const f = await fixture(t, { account: { isAdmin: true }, seller: { role: 'user' },
    product: { category: 'Health & Beauty', subcategory: 'Medicine', productStatus: 'disabled' } });
  assert.equal((await f.request(`/api/products/${pid}`, { description: 'Edited' })).status, 400);
  assert.equal((await f.request(`/api/products/${pid}/archive`, { archived: false }, 'PATCH')).status, 400);
  assert.equal(f.saved.length, 0); assert.equal(f.offers.length, 0);
});
test('admin restoration cannot bypass contradictory food classification review', async t => {
  const f = await fixture(t, { account: { isAdmin: true }, product: {
    category: 'Restaurant', subcategory: 'Restaurant Equipment', restaurantName: 'Fixture kitchen', productStatus: 'disabled' } });
  assert.equal((await f.request(`/api/products/${pid}/archive`, { archived: false }, 'PATCH')).status, 400);
  assert.equal(f.saved.length, 0);
});

for (const vendorStatus of ['none', 'sent', 'received', 'reviewing', 'rejected', 'suspended']) {
  test(`real authentication cannot grant ${vendorStatus} vendors product update or restoration rights`, async t => {
    const f = await fixture(t, { account: { vendorStatus } });
    assert.equal((await f.request(`/api/products/${pid}`, { description: 'Edited' })).status, 403);
    assert.equal((await f.request(`/api/products/${pid}/archive`, { archived: false }, 'PATCH')).status, 403);
    assert.equal(f.saved.length, 0);
  });
}
test('real authenticated approved vendor can edit its own legacy product', async t => {
  const f = await fixture(t, { product: { categoryId: 'ffffffffffffffffffffffff' } });
  assert.equal((await f.request(`/api/products/${pid}`, { description: 'Edited' })).status, 200);
  assert.equal(f.saved.length, 1);
});
test('missing or invalid JWT cannot update or moderate products', async t => {
  const f = await fixture(t);
  for (const token of ['', 'invalid-local-token']) {
    assert.equal((await f.request(`/api/products/${pid}`, { description: 'Edited' }, 'PUT', token)).status, 401);
    assert.equal((await f.request(`/api/admin/product-moderation/${pid}`, { status: 'approved' }, 'PUT', token)).status, 401);
  }
  assert.equal(f.saved.length, 0);
});
test('vendors cannot approve their own product or edit another vendor product', async t => {
  const f = await fixture(t, { product: { sellerId: '000000000000000000000003', vendor: '000000000000000000000003' } });
  assert.equal((await f.request(`/api/products/${pid}`, { description: 'Edited' })).status, 401);
  assert.equal((await f.request(`/api/admin/product-moderation/${pid}`, { status: 'approved' })).status, 403);
  assert.equal(f.saved.length, 0);
});
test('admin capability uses the authenticated admin flag even on legacy role strings', async t => {
  const f = await fixture(t, { account: { role: 'user', isAdmin: true, isVendor: false, vendorStatus: 'none' } });
  assert.equal((await f.request(`/api/products/${pid}`, { description: 'Edited' })).status, 200);
});
test('role string alone cannot authorize admin moderation', async t => {
  const f = await fixture(t, { account: { role: 'admin', isAdmin: false } });
  assert.equal((await f.request(`/api/admin/product-moderation/${pid}`, { status: 'approved' })).status, 403);
});
for (const product of [
  { category: 'Restaurant', subcategory: 'Meals', restaurantName: 'Fixture kitchen' },
  { category: 'Cosmetics & Beauty', subcategory: 'Medicine', requiresPrescription: true },
]) test(`vendor restoration of ${product.subcategory} cannot bypass review`, async t => {
  const f = await fixture(t, { account: { role: 'pharmacist', pharmacistStatus: 'approved' }, product: { ...product, productStatus: 'disabled' } });
  assert.equal((await f.request(`/api/products/${pid}/archive`, { archived: false }, 'PATCH')).status, 200);
  assert.equal(f.saved[0].moderationStatus, 'pending'); assert.equal(f.saved[0].isActive, false);
});
test('authorized admin can approve a valid approved pharmacist listing without removing prescription flags', async t => {
  const f = await fixture(t, { account: { isAdmin: true, isVendor: false, role: 'admin' },
    seller: { isVendor: true, vendorStatus: 'approved', role: 'pharmacist', pharmacistStatus: 'approved' },
    product: { category: 'Cosmetics & Beauty', subcategory: 'Medicine', moderationStatus: 'pending', requiresPrescription: true } });
  assert.equal((await f.request(`/api/admin/product-moderation/${pid}`, { status: 'approved' })).status, 200);
  assert.equal(f.saved[0].requiresPrescription, true); assert.equal(f.saved[0].moderationStatus, 'approved');
});
for (const seller of [
  { isVendor: true, vendorStatus: 'reviewing', role: 'pharmacist' },
  { isVendor: true, vendorStatus: 'suspended', role: 'pharmacist' },
  { isVendor: true, vendorStatus: 'approved', role: 'user' },
  { isVendor: true, vendorStatus: 'approved', role: 'pharmacist', pharmacistStatus: 'rejected' },
]) test(`admin cannot publish medicine for an ineligible seller ${JSON.stringify(seller)}`, async t => {
  const f = await fixture(t, { account: { isAdmin: true }, seller,
    product: { category: 'Cosmetics & Beauty', subcategory: 'Medicine', moderationStatus: 'pending' } });
  assert.equal((await f.request(`/api/admin/product-moderation/${pid}`, { status: 'approved' })).status, 400);
  assert.equal(f.saved.length, 0);
});
for (const product of [
  { category: 'Food & Beverage > Catering Supplies', subcategory: 'Restaurant Equipment', restaurantName: 'Fixture kitchen' },
  { categoryId: 'ffffffffffffffffffffffff' },
  { category: 'Restaurant', subcategory: 'Meals', restaurantName: ' ' },
]) test(`admin approval requires resolving unsafe classification ${JSON.stringify(product)}`, async t => {
  const f = await fixture(t, { account: { isAdmin: true }, product: { ...product, moderationStatus: 'pending' } });
  assert.equal((await f.request(`/api/admin/product-moderation/${pid}`, { status: 'approved' })).status, 400);
  assert.equal(f.saved.length, 0);
  assert.equal((await f.request(`/api/admin/product-moderation/${pid}`, { status: 'rejected' })).status, 200);
});
test('suspended vendor status is supported by the real User schema', async () => {
  const user = new User({ vendorStatus: 'suspended' }); await user.validate(['vendorStatus']);
  assert.equal(user.vendorStatus, 'suspended');
});

test('actual vendor update saves colours while retaining text-only category and approval', async t => {
  const f=await fixture(t);
  const result=await f.request(`/api/products/${pid}`,{availableColors:'["Black","Royal Blue"]'});
  assert.equal(result.status,200);assert.deepEqual(f.saved[0].availableColors,['Black','Royal Blue']);
  assert.equal(f.saved[0].category,'Fashion');assert.equal(f.saved[0].moderationStatus,'approved');
});
test('actual vendor update rejects invalid colours before saving', async t => {
  const f=await fixture(t);
  const result=await f.request(`/api/products/${pid}`,{availableColors:JSON.stringify(['x'.repeat(41)])});
  assert.equal(result.status,400);assert.equal(f.saved.length,0);
});

test('actual vendor update can explicitly clear optional sizes without clearing omitted colours', async t => {
  const f=await fixture(t,{product:{availableColors:['Cream'],sizeData:{type:'custom',customDimensions:[{length:10,width:20,height:30,unit:'cm',label:'Small'}]}}});
  const result=await f.request(`/api/products/${pid}`,{size_data:JSON.stringify({type:null,sizes:[]})});
  assert.equal(result.status,200);assert.equal(f.saved[0].sizeData,null);assert.deepEqual(f.saved[0].availableColors,['Cream']);
});
