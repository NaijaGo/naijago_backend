const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../services/koraPaymentService');
const {withKoraEnvironment} = require('./helpers/koraFixtures.cjs');
const reference = 'NGK_local_fixture_123';
const checkoutArgs = {amountNaira: 12500.25, email: 'buyer@example.com', customerName: 'Local Fixture', transactionRef: reference, orderId: 'local-order'};

test('hosted checkout uses naira, server metadata, merchant-paid fees and a fixed HTTPS API', async () => withKoraEnvironment(async () => {
  let captured;
  const httpClient = {post: async (...args) => {captured = args; return {data: {status: true,
    data: {reference, checkout_url: 'https://checkout.korapay.com/local/pay'}}};}};
  const result = await service.initiateKoraPayment({...checkoutArgs, httpClient});
  assert.equal(captured[0], 'https://api.korapay.com/merchant/api/v1/charges/initialize');
  assert.equal(captured[1].amount, 12500.25); assert.equal(captured[1].currency, 'NGN');
  assert.equal(captured[1].merchant_bears_cost, true);
  assert.deepEqual(captured[1].metadata, {'order-id': 'local-order', source: 'naijago-customer-app'});
  assert.equal(captured[1].notification_url, 'https://example.com/kora-webhook');
  assert.equal(captured[2].maxRedirects, 0); assert.equal(captured[2].timeout, 30000);
  assert.equal(result.mode, 'test'); assert.equal('secretKey' in result, false);
}));
test('rejects mismatched checkout references and untrusted URLs', async () => withKoraEnvironment(async () => {
  for (const data of [{reference: 'wrong', checkout_url: 'https://checkout.korapay.com/pay'},
    {reference, checkout_url: 'https://checkout.korapay.com.evil.example/pay'},
    {reference, checkout_url: 'http://checkout.korapay.com/pay'},
    {reference, checkout_url: 'https://user@checkout.korapay.com/pay'},
    {reference, checkout_url: 'https://checkout.korapay.com:444/pay'}]) {
    await assert.rejects(service.initiateKoraPayment({...checkoutArgs,
      httpClient: {post: async () => ({data: {status: true, data}})}}), {code: 'KORAPAY_INVALID_CHECKOUT'});
  }
}));
test('test/live key mismatch and production test mode fail before network use', async () => {
  await withKoraEnvironment(async () => assert.throws(service.getKoraConfig, {code: 'KORAPAY_NOT_CONFIGURED'}), {KORAPAY_MODE: 'live'});
  await withKoraEnvironment(async () => assert.throws(service.getKoraConfig, /Production.*live/), {NODE_ENV: 'production'});
  await withKoraEnvironment(async () => assert.throws(service.getKoraCheckoutConfig, /HTTPS/), {KORAPAY_NOTIFICATION_URL: 'http://example.com/webhook'});
});
test('bank listing uses the public key and preserves the existing app response shape', async () => withKoraEnvironment(async () => {
  let captured;
  const banks = await service.listKoraBanks({get: async (...args) => {captured = args;
    return {data: {status: true, data: [{name: 'Fixture Bank', code: '044'}]}};}});
  assert.equal(captured[0], 'https://api.korapay.com/merchant/api/v1/misc/banks');
  assert.equal(captured[1].headers.Authorization, 'Bearer pk_test_local_fixture_only');
  assert.deepEqual(captured[1].params, {countryCode: 'NG'});
  assert.deepEqual(banks, [{name: 'Fixture Bank', code: '044', id: '044'}]);
}));
test('verification never initiates payment and combines concurrent same-reference requests', async () => withKoraEnvironment(async () => {
  let count = 0, release;
  const httpClient = {get: async () => {count++; await new Promise(resolve => {release = resolve;});
    return {data: {status: true, data: {reference, status: 'processing'}}};},
    post: () => {throw new Error('Verification cannot create payment');}};
  const first = service.verifyKoraPayment({transactionRef: reference, httpClient});
  const second = service.verifyKoraPayment({transactionRef: reference, httpClient});
  assert.equal(count, 1); release();
  assert.deepEqual(await first, await second);
}));
test('rate limiting covers charge and payout verification for the same account', async t => withKoraEnvironment(async () => {
  let now = Date.now(), calls = 0; t.mock.method(Date, 'now', () => now);
  const httpClient = {get: async () => {calls++;
    if (calls === 1) throw Object.assign(new Error('private provider diagnostics'), {response: {status: 429, headers: {'retry-after': '120'}}});
    return {data: {status: false, data: null}};}};
  await assert.rejects(service.verifyKoraPayment({transactionRef: reference, httpClient}), {code: 'KORAPAY_RATE_LIMITED', retryAfterSeconds: 120});
  await assert.rejects(service.verifyKoraTransfer({transactionRef: 'NGW_local_fixture_123', httpClient}), {code: 'KORAPAY_RATE_LIMITED'});
  assert.equal(calls, 1); now += 120001;
  assert.equal((await service.verifyKoraPayment({transactionRef: reference, httpClient})).status, false);
  assert.equal(calls, 2);
}));
test('404 stays unconfirmed; provider errors are sanitized and invalid references never reach the API', async () => withKoraEnvironment(async () => {
  assert.deepEqual(await service.verifyKoraPayment({transactionRef: reference, httpClient: {get: async () => {
    throw Object.assign(new Error('fixture'), {response: {status: 404}});}}}), {status: false, data: null});
  await assert.rejects(service.verifyKoraTransfer({transactionRef: 'NGW_local_fixture_123', httpClient: {get: async () => {
    throw new Error('private key details must not be returned');}}}), error => error.code === 'KORAPAY_VERIFY_UNAVAILABLE' && !error.message.includes('private key'));
  await assert.rejects(service.verifyKoraPayment({transactionRef: '../invalid', httpClient: {get: () => {
    throw new Error('Invalid references cannot call the API');}}}), {code: 'KORAPAY_INVALID_REFERENCE'});
}));
test('bank payout has the documented destination and does not run when payouts are disabled', async () => withKoraEnvironment(async () => {
  let captured;
  const args = {reference: 'NGW_local_fixture_123', amount: 100.25, bank: '044', account: '0000000000',
    name: 'Local Fixture', email: 'fixture@example.com', httpClient: {post: async (...values) => {captured = values;
      return {data: {status: true, data: {status: 'processing'}}};}}};
  await service.initiateKoraTransfer(args);
  assert.equal(captured[0], 'https://api.korapay.com/merchant/api/v1/transactions/disburse');
  assert.deepEqual(captured[1].destination.bank_account, {bank: '044', account: '0000000000'});
  assert.equal(captured[1].destination.amount, 100.25);
  process.env.KORAPAY_PAYOUTS_ENABLED = 'false'; captured = undefined;
  await assert.rejects(service.initiateKoraTransfer(args), /not enabled/);
  assert.equal(captured, undefined);
}));

