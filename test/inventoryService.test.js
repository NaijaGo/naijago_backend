const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const inventory = require('../services/inventoryService');
const Product = require('../models/Product');
const ProductOffer = require('../models/ProductOffer');
const InventoryOperation = require('../models/InventoryOperation');
const DeliveryReservation = require('../models/DeliveryReservation');
const MainOrder = require('../models/MainOrder');

const id = () => new mongoose.Types.ObjectId();
const productValues = (stock = 10) => ({ name: 'Inventory fixture', description: 'Test only',
  price: 100, category: 'test', stockQuantity: stock, sellerType: 'naijago',
  productStatus: 'active', moderationStatus: 'approved' });

test('missing reserved counters mean zero; balances and quantities must be valid', () => {
  assert.equal(inventory.getAvailableQuantity({ stockQuantity: 10 }), 10);
  assert.equal(inventory.getAvailableQuantity({ stockQuantity: 10, reservedStockQuantity: 3 }), 7);
  assert.throws(() => inventory.getAvailableQuantity({ stockQuantity: 2, reservedStockQuantity: 3 }));
  for (const quantity of [0, -1, 1.5, NaN, Infinity, '3']) {
    assert.throws(() => inventory.assertAvailable({ stockQuantity: 10 }, quantity));
  }
  assert.throws(() => inventory.assertAvailable({ stockQuantity: 10, reservedStockQuantity: 3 }, 8),
    { code: 'INSUFFICIENT_INVENTORY' });
});

test('identities are canonical and duplicate aggregate allocations are merged', () => {
  const product = id(); const offer = id();
  const result = inventory.normalizeAllocations([{ product, offer, quantity: 2 },
    { product: String(product).toUpperCase(), offer, quantity: 1 }]);
  assert.deepEqual(result, [{ product: String(product), offer: String(offer), quantity: 3 }]);
  assert.throws(() => inventory.normalizeAllocations([{ product: 'bad', quantity: 1 }]));
});

test('variant and size reservations fail closed; immediate aggregate identity is preserved', () => {
  for (const selection of [{ variantId: id() }, { selectedSize: 'M' }, { selectedSize: { size: 'M' } }]) {
    assert.throws(() => inventory.normalizeAllocations([{ product: id(), quantity: 1, ...selection }], { hold: true }),
      { code: 'UNSUPPORTED_INVENTORY_VARIANT' });
    assert.equal(inventory.normalizeAllocations([{ product: id(), quantity: 1, ...selection }]).length, 1);
  }
});

test('writes require an active transaction', async () => {
  assert.throws(() => inventory.requireTransaction(null), { code: 'INVENTORY_TRANSACTION_REQUIRED' });
  assert.throws(() => inventory.requireTransaction({ inTransaction: () => false }));
  await assert.rejects(inventory.immediateSale({ allocations: [{ product: id(), quantity: 1 }],
    order: id(), businessKey: 'sale:test' }), { code: 'INVENTORY_TRANSACTION_REQUIRED' });
});

test('Product and ProductOffer validation reject stock below reserved balances', async () => {
  const product = new Product({ ...productValues(2), reservedStockQuantity: 3 });
  const offer = new ProductOffer({ product: id(), price: 100, stockQuantity: 2, reservedStockQuantity: 3 });
  await assert.rejects(product.validate(), /below reserved stock/);
  await assert.rejects(offer.validate(), /below reserved stock/);
  await assert.rejects(new Product({ ...productValues(10), productStatus: 'out_of_stock', reservedStockQuantity: 1 }).validate());
});

test('scheduling adapter remains unconnected', () => {
  const reservations = require('../services/deliveryReservationService');
  assert.throws(() => reservations.createReservationService().assertInventoryCoordination(),
    { code: 'INVENTORY_COORDINATION_REQUIRED' });
  assert.equal(require('../config/scheduledDelivery').DEFAULTS.scheduledDeliveryEnabled, false);
});

