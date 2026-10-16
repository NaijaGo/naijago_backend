const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {loadWithFixtures, memoryModel, withKoraEnvironment} = require('./helpers/koraFixtures.cjs');
function fixture(paymentResult, {rejectProvider = false, wait = false, initialize} = {}) {
  const order = {_id: 'fixture-order', totalPrice: 100.25, isPaid: false, paymentResult};
  const MainOrder = memoryModel([order], []);
  const calls = []; let release;
  const provider = {getKoraCheckoutConfig: () => ({mode: 'test'}),
    validCheckoutUrl: value => value === 'https://checkout.korapay.com/fixture/pay',
    initiateKoraPayment: async args => {
      calls.push(args);
      assert.equal(order.paymentResult.tx_ref, args.transactionRef, 'reference must be persisted before provider use');
      if (initialize) return initialize(args);
      if (wait) await new Promise(resolve => {release = resolve;});
      if (rejectProvider) throw new Error('fixture timeout');
      return {mode: 'test', data: {reference: args.transactionRef, checkout_url: 'https://checkout.korapay.com/fixture/pay'}};
    }};
  const service = loadWithFixtures('services/koraCheckoutService.js', {'node:crypto': crypto,
    '../models/MainOrder': MainOrder, './koraPaymentService': provider, '../utils/koraPayment': require('../utils/koraPayment')});
  return {order, calls, service, release: () => release(), buyer: {email: 'buyer@example.com', firstName: 'Local', lastName: 'Fixture'}};
}
const prepare = item => item.service.prepareKoraCheckout({order: item.order, buyer: item.buyer});
test('checkout reserves a reference before initialization and reuses the resulting URL', async () => {
  const item = fixture(); const first = await prepare(item), second = await prepare(item);
  assert.equal(first.tx_ref, second.tx_ref); assert.equal(first.amount, 100.25); assert.equal(first.amount_kobo, 10025);
  assert.match(first.tx_ref, /^NGK[a-f\d]{32}$/);
  assert.equal(first.tx_ref.length, 35);
  assert.equal(item.calls.length, 1); assert.equal(first.provider, 'korapay');
});

test('different orders receive distinct compact references with 128 random bits', async () => {
  const references = new Set();
  for (let attempt = 0; attempt < 100; attempt++) {
    const item = fixture();
    item.order._id = crypto.randomBytes(12).toString('hex');
    const result = await prepare(item);
    assert.match(result.tx_ref, /^NGK[a-f\d]{32}$/);
    assert.equal(result.tx_ref.includes(item.order._id), false);
    references.add(result.tx_ref);
  }
  assert.equal(references.size, 100);
});

test('real initialization payload uses the exact compact reference already reserved on the order', async () => withKoraEnvironment(async () => {
  const gateway = require('../services/koraPaymentService');
  let sent;
  const item = fixture(undefined, {initialize: args => gateway.initiateKoraPayment({...args, httpClient: {
    post: async (url, payload) => {
      assert.equal(url, 'https://api.korapay.com/merchant/api/v1/charges/initialize');
      assert.equal(payload.reference, item.order.paymentResult.tx_ref);
      assert.match(payload.reference, /^NGK[a-f\d]{32}$/);
      assert.equal(payload.amount, 100.25);
      assert.equal(payload.metadata['order-id'], item.order._id);
      sent = payload.reference;
      return {data: {status: true, data: {reference: sent, checkout_url: 'https://checkout.korapay.com/fixture/pay'}}};
    },
  }})});
  item.order._id = 'a'.repeat(24);
  const result = await prepare(item);
  assert.equal(result.tx_ref, sent);
  assert.equal(item.order.paymentResult.tx_ref, sent);
}));

test('a historical Kora reference and existing checkout URL remain usable without rewriting', async () => {
  const reference = `NGK_${'a'.repeat(24)}_${'b'.repeat(24)}`;
  const item = fixture({provider: 'korapay', tx_ref: reference, mode: 'test', expectedAmountKobo: 10025,
    checkoutUrl: 'https://checkout.korapay.com/fixture/pay'});
  const result = await prepare(item);
  assert.equal(result.tx_ref, reference);
  assert.equal(item.order.paymentResult.tx_ref, reference);
  assert.equal(item.calls.length, 0);
});

test('a rejected historical Kora reference is retained for reconciliation, never silently replaced', async () => {
  const reference = `NGK_${'a'.repeat(24)}_${'b'.repeat(24)}`;
  const item = fixture({provider: 'korapay', tx_ref: reference, mode: 'test', expectedAmountKobo: 10025}, {rejectProvider: true});
  await assert.rejects(prepare(item), /fixture timeout/);
  assert.equal(item.order.paymentResult.tx_ref, reference);
  assert.equal(item.calls[0].transactionRef, reference);
});
test('historical provider references are never overwritten or sent to Kora', async () => {
  for (const provider of ['squad', 'flutterwave', undefined]) {
    const item = fixture({provider, tx_ref: 'historic-reference'});
    await assert.rejects(prepare(item), /existing payment/);
    assert.equal(item.order.paymentResult.tx_ref, 'historic-reference'); assert.equal(item.calls.length, 0);
  }
});
test('mismatched mode or stored order total stops checkout', async () => {
  for (const change of [{mode: 'live'}, {expectedAmountKobo: 9999}]) {
    const item = fixture({provider: 'korapay', tx_ref: 'NGK_fixture_reference', mode: 'test', expectedAmountKobo: 10025, ...change});
    await assert.rejects(prepare(item), /settings or the order total changed/); assert.equal(item.calls.length, 0);
  }
});
test('timeout keeps one original reference rather than creating a replacement charge', async () => {
  const item = fixture(undefined, {rejectProvider: true});
  await assert.rejects(prepare(item), /fixture timeout/); const reference = item.order.paymentResult.tx_ref;
  await assert.rejects(prepare(item), /fixture timeout/);
  assert.equal(item.calls.length, 2); assert.equal(item.calls[0].transactionRef, reference);
  assert.equal(item.calls[1].transactionRef, reference); assert.equal(item.order.paymentResult.tx_ref, reference);
});
test('concurrent initialization is guarded by one persisted checkout lease', async () => {
  const item = fixture(undefined, {wait: true});
  const first = prepare(item);
  for (let attempt = 0; attempt < 10 && !item.calls.length; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(item.calls.length, 1);
  await assert.rejects(prepare(item), /being prepared/);
  item.release(); await first; assert.equal(item.calls.length, 1);
});
