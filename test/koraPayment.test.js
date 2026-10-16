const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {nairaToKobo, normalizeKoraTransaction, koraPaymentMatchesOrder, verifyKoraWebhookSignature,
  buildKoraPendingPaymentResult, koraVerifiedTransaction} = require('../utils/koraPayment');
const reference = 'NGK_local_fixture_reference';
const order = () => ({_id: 'local-order', totalPrice: 12500.25,
  paymentResult: {provider: 'korapay', tx_ref: reference, expectedAmountKobo: 1250025, expectedCustomerEmail: 'buyer@example.com'}});
const verified = () => ({status: true, data: {reference, status: 'success', amount: '12500.25', currency: 'NGN',
  customer: {email: 'buyer@example.com'}, metadata: {'order-id': 'local-order'}}});

test('NGN comparisons use integer kobo without changing the gateway amount', () => {
  assert.equal(nairaToKobo(12500.25), 1250025);
  assert.equal(nairaToKobo('12500.25'), 1250025);
  assert.equal(nairaToKobo(0.01), 1);
  assert.equal(normalizeKoraTransaction(verified()).amountKobo, 1250025);
  assert.equal(koraVerifiedTransaction(verified()).amount, 12500.25);
});
test('rejects nonpositive, nonnumeric, fractional-kobo and unsafe amounts', () => {
  for (const value of [0, -1, '', ' ', 'invalid', null, undefined, false, true, [], {}, NaN, Infinity,
    0.001, 0.000000001, Number.MAX_SAFE_INTEGER]) assert.equal(nairaToKobo(value), null, 'invalid amount: ' + String(value));
});
test('requires a fully matching server-verified payment', () => assert.equal(koraPaymentMatchesOrder(verified(), order(), reference), true));
test('rejects underpayment, overpayment, wrong currency/reference/status and failed API response', () => {
  for (const change of [{amount: '12500.24'}, {amount: '12500.26'}, {currency: 'USD'},
    {reference: 'another-reference'}, {status: 'processing'}, {status: 'failed'}, {amount_paid: 0},
    {customer: {email: 'other@example.com'}}, {metadata: {'order-id': 'another-order'}}]) {
    const response = verified(); Object.assign(response.data, change);
    assert.equal(koraPaymentMatchesOrder(response, order(), reference), false);
  }
  assert.equal(koraPaymentMatchesOrder({...verified(), status: false}, order(), reference), false);
});
test('rejects a changed stored amount, reference or provider', () => {
  for (const change of [{expectedAmountKobo: 1250026}, {tx_ref: 'wrong-reference'}, {provider: 'squad'}]) {
    const receipt = order(); Object.assign(receipt.paymentResult, change);
    assert.equal(koraPaymentMatchesOrder(verified(), receipt, reference), false);
  }
});
test('unconfirmed results preserve the original reference and expected amount', () => {
  const stored = order().paymentResult;
  const result = buildKoraPendingPaymentResult(stored, verified(), reference);
  assert.equal(result.status, 'pending'); assert.equal(result.tx_ref, reference);
  assert.equal(result.expectedAmountKobo, stored.expectedAmountKobo);
  assert.ok(result.lastCheckedAt instanceof Date);
  assert.equal(buildKoraPendingPaymentResult(stored, {status: true, data: {status: 'failed'}}, reference).status, 'failed');
});
test('Kora signature authenticates only the data object using SHA256', () => {
  const secretKey = 'sk_test_fixture_signature';
  const body = {event: 'charge.success', data: verified().data};
  const sign = value => crypto.createHmac('sha256', secretKey).update(JSON.stringify(value)).digest('hex');
  assert.equal(verifyKoraWebhookSignature({body, signature: sign(body.data), secretKey}), true);
  assert.equal(verifyKoraWebhookSignature({body, signature: sign(body.data).toUpperCase(), secretKey}), true);
  assert.equal(verifyKoraWebhookSignature({body, signature: sign(body), secretKey}), false);
  assert.equal(verifyKoraWebhookSignature({body: {...body, data: {...body.data, amount: 1}}, signature: sign(body.data), secretKey}), false);
  for (const signature of [undefined, '', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(128)])
    assert.equal(verifyKoraWebhookSignature({body, signature, secretKey}), false);
  assert.equal(verifyKoraWebhookSignature({body: {data: []}, signature: sign([]), secretKey}), false);
});