test('receipt schema declares the required unique and lookup indexes', () => {
  const indexes = InventoryOperation.schema.indexes();
  const unique = indexes.find(([key]) => key.businessKey === 1 && Object.keys(key).length === 1);
  assert.equal(unique?.[1].unique, true);
  assert.ok(!unique[1].sparse && !unique[1].partialFilterExpression);
  assert.ok(indexes.some(([key]) => key.reservation === 1 && key.type === 1));
  assert.ok(indexes.some(([key]) => key.order === 1 && key.type === 1));
});

test('every inventory mutation refuses a missing transaction before database writes', async () => {
  const allocations = [{ product: id(), quantity: 1 }]; const order = id();
  const options = { allocations, order, businessKey: 'transaction-required' };
  for (const invoke of [
    () => inventory.reserve(options), () => inventory.immediateSale(options),
    () => inventory.confirmReservation({ reservation: id() }),
    () => inventory.releaseReservation({ reservation: id() }), () => inventory.restock(options),
    () => inventory.adjustStock({ product: allocations[0].product, stockQuantity: 1,
      expectedRevision: 0, businessKey: options.businessKey }),
    () => inventory.initializeOffer({ product: allocations[0].product, values: {} }),
  ]) await assert.rejects(invoke(), { code: 'INVENTORY_TRANSACTION_REQUIRED' });
});

