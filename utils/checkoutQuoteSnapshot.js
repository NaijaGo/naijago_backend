'use strict';
const { CheckoutCatalogError } = require('../services/checkoutCatalogService');
const { scheduleQuoteSnapshot } = require('./scheduledOrderSnapshot');
const ref = (value) => value == null ? null : String(value._id || value);
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const money = (value) => {
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100))) {
        throw new CheckoutCatalogError('QUOTE_CHANGED', 'Refresh and approve the latest order total.');
    }
    return Math.round(value * 100);
};
const location = (value = {}) => ({ latitude: value.latitude, longitude: value.longitude,
    formattedAddress: value.formattedAddress || '', address: value.address || '', addressLine: value.addressLine || '' });

// Shared projection of the quote and recalculated creation result. Compare each
// charge and seller/selection, not just the grand total: offsetting differences
// must also require a new approval. Amounts are compared in integer kobo.
function checkoutQuoteSnapshot(quote) {
    if (!Array.isArray(quote?.shipmentSummaries) || !quote.shipmentSummaries.length) {
        throw new CheckoutCatalogError('QUOTE_CHANGED', 'Refresh and approve the latest order details.');
    }
    return stable(JSON.parse(JSON.stringify({
        totalSubtotal: money(quote.totalSubtotal), totalShippingPrice: money(quote.totalShippingPrice),
        originalShippingPrice: money(quote.originalShippingPrice), totalPlatformFees: money(quote.totalPlatformFees),
        totalPrice: money(quote.totalPrice), taxPrice: money(quote.taxPrice),
        subscriptionDeliveryDiscount: money(quote.subscriptionDeliveryDiscount),
        subscriptionFreeDeliveryApplied: quote.subscriptionFreeDeliveryApplied === true, subscriptionPlanId: quote.subscriptionPlanId || '',
        shippingAddress: quote.shippingAddress, userLocation: location(quote.userLocation),
        schedule: scheduleQuoteSnapshot(quote.schedule),
        shipments: quote.shipmentSummaries.map((summary) => ({
            sellerType: summary.sellerType, sellerId: ref(summary.sellerId), sellerName: summary.sellerName,
            location: location(summary.vendorLocation), fulfillmentMethod: summary.fulfillmentMethod,
            subtotal: money(summary.subtotal), shippingPrice: money(summary.shippingPrice), platformFee: money(summary.platformFee),
            originalShippingPrice: money(summary.originalShippingPrice), subscriptionDeliveryDiscount: money(summary.subscriptionDeliveryDiscount),
            subscriptionFreeDeliveryApplied: summary.subscriptionFreeDeliveryApplied === true,
            items: summary.items.map((item) => ({ product: ref(item.product), offer: ref(item.offer), variantId: ref(item.variantId),
                quantity: item.quantity, price: money(item.price), selectedSize: item.selectedSize ?? null, sku: item.sku || '',
                name: item.name, image: item.image, productSnapshot: item.productSnapshot,
                commissionType: item.commissionType, commissionKoboPerUnit: item.commissionKoboPerUnit || 0,
                itemCommission: money(item.itemCommission), customerNote: item.customerNote || '' })),
        })),
    })));
}
function assertCheckoutQuoteUnchanged(expected, actual) {
    if (JSON.stringify(checkoutQuoteSnapshot(expected)) !== JSON.stringify(checkoutQuoteSnapshot(actual))) {
        throw new CheckoutCatalogError('QUOTE_CHANGED', 'Your order details or price changed. Review and approve the new quote.');
    }
}
module.exports = { checkoutQuoteSnapshot, assertCheckoutQuoteUnchanged };
