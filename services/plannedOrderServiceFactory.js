'use strict';
const { createCheckoutCatalogService } = require('./checkoutCatalogService');
const { createPlannedOrderCatalogService } = require('./plannedOrderCatalogService');
const { createPlannedCheckoutApproval } = require('../utils/plannedCheckoutApproval');
const { createGroupOrderService } = require('./groupOrderService');
const { createRecurringOrderService } = require('./recurringOrderService');

// Explicit composition only: no env reads, jobs, database connection or routes
// start on import. Supply the existing router.calculateCheckoutSummary and the
// backend's private JWT_SECRET (>=32 bytes) when authenticated APIs are mounted.
function createPlannedOrderServices({ models, connection, queue, calculateCheckoutSummary, checkSchedule, signingSecret, now }) {
    const catalog = createCheckoutCatalogService(models);
    const adapters = createPlannedOrderCatalogService({ catalog, User: models.User, calculateCheckoutSummary, checkSchedule });
    const approval = createPlannedCheckoutApproval({ secret: signingSecret, now });
    const checkout = { ...adapters, approval };
    return {
        groups: createGroupOrderService({ Group: models.GroupOrder, connection, queue, validateItems: adapters.validateItems, checkout, now }),
        recurring: createRecurringOrderService({ Plan: models.RecurringPlan, Occurrence: models.RecurringOccurrence,
            connection, queue, validateTemplate: adapters.validateTemplate, validateOccurrence: adapters.validateOccurrence, checkout, now }),
    };
}
module.exports = { createPlannedOrderServices };
