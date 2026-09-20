'use strict';
const crypto = require('node:crypto');
const { fail, id, integer } = require('./orderPlanningPolicy');

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    return value;
}
function totalKobo(quote) {
    if (!Number.isFinite(quote?.totalPrice) || quote.totalPrice < 0) fail('QUOTE_UNAVAILABLE', 'A current order total is required.', 503);
    return integer(Math.round(quote.totalPrice * 100), 0, Number.MAX_SAFE_INTEGER, 'quote amount');
}
function digest(context, quote) {
    if (!['group', 'recurring'].includes(context.kind)) fail('INVALID_QUOTE', 'Invalid checkout context.');
    const binding = { ...context, owner: id(context.owner), recordId: id(context.recordId), revision: integer(context.revision, 0, Number.MAX_SAFE_INTEGER, 'revision') };
    totalKobo(quote);
    // Includes destination, schedule, all fees, subscription and canonical items.
    // Dates/ObjectIds are converted before sorting; no private data enters tokens.
    return crypto.createHash('sha256').update(JSON.stringify(stable(JSON.parse(JSON.stringify({ binding, quote }))))).digest('hex');
}
function createPlannedCheckoutApproval({ secret, now = () => new Date(), lifetimeMs = 300000 }) {
    if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new TypeError('Planned checkout requires a private signing secret of at least 32 bytes.');
    integer(lifetimeMs, 1000, 900000, 'quote lifetime');
    const sign = (payload) => crypto.createHmac('sha256', secret).update('naijago:planned-checkout:v1:' + payload).digest('hex');
    function issue({ context, quote }) {
        const expires = now().getTime() + lifetimeMs;
        const payload = `v1.${expires}.${digest(context, quote)}`;
        return { quote, totalKobo: totalKobo(quote), approvalToken: `${payload}.${sign(payload)}`, expiresAt: new Date(expires).toISOString() };
    }
    function verify({ context, quote, token }) {
        if (typeof token !== 'string' || !/^v1\.\d{13}\.[a-f\d]{64}\.[a-f\d]{64}$/.test(token)) fail('QUOTE_APPROVAL_REQUIRED', 'Review and approve the current order total before checkout.', 409);
        const parts = token.split('.'), payload = parts.slice(0, 3).join('.');
        if (!crypto.timingSafeEqual(Buffer.from(parts[3], 'hex'), Buffer.from(sign(payload), 'hex'))) fail('QUOTE_APPROVAL_REQUIRED', 'Review and approve the current order total before checkout.', 409);
        const expires = Number(parts[1]);
        if (expires <= now().getTime() || expires > now().getTime() + lifetimeMs) fail('QUOTE_EXPIRED', 'This quote expired. Refresh and approve the latest total.', 409);
        if (parts[2] !== digest(context, quote)) fail('QUOTE_CHANGED', 'Your order details or price changed. Review and approve the new quote.', 409);
        return true;
    }
    return { issue, verify };
}
function assertCreatedOrder({ order, quote, owner, shipmentCount }) {
    if (!order?._id || String(order.user) !== String(owner) || order.isPaid !== false || order.mainOrderStatus !== 'pending_payment' ||
        !Array.isArray(order.shipments) || order.shipments.length !== shipmentCount || shipmentCount < 1 ||
        totalKobo(order) !== totalKobo(quote)) fail('INVALID_ORDER', 'Planned checkout did not create the approved unpaid order.', 500);
}
module.exports = { createPlannedCheckoutApproval, totalKobo, assertCreatedOrder };
