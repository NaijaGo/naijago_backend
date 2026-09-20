'use strict';
const { fail, id, PlanningError } = require('../utils/orderPlanningPolicy');
const { normalizeItems } = require('../utils/groupOrderPolicy');
const { CheckoutCatalogError, hasLocation } = require('./checkoutCatalogService');
const { totalKobo } = require('../utils/plannedCheckoutApproval');

// Pass the SAME calculateCheckoutSummary used by POST /orders/summary. No copied
// delivery/commission formulas, provider calls, inventory reservation or charging.
function createPlannedOrderCatalogService({ catalog, User, calculateCheckoutSummary, checkSchedule }) {
    if (!catalog?.resolve || typeof calculateCheckoutSummary !== 'function') throw new TypeError('Planned orders require the shared catalog and checkout quote.');
    async function resolve(items, session) {
        // Across group participants duplicates are deliberate. The catalog sums
        // all lines; each member's own basket is deduplicated by the domain service.
        if (!Array.isArray(items) || !items.length || items.length > 100) fail('INVALID_ITEMS', 'Choose between 1 and 100 checkout lines.');
        return catalog.resolve(items.map((item) => normalizeItems([item])[0]), { session });
    }
    const canonical = (lines) => lines.map((line) => normalizeItems([line.item])[0]);
    const sameSeller = (line, sellerType, sellerId) => line.sellerType === sellerType && String(line.sellerId || '') === String(sellerId || '');
    async function validateItems({ items, sellerType, sellerId, fulfillmentKey, anchorItem, session, purpose }) {
        if (!['vendor', 'naijago'].includes(sellerType) || (sellerType === 'vendor') !== Boolean(sellerId)) fail('INVALID_SELLER', 'Choose one valid seller.');
        if (!Array.isArray(items)) fail('INVALID_ITEMS', 'Choose valid cart items.');
        if (!items.length) {
            // Empty edits only remove a member's basket from an already-owned
            // group. The complete seller/point is revalidated at checkout.
            if (purpose === 'edit' && fulfillmentKey) return { fulfillmentKey, items: [] };
            let key;
            if (anchorItem) {
                const [line] = await resolve([{ ...anchorItem, quantity: 1 }], session);
                if (!sameSeller(line, sellerType, sellerId)) fail('INVALID_SELLER', 'Choose a product from the selected seller.');
                key = line.fulfillmentKey;
            } else if (sellerType === 'vendor') {
                const query = User.findOne({ _id: id(sellerId), isVendor: true, vendorStatus: 'approved' }).select('businessLocation');
                if (session) query.session(session);
                const seller = await query.lean();
                if (!hasLocation(seller?.businessLocation)) fail('INVALID_SELLER', 'This shop is not available for group orders.', 409);
                key = `vendor:${id(sellerId)}:${seller.businessLocation.latitude}:${seller.businessLocation.longitude}`;
            } else fail('PICK_PRODUCT_FIRST', 'Select a NaijaGo product to identify its fulfilment location.');
            if (fulfillmentKey && key !== fulfillmentKey) fail('FULFILLMENT_CHANGED', 'This shop location changed. Please select it again.', 409);
            return { fulfillmentKey: key, items: [] };
        }
        const lines = await resolve(items, session), first = lines[0];
        if (lines.some((line) => !sameSeller(line, sellerType, sellerId) || line.fulfillmentKey !== first.fulfillmentKey) ||
            (fulfillmentKey && first.fulfillmentKey !== fulfillmentKey)) fail('FULFILLMENT_CHANGED', 'Group products must come from the selected shop and fulfilment location.', 409);
        return { fulfillmentKey: first.fulfillmentKey, items: canonical(lines) };
    }
    async function validateTemplate({ items, session }) { return { items: canonical(await resolve(items, session)) }; }
    async function quote({ owner, items, destination, schedule, session }) {
        if (!hasLocation(destination) || !destination.address || !destination.city || !destination.country || !destination.postalCode || !destination.phoneNumber) fail('INVALID_ADDRESS', 'Choose a complete delivery address.');
        const lines = await resolve(items, session);
        if (schedule?.mode === 'scheduled') {
            // No optimistic fallback: a future-time stock quote is not proof of
            // vendor hours, area/rider capacity, lead times or dispatch readiness.
            if (typeof checkSchedule !== 'function') fail('SCHEDULE_UNAVAILABLE', 'Scheduled delivery validation is not ready.', 503);
            const result = await checkSchedule({ owner, lines, destination, schedule, session });
            if (result?.eligible !== true) fail('SCHEDULE_UNAVAILABLE', 'This delivery window is not currently available.', 409);
        }
        const summary = await calculateCheckoutSummary({ userId: owner, cartItems: canonical(lines), shippingAddress: {
            address: destination.address, city: destination.city, country: destination.country, postalCode: destination.postalCode, phoneNumber: destination.phoneNumber },
            userLocation: { latitude: destination.latitude, longitude: destination.longitude }, session });
        return { ...summary, schedule: schedule?.toObject ? schedule.toObject() : schedule || { mode: 'now', timeZone: 'Africa/Lagos' } };
    }
    async function quoteGroup({ group, items, session }) {
        await validateItems({ items, sellerType: group.sellerType, sellerId: group.sellerId, fulfillmentKey: group.fulfillmentKey, session });
        const result = await quote({ owner: group.owner, items, destination: group.destination, schedule: group.schedule, session });
        if (result.shipmentSummaries?.length !== 1) fail('FULFILLMENT_CHANGED', 'A group checkout must contain exactly one shop shipment.', 409);
        return result;
    }
    const quoteOccurrence = ({ occurrence, session }) => quote({ owner: occurrence.owner, items: occurrence.items,
        destination: occurrence.destination, schedule: { mode: 'scheduled', startAt: occurrence.startAt, endAt: occurrence.endAt, timeZone: 'Africa/Lagos' }, session });
    async function validateOccurrence(args) {
        try { const result = await quoteOccurrence(args); return { eligible: true, totalKobo: totalKobo(result) }; }
        catch (error) {
            if ((error instanceof CheckoutCatalogError || error instanceof PlanningError) && [400, 409].includes(error.statusCode)) return { eligible: false };
            throw error; // Infrastructure failures are retried, not false stock warnings.
        }
    }
    return { validateItems, validateTemplate, quoteGroup, quoteOccurrence, validateOccurrence };
}
module.exports = { createPlannedOrderCatalogService };
