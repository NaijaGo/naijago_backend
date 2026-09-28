'use strict';
const { CheckoutCatalogError } = require('./checkoutCatalogService');
const changed = () => { throw new CheckoutCatalogError('PAYMENT_QUOTE_CHANGED',
    'Your order price, delivery or availability changed. Return to your cart and review the latest total before paying.'); };
const ref = value => value == null ? null : String(value._id || value);
const plain = value => JSON.parse(JSON.stringify(value));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const sorted = rows => rows.map(row => JSON.stringify(stable(row))).sort();
const money = value => {
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100))) changed();
    return Math.round(value * 100);
};
const seller = row => ({ type: row.sellerType || (row.vendor || row.vendorId ? 'vendor' : 'naijago'),
    id: ref(row.sellerId || row.vendor || row.vendorId || null) });

// Recheck economic/fulfilment identity, not mutable marketing copy or pictures.
// Never rewrite the original receipt or increase its charge automatically.
function paymentQuoteFingerprint(quote) {
    const fee = row => ({
        shipping: money(row.shippingPrice), original: money(row.originalShippingPrice ?? row.shippingPrice),
        commission: money(row.platformFee), subtotal: money(row.subtotal),
        discount: money(row.subscriptionDeliveryDiscount ?? 0), subscribed: row.subscriptionFreeDeliveryApplied === true,
    });
    return JSON.stringify(stable({
        total: money(quote.totalPrice), subtotal: money(quote.totalSubtotal), commission: money(quote.totalPlatformFees),
        shipping: money(quote.totalShippingPrice), original: money(quote.originalShippingPrice ?? quote.totalShippingPrice),
        tax: money(quote.taxPrice ?? quote.totalTaxPrice ?? 0), discount: money(quote.subscriptionDeliveryDiscount ?? 0),
        subscribed: quote.subscriptionFreeDeliveryApplied === true, plan: quote.subscriptionPlanId || '',
        shipments: sorted(quote.shipmentSummaries.map(row => ({
            seller: seller(row), method: row.fulfillmentMethod || 'delivery', fees: fee(row),
            location: { latitude: row.vendorLocation?.latitude, longitude: row.vendorLocation?.longitude },
            pickupTime: row.pickupDetails?.selectedTime ? new Date(row.pickupDetails.selectedTime).toISOString() : null,
            items: sorted(row.items.map(item => ({
                product: ref(item.product), offer: ref(item.offer), variant: ref(item.variantId),
                quantity: item.quantity, size: item.selectedSize ?? null, price: money(item.price),
                commissionType: item.commissionType || 'percentage', commission: money(item.itemCommission ?? 0),
                fixedCommission: item.commissionKoboPerUnit || 0,
            }))),
        }))),
    }));
}

function createCheckoutPaymentFreshnessService({ Shipment, calculateCheckoutSummary }) {
    async function check(order, { session = null } = {}) {
        if (!order || order.isPaid || order.mainOrderStatus !== 'pending_payment') {
            throw new CheckoutCatalogError('ORDER_NOT_PAYABLE', 'This order cannot accept another payment.');
        }
        const query = Shipment.find({ mainOrder: order._id });
        if (session) query.session(session);
        const rows = plain(await query), stored = plain(order);
        if (!rows.length || rows.some(row => !row.items?.length)) changed();
        const fulfillmentSelections = {}, cartItems = [];
        for (const row of rows) {
            const owner = seller(row), key = owner.type === 'naijago' ? 'naijago' : 'vendor:' + owner.id;
            const selection = { method: row.fulfillmentMethod || 'delivery', selectedTime: row.pickupDetails?.selectedTime || null };
            if (fulfillmentSelections[key] && JSON.stringify(fulfillmentSelections[key]) !== JSON.stringify(selection)) changed();
            fulfillmentSelections[key] = selection;
            cartItems.push(...row.items.map(item => ({
                product: ref(item.product), offer: ref(item.offer), variantId: ref(item.variantId),
                quantity: item.quantity, selectedSize: item.selectedSize ?? null, customerNote: item.customerNote || '',
            })));
        }
        const current = await calculateCheckoutSummary({ userId: ref(order.user), cartItems, session,
            shippingAddress: stored.shippingAddress, userLocation: stored.userLocation, fulfillmentSelections,
            deliveryAt: stored.schedule?.mode === 'scheduled' ? stored.schedule.startAt : null });
        if (paymentQuoteFingerprint({ ...stored, shipmentSummaries: rows }) !== paymentQuoteFingerprint(current)) changed();
        return current;
    }
    return { check };
}
module.exports = { createCheckoutPaymentFreshnessService, paymentQuoteFingerprint };
