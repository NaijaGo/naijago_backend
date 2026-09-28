'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCheckoutPaymentFreshnessService, paymentQuoteFingerprint } = require('../services/checkoutPaymentFreshnessService');
const clone = value => structuredClone(value);
function fixture() {
    const row = { sellerType: 'vendor', sellerId: 'seller', vendorLocation: { latitude: 9, longitude: 7 },
        fulfillmentMethod: 'delivery', subtotal: 2000, platformFee: 114, shippingPrice: 500, originalShippingPrice: 500,
        subscriptionDeliveryDiscount: 0, subscriptionFreeDeliveryApplied: false,
        items: [{ product: 'product', offer: 'offer', variantId: null, quantity: 2, price: 1000,
            commissionType: 'fixed_per_unit', commissionKoboPerUnit: 5700, itemCommission: 114, selectedSize: 'M',
            customerNote: 'Synthetic note', name: 'Old name', image: 'old-image' }] };
    const order = { _id: 'order', user: 'owner', isPaid: false, mainOrderStatus: 'pending_payment',
        shippingAddress: { address: 'Synthetic address' }, userLocation: { latitude: 9.1, longitude: 7.1 },
        totalPrice: 2500, totalSubtotal: 2000, totalPlatformFees: 114, totalShippingPrice: 500, originalShippingPrice: 500,
        totalTaxPrice: 0, subscriptionDeliveryDiscount: 0, subscriptionFreeDeliveryApplied: false };
    const quote = { ...clone(order), taxPrice: 0, shipmentSummaries: [clone(row)] };
    const calls = [], sessions = [], rows = [row];
    const service = createCheckoutPaymentFreshnessService({ Shipment: { find(filter) {
        assert.deepEqual(filter, { mainOrder: 'order' });
        return { session(value) { sessions.push(value); return this; }, then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); } };
    } }, calculateCheckoutSummary: async args => { calls.push(args); return quote; } });
    return { service, calls, sessions, rows, row, order, quote };
}
test('freshness reuses the real quote inputs, trusted owner, notes and caller transaction without changing the receipt', async () => {
    const f = fixture(), session = {}, before = clone(f.order);
    await f.service.check(f.order, { session });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].session, session); assert.deepEqual(f.sessions, [session]);
    assert.equal(f.calls[0].userId, 'owner'); assert.equal(f.calls[0].deliveryAt, null);
    assert.equal(f.calls[0].cartItems[0].customerNote, 'Synthetic note');
    assert.equal(f.calls[0].cartItems[0].selectedSize, 'M');
    assert.deepEqual(f.order, before);
});
test('changes to price, seller, variant, fulfilment location and fee components require fresh approval', async () => {
    for (const change of [
        q => { q.totalPrice++; }, q => { q.shipmentSummaries[0].items[0].price++; },
        q => { q.shipmentSummaries[0].sellerId = 'another-seller'; },
        q => { q.shipmentSummaries[0].items[0].offer = 'another-offer'; },
        q => { q.shipmentSummaries[0].items[0].variantId = 'another-variant'; },
        q => { q.shipmentSummaries[0].vendorLocation.latitude++; },
        q => { q.totalShippingPrice--; q.totalSubtotal++; },
        q => { q.shipmentSummaries[0].items[0].commissionKoboPerUnit++; },
        q => { q.shipmentSummaries[0].fulfillmentMethod = 'pickup'; },
    ]) {
        const f = fixture(); change(f.quote);
        await assert.rejects(f.service.check(f.order), { code: 'PAYMENT_QUOTE_CHANGED' });
    }
});
test('name, image and descriptive edits do not change an otherwise identical payment', async () => {
    const f = fixture();
    Object.assign(f.quote.shipmentSummaries[0].items[0], { name: 'New name', image: 'new-image', productSnapshot: { description: 'New description' } });
    await f.service.check(f.order);
});
test('pickup choices and selected time are preserved, not silently changed to delivery', async () => {
    const f = fixture(), date = '2030-01-01T12:00:00.000Z';
    for (const row of [f.row, f.quote.shipmentSummaries[0]]) {
        row.fulfillmentMethod = 'pickup'; row.pickupDetails = { selectedTime: date };
        row.shippingPrice = row.originalShippingPrice = 0;
    }
    for (const order of [f.order, f.quote]) { order.totalPrice = 2000; order.totalShippingPrice = order.originalShippingPrice = 0; }
    await f.service.check(f.order);
    assert.deepEqual(f.calls[0].fulfillmentSelections['vendor:seller'], { method: 'pickup', selectedTime: date });
});
test('scheduled price validation evaluates the trusted receipt window, not the client clock', async () => {
    const f = fixture(); f.order.schedule = { mode: 'scheduled', startAt: new Date('2030-01-01T12:00:00Z') };
    await f.service.check(f.order);
    assert.equal(f.calls[0].deliveryAt, '2030-01-01T12:00:00.000Z');
});
test('expired benefits, altered subscription plan and invalid amounts cannot pass payment freshness', async () => {
    for (const change of [
        q => { q.subscriptionPlanId = 'new-plan'; },
        q => { q.subscriptionFreeDeliveryApplied = true; q.subscriptionDeliveryDiscount = 500; },
        q => { q.totalPrice = NaN; }, q => { q.shipmentSummaries[0].items[0].price = -1; },
    ]) {
        const f = fixture(); change(f.quote);
        await assert.rejects(f.service.check(f.order), { code: 'PAYMENT_QUOTE_CHANGED' });
    }
});
test('empty, paid or cancelled orders cannot produce a new payment quote', async () => {
    const f = fixture(); f.rows.length = 0;
    await assert.rejects(f.service.check(f.order), { code: 'PAYMENT_QUOTE_CHANGED' });
    for (const order of [{ ...f.order, isPaid: true }, { ...f.order, mainOrderStatus: 'cancelled' }]) {
        await assert.rejects(f.service.check(order), { code: 'ORDER_NOT_PAYABLE' });
    }
    assert.equal(f.calls.length, 0);
});
test('fingerprint does not depend on shipment or item ordering', () => {
    const f = fixture(), quote = clone(f.quote);
    quote.shipmentSummaries[0].items.push({ ...clone(f.row.items[0]), product: 'another-product' });
    quote.shipmentSummaries.push({ ...clone(f.row), sellerId: 'another-seller' });
    const reordered = clone(quote); reordered.shipmentSummaries.reverse();
    reordered.shipmentSummaries.forEach(row => row.items.reverse());
    assert.equal(paymentQuoteFingerprint(quote), paymentQuoteFingerprint(reordered));
});
