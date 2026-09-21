'use strict';

const { canDispatch } = require('./orderPlanningPolicy');
const fail = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409 }); };
const needsPaymentReview = order => order?.mainOrderStatus === 'payment_review' ||
    order?.paymentResult?.fulfillmentStatus === 'needs_attention' || order?.schedule?.state === 'needs_attention';

function assertCanPrepare(order, now = new Date()) {
    if (!order) fail('ORDER_NOT_FOUND', 'The order is no longer available.');
    if (needsPaymentReview(order)) fail('ORDER_PAYMENT_REVIEW', 'Payment needs support review. Do not prepare, dispatch or charge this order again.');
    if (order.isPaid !== true || order.mainOrderStatus === 'pending_payment') fail('ORDER_UNPAID', 'Wait for payment confirmation before preparing this order.');
    if (order.isDelivered || ['cancelled', 'completed', 'delivered'].includes(order.mainOrderStatus)) fail('ORDER_CLOSED', 'This order is already closed.');
    if (order.schedule != null && order.schedule.mode !== 'now' &&
        (order.schedule.mode !== 'scheduled' || order.schedule.state !== 'confirmed' || !(new Date(order.schedule.endAt) > now))) {
        fail('SCHEDULE_UNAVAILABLE', 'The delivery window needs support review before preparation.');
    }
}

function assertAdminStatusChange(order, status, now = new Date()) {
    if (needsPaymentReview(order)) fail('ORDER_PAYMENT_REVIEW', 'Resolve the payment review through support before changing this order.');
    if (status === 'pending_payment' && order.isPaid) fail('ORDER_ALREADY_PAID', 'A paid order cannot be moved back to pending payment.');
    if (['pending_payment', 'cancelled'].includes(status)) {
        if (order.schedule?.mode === 'scheduled') fail('SCHEDULE_LOCKED', 'Scheduled changes require reservation and payment reconciliation. Use support.');
        return;
    }
    // Existing completed-order payout repair remains available for legacy
    // orders, but never for an unpaid or review-blocked payment.
    if (order.isPaid !== true) fail('ORDER_UNPAID', 'Payment must be confirmed before fulfillment or payout.');
    if (order.schedule?.mode === 'scheduled' && status !== 'processing' && !canDispatch(order, now)) {
        fail('SCHEDULE_NOT_DUE', 'This scheduled order cannot be dispatched or completed through this status control.');
    }
    if (status === 'processing') assertCanPrepare(order, now);
}

module.exports = { needsPaymentReview, assertCanPrepare, assertAdminStatusChange };
