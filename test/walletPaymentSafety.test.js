const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { nairaToKobo } = require('../utils/koraPayment');

// Exercise the actual checked-in route with in-memory dependencies, following
// koraWebhook.test.js. No app bootstrap, MongoDB, HTTP, .env or file writes.
const source = fs.readFileSync(path.join(__dirname, '../routes/orderRoutes.js'), 'utf8');
const start = source.indexOf("router.put('/:id/pay/wallet', protect");
const end = source.indexOf("router.post('/:id/payment-intent'", start);
assert.ok(start >= 0 && end > start, 'wallet route boundaries must exist');
const routeSource = source.slice(start, end);

function fixture({ total = 100.25, balance = 500, owner = 'fixture-buyer',
  requester = 'fixture-buyer', paid = false, orderExists = true, buyerExists = true } = {}) {
  const events = [];
  // Setters detect attempted mutation even if a later path would undo it.
  const state = { isPaid: paid, paidAt: undefined, mainOrderStatus: 'pending_payment', paymentResult: undefined };
  const order = { _id: 'fixture-order', user: owner, totalPrice: total,
    async save(options) { assert.equal(options.session, session); events.push('save-order'); return this; },
    toObject() { return { _id: this._id, user: this.user, totalPrice: this.totalPrice, ...state }; },
  };
  for (const key of Object.keys(state)) Object.defineProperty(order, key, {
    get: () => state[key],
    set(value) { events.push(`mutate-${key}`); state[key] = value; },
  });
  const buyer = { email: 'fixture@example.invalid',
    async save(options) { assert.equal(options.session, session); events.push('save-buyer'); return this; },
  };
  Object.defineProperty(buyer, 'userWalletBalance', {
    get: () => balance,
    set(value) { events.push('mutate-balance'); balance = value; },
  });
  const shipment = { _id: 'fixture-shipment', shipmentStatus: 'awaiting_payment',
    items: [{ product: 'fixture-product', quantity: 1, price: total }],
    async save(options) { assert.equal(options.session, session); events.push('save-shipment'); return this; },
  };
  const session = {
    startTransaction() { events.push('start-transaction'); },
    async abortTransaction() { events.push('abort'); },
    async commitTransaction() { events.push('commit'); },
    endSession() { events.push('end-session'); },
  };
  let handler;
  const protect = () => { throw new Error('fixture invokes the handler after authentication'); };
  const query = (value, event) => ({ async session(valueSession) {
    assert.equal(valueSession, session); events.push(event); return value;
  } });
  const dependencies = {
    router: { put(route, auth, callback) {
      assert.equal(route, '/:id/pay/wallet');
      assert.equal(auth, protect, 'authentication middleware must remain registered');
      handler = callback;
    } },
    protect, nairaToKobo,
    mongoose: { async startSession() { events.push('session'); return session; } },
    MainOrder: { findById(id) { assert.equal(id, order._id); return query(orderExists ? order : null, 'read-order'); } },
    User: { findById(id) { assert.equal(id, requester); return query(buyerExists ? buyer : null, 'read-buyer'); } },
    Shipment: { find(filter) { assert.equal(filter.mainOrder, order._id); return query([shipment], 'read-shipments'); } },
    async consumeSubscriptionDeliveryIfNeeded(options) {
      assert.equal(options.buyer, buyer); assert.equal(options.mainOrder, order);
      assert.equal(options.session, session); events.push('consume-subscription');
    },
    async decrementPaidItemInventory(options) {
      assert.equal(options.session, session); assert.equal(options.item, shipment.items[0]);
      assert.equal(options.orderId, order._id); assert.equal(options.shipmentId, shipment._id);
      assert.equal(options.itemIndex, 0); events.push('inventory');
    },
    notificationService: { async sendToUser(id) {
      assert.equal(id, requester); assert.ok(events.includes('commit')); events.push('notify-buyer');
    } },
    async notifyPaidOrderVendors(options) {
      assert.equal(options.order, order); assert.equal(options.paymentMethod, 'Wallet');
      assert.ok(events.includes('commit')); events.push('notify-vendors');
    },
    async grantReferralRewardForVerifiedUser(id) {
      assert.equal(id, requester); assert.ok(events.includes('commit')); events.push('referral');
    },
    console: { error() { events.push('unexpected-error-log'); } },
  };
  new Function(...Object.keys(dependencies), routeSource)(...Object.values(dependencies));
  async function request() {
    const res = { statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; events.push('respond'); return this; },
    };
    await handler({ params: { id: order._id }, user: { id: requester }, app: {} }, res);
    return res;
  }
  return { request, order, buyer, shipment, events };
}

