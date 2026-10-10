const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Product = require('../models/Product');
const ProductOffer = require('../models/ProductOffer');
const Shipment = require('../models/Shipment');
const { buildCategoryFilter, buildHierarchicalCategoryFilter } = require('../utils/productFilters');
const catalog = require('../services/catalogSearchService');

// Fixture-only route checks: no production DB, email, uploads, payments or credentials.
// Auth behavior is covered separately; this fixture grants a local admin for GET-only checks.
const authPath = require.resolve('../middleware/authMiddleware');
const auth = require(authPath);
const pricePath = require.resolve('../services/productPriceService');
const prices = require(pricePath);
require.cache[authPath].exports = { ...auth,
  protect: (req, res, next) => { req.user = { role: 'admin' }; next(); },
  authorizeRoles: () => (req, res, next) => next(),
};
require.cache[pricePath].exports = { ...prices, decorateProductPrices: async rows => rows };
const router = require('../routes/productRoutes');
require.cache[authPath].exports = auth;
require.cache[pricePath].exports = prices;

function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$and') return value.every(part => matches(row, part));
    if (key === '$or') return value.some(part => matches(row, part));
    if (value && value.$regex !== undefined) {
      const expression = value.$regex instanceof RegExp ? value.$regex : new RegExp(value.$regex, value.$options || '');
      return expression.test(String(row[key] || ''));
    }
    if (value && value.$nin) return !value.$nin.includes(row[key]);
    return row[key] === value;
  });
}
const rows = [
  { _id: 'medicine', name: 'medicine fixture', category: 'Health & Beauty > Medicine', isActive: true },
  { _id: 'canonical', name: 'medicine fixture', category: 'Cosmetics & Beauty > Medicine', isActive: true },
  { _id: 'split', name: 'medicine fixture', category: 'Health & Beauty', subcategory: 'Medicine', isActive: true },
  { _id: 'shirt', name: 'shirt', category: "Fashion > Men's Fashion", isActive: true },
  { _id: 'hidden', name: 'medicine fixture', category: 'Health & Beauty > Medicine', isActive: false },
  { _id: 'fragrance', name: 'fragrance fixture', category: 'Health & Beauty > Fragrance', isActive: true },
];
function chain(result) {
  let skip = 0, limit = result.length;
  return {
    populate() { return this; }, sort() { return this; }, select() { return this; },
    skip(value) { skip = value; return this; }, limit(value) { limit = value; return this; },
    lean: async () => result.slice(skip, skip + limit),
  };
}
async function routeFixture(t) {
  t.mock.method(Product, 'find', filter => chain(rows.filter(row => matches(row, filter))));
  t.mock.method(Product, 'countDocuments', async filter => rows.filter(row => matches(row, filter)).length);
  t.mock.method(ProductOffer, 'find', () => chain([]));
  t.mock.method(Shipment, 'distinct', async () => []);
  const app = express(); app.use('/api/products', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async (path, query) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/products' + path + '?' + new URLSearchParams(query));
    assert.equal(response.status, 200);
    return { body: await response.json(), total: response.headers.get('x-total-count') };
  };
}

test('medicine categories accept legacy and current labels, including separate subcategory storage', () => {
  const filter = buildCategoryFilter('Cosmetics & Beauty > Medicine');
  assert.deepEqual(rows.filter(row => matches(row, filter)).map(row => row._id), ['medicine', 'canonical', 'split', 'hidden']);
  assert.equal(matches(rows[3], filter), false);
  assert.equal(matches(rows[5], filter), false);
});

test('category paths tolerate separator spacing and case without matching siblings', () => {
  const filter = buildCategoryFilter('cosmetics & beauty>medicine');
  assert.equal(matches({ category: 'HEALTH & BEAUTY > Medicine' }, filter), true);
  assert.equal(matches({ category: 'Health & Beauty>Medicine>First Aid' }, filter), true);
  assert.equal(matches({ category: 'Health & Beauty > Medicine Cabinet' }, filter), false);
  assert.equal(matches({ category: 'Fashion', subcategory: 'Medicine' }, filter), false);
});

