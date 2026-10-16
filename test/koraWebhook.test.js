const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const payment = require('../utils/koraPayment');

// Exercise the checked-in handler with isolated dependencies. This does not
// bootstrap the application, connect MongoDB or contact the payment provider.
const source = fs.readFileSync(path.join(__dirname, '../routes/orderRoutes.js'), 'utf8');
const start = source.indexOf("router.post('/webhooks/korapay'");
const end = source.indexOf('// Historical Squad references', start);
assert.ok(start >= 0 && end > start, 'Kora webhook handler is present');
const routeSource = source.slice(start, end);
const reference = 'NGK_webhook_fixture_reference';
const secretKey = 'sk_test_webhook_fixture_only';

function fixture({configured = true, mismatch = false, verifyError = false, transferError = false} = {}) {
  const events = [];
  const order = {_id: 'fixture-order', user: 'fixture-buyer', totalPrice: 100,
    isPaid: false, paymentResult: {provider: 'korapay', mode: 'test', tx_ref: reference,
      expectedAmountKobo: 10000, expectedCustomerEmail: 'buyer@example.com'},
    save: async () => events.push('save-pending')};
  let handler;
  const dependencies = {
    router: {post: (route, callback) => {assert.equal(route, '/webhooks/korapay'); handler = callback;}},
    getKoraConfig: () => {if (!configured) throw new Error('fixture'); return {secretKey, mode: 'test'};},
    ...payment,
    mongoose: {startSession: async () => {events.push('session'); return {
      withTransaction: async work => {await work(); events.push('commit');},
      endSession: async () => events.push('end-session')};}},
    MainOrder: {findOne: query => ({session: async () => {
      assert.equal(query['paymentResult.tx_ref'], reference);
      assert.equal(query['paymentResult.provider'], 'korapay');
      assert.equal(query.isPaid, false); return order.isPaid ? null : order;
    }})},
    User: {findById: id => ({session: async () => {assert.equal(id, order.user); return {_id: id};}})},
    verifyKoraPayment: async ({transactionRef}) => {
      events.push('verify'); assert.equal(transactionRef, reference);
      if (verifyError) throw new Error('fixture-provider-error');
      return {status: true, data: {reference, status: 'success', amount: mismatch ? 99 : 100,
        currency: 'NGN', customer: {email: 'buyer@example.com'}}};
    },
    settleVerifiedPayment: async options => {
      events.push('settle'); assert.ok(events.includes('verify'));
      assert.equal(options.provider, 'korapay'); assert.equal(options.deferVendorNotifications, true);
      order.isPaid = true; return order;
    },
    notifyPaidOrderVendors: async () => {assert.ok(events.includes('commit')); events.push('notify');},
    grantReferralRewardForVerifiedUser: async () => events.push('referral'),
    reconcileKoraWithdrawal: async ref => {
      assert.equal(ref, reference); events.push('reconcile-payout');
      if (transferError) throw new Error('fixture-payout-error');
    },
    console: {error() {}},
  };
  new Function(...Object.keys(dependencies), routeSource)(...Object.values(dependencies));
  async function request(event = 'charge.success', signed = true) {
    const body = {event, data: {reference, amount: 100, currency: 'NGN'}};
    const headers = signed ? {'x-korapay-signature': crypto.createHmac('sha256', secretKey)
      .update(JSON.stringify(body.data)).digest('hex')} : {};
    const response = {statusCode: 200, status(code) {this.statusCode = code; return this;},
      send(body) {this.body = body; return this;}, sendStatus(code) {this.statusCode = code; return this;}};
    await handler({body, headers, app: {}}, response); return response;
  }
  return {request, events, order};
}

test('webhook rejects unsigned requests before opening a database session', async () => {
  const f = fixture(); assert.equal((await f.request('charge.success', false)).statusCode, 401);
  assert.deepEqual(f.events, []);
});
test('missing Kora configuration returns 503, not a missing-route response', async () => {
  const f = fixture({configured: false}); assert.equal((await f.request()).statusCode, 503);
  assert.deepEqual(f.events, []);
});
test('signed charge is queried before settlement; duplicate delivery does not settle twice', async () => {
  const f = fixture(); assert.equal((await f.request()).statusCode, 200);
  assert.equal((await f.request()).statusCode, 200);
  assert.equal(f.events.filter(event => event === 'settle').length, 1);
  assert.equal(f.events.filter(event => event === 'notify').length, 1);
  assert.ok(f.order.isPaid);
});
test('a signed event with a mismatched provider amount remains unpaid', async () => {
  const f = fixture({mismatch: true}); assert.equal((await f.request()).statusCode, 200);
  assert.equal(f.order.isPaid, false); assert.ok(f.events.includes('save-pending'));
  assert.equal(f.events.includes('settle'), false);
});
test('verification failure asks provider to retry and closes the session', async () => {
  const f = fixture({verifyError: true}); assert.equal((await f.request()).statusCode, 503);
  assert.equal(f.order.isPaid, false); assert.equal(f.events.at(-1), 'end-session');
});
test('unsupported signed event is acknowledged without accessing a database', async () => {
  const f = fixture(); assert.equal((await f.request('unsupported.event')).statusCode, 200);
  assert.deepEqual(f.events, []);
});
test('transfer event uses payout reconciliation without order settlement', async () => {
  const f = fixture(); assert.equal((await f.request('transfer.success')).statusCode, 200);
  assert.deepEqual(f.events, ['reconcile-payout']);
});
test('payout reconciliation failure returns a retryable response', async () => {
  const f = fixture({transferError: true}); assert.equal((await f.request('transfer.failed')).statusCode, 503);
  assert.equal(f.order.isPaid, false);
});
