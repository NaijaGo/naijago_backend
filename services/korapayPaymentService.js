'use strict';
const axios = require('axios');
const { moneyKobo, safeKorapayCheckoutUrl } = require('../utils/korapayPayment');
const API = 'https://api.korapay.com/merchant/api/v1';
function fail(code, message, statusCode = 503) { return Object.assign(new Error(message), { code, statusCode }); }
function getKorapayConfig({ expectedMode, checkout = false } = {}) {
    const mode = String(process.env.KORAPAY_MODE || 'test').trim().toLowerCase();
    const secretKey = String(process.env.KORAPAY_SECRET_KEY || '').trim();
    if (!['test', 'live'].includes(mode) || !secretKey.startsWith(`sk_${mode}_`) || /\s/.test(secretKey)) {
        throw fail('KORAPAY_NOT_CONFIGURED', 'KoraPay is not configured for this payment mode.');
    }
    if (expectedMode && expectedMode !== mode) throw fail('KORAPAY_MODE_MISMATCH', 'This payment belongs to a different payment mode. Contact support; do not pay again.');
    if (mode === 'test' && !['test', 'development', 'staging'].includes(process.env.NODE_ENV)) {
        throw fail('KORAPAY_TEST_MODE_BLOCKED', 'Test payments must use a separate non-production backend and database.');
    }
    const config = { mode, secretKey };
    if (checkout) for (const [key, name] of [['redirectUrl', 'KORAPAY_REDIRECT_URL'], ['notificationUrl', 'KORAPAY_WEBHOOK_URL']]) {
        try { const url = new URL(String(process.env[name] || ''));
            if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
            config[key] = url.toString();
        } catch { throw fail('KORAPAY_NOT_CONFIGURED', 'KoraPay callback configuration is incomplete.'); }
    }
    return config;
}
function reference(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,120}$/.test(value)) throw fail('INVALID_PAYMENT_REFERENCE', 'Invalid payment reference.', 400);
    return value;
}
async function initiateKorapayPayment({ amountNaira, email, customerName, transactionRef, orderId, mode, httpClient = axios }) {
    const config = getKorapayConfig({ expectedMode: mode, checkout: true });
    const kobo = moneyKobo(amountNaira);
    if (kobo === null || kobo < 1 || !email || typeof email !== 'string') throw fail('INVALID_PAYMENT_DETAILS', 'Valid payment details are required.', 400);
    let response;
    try { response = await httpClient.post(`${API}/charges/initialize`, {
        amount: kobo / 100, currency: 'NGN', reference: reference(transactionRef),
        customer: { email, name: customerName || email }, merchant_bears_cost: true,
        redirect_url: config.redirectUrl, notification_url: config.notificationUrl,
        metadata: { 'order-id': String(orderId), source: 'naijago' },
    }, { headers: { Authorization: `Bearer ${config.secretKey}` }, timeout: 30000, maxRedirects: 0 });
    } catch { throw fail('KORAPAY_INITIALIZATION_UNCERTAIN', 'Payment setup is delayed. Check this order before trying again.'); }
    const data = response?.data?.data, url = safeKorapayCheckoutUrl(data?.checkout_url);
    if (response?.data?.status !== true || data?.reference !== transactionRef || !url) {
        throw fail('KORAPAY_INVALID_RESPONSE', 'Unable to prepare the secure payment page.');
    }
    return { data: { reference: transactionRef, checkout_url: url }, mode: config.mode };
}
async function verifyKorapayPayment({ transactionRef, mode, httpClient = axios }) {
    const { secretKey } = getKorapayConfig({ expectedMode: mode });
    const ref = reference(transactionRef);
    try { const response = await httpClient.get(`${API}/charges/${encodeURIComponent(ref)}`,
        { headers: { Authorization: `Bearer ${secretKey}` }, timeout: 30000, maxRedirects: 0 });
        return response.data;
    } catch (error) {
        if (error.response?.status === 404) return { status: false, notFound: true, data: null };
        // Never propagate Axios config/headers or provider bodies into logs/responses.
        throw fail('KORAPAY_VERIFICATION_UNAVAILABLE', 'Payment confirmation is delayed. Please do not pay again.');
    }
}
module.exports = { getKorapayConfig, initiateKorapayPayment, verifyKorapayPayment };