test('equivalent supermarket labels keep grocery products within grocery browsing', () => {
  const regex = buildHierarchicalCategoryFilter('Supermarket').category.$regex;
  assert.equal(regex.test('Groceries > Food Cupboard'), true);
  assert.equal(regex.test('Supermarket > Groceries'), true);
  assert.equal(regex.test('Fashion > Food Cupboard'), false);
});

test('category punctuation remains literal and an empty category remains unfiltered', () => {
  const filter = buildCategoryFilter('Health & Beauty > Medicine (OTC)');
  assert.equal(matches({ category: 'Cosmetics & Beauty > Medicine (OTC)' }, filter), true);
  assert.equal(matches({ category: 'Cosmetics & Beauty > Medicine OTC' }, filter), false);
  assert.deepEqual(buildCategoryFilter(''), {});
});

test('catalog search uses the same aliases while preserving standalone subcategory lookup', () => {
  const filter = catalog.buildCategoryFilter('Cosmetics & Beauty > Medicine');
  assert.equal(matches(rows[0], filter), true);
  assert.equal(matches(rows[3], filter), false);
  assert.equal(matches({ category: 'Health & Beauty', subcategory: 'Medicine' }, catalog.buildCategoryFilter('Medicine')), true);
  assert.equal(catalog.buildCategoryFilter(''), null);
});

test('public pharmacy browsing returns medicine fixtures and excludes inactive products', async t => {
  const get = await routeFixture(t);
  const result = await get('', { category: 'Cosmetics & Beauty > Medicine' });
  assert.deepEqual(result.body.map(row => row._id), ['medicine', 'canonical', 'split']);
  assert.equal(result.total, '3');
});

test('searching shirt in pharmacy cannot replace its category condition', async t => {
  const get = await routeFixture(t);
  const result = await get('', { category: 'Cosmetics & Beauty > Medicine', q: 'shirt' });
  assert.deepEqual(result.body, []);
  assert.equal(result.total, '0');
});

test('matching searches inside pharmacy preserve the selected category', async t => {
  const get = await routeFixture(t);
  const result = await get('', { category: 'Cosmetics & Beauty > Medicine', query: 'fixture' });
  assert.deepEqual(result.body.map(row => row._id), ['medicine', 'canonical', 'split']);
});

test('admin search also intersects search text with category', async t => {
  const get = await routeFixture(t);
  const result = await get('/admin/catalog', { category: 'Cosmetics & Beauty > Medicine', q: 'shirt' });
  assert.deepEqual(result.body.products, []);
});

test('ordinary product search and fashion categories still return clothing', async t => {
  const get = await routeFixture(t);
  const search = await get('', { q: 'shirt' });
  assert.deepEqual(search.body.map(row => row._id), ['shirt']);
  const fashion = await get('', { category: "Fashion > Men's Fashion", q: 'shirt' });
  assert.deepEqual(fashion.body.map(row => row._id), ['shirt']);
});


test('legacy fashion labels are scoped to fashion, including separate subcategory storage', () => {
  const filter = buildCategoryFilter("Fashion > Men's Fashion");
  assert.equal(matches({ category: 'Fashion > Men' }, filter), true);
  assert.equal(matches({ category: 'Fashion', subcategory: 'Men' }, filter), true);
  assert.equal(matches({ category: 'Fashion > Menswear Unrelated' }, filter), false);
  assert.equal(matches({ category: 'Electronics', subcategory: 'Men' }, filter), false);
});

test('phone accessory labels stay within phones and tablets', () => {
  const filter = buildCategoryFilter('Phones & Tablets > Mobile Phone Accessories');
  assert.equal(matches({ category: 'Phones & Tablets > Accessories' }, filter), true);
  assert.equal(matches({ category: 'Phones & Tablets', subcategory: 'Accessories' }, filter), true);
  assert.equal(matches({ category: 'Fashion > Accessories' }, filter), false);
  assert.equal(matches({ category: 'Phones & Tablets > Mobile Phones' }, filter), false);
});

test('legacy combined beauty label matches only its selected beauty branch', () => {
  const row = { category: 'Supermarket Health & Beauty > Skin Care & Cosmetics> Others' };
  assert.equal(matches(row, buildCategoryFilter('Cosmetics & Beauty > Skin Care & Cosmetics')), true);
  assert.equal(matches(row, buildCategoryFilter('Cosmetics & Beauty > Medicine')), false);
});