// Opt-in only. A random database name is supplied regardless of the URI's name.
// Never use MONGO_URI automatically. No existing database is cleared or migrated.
test('transactional inventory integration and concurrency', {
  skip: !process.env.INVENTORY_TEST_MONGO_URI,
}, async (context) => {
  const database = `naijago_inventory_test_${Date.now()}_${id()}`;
  await mongoose.connect(process.env.INVENTORY_TEST_MONGO_URI, { dbName: database });
  let transactionCapable = false;
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.ok(hello.setName || hello.msg === 'isdbgrid', 'Tests require a replica set or mongos');
    transactionCapable = true;
    await Promise.all([Product, ProductOffer, InventoryOperation, DeliveryReservation, MainOrder].map((model) => model.init()));
    async function transaction(operation) {
      const session = await mongoose.startSession();
      try { return await session.withTransaction(() => operation(session)); }
      finally { await session.endSession(); }
    }
    async function fixture(stock = 10, offerStock = stock, quantity = 3) {
      const product = await Product.create(productValues(stock));
      const offer = await ProductOffer.create({ product: product._id, price: 100, stockQuantity: offerStock, status: 'active' });
      const user = id(); const reservationId = id(); const window = id();
      const key = `fixture-${reservationId}`;
      const allocations = [{ product: product._id, offer: offer._id, quantity }];
      await DeliveryReservation.create({ _id: reservationId, user, window, inventoryAllocations: allocations,
        idempotencyKey: key, requestHash: key, expiresAt: new Date(Date.now() + 600000) });
      return { product, offer, user, window, reservationId, allocations, key,
        hold: (session) => inventory.reserve({ allocations, businessKey: `${user}:${key}`, session }) };
    }
    async function balances(fixture) {
      return Promise.all([Product.findById(fixture.product._id).lean(), ProductOffer.findById(fixture.offer._id).lean()]);
    }
    function assertOutcome(results, successes = 1) {
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, successes);
      for (const result of results.filter((entry) => entry.status === 'rejected')) {
        assert.ok(['INSUFFICIENT_INVENTORY', 'INVENTORY_ADJUSTMENT_CONFLICT', 'INVENTORY_OPERATION_CONFLICT',
          'INVENTORY_RECONCILIATION_REQUIRED'].includes(result.reason?.code) || result.reason?.code === 11000,
        `Unexpected concurrency failure: ${result.reason?.code || result.reason?.name}`);
      }
    }
    async function paidOrder(fixture) {
      const now = Date.now();
      const order = await MainOrder.create({ user: fixture.user, paymentMethod: 'Wallet', isPaid: true,
        shippingAddress: { address: 'Test', city: 'Test', postalCode: '000000', country: 'NG' },
        userLocation: { latitude: 9, longitude: 7 }, schedule: {
          mode: 'scheduled', window: fixture.window, reservation: fixture.reservationId,
          startAt: new Date(now + 3600000), endAt: new Date(now + 7200000),
          preparationAt: new Date(now), preparationDeadline: new Date(now + 600000),
          dispatchAt: new Date(now + 1200000), dispatchDeadline: new Date(now + 5400000), state: 'reserved',
        } });
      await DeliveryReservation.updateOne({ _id: fixture.reservationId }, { $set: { order: order._id } });
      return order;
    }

    await context.test('test database has all required receipt indexes', async () => {
      const indexes = await InventoryOperation.collection.indexes();
      const unique = indexes.find((index) => index.key.businessKey === 1 && Object.keys(index.key).length === 1);
      assert.equal(unique?.unique, true);
      assert.ok(!unique.sparse && !unique.partialFilterExpression);
      assert.ok(indexes.some((index) => index.key.reservation === 1 && index.key.type === 1));
      assert.ok(indexes.some((index) => index.key.order === 1 && index.key.type === 1));
    });

    await context.test('duplicate hold replays its receipt; changed hold arguments fail without mutation', async () => {
      const f = await fixture(); const first = await transaction(f.hold); const second = await transaction(f.hold);
      assert.equal(String(first._id), String(second._id));
      const businessKey = `${f.user}:${f.key}`;
      await assert.rejects(transaction((session) => inventory.reserve({ businessKey, session,
        allocations: [{ ...f.allocations[0], quantity: 4 }] })), { code: 'INVENTORY_OPERATION_CONFLICT' });
      const another = await fixture();
      await assert.rejects(transaction((session) => inventory.reserve({ businessKey, session,
        allocations: another.allocations })), { code: 'INVENTORY_OPERATION_CONFLICT' });
      for (const balance of await balances(f)) assert.deepEqual([balance.stockQuantity, balance.reservedStockQuantity], [10, 3]);
      for (const balance of await balances(another)) assert.deepEqual([balance.stockQuantity, balance.reservedStockQuantity], [10, 0]);
      assert.equal(await InventoryOperation.countDocuments({ businessKey: `hold:${businessKey}` }), 1);
    });

    await context.test('failure after completed inventory mutation rolls back both balances and receipt', async () => {
      const f = await fixture(); const order = id(); const key = `abort-after-sale:${id()}`;
      await assert.rejects(transaction(async (session) => {
        await inventory.immediateSale({ allocations: f.allocations, order, businessKey: key, session });
        throw new Error('Forced failure before transaction commit');
      }), /Forced failure before transaction commit/);
      for (const balance of await balances(f)) assert.deepEqual([balance.stockQuantity, balance.reservedStockQuantity], [10, 0]);
      assert.equal((await balances(f))[0].salesCount, 0);
      assert.equal(await InventoryOperation.countDocuments({ businessKey: key }), 0);
    });

    await context.test('hold available stock and reject above available', async () => {
      const f = await fixture(); await transaction(f.hold);
      for (const balance of await balances(f)) assert.deepEqual([balance.stockQuantity, balance.reservedStockQuantity], [10, 3]);
      await assert.rejects(transaction((session) => inventory.reserve({ allocations: [{ ...f.allocations[0], quantity: 8 }],
        businessKey: `too-large:${id()}`, session })), { code: 'INSUFFICIENT_INVENTORY' });
    });
    await context.test('two concurrent holds cannot consume the final units twice', async () => {
      const f = await fixture(1, 1, 1);
      const keys = [`concurrent:${id()}`, `concurrent:${id()}`];
      const results = await Promise.allSettled(keys.map((businessKey) => transaction((session) => inventory.reserve({
        allocations: f.allocations, businessKey, session }))));
      assertOutcome(results);
      for (const balance of await balances(f)) {
        assert.deepEqual([balance.stockQuantity, balance.reservedStockQuantity], [1, 1]);
        assert.equal(inventory.getAvailableQuantity(balance), 0);
      }
    });
    await context.test('release preserves stock and duplicate release is harmless', async () => {
      const f = await fixture(); await transaction(f.hold);
      for (let i = 0; i < 2; i++) await transaction((session) => inventory.releaseReservation({ reservation: f.reservationId, session }));
      for (const balance of await balances(f)) assert.deepEqual([balance.stockQuantity, balance.reservedStockQuantity], [10, 0]);
    });
    await context.test('confirm sells once and cannot subsequently release', async () => {
      const f = await fixture(); await transaction(f.hold); await paidOrder(f);
      for (let i = 0; i < 2; i++) await transaction((session) => inventory.confirmReservation({ reservation: f.reservationId, session }));
      for (const balance of await balances(f)) assert.deepEqual([balance.stockQuantity, balance.reservedStockQuantity], [7, 0]);
      assert.equal((await balances(f))[0].salesCount, 3);
      await assert.rejects(transaction((session) => inventory.releaseReservation({ reservation: f.reservationId, session })),
        { code: 'INVENTORY_OPERATION_CONFLICT' });
    });
    await context.test('immediate sale respects reserved stock and duplicate settlement', async () => {
      const f = await fixture(); await transaction(f.hold); const order = id(); const key = `sale:${order}`;
      await assert.rejects(transaction((session) => inventory.immediateSale({ allocations: [{ ...f.allocations[0], quantity: 8 }],
        order, businessKey: key, session })), { code: 'INSUFFICIENT_INVENTORY' });
      for (let i = 0; i < 2; i++) await transaction((session) => inventory.immediateSale({ allocations: [{ ...f.allocations[0], quantity: 7 }],
        order, businessKey: key, session }));
      for (const balance of await balances(f)) assert.deepEqual([balance.stockQuantity, balance.reservedStockQuantity], [3, 3]);
    });
    await context.test('adjustment below holds rejected; valid adjustment preserves holds', async () => {
      const f = await fixture(10, 10, 4); await transaction(f.hold);
      for (const quantity of [3, 10]) {
        const [product, offer] = await balances(f);
        const operation = () => transaction((session) => inventory.adjustStock({ product: product._id, offer: offer._id,
          stockQuantity: quantity, expectedRevision: product.inventoryRevision, expectedOfferRevision: offer.inventoryRevision,
          businessKey: `adjust:${id()}`, session }));
        if (quantity === 3) await assert.rejects(operation(), { code: 'INVENTORY_ADJUSTMENT_CONFLICT' });
        else await operation();
      }
      for (const balance of await balances(f)) assert.deepEqual([balance.stockQuantity, balance.reservedStockQuantity], [10, 4]);
    });
    await context.test('offer failure rolls back Product and receipt', async () => {
      const f = await fixture(10, 2); const key = `rollback:${id()}`;
      await assert.rejects(transaction((session) => inventory.immediateSale({ allocations: f.allocations,
        order: id(), businessKey: key, session })), { code: 'INSUFFICIENT_INVENTORY' });
      assert.equal((await balances(f))[0].stockQuantity, 10);
      assert.equal((await balances(f))[1].stockQuantity, 2);
      assert.equal(await InventoryOperation.countDocuments({ businessKey: key }), 0);
    });
    await context.test('hold racing immediate sale cannot oversell', async () => {
      const f = await fixture(1, 1, 1); const order = id(); const key = `race-sale:${id()}`;
      const results = await Promise.allSettled([transaction(f.hold), transaction((session) => inventory.immediateSale({
        allocations: f.allocations, order, businessKey: key, session }))]);
      assertOutcome(results);
      for (const balance of await balances(f)) assert.ok(inventory.getAvailableQuantity(balance) >= 0);
    });
    await context.test('hold racing adjustment preserves invariant', async () => {
      const f = await fixture(); const key = `race-adjust:${id()}`;
      const results = await Promise.allSettled([transaction(f.hold), transaction((session) => inventory.adjustStock({ product: f.product._id,
        offer: f.offer._id, stockQuantity: 2, expectedRevision: 0, expectedOfferRevision: 0,
        businessKey: key, session }))]);
      assertOutcome(results);
      for (const balance of await balances(f)) assert.ok(inventory.getAvailableQuantity(balance) >= 0);
    });
    await context.test('stale metadata saves do not replace settled Product or offer stock', async () => {
      const f = await fixture(); const stale = await Product.findById(f.product._id);
      const order = id(); const key = `metadata-sale:${id()}`;
      await transaction((session) => inventory.immediateSale({ allocations: [{ ...f.allocations[0], quantity: 4 }],
        order, businessKey: key, session }));
      await transaction(async (session) => {
        stale.description = 'Metadata changed after a concurrent sale';
        await stale.save({ session });
        // The catalog route's offer metadata whitelist deliberately excludes stock.
        await ProductOffer.updateOne({ _id: f.offer._id }, { $set: { price: stale.price, status: stale.productStatus } }, { session });
      });
      for (const balance of await balances(f)) assert.deepEqual([balance.stockQuantity, balance.reservedStockQuantity], [6, 0]);
    });
    await context.test('catalog-style adjustment and metadata save retain held balances', async () => {
      const f = await fixture(); await transaction(f.hold); const key = `catalog-adjust:${id()}`;
      await transaction(async (session) => {
        const product = await Product.findById(f.product._id).session(session);
        const offer = await ProductOffer.findById(f.offer._id).session(session);
        product.stockQuantity = 5;
        await product.validate();
        await inventory.adjustStock({ product: product._id, offer: offer._id, stockQuantity: product.stockQuantity,
          expectedRevision: product.inventoryRevision, expectedOfferRevision: offer.inventoryRevision,
          businessKey: key, session });
        product.unmarkModified('stockQuantity');
        product.description = 'Explicit adjustment plus metadata';
        await product.save({ session });
      });
      for (const balance of await balances(f)) assert.deepEqual([balance.stockQuantity, balance.reservedStockQuantity], [5, 3]);
    });
    await context.test('concurrent duplicate confirmation applies once', async () => {
      const f = await fixture(); await transaction(f.hold); await paidOrder(f);
      const results = await Promise.allSettled([1, 2].map(() => transaction((session) => inventory.confirmReservation({ reservation: f.reservationId, session }))));
      assert.ok(results.some((result) => result.status === 'fulfilled'));
      assertOutcome(results, results.filter((result) => result.status === 'fulfilled').length);
      for (const balance of await balances(f)) assert.deepEqual([balance.stockQuantity, balance.reservedStockQuantity], [7, 0]);
    });
    await context.test('confirmation racing expiry-style release cannot perform both', async () => {
      const f = await fixture(); await transaction(f.hold); await paidOrder(f);
      const results = await Promise.allSettled([
        transaction((session) => inventory.confirmReservation({ reservation: f.reservationId, session })),
        transaction((session) => inventory.releaseReservation({ reservation: f.reservationId, session })),
      ]);
      assert.equal(results[0].status, 'fulfilled');
      assert.equal(results[1].status, 'rejected');
      for (const balance of await balances(f)) assert.deepEqual([balance.stockQuantity, balance.reservedStockQuantity], [7, 0]);
    });
    await context.test('concurrent duplicate sale and release cannot mutate twice', async () => {
      const f = await fixture(); const order = id(); const key = `duplicate-sale:${order}`;
      const sales = await Promise.allSettled([1, 2].map(() => transaction((session) => inventory.immediateSale({
        allocations: f.allocations, order, businessKey: key, session }))));
      assert.ok(sales.some((result) => result.status === 'fulfilled'));
      assertOutcome(sales, sales.filter((result) => result.status === 'fulfilled').length);
      for (const balance of await balances(f)) assert.equal(balance.stockQuantity, 7);
      await transaction(f.hold);
      const releases = await Promise.allSettled([1, 2].map(() => transaction((session) => inventory.releaseReservation({ reservation: f.reservationId, session }))));
      assert.ok(releases.some((result) => result.status === 'fulfilled'));
      assertOutcome(releases, releases.filter((result) => result.status === 'fulfilled').length);
      for (const balance of await balances(f)) assert.deepEqual([balance.stockQuantity, balance.reservedStockQuantity], [7, 0]);
    });
    await context.test('mismatched offer and changed operation identity fail closed', async () => {
      const first = await fixture(); const second = await fixture();
      await assert.rejects(transaction((session) => inventory.immediateSale({ allocations: [{ product: first.product._id,
        offer: second.offer._id, quantity: 1 }], order: id(), businessKey: `wrong-offer:${id()}`, session })),
        { code: 'INVALID_INVENTORY_OFFER' });
      const order = id(); const key = `changed-key:${order}`;
      await transaction((session) => inventory.immediateSale({ allocations: first.allocations, order, businessKey: key, session }));
      await assert.rejects(transaction((session) => inventory.immediateSale({ allocations: [{ ...first.allocations[0], quantity: 1 }],
        order, businessKey: key, session })), { code: 'INVENTORY_OPERATION_CONFLICT' });
    });
    await context.test('paid hold cannot expire or release', async () => {
      const f = await fixture(); await transaction(f.hold); await paidOrder(f);
      await assert.rejects(transaction((session) => inventory.releaseReservation({ reservation: f.reservationId, session })),
        { code: 'INVENTORY_RECONCILIATION_REQUIRED' });
      for (const balance of await balances(f)) assert.equal(balance.reservedStockQuantity, 3);
    });
    await context.test('variant catalog cannot acquire aggregate holds', async () => {
      const f = await fixture();
      await Product.updateOne({ _id: f.product._id }, { $set: { variants: [{ sku: 'TEST-VARIANT', stockQuantity: 10 }] } });
      await assert.rejects(transaction(f.hold), { code: 'UNSUPPORTED_INVENTORY_VARIANT' });
    });
    await context.test('size and offer variant catalogs reject holds but preserve immediate aggregate sales', async () => {
      const sized = await fixture();
      await Product.updateOne({ _id: sized.product._id }, { $set: { 'sizeData.sizes': [{ value: 'M', label: 'Medium' }] } });
      await assert.rejects(transaction(sized.hold), { code: 'UNSUPPORTED_INVENTORY_VARIANT' });
      const variant = await fixture(); const variantId = id();
      await ProductOffer.updateOne({ _id: variant.offer._id }, { $set: { variants: [{ productVariantId: variantId,
        price: 100, stockQuantity: 10 }] } });
      await assert.rejects(transaction(variant.hold), { code: 'UNSUPPORTED_INVENTORY_VARIANT' });
      const order = id(); const key = `variant-immediate:${id()}`;
      await transaction((session) => inventory.immediateSale({ allocations: [{ ...variant.allocations[0], quantity: 2,
        variantId, selectedSize: 'M' }], order, businessKey: key, session }));
      for (const balance of await balances(variant)) assert.deepEqual([balance.stockQuantity, balance.reservedStockQuantity], [8, 0]);
    });
  } finally {
    // Only the randomly named database created by this test is eligible for cleanup.
    if (transactionCapable && mongoose.connection.name === database && database.startsWith('naijago_inventory_test_')) {
      await mongoose.connection.dropDatabase();
    }
    await mongoose.disconnect();
  }
});
