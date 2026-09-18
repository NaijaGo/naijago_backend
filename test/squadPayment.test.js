const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { buildSquadPendingPaymentResult, normalizeSquadTransaction, squadPaymentMatchesOrder, verifySquadWebhookSignature } = require('../utils/squadPayment');

const reference = 'NGS_order_reference';
const successful = { status: 200, success: true, data: { transaction_status: 'Success', transaction_ref: reference, gateway_ref: `${reference}_1`, currency: 'NGN', amount: 1250000, email: 'buyer@example.com' } };

test('normalizes a Squad transaction without changing kobo to naira', () => {
  const normalized = normalizeSquadTransaction(successful);
  assert.equal(normalized.tx_ref, reference);
  assert.equal(normalized.amountKobo, 1250000);
  assert.equal(normalized.status, 'Success');
});

test('accepts a successful matching Squad payment', () => {
  assert.equal(squadPaymentMatchesOrder(successful, { totalPrice: 12500 }, reference), true);
});

test('rejects underpayment, wrong reference, currency, and pending payment', () => {
  const cases = [
    { ...successful, data: { ...successful.data, amount: 1249999 } },
    { ...successful, data: { ...successful.data, transaction_ref: 'wrong' } },
    { ...successful, data: { ...successful.data, currency: 'USD' } },
    { ...successful, data: { ...successful.data, transaction_status: 'Pending' } },
  ];
  for (const payment of cases) assert.equal(squadPaymentMatchesOrder(payment, { totalPrice: 12500 }, reference), false);
});

test('validates the Squad HMAC-SHA512 signature using the exact raw body', () => {
  const secretKey = 'sk_test_secret';
  const rawBody = Buffer.from('{Event:charge_successful,Body:{amount:1250000}}');
  const signature = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  assert.equal(verifySquadWebhookSignature({ rawBody, signature, secretKey }), true);
  assert.equal(verifySquadWebhookSignature({ rawBody: Buffer.from(`${rawBody.toString()} `), signature, secretKey }), false);
});

test('keeps the reference while a Squad payment is pending', () => {
  const checkedAt = new Date('2026-09-18T12:00:00.000Z');
  assert.deepEqual(buildSquadPendingPaymentResult({ expectedAmount: 12500, currency: 'NGN' }, { data: { transaction_status: 'Pending' } }, reference, checkedAt), {
    expectedAmount: 12500, currency: 'NGN', provider: 'squad', tx_ref: reference, status: 'pending', lastCheckedAt: checkedAt,
  });
});
