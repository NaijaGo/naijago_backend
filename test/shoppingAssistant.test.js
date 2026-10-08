// Real service/search/pricing/route code with isolated DB and Gemini boundaries.
// These tests do not connect to MongoDB, Gemini, or production.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const catalog = require('../services/catalogSearchService');
const pid = '507f1f77bcf86cd799439011', oid = '507f1f77bcf86cd799439012', vid = '507f1f77bcf86cd799439013';
const copy = value => JSON.parse(JSON.stringify(value));
const id = value => String(value?._id || value || '');
const same = (a, b) => id(a) === id(b);
function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$and') return expected.every(item => matches(row, item));
    if (key === '$or') return expected.some(item => matches(row, item));
    const actual = key.split('.').reduce((value, part) => value?.[part], row);
    if (expected && typeof expected === 'object' && !expected._bsontype && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, value]) => {
        if (operator === '$options') return true;
        if (operator === '$regex') return new RegExp(value, expected.$options || '').test(Array.isArray(actual) ? actual.join(' ') : String(actual || ''));
        if (operator === '$in') return value.some(item => same(actual, item));
        if (operator === '$nin') return !value.some(item => same(actual, item));
        if (operator === '$ne') return actual !== value;
        if (operator === '$gt') return actual > value;
        if (operator === '$lte') return actual <= value;
        throw new Error(`Unimplemented DB-stub operator: ${operator}`);
      });
    }
    return same(actual, expected);
  });
}
function load(file, dependencies, extras = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, exports: module.exports, require: name => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    }, Date, Map, Set, Number, String, Math, Object, Array, JSON, URL, setTimeout, clearTimeout, ...extras,
  }, { filename: file });
  return module.exports;
}
function fixture({ name = 'Lunch rice meal', price = 7000, effectivePrice, offers = true } = {}) {
  return { _id: pid, name, description: name, brand: '', category: 'Food', subcategory: '', searchTags: [], imageUrls: [],
    vendor: vid, sellerType: 'vendor', sellerId: vid, price, discountPrice: effectivePrice ?? null,
    isActive: true, productStatus: 'active', moderationStatus: 'approved', stockQuantity: 10,
    reservedStockQuantity: 0, ...(offers ? {} : { offers: [] }) };
}
function harness(options = {}) {
  const state = { products: options.products ?? [fixture()],
    offers: options.offers ?? [{ _id: oid, product: pid, sellerType: 'vendor', sellerId: vid,
      price: 7000, discountPrice: 4500, status: 'active', stockQuantity: 10, reservedStockQuantity: 0, isPrimary: true }],
    users: [{ _id: vid, businessName: 'Lucas World', isVendor: true, vendorStatus: 'approved', isTemporarilyClosed: false }],
    deals: options.deals ?? [], posts: [], searches: [], reads: 0, intent: options.intent ?? { queries: ['lunch'], clarification: 'none' }, failure: options.failure };
  function query(values) {
    let skip = 0, limit = Infinity, population;
    const chain = { select() { return this; }, sort() { return this; }, populate(field) { population = field; return this; },
      skip(value) { skip = value; return this; }, limit(value) { limit = value; return this; }, lean() { return this; },
      then(resolve, reject) { const rows = copy(values).slice(skip, skip + limit);
        if (population) for (const row of rows) row[population] = copy(state.users.find(user => same(user._id, row[population])) || row[population]);
        return Promise.resolve(rows).then(resolve, reject); } };
    return chain;
  }
  const Product = { find(filter) { state.reads++; return query(state.products.filter(row => matches(row, filter))); }, countDocuments: async filter => state.products.filter(row => matches(row, filter)).length };
  const User = { find(filter) { state.reads++; return query(state.users.filter(row => matches(row, filter))); } };
  const Offer = { find: filter => query(state.offers.filter(row => matches(row, filter))) };
  const Deal = { find: filter => query(state.deals.filter(row => matches(row, filter))) };
  const prices = load('services/productPriceService.js', { '../models/Deal': Deal, '../models/User': User, '../models/ProductOffer': Offer });
  const gemini = load('services/geminiCatalogService.js', { axios: { async post(url, body, config) {
    state.posts.push({ url, body, config }); if (state.failure) throw state.failure;
    if (options.pending) await options.pending;
    return { data: { candidates: [{ content: { parts: [{ text: options.raw ?? JSON.stringify(state.intent) }] } }] } };
  } } }, { process: { env: options.noKey ? {} : { GEMINI_API_KEY: 'isolated-test-not-a-production-key', GEMINI_CATALOG_MODEL: 'isolated-test-model' } } });
  const routeSource = fs.readFileSync(path.join(__dirname, '../routes/productRoutes.js'), 'utf8');
  const start = routeSource.indexOf('const attachPrimaryOffers = async (products) => {');
  const end = routeSource.indexOf('\n};', start);
  assert.ok(start >= 0 && end > start);
  const attachOffers = vm.runInNewContext(`(${routeSource.slice(start, end + 3).replace('const attachPrimaryOffers = ', '').replace(/;$/, '')})`,
    { ProductOffer: Offer, vendorPopulateFields: '_id businessName', decorateProductPrices: prices.decorateProductPrices, Map, String, Array });
  const service = load('services/shoppingAssistantService.js', {
    '../models/Product': Product, '../models/User': User, './geminiCatalogService': gemini,
    './catalogSearchService': { parseCatalogSearchRequest: catalog.parseCatalogSearchRequest,
      searchCatalog(input, args) { state.searches.push(input); return catalog.searchCatalog(input, { ...args, ProductModel: Product, UserModel: User }); } },
    './productPriceService': prices,
  });
  return { state, suggest: body => service.suggest(typeof body === 'string' ? { message: body } : body, { attachOffers }), service, attachOffers, routeSource };
}

