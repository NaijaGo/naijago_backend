const test = require('node:test');
const assert = require('node:assert/strict');
const { initiateSquadPayment, verifySquadPayment } = require('../services/squadPaymentService');

test('initiates hosted Squad checkout in kobo with server-owned metadata', async () => {
  const previous = {
    key: process.env.SQUAD_SECRET_KEY,
    base: process.env.SQUAD_BASE_URL,
    redirect: process.env.SQUAD_REDIRECT_URL,
  };
  process.env.SQUAD_SECRET_KEY = 'sandbox_sk_test';
  process.env.SQUAD_BASE_URL = 'https://sandbox-api-d.squadco.com/';
  process.env.SQUAD_REDIRECT_URL = 'https://naijago.com/payment-redirect';
  let request;
  const httpClient = {
    post: async (...args) => {
      request = args;
      return { data: { status: 200, data: { transaction_ref: 'NGS_1', checkout_url: 'https://sandbox-pay.squadco.com/NGS_1' } } };
    },
  };
  try {
    const result = await initiateSquadPayment({
      amountNaira: 12500, email: 'buyer@example.com', customerName: 'Ada Buyer',
      transactionRef: 'NGS_1', orderId: 'order-1', httpClient,
    });
    assert.equal(request[0], 'https://sandbox-api-d.squadco.com/transaction/initiate');
    assert.equal(request[1].amount, 1250000);
    assert.equal(request[1].transaction_ref, 'NGS_1');
    assert.equal(request[1].metadata.order_id, 'order-1');
    assert.deepEqual(request[1].payment_channels, ['card', 'bank', 'ussd', 'transfer']);
    assert.equal(request[2].headers.Authorization, 'Bearer sandbox_sk_test');
    assert.equal(result.data.checkout_url, 'https://sandbox-pay.squadco.com/NGS_1');
  } finally {
    if (previous.key === undefined) delete process.env.SQUAD_SECRET_KEY; else process.env.SQUAD_SECRET_KEY = previous.key;
    if (previous.base === undefined) delete process.env.SQUAD_BASE_URL; else process.env.SQUAD_BASE_URL = previous.base;
    if (previous.redirect === undefined) delete process.env.SQUAD_REDIRECT_URL; else process.env.SQUAD_REDIRECT_URL = previous.redirect;
  }
});

test('requeries Squad and selects only the exact transaction reference', async () => {
  const previousKey = process.env.SQUAD_SECRET_KEY;
  process.env.SQUAD_SECRET_KEY = 'sandbox_sk_test';
  let options;
  const httpClient = {
    get: async (_url, requestOptions) => {
      options = requestOptions;
      return { data: { data: [
        { transaction_ref: 'another', transaction_status: 'success' },
        { transaction_ref: 'NGS_1', transaction_status: 'success', transaction_amount: 1250000, transaction_currency_id: 'NGN' },
      ] } };
    },
  };
  try {
    const result = await verifySquadPayment({ transactionRef: 'NGS_1', initiatedAt: new Date(), httpClient });
    assert.equal(options.params.reference, 'NGS_1');
    assert.equal('perpage' in options.params, false);
    assert.equal('page' in options.params, false);
    assert.equal(result.data.transaction_ref, 'NGS_1');
  } finally {
    if (previousKey === undefined) delete process.env.SQUAD_SECRET_KEY; else process.env.SQUAD_SECRET_KEY = previousKey;
  }
});
