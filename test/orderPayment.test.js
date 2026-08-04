const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPendingPaymentResult,
  paymentMatchesOrder,
} = require('../utils/flutterwavePayment');

const order = { totalPrice: 12500 };
const successfulPayment = {
  status: 'success',
  data: {
    status: 'successful',
    tx_ref: 'NGO_order_reference',
    currency: 'NGN',
    amount: 12500,
  },
};

test('accepts a fully matching verified Flutterwave payment', () => {
  assert.equal(
    paymentMatchesOrder(successfulPayment, order, 'NGO_order_reference'),
    true,
  );
});

test('rejects mismatched reference, currency, amount, or status', () => {
  const cases = [
    { ...successfulPayment, data: { ...successfulPayment.data, tx_ref: 'wrong' } },
    { ...successfulPayment, data: { ...successfulPayment.data, currency: 'USD' } },
    { ...successfulPayment, data: { ...successfulPayment.data, amount: 12499 } },
    { ...successfulPayment, data: { ...successfulPayment.data, status: 'pending' } },
  ];
  for (const payment of cases) {
    assert.equal(
      paymentMatchesOrder(payment, order, 'NGO_order_reference'),
      false,
    );
  }
});

test('accepts an overpayment without weakening the expected amount', () => {
  const overpayment = {
    ...successfulPayment,
    data: { ...successfulPayment.data, amount: 13000 },
  };
  assert.equal(
    paymentMatchesOrder(overpayment, order, 'NGO_order_reference'),
    true,
  );
});

test('preserves the order payment reference while verification is pending', () => {
  const checkedAt = new Date('2026-08-04T12:00:00.000Z');
  const existingResult = {
    tx_ref: 'NGO_order_reference',
    status: 'initiated',
    expectedAmount: 12500,
    currency: 'NGN',
  };
  const pendingVerification = {
    status: 'pending',
    data: { status: 'pending', tx_ref: 'NGO_order_reference' },
  };

  assert.deepEqual(
    buildPendingPaymentResult(
      existingResult,
      pendingVerification,
      'NGO_order_reference',
      checkedAt,
    ),
    {
      ...existingResult,
      status: 'pending',
      lastCheckedAt: checkedAt,
    },
  );
  assert.equal(
    paymentMatchesOrder(pendingVerification, order, 'NGO_order_reference'),
    false,
  );
  assert.equal(
    paymentMatchesOrder(successfulPayment, order, 'NGO_order_reference'),
    true,
  );
});