const invalidTotals = [
  ['negative', -100], ['negative fraction', -0.01], ['zero', 0], ['negative zero', -0],
  ['missing', undefined], ['null', null], ['nonnumeric text', 'invalid'],
  ['numeric string instead of a stored Number', '100.25'], ['NaN', NaN],
  ['positive infinity', Infinity], ['negative infinity', -Infinity],
  ['boolean false', false], ['boolean true', true], ['array', []], ['object', {}],
  ['fractional kobo', 0.001], ['half kobo', 1.005], ['sub-kobo rounded to zero', 1e-9],
  ['unsafe whole-kobo integer', Number.MAX_SAFE_INTEGER],
  ['unsafe cent boundary', 90071992547409.92], ['finite multiplication overflow', Number.MAX_VALUE],
];
for (const [label, total] of invalidTotals) test(`wallet rejects ${label} without mutations or commit`, async () => {
  const f = fixture({ total });
  // Destructuring defaults cannot represent a missing value; remove it explicitly.
  if (total === undefined) delete f.order.totalPrice;
  const beforeBalance = f.buyer.userWalletBalance;
  const beforeTotal = f.order.totalPrice;
  const res = await f.request();
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: 'Invalid order total. Please contact support before paying.' });
  assert.equal(f.buyer.userWalletBalance, beforeBalance);
  assert.equal(f.order.totalPrice, beforeTotal, 'never normalize or recalculate the stored total');
  assert.equal(f.order.isPaid, false);
  assert.equal(f.order.paidAt, undefined);
  assert.equal(f.order.mainOrderStatus, 'pending_payment');
  assert.equal(f.order.paymentResult, undefined);
  assert.equal(f.shipment.shipmentStatus, 'awaiting_payment');
  assert.deepEqual(f.events, ['session', 'start-transaction', 'read-order', 'read-buyer', 'abort', 'end-session', 'respond']);
});

for (const total of [0.01, 0.29, 1.1, 100.25, 500, 10.100000000000001]) {
  test(`valid wallet total ${total} preserves existing settlement and response`, async () => {
    const f = fixture({ total });
    const res = await f.request();
    const expectedBalance = Number((500 - total).toFixed(2));
    assert.equal(res.statusCode, 200);
    assert.equal(f.order.totalPrice, total);
    assert.equal(f.buyer.userWalletBalance, expectedBalance);
    assert.equal(f.order.isPaid, true);
    assert.equal(f.order.mainOrderStatus, 'processing');
    assert.equal(f.shipment.shipmentStatus, 'processing');
    assert.equal(f.order.paymentResult.amount, total);
    assert.equal(f.order.paymentResult.currency, 'NGN');
    assert.equal(f.order.paymentResult.status, 'successful');
    assert.equal(f.order.paymentResult.payment_type, 'Wallet Balance');
    assert.equal(typeof f.order.paidAt, 'number');
    assert.deepEqual(res.body, { ...f.order.toObject(), newBuyerWalletBalance: expectedBalance });
    assert.deepEqual(f.events, ['session', 'start-transaction', 'read-order', 'read-buyer',
      'mutate-balance', 'consume-subscription', 'save-buyer', 'mutate-isPaid', 'mutate-paidAt',
      'mutate-mainOrderStatus', 'mutate-paymentResult', 'read-shipments', 'save-shipment', 'inventory',
      'save-order', 'commit', 'end-session', 'notify-buyer', 'notify-vendors', 'referral', 'respond']);
  });
}

test('insufficient wallet balance still aborts without changes', async () => {
  const f = fixture({ total: 100.25, balance: 100 });
  const res = await f.request();
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /^Insufficient wallet balance\./);
  assert.equal(f.buyer.userWalletBalance, 100);
  assert.equal(f.order.isPaid, false);
  assert.deepEqual(f.events, ['session', 'start-transaction', 'read-order', 'read-buyer', 'abort', 'end-session', 'respond']);
});

test('exact wallet balance can still pay the valid total once', async () => {
  const f = fixture({ total: 100.25, balance: 100.25 });
  assert.equal((await f.request()).statusCode, 200);
  assert.equal(f.buyer.userWalletBalance, 0);
  const beforeRetry = f.events.length;
  const retry = await f.request();
  assert.equal(retry.statusCode, 400);
  assert.equal(retry.body.message, 'Order is already paid');
  assert.equal(f.buyer.userWalletBalance, 0);
  assert.equal(f.events.filter(event => event === 'commit').length, 1);
  assert.deepEqual(f.events.slice(beforeRetry), ['session', 'start-transaction', 'read-order', 'abort', 'end-session', 'respond']);
});

test('another customer remains unauthorized before buyer lookup or mutation', async () => {
  const f = fixture({ requester: 'fixture-other-customer', total: -100 });
  const res = await f.request();
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.message, 'Not authorized to modify this order');
  assert.equal(f.buyer.userWalletBalance, 500);
  assert.equal(f.order.isPaid, false);
  assert.deepEqual(f.events, ['session', 'start-transaction', 'read-order', 'abort', 'end-session', 'respond']);
});

test('missing order retains its existing 404 and closes the session', async () => {
  const f = fixture({ orderExists: false });
  const res = await f.request();
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.message, 'Main Order not found');
  assert.deepEqual(f.events, ['session', 'start-transaction', 'read-order', 'abort', 'end-session', 'respond']);
});

test('missing buyer retains its existing 404 and closes the session', async () => {
  const f = fixture({ buyerExists: false });
  const res = await f.request();
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.message, 'Buyer user account not found.');
  assert.deepEqual(f.events, ['session', 'start-transaction', 'read-order', 'read-buyer', 'abort', 'end-session', 'respond']);
});
