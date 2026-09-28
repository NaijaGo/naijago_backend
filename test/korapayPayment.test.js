'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { moneyKobo, normalizeKorapayTransaction, korapayPaymentMatchesOrder,
    verifyKorapayWebhookSignature, safeKorapayCheckoutUrl } = require('../utils/korapayPayment');
const { getKorapayConfig, initiateKorapayPayment, verifyKorapayPayment } = require('../services/korapayPaymentService');
const ref = 'NGK_synthetic_order_001';
const order = { totalPrice: 100.25, paymentResult: { provider: 'korapay', tx_ref: ref } };
const good = () => ({ status: true, data: { reference: ref, status: 'success', amount: '100.25', amount_paid: '100.25', currency: 'NGN' } });

test('NGN decimal amounts are compared in kobo without accepting malformed amounts', () => {
    for (const [input, expected] of [[100.25, 10025], ['100.25', 10025], ['100', 10000], [0, 0]]) assert.equal(moneyKobo(input), expected);
    for (const input of [null, undefined, '', ' ', '1e3', '1.234', true, NaN, Infinity, -1, {}, 1e30]) assert.equal(moneyKobo(input), null);
});
test('success requires the exact stored reference, provider, currency and actual received amount', () => {
    assert.equal(korapayPaymentMatchesOrder(good(), order, ref), true);
    for (const change of [{ reference: 'wrong-ref' }, { status: 'pending' }, { currency: 'USD' },
        { amount_paid: '99.99' }, { amount_paid: null }, { amount_paid: 'NaN' },
        { amount_accepted: '99.00' }, { amount_accepted: '' }, { amount_paid: '99', amount_accepted: '100.25' }]) {
        const data = good(); Object.assign(data.data, change);
        assert.equal(korapayPaymentMatchesOrder(data, order, ref), false, JSON.stringify(change));
    }
    assert.equal(korapayPaymentMatchesOrder({ ...good(), status: false }, order, ref), false);
    assert.equal(korapayPaymentMatchesOrder(good(), { ...order, paymentResult: { provider: 'squad', tx_ref: ref } }, ref), false);
    assert.equal(korapayPaymentMatchesOrder(good(), { ...order, paymentResult: { provider: 'korapay', tx_ref: 'other' } }, ref), false);
});
test('accepted transfer funds take precedence; requested amount is never payment evidence', () => {
    const result = good(); result.data.amount = '900000'; result.data.amount_paid = '110'; result.data.amount_accepted = '100.25';
    assert.equal(normalizeKorapayTransaction(result).amountKobo, 10025);
    assert.equal(korapayPaymentMatchesOrder(result, order, ref), true);
    delete result.data.amount_paid; delete result.data.amount_accepted;
    assert.equal(korapayPaymentMatchesOrder(result, order, ref), false);
});
test('webhook HMAC covers only the data object and rejects invalid signatures or payloads', () => {
    const body = { event: 'charge.success', data: { reference: ref, amount: 100.25 } }, secretKey = 'synthetic-only';
    const signature = crypto.createHmac('sha256', secretKey).update(JSON.stringify(body.data)).digest('hex');
    assert.equal(verifyKorapayWebhookSignature({ body, signature, secretKey }), true);
    assert.equal(verifyKorapayWebhookSignature({ body, signature: signature.toUpperCase(), secretKey }), true);
    assert.equal(verifyKorapayWebhookSignature({ body: { ...body, data: { ...body.data, amount: 10000 } }, signature, secretKey }), false);
    for (const value of ['', null, [], 'aa', 'z'.repeat(64)]) assert.equal(verifyKorapayWebhookSignature({ body, signature: value, secretKey }), false);
    assert.equal(verifyKorapayWebhookSignature({ body: { data: [] }, signature, secretKey }), false);
});
test('checkout links are restricted to the official HTTPS checkout host', () => {
    assert.ok(safeKorapayCheckoutUrl('https://checkout.korapay.com/reference/pay'));
    for (const value of [undefined, 'http://checkout.korapay.com/pay', 'https://checkout.korapay.com.evil.example/pay',
        'https://user:secret@checkout.korapay.com/pay', 'https://checkout.korapay.com:8080/pay', 'javascript:alert(1)']) assert.equal(safeKorapayCheckoutUrl(value), null);
});

