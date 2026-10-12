// Exercise the real inventory service with isolated persistence mocks. These
// assertions verify command/session boundaries, not MongoDB atomic rollback.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Offer = require('../models/ProductOffer');
const Operation = require('../models/InventoryOperation');
const inventory = require('../services/inventoryService');

function fixture(t, { offerConflict = false } = {}) {
  const productId = new mongoose.Types.ObjectId(), offerId = new mongoose.Types.ObjectId();
  const session = { inTransaction: () => true };
  const product = Product.hydrate({ _id: productId, name: 'Fixture', description: 'Fixture',
    category: 'Fashion', subcategory: 'Footwear', categoryId: 'ffffffffffffffffffffffff',
    price: 1, stockQuantity: 10, reservedStockQuantity: 2, inventoryRevision: 3 });
  const offer = { _id: offerId, product: productId, stockQuantity: 10, reservedStockQuantity: 2, inventoryRevision: 4 };
  const receipts = [], updates = [];
  const query = value => ({ session(actual) { assert.equal(actual, session); return Promise.resolve(value); } });
  t.mock.method(mongoose, 'connect', async () => assert.fail('No real database connections.'));
  t.mock.method(Product, 'findById', () => query(product));
  t.mock.method(Offer, 'findOne', filter => { assert.equal(String(filter.product), String(productId)); return query(offer); });
  t.mock.method(Operation.collection, 'indexes', async () => [{ unique: true, key: { businessKey: 1 } }]);
  t.mock.method(Operation, 'findOne', filter => query(receipts.find(row => row.businessKey === filter.businessKey)));
  t.mock.method(Operation, 'create', async (values, options) => {
    assert.equal(options.session, session); receipts.push(...values); return values;
  });
  for (const model of [Product, Offer]) t.mock.method(model, 'findOneAndUpdate', async (filter, update, options) => {
    assert.equal(options.session, session); assert.equal(options.runValidators, true);
    assert.equal(update.$set.stockQuantity, 7); assert.deepEqual(update.$inc, { inventoryRevision: 1 });
    assert.ok(filter.$expr.$and.some(condition => condition.$lte?.[1] === 7));
    updates.push({ model: model.modelName, filter, update });
    return model === Offer && offerConflict ? null : {};
  });
  t.after(() => { assert.equal(mongoose.connect.mock.callCount(), 0); assert.equal(mongoose.connection.readyState, 0); });
  const input = { product: productId, offer: offerId, stockQuantity: 7, expectedRevision: 3,
    expectedOfferRevision: 4, businessKey: 'category-fixture-adjustment', session };
  return { input, product, receipts, updates };
}
test('real stock service accepts legacy stale category references while retaining inventory fences', async t => {
  const f = fixture(t); await inventory.adjustStock(f.input);
  assert.equal(f.updates.length, 2);
  assert.deepEqual(f.updates.map(row => row.filter.$expr.$and[0].$eq[1]), [3, 4]);
  assert.equal(String(f.product.categoryId), 'ffffffffffffffffffffffff');
  assert.equal(f.product.category, 'Fashion'); assert.equal(f.product.subcategory, 'Footwear');
  assert.equal(f.receipts.length, 1);
});
test('real stock service reuses identical receipts and rejects conflicting retry quantities', async t => {
  const f = fixture(t); await inventory.adjustStock(f.input); await inventory.adjustStock(f.input);
  assert.equal(f.updates.length, 2); assert.equal(f.receipts.length, 1);
  await assert.rejects(inventory.adjustStock({ ...f.input, stockQuantity: 8 }), { code: 'INVENTORY_OPERATION_CONFLICT' });
  assert.equal(f.updates.length, 2);
});
test('offer conflict is propagated to the owning transaction; no success is returned', async t => {
  const f = fixture(t, { offerConflict: true });
  await assert.rejects(inventory.adjustStock(f.input), { code: 'INVENTORY_ADJUSTMENT_CONFLICT' });
  assert.equal(f.updates.length, 2);
  // A real rollback still requires a disposable replica-set integration test.
});
