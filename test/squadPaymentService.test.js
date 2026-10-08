const test = require('node:test');
const assert = require('node:assert/strict');
const { initiateSquadPayment, verifySquadPayment } = require('../services/squadPaymentService');

async function withVerificationKey(work) {
  const previous = process.env.SQUAD_SECRET_KEY;
  process.env.SQUAD_SECRET_KEY = 'sandbox_sk_local_verification_fixture';
  try { await work(); }
  finally { if (previous === undefined) delete process.env.SQUAD_SECRET_KEY; else process.env.SQUAD_SECRET_KEY = previous; }
}

test('concurrent same-reference verification shares one request and never initiates payment', async () => withVerificationKey(async () => {
  let calls = 0, release;
  const client = { get: async () => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    return { data: { data: [{ transaction_ref: 'NGS_same', transaction_status: 'Success' }] } };
  }, post: () => { throw new Error('Verification must not initiate a charge'); } };
  const first = verifySquadPayment({ transactionRef: 'NGS_same', httpClient: client });
  const second = verifySquadPayment({ transactionRef: 'NGS_same', httpClient: client });
  assert.equal(calls, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].data.transaction_ref, 'NGS_same');
  assert.deepEqual(results[0], results[1]);
}));

test('429 respects Retry-After across references and verification resumes after cooldown', async t => withVerificationKey(async () => {
  let instant = Date.now(), calls = 0;
  t.mock.method(Date, 'now', () => instant);
  const client = { get: async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('Provider details must not reach the client'), { response: { status: 429, headers: { 'retry-after': '120' } } });
    return { data: { data: [{ transaction_ref: 'NGS_second', transaction_status: 'Success' }] } };
  } };
  await assert.rejects(verifySquadPayment({ transactionRef: 'NGS_first', httpClient: client }), error =>
    error.code === 'SQUAD_RATE_LIMITED' && error.statusCode === 503 && error.retryAfterSeconds === 120 && /Do not pay again/.test(error.message));
  instant += 1000;
  await assert.rejects(verifySquadPayment({ transactionRef: 'NGS_second', httpClient: client }), { code: 'SQUAD_RATE_LIMITED' });
  assert.equal(calls, 1);
  instant += 120000;
  assert.equal((await verifySquadPayment({ transactionRef: 'NGS_second', httpClient: client })).data.transaction_ref, 'NGS_second');
  assert.equal(calls, 2);
}));

test('429 without Retry-After waits at least a minute; failed verification is not cached as paid', async t => withVerificationKey(async () => {
  let instant = Date.now(), calls = 0;
  t.mock.method(Date, 'now', () => instant);
  const client = { get: async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('rate limit'), { response: { status: 429 } });
    return { data: { data: [] } };
  } };
  await assert.rejects(verifySquadPayment({ transactionRef: 'NGS_pending', httpClient: client }), error => error.retryAfterSeconds === 60);
  instant += 60001;
  assert.equal((await verifySquadPayment({ transactionRef: 'NGS_pending', httpClient: client })).success, false);
  assert.equal((await verifySquadPayment({ transactionRef: 'NGS_pending', httpClient: client })).success, false);
  assert.equal(calls, 3);
}));

test('invalid reference fails before calling Squad', async () => withVerificationKey(async () => {
  const client = { get: () => { throw new Error('Must not call provider'); } };
  for (const reference of ['', null, ' '.repeat(3), 'x'.repeat(201)]) {
    await assert.rejects(verifySquadPayment({ transactionRef: reference, httpClient: client }), /valid transaction reference/);
  }
}));

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
