const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mongoose = require('mongoose');
const Shipment = require('../models/Shipment');
const MainOrder = require('../models/MainOrder');
const Product = require('../models/Product');
const ProductOffer = require('../models/ProductOffer');
const Operation = require('../models/InventoryOperation');
const inventory = require('../services/inventoryService');
const { inventorySaleBusinessKey } = require('../utils/orderInventoryIdentity');
const id = () => new mongoose.Types.ObjectId();
const item = product => ({ product, name: 'Local fixture', image: 'fixture.png', quantity: 1, price: 200 });

test('actual shipment item shape without _id has a stable identity after hydration', () => {
  const shipment = new Shipment({ mainOrder: id(), items: [item(id()), item(id())] });
  const persisted = shipment.toObject();
  assert.equal(persisted.items[0]._id, undefined);
  const reloaded = Shipment.hydrate(persisted);
  const key = (doc, index) => inventorySaleBusinessKey({ item: doc.items[index], orderId: doc.mainOrder, shipmentId: doc._id, itemIndex: index });
  assert.equal(key(shipment, 0), key(reloaded, 0));
  assert.notEqual(key(reloaded, 0), key(reloaded, 1));
});

test('existing item IDs retain their original receipt key', () => {
  const orderId = id(), shipmentId = id(), itemId = id();
  assert.equal(inventorySaleBusinessKey({ item: { _id: itemId }, orderId, shipmentId, itemIndex: 0 }), `sale:${orderId}:${shipmentId}:${itemId}`);
});

test('missing or invalid inventory context still fails closed', () => {
  const valid = { item: {}, orderId: id(), shipmentId: id(), itemIndex: 0 };
  for (const values of [{ item: null }, { orderId: 'bad' }, { shipmentId: 'bad' },
    { itemIndex: undefined }, { itemIndex: -1 }, { itemIndex: 0.5 }, { itemIndex: NaN }, { item: { _id: 'bad' } }]) {
    assert.throws(() => inventorySaleBusinessKey({ ...valid, ...values }), { statusCode: 409 });
  }
});

// Run the actual shared settlement functions from orderRoutes against real models.
// This tests post-verification settlement, not a live Squad charge or webhook.
function settlement() {
  const source = fs.readFileSync(path.join(__dirname, '../routes/orderRoutes.js'), 'utf8');
  const start = source.indexOf('async function consumeSubscriptionDeliveryIfNeeded(');
  const end = source.indexOf('// Category-based commission rates', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`${source.slice(start, end)}\nsettleVerifiedPayment;`, {
    Shipment, inventory, inventorySaleBusinessKey,
    notifyVendorOfPaidShipment: () => { throw new Error('Provider notifications are deferred in this settlement check'); },
  });
}

test('real MongoDB legacy-item settlement, duplicate receipt and rollback', { skip: !process.env.INVENTORY_TEST_MONGO_URI }, async t => {
  const database = `naijago_payment_fix_test_${Date.now()}_${id()}`;
  await mongoose.connect(process.env.INVENTORY_TEST_MONGO_URI, { dbName: database });
  let verified = false;
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.ok(hello.setName || hello.msg === 'isdbgrid', 'Replica set or mongos required');
    verified = true;
    await Promise.all([Product, ProductOffer, MainOrder, Shipment, Operation].map(model => model.init()));
    const settle = settlement();
    async function transaction(work) {
      const session = await mongoose.startSession();
      try { return await session.withTransaction(() => work(session)); }
      finally { await session.endSession(); }
    }
    async function fixture(stock = 5) {
      const product = await Product.create({ name: 'Payment fixture', description: 'Local test only', price: 200, category: 'test', stockQuantity: stock,
        sellerType: 'naijago', productStatus: 'active', moderationStatus: 'approved' });
      const offer = await ProductOffer.create({ product: product._id, price: 200, stockQuantity: stock, sellerType: 'naijago', status: 'active' });
      const order = await MainOrder.create({ user: id(), shippingAddress: { address: 'Local test', city: 'Test', country: 'Nigeria' },
        userLocation: { latitude: 9, longitude: 7 }, totalPrice: 200, paymentMethod: 'Card', mainOrderStatus: 'pending_payment', isPaid: false,
        paymentResult: { provider: 'squad', tx_ref: `NGS_fixture_${id()}`, status: 'initiated' } });
      const shipment = await Shipment.create({ mainOrder: order._id, sellerType: 'naijago', items: [{ ...item(product._id), offer: offer._id }] });
      return { product, offer, order, shipment };
    }
    async function confirm(f, session) {
      const order = await MainOrder.findById(f.order._id).session(session);
      return settle({ order, buyer: {}, verifiedTx: { id: order.paymentResult.tx_ref, tx_ref: order.paymentResult.tx_ref,
        status: 'successful', amount: 200, currency: 'NGN' }, session, app: {}, provider: 'squad', method: 'local_post_verification_check', deferVendorNotifications: true });
    }
    await t.test('successful legacy settlement commits stock and paid order together', async () => {
      const f = await fixture();
      assert.equal(f.shipment.items[0]._id, undefined);
      await transaction(session => confirm(f, session));
      assert.equal((await MainOrder.findById(f.order._id)).isPaid, true);
      assert.equal((await Product.findById(f.product._id)).stockQuantity, 4);
      assert.equal((await ProductOffer.findById(f.offer._id)).stockQuantity, 4);
      assert.equal(await Operation.countDocuments({ order: f.order._id }), 1);
      await transaction(session => confirm(f, session));
      assert.equal((await Product.findById(f.product._id)).stockQuantity, 4);
      assert.equal(await Operation.countDocuments({ order: f.order._id }), 1);
    });
    await t.test('concurrent duplicate settlement never deducts twice', async () => {
      const f = await fixture();
      await Promise.all([1, 2].map(() => transaction(session => confirm(f, session))));
      assert.equal((await Product.findById(f.product._id)).stockQuantity, 4);
      assert.equal((await ProductOffer.findById(f.offer._id)).stockQuantity, 4);
      assert.equal(await Operation.countDocuments({ order: f.order._id }), 1);
    });
    await t.test('failure after settlement rolls back paid state, both balances and receipt', async () => {
      const f = await fixture();
      await assert.rejects(transaction(async session => { await confirm(f, session); throw new Error('forced rollback'); }), /forced rollback/);
      assert.equal((await MainOrder.findById(f.order._id)).isPaid, false);
      assert.equal((await Product.findById(f.product._id)).stockQuantity, 5);
      assert.equal((await ProductOffer.findById(f.offer._id)).stockQuantity, 5);
      assert.equal(await Operation.countDocuments({ order: f.order._id }), 0);
    });
    await t.test('insufficient stock rejects settlement without marking paid', async () => {
      const f = await fixture(0);
      await assert.rejects(transaction(session => confirm(f, session)), { code: 'INSUFFICIENT_INVENTORY' });
      assert.equal((await MainOrder.findById(f.order._id)).isPaid, false);
      assert.equal(await Operation.countDocuments({ order: f.order._id }), 0);
    });
  } finally {
    if (verified && mongoose.connection.name === database && database.startsWith('naijago_payment_fix_test_')) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
