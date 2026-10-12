const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Product = require('../models/Product');
const ProductOffer = require('../models/ProductOffer');
const User = require('../models/User');
const Shipment = require('../models/Shipment');
const cloudinary = require('cloudinary').v2;
const authPath = require.resolve('../middleware/authMiddleware');
const auth = require(authPath);
// Replace authentication only. Keep the actual role authorization middleware.
require.cache[authPath].exports = { ...auth, protect: (req, res, next) => {
  req.user = { _id: '000000000000000000000001', role: req.headers['x-fixture-role'] || 'vendor',
    isVendor: req.headers['x-fixture-vendor'] !== 'false' }; next();
} };
const router = require('../routes/productRoutes');
require.cache[authPath].exports = auth;

async function fixture(t, { approved = true, role = 'vendor' } = {}) {
  const saved = [], uploads = [];
  t.mock.method(User, 'findById', async () => ({ _id: '000000000000000000000001', role,
    isVendor: true, vendorStatus: approved ? 'approved' : 'pending', save: async () => {} }));
  t.mock.method(Product.prototype, 'save', async function () { saved.push(this); return this; });
  t.mock.method(Product.prototype, 'populate', async function () { return this; });
  t.mock.method(ProductOffer, 'create', async () => ({}));
  t.mock.method(cloudinary.uploader, 'upload', async () => { uploads.push('fixture'); return { secure_url: 'https://fixture.invalid/photo.jpg' }; });
  t.mock.method(Product, 'startSession', async () => ({ endSession: async () => {}, inTransaction: () => false }));
  t.mock.method(Product, 'findById', async () => new Product({ _id: '000000000000000000000002',
    name: 'Fixture', description: 'Fixture', price: 1, stockQuantity: 1, category: 'Fashion > Footwear',
    sellerType: 'vendor', sellerId: '000000000000000000000001', vendor: '000000000000000000000001', imageUrls: [] }));
  t.mock.method(Shipment, 'exists', async () => false);
  const app = express(); app.use('/api/products', router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function request(fields, { method = 'POST', headers = {} } = {}) {
    const body = new FormData();
    Object.entries({ name: 'Fixture', description: 'Fixture description', price: '1', stockQuantity: '1', sku: 'FIXTURE', ...fields })
      .forEach(([key, value]) => body.append(key, value));
    body.append('mainImage', new Blob(['fixture'], { type: 'image/png' }), 'fixture.png');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/products${method === 'PUT' ? '/000000000000000000000002' : ''}`, { method, headers, body });
    return { status: response.status, body: await response.json() };
  }
  return { request, saved, uploads };
}
test('unapproved vendors and non-vendors remain blocked before uploads', async t => {
  const f = await fixture(t, { approved: false });
  const result = await f.request({ category: 'Fashion', subcategory: 'Footwear' });
  assert.equal(result.status, 403);
  assert.equal((await f.request({ category: 'Fashion' }, { headers: { 'x-fixture-vendor': 'false' } })).status, 403);
  assert.equal(f.uploads.length, 0); assert.equal(f.saved.length, 0);
});
test('split and aliased medicine fields cannot bypass pharmacist permissions on create or edit', async t => {
  const f = await fixture(t);
  for (const category of ['Cosmetics & Beauty', 'Health & Beauty', 'Supermarket Health & Beauty']) {
    for (const method of ['POST', 'PUT']) {
      const result = await f.request({ category, subcategory: 'Medicine' }, { method });
      assert.equal(result.status, 403); assert.match(result.body.message, /pharmacist/);
    }
  }
  assert.equal(f.uploads.length, 0); assert.equal(f.saved.length, 0);
});
test('approved pharmacist medicine creation still requires moderation', async t => {
  const f = await fixture(t, { role: 'pharmacist' });
  const result = await f.request({ category: 'Cosmetics & Beauty', subcategory: 'Medicine', productStatus: 'active', requiresPrescription: 'true' });
  assert.equal(result.status, 201); assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].isActive, false); assert.equal(f.saved[0].moderationStatus, 'pending');
  assert.equal(f.saved[0].requiresPrescription, true);
});
test('split food listings still need restaurant details and approval', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ category: 'Restaurant', subcategory: 'Meals' })).status, 400);
  assert.equal(f.uploads.length, 0);
  const result = await f.request({ category: 'Restaurant', subcategory: 'Meals', restaurantName: 'Fixture Kitchen', productStatus: 'active' });
  assert.equal(result.status, 201); assert.equal(f.saved[0].isActive, false);
  assert.equal(f.saved[0].moderationStatus, 'pending');
});
