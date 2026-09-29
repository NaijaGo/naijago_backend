'use strict';
const mongoose = require('mongoose');
const BackgroundJob = require('../models/BackgroundJob');
const DeliveryReservation = require('../models/DeliveryReservation');
const DeliveryWindow = require('../models/DeliveryWindow');
const AppSetting = require('../models/AppSetting');
const GroupOrder = require('../models/GroupOrder');
const RecurringPlan = require('../models/RecurringPlan');
const RecurringOccurrence = require('../models/RecurringOccurrence');
const Product = require('../models/Product');
const ProductOffer = require('../models/ProductOffer');
const User = require('../models/User');
const { createBackgroundJobService } = require('./backgroundJobService');
const { createDeliveryReservationService } = require('./deliveryReservationService');
const { createPlannedOrderServices } = require('./plannedOrderServiceFactory');
const { createFeatureReadiness } = require('./featureReadiness');
const orderRoutes = require('../routes/orderRoutes');

const models = {
    BackgroundJob, DeliveryReservation, DeliveryWindow, AppSetting, GroupOrder,
    RecurringPlan, RecurringOccurrence, Product, ProductOffer, User,
};
const ready = createFeatureReadiness({
    models: [BackgroundJob, DeliveryReservation, DeliveryWindow, GroupOrder, RecurringPlan, RecurringOccurrence],
});
let runtime;
let reservationRuntime;

function enabled() {
    return process.env.PLANNED_ORDERS_ENABLED === 'true';
}

function services() {
    if (runtime) return runtime;
    const signingSecret = process.env.PLANNED_ORDER_SIGNING_SECRET || process.env.JWT_SECRET;
    const queue = createBackgroundJobService({
        Job: BackgroundJob,
        allowedTypes: ['group.notify', 'recurring.notify'],
    });
    const reservations = createDeliveryReservationService({
        Window: DeliveryWindow,
        Reservation: DeliveryReservation,
        connection: mongoose.connection,
    });
    reservationRuntime = reservations;
    runtime = createPlannedOrderServices({
        models,
        connection: mongoose.connection,
        queue,
        reservations,
        calculateCheckoutSummary: orderRoutes.calculateCheckoutSummary,
        createUnpaidOrder: orderRoutes.createUnpaidOrder,
        signingSecret,
    });
    return runtime;
}

function lifecycle() {
    const planned = services();
    return {
        closeDueGroups: planned.groups.closeDue,
        generateDueRecurring: planned.recurring.generateDue,
        expireReservations: reservationRuntime.expire,
    };
}

module.exports = { enabled, ready, services, lifecycle };