async function environment(work) {
    const values = { KORAPAY_MODE: 'test', KORAPAY_SECRET_KEY: 'sk_test_synthetic_only', NODE_ENV: 'test',
        KORAPAY_REDIRECT_URL: 'https://example.invalid/payment-redirect', KORAPAY_WEBHOOK_URL: 'https://example.invalid/api/orders/webhooks/korapay' };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    try { return await work(); } finally { for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    } }
}
test('configuration rejects public/wrong-mode keys and test payments in production', () => environment(() => {
    assert.equal(getKorapayConfig({ checkout: true }).mode, 'test');
    assert.throws(() => getKorapayConfig({ expectedMode: 'live' }), { code: 'KORAPAY_MODE_MISMATCH' });
    for (const environment of ['production', '', 'unknown']) {
        process.env.NODE_ENV = environment;
        assert.throws(() => getKorapayConfig(), { code: 'KORAPAY_TEST_MODE_BLOCKED' });
    }
    delete process.env.NODE_ENV;
    assert.throws(() => getKorapayConfig(), { code: 'KORAPAY_TEST_MODE_BLOCKED' });
    process.env.NODE_ENV = 'test';
    for (const value of ['', 'pk_test_synthetic', 'sk_live_synthetic', 'sk_test_bad key']) {
        process.env.KORAPAY_SECRET_KEY = value; assert.throws(() => getKorapayConfig(), { code: 'KORAPAY_NOT_CONFIGURED' });
    }
}));
test('checkout config requires HTTPS callback URLs, not credentials or arbitrary redirects', () => environment(() => {
    for (const value of ['', 'http://example.invalid/callback', 'https://user:pass@example.invalid/callback']) {
        process.env.KORAPAY_WEBHOOK_URL = value; assert.throws(() => getKorapayConfig({ checkout: true }), { code: 'KORAPAY_NOT_CONFIGURED' });
    }
}));
test('initialization sends naira, trusted metadata and merchant-paid fees without frontend secret keys', () => environment(async () => {
    let args;
    const result = await initiateKorapayPayment({ amountNaira: 100.25, email: 'buyer@example.invalid', orderId: 'order001', transactionRef: ref, mode: 'test',
        httpClient: { post: async (...values) => { args = values; return { data: { status: true, data: { reference: ref, checkout_url: 'https://checkout.korapay.com/ref/pay' } } }; } } });
    assert.equal(args[0], 'https://api.korapay.com/merchant/api/v1/charges/initialize');
    assert.equal(args[1].amount, 100.25); assert.equal(args[1].merchant_bears_cost, true);
    assert.equal(args[1].metadata['order-id'], 'order001'); assert.equal(args[1].notification_url, process.env.KORAPAY_WEBHOOK_URL);
    assert.equal(args[2].timeout, 30000); assert.equal(args[2].maxRedirects, 0);
    assert.deepEqual(Object.keys(result).sort(), ['data', 'mode']);
    assert.equal(JSON.stringify(result).includes('sk_test_'), false);
}));
test('initialization rejects mismatched references and unsafe provider checkout links', () => environment(async () => {
    for (const data of [{ reference: 'wrong', checkout_url: 'https://checkout.korapay.com/pay' },
        { reference: ref, checkout_url: 'https://evil.example/pay' }]) {
        await assert.rejects(initiateKorapayPayment({ amountNaira: 100, email: 'buyer@example.invalid', transactionRef: ref,
            httpClient: { post: async () => ({ data: { status: true, data } }) } }), { code: 'KORAPAY_INVALID_RESPONSE' });
    }
}));
test('verification uses the exact escaped reference and never sends pagination parameters', () => environment(async () => {
    let args;
    await verifyKorapayPayment({ transactionRef: ref, mode: 'test', httpClient: { get: async (...values) => { args = values; return { data: good() }; } } });
    assert.equal(args[0], 'https://api.korapay.com/merchant/api/v1/charges/' + ref);
    assert.equal(args[1].params, undefined); assert.equal(args[1].maxRedirects, 0);
    await assert.rejects(verifyKorapayPayment({ transactionRef: '../../other', httpClient: { get: () => assert.fail('HTTP must not run') } }), { code: 'INVALID_PAYMENT_REFERENCE' });
}));
test('not found stays pending; provider errors cannot leak Axios headers, bodies or secrets', () => environment(async () => {
    const notFound = await verifyKorapayPayment({ transactionRef: ref, httpClient: { get: async () => { throw { response: { status: 404 } }; } } });
    assert.equal(notFound.notFound, true);
    const secretError = { message: 'sk_test_private', config: { headers: { Authorization: 'Bearer sk_test_private' } }, response: { status: 500, data: 'private' } };
    const error = await verifyKorapayPayment({ transactionRef: ref, httpClient: { get: async () => { throw secretError; } } }).catch(value => value);
    assert.equal(error.code, 'KORAPAY_VERIFICATION_UNAVAILABLE'); assert.equal(error.config, undefined); assert.equal(error.response, undefined);
    assert.doesNotMatch(error.message, /private|sk_test/);
}));
