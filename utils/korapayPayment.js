'use strict';
const crypto = require('node:crypto');

function moneyKobo(value) {
    if (!['number', 'string'].includes(typeof value) ||
        (typeof value === 'string' && !/^\d+(?:\.\d{1,2})?$/.test(value))) return null;
    const amount = Number(value), kobo = Math.round(amount * 100);
    return Number.isFinite(amount) && amount >= 0 && Number.isSafeInteger(kobo) &&
        Math.abs(amount * 100 - kobo) < 0.00001 ? kobo : null;
}

function normalizeKorapayTransaction(response) {
    const data = response?.status === true && response.data && !Array.isArray(response.data) ? response.data : {};
    // amount is the requested charge, not proof of the amount actually received.
    const paid = moneyKobo(data.amount_paid), accepted = moneyKobo(data.amount_accepted);
    const received = data.amount_accepted != null ? accepted : paid;
    const validAmounts = (data.amount_paid == null || paid !== null) &&
        (data.amount_accepted == null || accepted !== null);
    return { id: data.transaction_reference || data.reference, tx_ref: data.reference,
        status: data.status, currency: data.currency, amountKobo: validAmounts ? received : null,
        paidKobo: paid, gateway_ref: data.transaction_reference || data.reference,
        email: data.customer?.email, raw: data };
}

function korapayPaymentMatchesOrder(response, order, reference) {
    const tx = normalizeKorapayTransaction(response), expected = moneyKobo(order?.totalPrice);
    return response?.status === true && tx.status === 'success' &&
        typeof reference === 'string' && reference.length > 0 && tx.tx_ref === reference &&
        order?.paymentResult?.tx_ref === reference && order?.paymentResult?.provider === 'korapay' &&
        tx.currency === 'NGN' && expected !== null && expected > 0 && tx.amountKobo !== null &&
        tx.amountKobo >= expected && (tx.paidKobo === null || tx.paidKobo >= expected);
}

function verifyKorapayWebhookSignature({ body, signature, secretKey }) {
    if (!secretKey || typeof signature !== 'string' || !/^[a-fA-F0-9]{64}$/.test(signature) ||
        !body?.data || typeof body.data !== 'object' || Array.isArray(body.data)) return false;
    const expected = crypto.createHmac('sha256', secretKey).update(JSON.stringify(body.data)).digest();
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), expected);
}

function buildKorapayPendingPaymentResult(existing, response, reference, now = new Date()) {
    const tx = normalizeKorapayTransaction(response);
    return { ...existing, provider: 'korapay', tx_ref: reference,
        // Even underpaid/temporarily mismatched successful charges stay recoverable.
        status: 'pending', gatewayStatus: tx.status || 'unknown', lastCheckedAt: now };
}

function safeKorapayCheckoutUrl(value) {
    try { const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'checkout.korapay.com' &&
            !url.username && !url.password && !url.port ? url.toString() : null;
    } catch { return null; }
}

module.exports = { moneyKobo, normalizeKorapayTransaction, korapayPaymentMatchesOrder,
    verifyKorapayWebhookSignature, buildKorapayPendingPaymentResult, safeKorapayCheckoutUrl };
