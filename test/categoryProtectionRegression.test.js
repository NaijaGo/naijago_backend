const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const ProductOffer = require('../models/ProductOffer');
const User = require('../models/User');
const Shipment = require('../models/Shipment');
const inventory = require('../services/inventoryService');
const taxonomy = require('../services/catalogTaxonomyService');
const policy = require('../utils/categoryPolicy');
const cloudinary = require('cloudinary').v2;
const authPath = require.resolve('../middleware/authMiddleware');
const auth = require(authPath);
// Only authentication is replaced. Exercise the actual role checks and handlers.
require.cache[authPath].exports = { ...auth, protect(req, _res, next) {
  req.user = { _id: '000000000000000000000001', role: req.headers['x-fixture-role'] || 'vendor',
    isVendor: req.headers['x-fixture-vendor'] !== 'false', isAdmin: req.headers['x-fixture-admin'] === 'true' };
  next();
} };
const router = require('../routes/productRoutes');
require.cache[authPath].exports = auth;

async function fixture(t, { current = {}, role = 'vendor', approved = true, vendorStatus = approved ? 'approved' : 'reviewing',
  pharmacistStatus, isVendor = true, isAdmin = false, referencesReady = false, hasOrders = false } = {}) {
  const saved = [], uploads = [], offerUpdates = [], inventoryCalls = [], transactions = [];
  const product = Product.hydrate({ _id: '000000000000000000000002', name: 'Fixture', description: 'Fixture',
    price: 1, stockQuantity: 1, sellerType: 'vendor', sellerId: '000000000000000000000001',
    vendor: '000000000000000000000001', category: 'Fashion', subcategory: 'Footwear',
    imageUrls: [], productStatus: 'active', moderationStatus: 'approved', ...current });
  // Hydrate saved legacy data without validating it before the actual handler.
  // Pre-validation would conceal the stale-reference compatibility failure.
  t.mock.method(mongoose, 'connect', async () => { assert.fail('No database connection is permitted.'); });
  t.mock.method(taxonomy, 'databaseReadiness', async () => referencesReady);
  t.mock.method(User, 'findById', async () => ({ _id: '000000000000000000000001', role,
    isVendor, isAdmin, vendorStatus, pharmacistStatus, save: async () => {} }));
  // Validate the real model before capturing the would-be persisted payload.
  t.mock.method(Product.prototype, 'save', async function () {
    await this.validate(); saved.push(this.toObject({ virtuals: false }));
    this.$__reset(); this.isNew = false; return this;
  });
  t.mock.method(Product.prototype, 'populate', async function () { return this; });
  t.mock.method(Product, 'findById', () => ({
    then: (resolve, reject) => Promise.resolve(product).then(resolve, reject),
    select() { return this; }, session() { return this; },
    lean: async () => ({ stockQuantity: product.stockQuantity, reservedStockQuantity: product.reservedStockQuantity,
      inventoryRevision: product.inventoryRevision }),
  }));
  t.mock.method(ProductOffer, 'findOne', () => ({ session: async () => ({ _id: product._id }) }));
  t.mock.method(ProductOffer, 'updateOne', async (_filter, update) => { offerUpdates.push(update); return {}; });
  t.mock.method(ProductOffer, 'create', async () => ({}));
  t.mock.method(inventory, 'adjustStock', async input => {
    inventoryCalls.push(input);
    if (input.expectedRevision !== (current.inventoryRevision ?? 0)) {
      const error = new Error('Fixture inventory revision conflict.'); error.statusCode = 409; throw error;
    }
  });
  t.mock.method(cloudinary.uploader, 'upload', async () => {
    uploads.push('fixture'); return { secure_url: 'https://fixture.invalid/photo.jpg' };
  });
  t.mock.method(Shipment, 'exists', async () => hasOrders);
  t.mock.method(Product, 'startSession', async () => {
    let active = false;
    return { startTransaction() { active = true; transactions.push('start'); }, inTransaction: () => active,
      commitTransaction: async () => { active = false; transactions.push('commit'); },
      abortTransaction: async () => { active = false; transactions.push('abort'); },
      endSession: async () => {} };
  });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.files = {}; next(); });
  app.use('/api/products', router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    assert.equal(mongoose.connect.mock.callCount(), 0);
    assert.equal(mongoose.connection.readyState, 0);
  });
  async function request(fields, method = 'PUT') {
    let body, headers;
    if (method === 'POST') {
      body = new FormData();
      Object.entries({ name: 'Fixture', description: 'Fixture', price: '1', stockQuantity: '1', sku: 'FIXTURE', ...fields })
        .forEach(([key, value]) => body.append(key, value));
      body.append('mainImage', new Blob(['fixture'], { type: 'image/png' }), 'fixture.png');
      headers = { 'x-fixture-role': role };
    } else {
      body = JSON.stringify(fields); headers = { 'Content-Type': 'application/json', 'x-fixture-role': role };
    }
    headers['x-fixture-vendor'] = String(isVendor); headers['x-fixture-admin'] = String(isAdmin);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/products${method === 'PUT' ? '/000000000000000000000002' : ''}`, { method, headers, body });
    return { status: response.status, body: await response.json() };
  }
  return { request, saved, uploads, offerUpdates, inventoryCalls, transactions };
}

const medicineState = { category: 'Cosmetics & Beauty', subcategory: 'Medicine', medicineAccess: 'prescription',
  requiresPrescription: true, requiresPharmacistApproval: true };
function assertMedicinePreserved(value) {
  assert.equal(value.medicineAccess, 'prescription');
  assert.equal(value.requiresPrescription, true); assert.equal(value.requiresPharmacistApproval, true);
  assert.equal(value.isActive, false); assert.equal(value.moderationStatus, 'pending');
  assert.equal(policy.isRestrictedMedicine(value), true);
}

test('actual medicine alias edit preserves an omitted child and prescription protections', async t => {
  const f = await fixture(t, { current: medicineState, role: 'pharmacist' });
  const result = await f.request({ category: 'Health & Beauty' });
  assert.equal(result.status, 200); assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].category, 'Health & Beauty'); assert.equal(f.saved[0].subcategory, 'Medicine');
  assertMedicinePreserved(f.saved[0]); assertMedicinePreserved(result.body.product);
  assert.equal(result.body.product.subcategory, 'Medicine');
});

test('actual alias edit keeps the effective stable child identity when references are ready', async t => {
  const { parent, child } = taxonomy.resolveLabels('Cosmetics & Beauty > Medicine');
  const f = await fixture(t, { role: 'pharmacist', referencesReady: true,
    current: { ...medicineState, categoryId: parent.id, subcategoryId: child.id } });
  assert.equal((await f.request({ category: 'Health & Beauty' })).status, 200);
  assert.equal(String(f.saved[0].categoryId), parent.id); assert.equal(String(f.saved[0].subcategoryId), child.id);
  assertMedicinePreserved(f.saved[0]);
});

test('actual unrelated partial edit preserves the saved child and medicine access', async t => {
  const f = await fixture(t, { current: medicineState, role: 'pharmacist' });
  assert.equal((await f.request({ description: 'Updated description' })).status, 200);
  assert.equal(f.saved[0].subcategory, 'Medicine'); assert.equal(f.saved[0].description, 'Updated description');
  assertMedicinePreserved(f.saved[0]);
});

test('older forms can resubmit unchanged unmapped legacy children during ordinary edits', async t => {
  const f = await fixture(t, { current: { category: 'Home & Office', subcategory: 'Legacy Blender Type' } });
  const result = await f.request({ category: 'Home & Office', subcategory: 'Legacy Blender Type', description: 'Updated description' });
  assert.equal(result.status, 200); assert.equal(f.saved[0].subcategory, 'Legacy Blender Type');
  assert.equal(f.saved[0].categoryId, null); assert.equal(f.saved[0].isActive, true);
});

test('saved prescription flags survive partial edits even on an unmapped legacy category', async t => {
  const f = await fixture(t, { current: { ...medicineState, category: 'Legacy health listing', subcategory: '' }, role: 'pharmacist' });
  assert.equal((await f.request({ description: 'Updated description' })).status, 200);
  assertMedicinePreserved(f.saved[0]);
});

test('actual partial edits retain pharmacist-approval flags without medicineAccess or category keywords', async t => {
  const f = await fixture(t, { role: 'pharmacist', current: { category: 'Legacy health listing',
    subcategory: '', medicineAccess: null, requiresPharmacistApproval: true } });
  assert.equal((await f.request({ description: 'Updated description' })).status, 200);
  assert.equal(f.saved[0].requiresPharmacistApproval, true); assert.equal(f.saved[0].medicineAccess, null);
  assert.equal(f.saved[0].isActive, false); assert.equal(f.saved[0].moderationStatus, 'pending');
  assert.equal(policy.isRestrictedMedicine(f.saved[0]), true);
});

test('explicit child clearing does not implicitly clear omitted prescription protections', async t => {
  const f = await fixture(t, { current: medicineState, role: 'pharmacist' });
  assert.equal((await f.request({ subcategory: null })).status, 200);
  assert.equal(f.saved[0].subcategory, ''); assertMedicinePreserved(f.saved[0]);
});

test('actual valid subcategory changes keep ordinary products usable', async t => {
  const f = await fixture(t);
  const result = await f.request({ subcategory: 'Watches' });
  assert.equal(result.status, 200); assert.equal(f.saved[0].subcategory, 'Watches');
  assert.equal(f.saved[0].category, 'Fashion'); assert.equal(f.saved[0].isActive, true);
  assert.equal(f.saved[0].moderationStatus, 'approved'); assert.equal(f.offerUpdates.length, 1);
});

test('actual ordinary category changes work with an explicitly matching child', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ category: 'Phones & Tablets > Smartphones', subcategory: 'Smartphones' })).status, 200);
  assert.equal(f.saved[0].category, 'Phones & Tablets > Smartphones');
  assert.equal(f.saved[0].subcategory, 'Smartphones'); assert.equal(f.saved[0].isActive, true);
});

test('old combined-path edits remain compatible when no separate child was saved', async t => {
  const f = await fixture(t, { current: { category: 'Fashion > Footwear', subcategory: '' } });
  assert.equal((await f.request({ category: 'Fashion > Watches' })).status, 200);
  assert.equal(f.saved[0].category, 'Fashion > Watches'); assert.equal(f.saved[0].subcategory, '');
  assert.equal(f.saved[0].isActive, true);
});

test('actual explicit empty and null children differ from omission', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ description: 'Keep child' })).status, 200);
  assert.equal(f.saved[0].subcategory, 'Footwear');
  for (const subcategory of ['', null]) {
    assert.equal((await f.request({ subcategory })).status, 200);
    assert.equal(f.saved.at(-1).subcategory, '');
  }
});

test('actual invalid parent-child changes are rejected without persisting an unsafe update', async t => {
  const f = await fixture(t);
  for (const fields of [{ category: 'Phones & Tablets' }, { category: 'Fashion', subcategory: 'Medicine' },
    { category: 'Fashion > Watches', subcategory: 'Footwear' }]) {
    const result = await f.request(fields);
    assert.equal(result.status, 400); assert.equal(result.body.code, 'INVALID_PRODUCT_CATEGORY');
  }
  assert.equal(f.saved.length, 0); assert.equal(f.offerUpdates.length, 0); assert.equal(f.uploads.length, 0);
});

test('actual food-category plus equipment-child creation cannot bypass food review', async t => {
  const f = await fixture(t);
  const fields = { category: 'Food & Beverage > Catering Supplies', subcategory: 'Restaurant Equipment', productStatus: 'active' };
  const result = await f.request(fields, 'POST');
  assert.equal(result.status, 400); assert.equal(result.body.code, 'INVALID_PRODUCT_CATEGORY');
  assert.equal(policy.isRestaurantCategory(fields), true);
  assert.equal(f.saved.length, 0); assert.equal(f.uploads.length, 0);
});

test('actual edits of legacy contradictory food fields retain food restrictions and details', async t => {
  const f = await fixture(t, { current: { category: 'Food & Beverage > Catering Supplies',
    subcategory: 'Restaurant Equipment', restaurantName: 'Fixture Kitchen', foodCategory: 'Catering' } });
  assert.equal((await f.request({ description: 'Updated food details' })).status, 200);
  assert.equal(f.saved[0].isActive, false); assert.equal(f.saved[0].moderationStatus, 'pending');
  assert.equal(f.saved[0].restaurantName, 'Fixture Kitchen'); assert.equal(f.saved[0].foodCategory, 'Catering');
});

test('older forms resubmitting unchanged conflicting food labels remain restricted', async t => {
  const current = { category: 'Food & Beverage > Catering Supplies', subcategory: 'Restaurant Equipment', restaurantName: 'Fixture Kitchen' };
  const f = await fixture(t, { current });
  assert.equal((await f.request({ ...current, description: 'Updated description' })).status, 200);
  assert.equal(f.saved[0].isActive, false); assert.equal(f.saved[0].moderationStatus, 'pending');
});

test('actual valid food creation still requires restaurant details and admin review', async t => {
  const f = await fixture(t);
  const fields = { category: 'Restaurant', subcategory: 'Meals', productStatus: 'active' };
  assert.equal((await f.request(fields, 'POST')).status, 400); assert.equal(f.saved.length, 0);
  const result = await f.request({ ...fields, restaurantName: 'Fixture Kitchen' }, 'POST');
  assert.equal(result.status, 201); assert.equal(f.saved[0].isActive, false);
  assert.equal(f.saved[0].moderationStatus, 'pending'); assert.equal(f.saved[0].restaurantName, 'Fixture Kitchen');
});

test('actual conflicting category text and IDs cannot bypass medicine or food restrictions', async t => {
  const f = await fixture(t, { referencesReady: true });
  for (const selection of [taxonomy.resolveLabels('Cosmetics & Beauty > Medicine'), taxonomy.resolveLabels('Restaurant > Meals')]) {
    const fields = { category: 'Food & Beverage > Restaurant Equipment', subcategory: 'Restaurant Equipment',
      categoryId: selection.parent.id, subcategoryId: selection.child.id, productStatus: 'active' };
    assert.equal(policy.requiresProductModeration(fields), true);
    for (const method of ['POST', 'PUT']) {
      assert.equal((await f.request(fields, method)).status, 400);
    }
  }
  assert.equal(f.saved.length, 0); assert.equal(f.uploads.length, 0);
});

test('actual invalid cross-parent references are rejected before persistence', async t => {
  const f = await fixture(t, { referencesReady: true });
  const categoryId = taxonomy.resolveLabels('Fashion').parent.id;
  const subcategoryId = taxonomy.resolveLabels('Restaurant > Meals').child.id;
  assert.equal((await f.request({ categoryId, subcategoryId })).status, 400);
  assert.equal(f.saved.length, 0);
});

test('actual ownership, order-history and pharmacist guards remain effective', async t => {
  for (const [options, fields, status] of [
    [{ current: { sellerId: '000000000000000000000003', vendor: '000000000000000000000003' } }, { subcategory: 'Watches' }, 401],
    [{ hasOrders: true }, { subcategory: 'Watches' }, 409],
    [{ current: medicineState }, { category: 'Health & Beauty' }, 403],
  ]) {
    await t.test(`rejects with ${status}`, async child => {
      const f = await fixture(child, options);
      assert.equal((await f.request(fields)).status, status); assert.equal(f.saved.length, 0);
    });
  }
});

test('actual unapproved vendor creation remains blocked', async t => {
  const f = await fixture(t, { approved: false });
  assert.equal((await f.request({ category: 'Fashion', subcategory: 'Footwear' }, 'POST')).status, 403);
  assert.equal(f.saved.length, 0); assert.equal(f.uploads.length, 0);
});

test('unknown IDs are not classification authority and genuine equipment stays non-food', () => {
  assert.equal(policy.requiresProductModeration({ category: 'Fashion', subcategory: 'Footwear',
    categoryId: 'Restaurant', subcategoryId: 'Medicine' }), false);
  assert.equal(policy.isRestaurantCategory({ category: 'Food & Beverage', subcategory: 'Restaurant Equipment' }), false);
  assert.equal(policy.isRestaurantCategory({ category: 'Food & Beverage > Restaurant Equipment' }), false);
  assert.equal(policy.isRestrictedMedicine({ category: 'Legacy', requiresPrescription: true }), true);
});

const staleReferences = { categoryId: 'ffffffffffffffffffffffff', subcategoryId: 'eeeeeeeeeeeeeeeeeeeeeeee' };
for (const referencesReady of [false, true]) {
  for (const fields of [{ description: 'Edited' }, { price: 2 }, { stockQuantity: 3 }]) {
    test(`actual stale-reference ${Object.keys(fields)[0]} edit remains compatible, readiness ${referencesReady}`, async t => {
      const f = await fixture(t, { referencesReady, current: staleReferences });
      const result = await f.request(fields);
      assert.equal(result.status, 200); assert.equal(f.saved.length, 1);
      const saved = f.saved[0];
      assert.equal(saved.category, 'Fashion'); assert.equal(saved.subcategory, 'Footwear');
      assert.equal(saved.moderationStatus, 'approved'); assert.equal(saved.isActive, true);
      if (referencesReady) {
        const mapping = taxonomy.resolveLabels('Fashion', 'Footwear');
        assert.equal(String(saved.categoryId), mapping.parent.id); assert.equal(String(saved.subcategoryId), mapping.child.id);
      } else {
        assert.equal(String(saved.categoryId), staleReferences.categoryId);
        assert.equal(String(saved.subcategoryId), staleReferences.subcategoryId);
      }
      assert.equal(f.inventoryCalls.length, fields.stockQuantity === undefined ? 0 : 1);
      assert.equal(Object.hasOwn(f.offerUpdates[0].$set, 'stockQuantity'), false);
      assert.deepEqual(f.transactions, ['start', 'commit']);
    });
  }
}
test('unchanged valid references survive older full forms while reference writes are disabled', async t => {
  const mapping = taxonomy.resolveLabels('Fashion', 'Footwear');
  const f = await fixture(t, { current: { categoryId: mapping.parent.id, subcategoryId: mapping.child.id } });
  assert.equal((await f.request({ category: 'Fashion', subcategory: 'Footwear', price: 2 })).status, 200);
  assert.equal(String(f.saved[0].categoryId), mapping.parent.id); assert.equal(String(f.saved[0].subcategoryId), mapping.child.id);
});
test('ambiguous duplicate child labels and contradictory legacy text are never guessed', async t => {
  const f = await fixture(t, { referencesReady: true, current: { ...staleReferences,
    category: 'Legacy toys', subcategory: 'Educational Toys' } });
  assert.equal((await f.request({ description: 'Edited' })).status, 200);
  assert.equal(f.saved[0].category, 'Legacy toys'); assert.equal(f.saved[0].subcategory, 'Educational Toys');
  assert.equal(String(f.saved[0].categoryId), staleReferences.categoryId);
});
test('stale medicine reference evidence survives reconciliation and older unchanged form submissions', async t => {
  const medicine = taxonomy.resolveLabels('Cosmetics & Beauty', 'Medicine');
  const f = await fixture(t, { referencesReady: true, role: 'pharmacist',
    current: { categoryId: medicine.parent.id, subcategoryId: medicine.child.id } });
  assert.equal((await f.request({ category: 'Fashion', subcategory: 'Footwear', description: 'Edited' })).status, 200);
  assert.equal(String(f.saved[0].subcategoryId), medicine.child.id);
  assert.equal(policy.isMedicineProduct(f.saved[0]), true);
  assert.equal(f.saved[0].moderationStatus, 'pending'); assert.equal(f.saved[0].isActive, false);
});
test('stale food references cannot be erased by unrelated edits', async t => {
  const food = taxonomy.resolveLabels('Restaurant', 'Meals');
  const f = await fixture(t, { referencesReady: true, current: { categoryId: food.parent.id,
    subcategoryId: food.child.id, restaurantName: 'Fixture kitchen', orderStartTime: '10:00', orderEndTime: '18:00' } });
  assert.equal((await f.request({ price: 2 })).status, 200);
  assert.equal(String(f.saved[0].subcategoryId), food.child.id);
  assert.equal(f.saved[0].moderationStatus, 'pending'); assert.equal(f.saved[0].restaurantName, 'Fixture kitchen');
  assert.equal(f.saved[0].orderStartTime, '10:00'); assert.equal(f.saved[0].orderEndTime, '18:00');
});
for (const vendorStatus of ['none', 'sent', 'received', 'reviewing', 'rejected', 'suspended']) {
  for (const method of ['PUT', 'POST']) test(`actual ${vendorStatus} vendor ${method} is rejected before persistence`, async t => {
    const f = await fixture(t, { vendorStatus });
    const result = await f.request(method === 'PUT' ? { description: 'Edited' } : { category: 'Fashion', subcategory: 'Footwear' }, method);
    assert.equal(result.status, 403); assert.equal(f.saved.length, 0); assert.equal(f.uploads.length, 0);
    assert.equal(f.inventoryCalls.length, 0);
  });
}
test('a vendor with an admin role string but no admin flag cannot bypass pending approval', async t => {
  const f = await fixture(t, { role: 'admin', vendorStatus: 'reviewing', isAdmin: false });
  assert.equal((await f.request({ description: 'Edited' })).status, 403);
  assert.equal(f.saved.length, 0);
});
test('authorized admin updates preserve access even without vendor approval', async t => {
  const f = await fixture(t, { role: 'admin', isAdmin: true, isVendor: false, vendorStatus: 'none' });
  assert.equal((await f.request({ description: 'Edited' })).status, 200);
  assert.equal(f.saved.length, 1);
});
for (const pharmacistStatus of ['received', 'reviewing', 'rejected', 'suspended']) test(`pharmacist role cannot override ${pharmacistStatus} pharmacist status`, async t => {
  const f = await fixture(t, { role: 'pharmacist', pharmacistStatus, current: medicineState });
  assert.equal((await f.request({ description: 'Edited' })).status, 403); assert.equal(f.saved.length, 0);
});
test('medicine access fields on an ordinary category cannot bypass pharmacist creation checks', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ category: 'Fashion', subcategory: 'Footwear', requiresPrescription: 'true' }, 'POST')).status, 403);
  assert.equal(f.saved.length, 0); assert.equal(f.uploads.length, 0);
});
test('new medicine fields on an ordinary partial edit require an eligible pharmacist', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ requiresPrescription: 'true' })).status, 403);
  assert.equal(f.saved.length, 0); assert.equal(f.uploads.length, 0);
});
test('approved pharmacist adding medicine flags to a legacy product enters review', async t => {
  const f = await fixture(t, { role: 'pharmacist', pharmacistStatus: 'approved' });
  assert.equal((await f.request({ requiresPrescription: 'true' })).status, 200);
  assert.equal(f.saved[0].requiresPrescription, true);
  assert.equal(f.saved[0].moderationStatus, 'pending'); assert.equal(f.saved[0].isActive, false);
});
test('vendor cannot erase the only saved medicine evidence by explicitly clearing flags', async t => {
  const f = await fixture(t, { role: 'pharmacist', current: { category: 'Legacy', subcategory: '', requiresPrescription: true } });
  assert.equal((await f.request({ requiresPrescription: false, medicineAccess: '' })).status, 400);
  assert.equal(f.saved.length, 0);
});
test('vendor cannot erase an existing food classification through a new ordinary category', async t => {
  const f = await fixture(t, { current: { category: 'Restaurant', subcategory: 'Meals', restaurantName: 'Fixture kitchen' } });
  assert.equal((await f.request({ category: 'Fashion', subcategory: 'Footwear' })).status, 400);
  assert.equal(f.saved.length, 0);
});
test('blank restaurant names cannot activate a new food classification', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ category: 'Restaurant', subcategory: 'Meals', restaurantName: '   ' })).status, 400);
  assert.equal(f.saved.length, 0);
});
for (const [fields, status] of [[{ stockQuantity: -1 }, 400], [{ stockQuantity: 1 }, 409],
  [{ stockQuantity: 5, inventoryRevision: 1 }, 409]]) test(`stock failure ${JSON.stringify(fields)} aborts without saving`, async t => {
  const f = await fixture(t, { current: { stockQuantity: 4, reservedStockQuantity: 2, inventoryRevision: 2 } });
  assert.equal((await f.request(fields)).status, status); assert.equal(f.saved.length, 0);
  assert.deepEqual(f.transactions, ['start', 'abort']);
});
