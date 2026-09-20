'use strict';
const { createCheckoutCatalogService } = require('./checkoutCatalogService');
const { createPlannedOrderCatalogService } = require('./plannedOrderCatalogService');
const { createPlannedCheckoutApproval } = require('../utils/plannedCheckoutApproval');
const { createGroupOrderService } = require('./groupOrderService');
const { createRecurringOrderService } = require('./recurringOrderService');
const { fail } = require('../utils/orderPlanningPolicy');

// Explicit composition only: no env reads, jobs, database connection or routes
// start on import. Supply the existing router.calculateCheckoutSummary and the
// backend's private JWT_SECRET (>=32 bytes) when authenticated APIs are mounted.
function createPlannedOrderServices({ models, connection, queue, calculateCheckoutSummary, createUnpaidOrder, checkSchedule, signingSecret, now }) {
    const catalog = createCheckoutCatalogService(models);
    const adapters = createPlannedOrderCatalogService({ catalog, User: models.User, calculateCheckoutSummary, checkSchedule });
    const approval = createPlannedCheckoutApproval({ secret: signingSecret, now });
    const checkout = { ...adapters, approval };
    const groups = createGroupOrderService({ Group: models.GroupOrder, connection, queue, validateItems: adapters.validateItems, checkout, now });
    const recurring = createRecurringOrderService({ Plan: models.RecurringPlan, Occurrence: models.RecurringOccurrence,
        connection, queue, validateTemplate: adapters.validateTemplate, validateOccurrence: adapters.validateOccurrence, checkout, now });
    function orderAdapter(paymentMethod, kind) {
        if (typeof createUnpaidOrder !== 'function') fail('CHECKOUT_UNAVAILABLE', 'Planned order creation is not ready.', 503);
        if (!['Card', 'Bank Transfer', 'Wallet'].includes(paymentMethod)) fail('INVALID_PAYMENT_METHOD', 'Choose a valid payment method.');
        return async ({ owner, group, occurrence, quote, session }) => {
            const source = group || occurrence;
            const result = await createUnpaidOrder({ userId: owner, session, expectedQuote: quote,
                planning: { kind, sourceId: source._id, revision: source.revision },
                input: { shippingAddress: quote.shippingAddress, userLocation: quote.userLocation,
                    shipmentSummaries: quote.shipmentSummaries, schedule: quote.schedule, paymentMethod } });
            return result.order;
        };
    }
    // Future authenticated handlers pass only these explicit fields. Order,
    // outbox and source link share the SAME caller-owned Mongo transaction.
    // The existing creator refuses scheduled/recurring orders until slot and
    // dispatch integration is ready; no request can substitute its own adapter.
    const checkoutGroup = async ({ groupId, actor, revision, approvalToken, paymentMethod }) => {
        const createOrder = orderAdapter(paymentMethod, 'group');
        return connection.transaction((session) => groups.checkout({ groupId, actor, revision, approvalToken, session, createOrder }));
    };
    const checkoutRecurring = async ({ occurrenceId, actor, revision, approvalToken, paymentMethod }) => {
        const createOrder = orderAdapter(paymentMethod, 'recurring');
        return connection.transaction((session) => recurring.checkout({ occurrenceId, actor, revision, approvalToken, session, createOrder }));
    };
    return { groups, recurring, checkoutGroup, checkoutRecurring };
}
module.exports = { createPlannedOrderServices };