test('checkout failure diagnostics retain HTTP categories without secrets or provider text', async () => withKoraEnvironment(async () => {
  const cases = [
    [401, 'Invalid API key', 'authentication_rejected'],
    [403, 'Forbidden', 'permission_rejected'],
    [403, 'IP address is not allowed on the whitelist', 'ip_restricted'],
    [400, 'Merchant account is not activated', 'account_restricted'],
    [422, 'Payment channel is not enabled', 'channel_rejected'],
    [409, 'Reference already exists', 'reference_conflict'],
    [400, 'Invalid customer', 'request_rejected'],
    [429, 'Too many requests', 'rate_limited'],
    [502, 'Bad gateway', 'provider_unavailable'],
  ];
  for (const [status, message, reason] of cases) {
    let calls = 0;
    const httpClient = {post: async () => {
      calls++;
      throw Object.assign(new Error('raw-sensitive-transport-message'), {
        config: {headers: {Authorization: 'Bearer sk_live_private_fixture'}, data: {email: 'private-customer@example.com'}},
        response: {status, data: {message: message + ' private-customer@example.com sk_live_private_fixture',
          data: {customer: {email: 'private-customer@example.com'}, untrusted: 'private-provider-payload'},
          errors: {email: 'private-customer@example.com'}}},
      });
    }};
    await assert.rejects(service.initiateKoraPayment({...checkoutArgs, httpClient}), error => {
      assert.equal(error.code, 'KORAPAY_INITIALIZE_UNAVAILABLE');
      assert.equal(error.statusCode, 503);
      assert.deepEqual(error.providerDiagnostic, {providerHttpStatus: status, reason, fields: ['customer', 'email']});
      const output = error.stack + JSON.stringify(error);
      for (const privateText of ['sk_live_private_fixture', 'private-customer@example.com',
        'raw-sensitive-transport-message', 'private-provider-payload']) assert.equal(output.includes(privateText), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1, 'initialization errors must not automatically retry or create a different reference');
  }
}));

test('checkout transport diagnostics allow only recognized network codes', async () => withKoraEnvironment(async () => {
  for (const code of ['ENOTFOUND', 'ECONNABORTED', 'ECONNRESET', 'sk_live_private_fixture']) {
    await assert.rejects(service.initiateKoraPayment({...checkoutArgs, httpClient: {post: async () => {
      throw Object.assign(new Error('raw private diagnostics'), {code});
    }}}), error => {
      assert.equal(error.providerDiagnostic.providerHttpStatus, null);
      assert.equal(error.providerDiagnostic.reason, 'transport_error');
      assert.equal(error.providerDiagnostic.transportCode, code.startsWith('sk_') ? undefined : code);
      assert.equal(JSON.stringify(error).includes('private'), false);
      return true;
    });
  }
}));