for (const [request, query, name, regular, final, budget] of [
  ['I need lunch under ₦5,000', 'lunch', 'Lunch rice meal', 7000, 4500, 5000],
  ['Find me a phone under ₦150,000', 'phone', 'Samsung phone', 170000, 140000, 150000],
  ['I need a birthday gift for my girlfriend under ₦30,000', 'perfume', 'Birthday perfume gift', 35000, 25000, 30000],
]) test(`real catalog selection: ${request}`, async () => {
  const h = harness({ products: [fixture({ name, price: regular })], offers: [{ _id: oid, product: pid, sellerType: 'vendor', sellerId: vid,
    price: regular, discountPrice: final, status: 'active', stockQuantity: 3 }], intent: { queries: [query], clarification: 'none' } });
  const response = await h.suggest(request);
  assert.equal(response.maxPrice, budget); assert.equal(response.products.length, 1);
  const product = response.products[0]; assert.equal(product._id, pid); assert.equal(product.selectedOffer._id, oid);
  assert.equal(product.sellerId, vid); assert.equal(product.vendor.businessName, 'Lucas World'); assert.equal(product.effectivePrice, final);
  assert.ok(product.effectivePrice <= budget); assert.equal(response.budgetScope, 'per_listing'); assert.equal(response.deliveryIncluded, false);
  assert.match(response.notice, /not a combined basket/); assert.equal(h.state.posts.length, 1);
  assert.equal(h.state.posts[0].body.tools, undefined); assert.equal(h.state.posts[0].config.timeout, 12000);
  assert.equal(h.state.searches[0].maxPrice, null); // Actual decorated offer price is filtered afterward.
});
test('student request may ask category clarification without querying inventory', async () => {
  const h = harness({ intent: { queries: [], clarification: 'category' } });
  const response = await h.suggest('I need something useful for a student');
  assert.match(response.question, /type of product/); assert.equal(response.products.length, 0); assert.equal(h.state.reads, 0);
});
test('ambiguous request asks product clarification rather than inventing a listing', async () => {
  const response = await harness({ intent: { queries: [], clarification: 'product' } }).suggest('I need something');
  assert.match(response.question, /like to buy/); assert.equal(response.products.length, 0);
});
test('nonexistent product returns no fake recommendation', async () => {
  const response = await harness({ intent: { queries: ['quantum teleportation machine'], clarification: 'none' } }).suggest('Find me a quantum teleportation machine under ₦10,000');
  assert.equal(response.products.length, 0); assert.match(response.message, /No suitable/); assert.equal(response.maxPrice, 10000);
});
test('valid empty catalog returns empty successful contract', async () => {
  const response = await harness({ products: [], offers: [] }).suggest('I need lunch under ₦5,000');
  assert.equal(response.products.length, 0); assert.equal(response.question, null); assert.equal(response.source, 'naijago_catalog');
});
for (const failure of [new Error('provider unavailable'), Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }), Object.assign(new Error('quota'), { response: { status: 429 } })]) {
  test(`Gemini failure safe 503: ${failure.message}`, async () => {
    const h = harness({ failure });
    await assert.rejects(h.suggest('lunch'), error => error.statusCode === 503 && /normal search/.test(error.message));
    assert.equal(h.state.searches.length, 0); assert.equal(h.state.posts.length, 1);
  });
}
test('missing Gemini key fails closed without making an external request', async () => {
  const h = harness({ noKey: true }); await assert.rejects(h.suggest('lunch'), error => error.statusCode === 503);
  assert.equal(h.state.posts.length, 0);
});
for (const raw of ['not json', JSON.stringify({ queries: ['lunch'], clarification: 'none', products: [{ price: 1 }] }), JSON.stringify({ queries: ['.*'], clarification: 'none' }), JSON.stringify({ queries: ['lunch'], clarification: 'invented' })]) {
  test(`unusable Gemini output rejected: ${raw.slice(0, 36)}`, async () => {
    const h = harness({ raw }); await assert.rejects(h.suggest('lunch'), error => error.statusCode === 503); assert.equal(h.state.searches.length, 0);
  });
}
test('Gemini empty intent produces clarification without fabricated data', async () => {
  const response = await harness({ intent: { queries: [], clarification: 'none' } }).suggest('lunch');
  assert.equal(response.products.length, 0); assert.ok(response.question);
});
test('input limits and client price/identity fields are rejected before Gemini', async () => {
  const h = harness();
  for (const body of [null, [], {}, { message: '' }, { message: 'x'.repeat(501) }, { message: 'lunch', price: 1 }, { message: 'lunch', maxPrice: 1 }, { message: 'lunch', vendorId: vid }]) {
    await assert.rejects(h.suggest(body), error => error.statusCode === 400);
  }
  assert.equal(h.state.posts.length, 0);
});
test('budget parsing handles people counts, k suffix and clear naira amounts', async () => {
  for (const [text, budget] of [['I have ₦10,000. I need food for 3 people tonight.', 10000], ['lunch under ₦5,000.', 5000], ['phone under ₦150,000.', 150000], ['lunch under ₦15k.', 15000], ['lunch under ₦5000.50.', 5000.50], ['Find a lunch under ₦15k', 15000], ['lunch below 5000 naira', 5000], ['I have 3 people who need lunch', null]]) {
    const result = await harness().suggest(text); assert.equal(result.maxPrice, budget, text);
  }
});
test('ambiguous, malformed, negative, foreign and excessive budgets request clarification', async () => {
  for (const text of ['lunch under ₦-100', 'lunch under ₦0', 'lunch ₦1,00', 'lunch ₦15.999', 'lunch under $50', 'lunch ₦1000 and ₦2000', 'lunch under ₦1000000001']) {
    const h = harness(); const result = await h.suggest(text); assert.ok(result.question, text); assert.equal(result.products.length, 0); assert.equal(h.state.posts.length, 0);
  }
});
test('over-budget and irrelevant catalog records are excluded', async () => {
  const h = harness({ products: [fixture({ name: 'Lunch', price: 6000 }), { ...fixture({ name: 'Phone', price: 3000, offers: false }), _id: '507f1f77bcf86cd799439014' }], offers: [] });
  const result = await h.suggest('lunch under ₦5,000'); assert.equal(result.products.length, 0);
});
test('reserved stock and invalid balances cannot be advertised as available', async () => {
  for (const [stock, reserved] of [[0, 0], [3, 3], [3, 4], [3, -1], [1.5, 0]]) {
    const h = harness(); h.state.products[0].stockQuantity = stock; h.state.products[0].reservedStockQuantity = reserved;
    assert.equal((await h.suggest('lunch')).products.length, 0);
  }
  const h = harness(); h.state.offers[0].reservedStockQuantity = 10;
  assert.equal((await h.suggest('lunch')).products.length, 0);
});
test('unapproved or closed vendor cannot supply recommendations', async () => {
  for (const change of [{ vendorStatus: 'pending' }, { isTemporarilyClosed: true }]) {
    const h = harness(); Object.assign(h.state.users[0], change); assert.equal((await h.suggest('lunch')).products.length, 0);
  }
});
test('active Deal uses existing backend resolver, no stacking or AI price', async () => {
  const h = harness({ deals: [{ _id: '507f1f77bcf86cd799439017', productId: pid, productOfferId: oid, vendorId: vid,
    targetKey: `${pid}:${oid}`, status: 'approved', discountType: 'percentage', discountValue: 50,
    startAt: new Date(Date.now() - 60000), endAt: new Date(Date.now() + 3600000) }] });
  const result = await h.suggest('lunch under ₦4,000');
  assert.equal(result.products[0].effectivePrice, 3500); assert.equal(result.products[0].deal.finalPrice, 3500);
});
test('concurrency limit rejects fifth in-flight request and clears after completion', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; }); const h = harness({ pending });
  const requests = Array.from({ length: 4 }, () => h.suggest('lunch'));
  await assert.rejects(h.suggest('lunch'), error => error.statusCode === 429);
  release(); await Promise.all(requests); assert.ok((await h.suggest('lunch')).products.length);
});
test('actual localhost route and limiter: six allowed, seventh HTTP 429', async () => {
  const h = harness(); const router = express.Router(); const context = { router, rateLimit, shoppingAssistant: h.service, attachPrimaryOffers: h.attachOffers };
  const limiter = h.routeSource.match(/const shoppingAssistantLimiter = rateLimit\([\s\S]*?\);/);
  assert.ok(limiter); vm.runInNewContext(`${limiter[0]}\nthis.limiter = shoppingAssistantLimiter;`, context);
  const start = h.routeSource.indexOf("router.post('/shopping-assistant'"); const end = h.routeSource.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start); vm.runInNewContext(h.routeSource.slice(start, end + 4), { ...context, shoppingAssistantLimiter: context.limiter });
  const app = express(); app.use(express.json()); app.use('/api/products', router); const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    for (let i = 1; i <= 7; i++) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/products/shopping-assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ message: 'lunch under ₦5,000' }) });
      assert.equal(response.status, i <= 6 ? 200 : 429); assert.match(response.headers.get('cache-control') || '', i <= 6 ? /no-store/ : /^/);
      const data = await response.json(); if (i <= 6) assert.equal(data.products[0].effectivePrice, 4500); else assert.match(data.message, /Too many/);
    }
    assert.equal(h.state.posts.length, 6);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
