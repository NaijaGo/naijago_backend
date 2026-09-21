'use strict';
const { fail, instant } = require('../utils/orderPlanningPolicy');

const reviewCodes = new Set(['RESERVATION_NOT_FOUND', 'RESERVATION_CHANGED', 'RESERVATION_EXPIRED', 'PAID_SLOT_NEEDS_ATTENTION', 'ORDER_NOT_PAYABLE']);

// No provider calls: callers MUST verify payment with the gateway first. The
// same session owns reservation confirmation, inventory, wallet and receipt.
function createScheduledOrderPaymentService({ Reservation, reservations, now = () => new Date() }) {
    async function inspect(order, session) {
        if (!order || order.isPaid || order.mainOrderStatus !== 'pending_payment') fail('ORDER_NOT_PAYABLE', 'This order cannot accept another payment.', 409);
        if (!order.schedule) return null;
        if (order.schedule.mode !== 'scheduled' || !['held', 'confirmed'].includes(order.schedule.state)) {
            fail('RESERVATION_CHANGED', 'Your delivery reservation is no longer available.', 409);
        }
        const query = Reservation.findOne({ order: order._id, owner: order.user });
        if (session) query.session(session);
        const row = await query;
        if (!row) fail('RESERVATION_NOT_FOUND', 'Your delivery reservation could not be found.', 409);
        const fields = ['startAt', 'endAt', 'dispatchAt', 'changeCutoffAt', 'expiresAt'];
        if (String(row.order) !== String(order._id) || String(row.owner) !== String(order.user) ||
            String(row._id) !== String(order.schedule.reservation) || row.policyRevision !== order.schedule.policyRevision ||
            row.timeZone !== order.schedule.timeZone || fields.some((key) => +instant(row[key]) !== +instant(order.schedule[key]))) {
            fail('RESERVATION_CHANGED', 'Your delivery reservation changed. Please contact support.', 409);
        }
        if (row.state !== 'held' || row.expiresAt <= now() || row.dispatchAt <= now()) {
            fail('RESERVATION_EXPIRED', 'Your delivery window hold expired. Choose a new checkout before paying.', 409);
        }
        return row;
    }
    async function confirm(order, session) {
        if (!session?.inTransaction()) fail('TRANSACTION_REQUIRED', 'Payment settlement requires a transaction.', 500);
        const row = await inspect(order, session);
        if (!row) return null;
        const confirmed = await reservations.confirm({ orderId: String(order._id), owner: String(order.user), session });
        order.schedule.state = 'confirmed';
        order.schedule.confirmedAt = confirmed.confirmedAt;
        return confirmed;
    }
    async function markVerifiedReview({ order, error, session }) {
        if (!session?.inTransaction()) fail('TRANSACTION_REQUIRED', 'Payment review requires a transaction.', 500);
        if (!order.isPaid || !order.paymentResult?.verifiedAt || !order.paymentResult?.tx_ref) {
            fail('VERIFIED_PAYMENT_REQUIRED', 'Only a verified gateway payment can enter payment review.', 500);
        }
        if (!reviewCodes.has(error?.code)) throw error;
        // Release only an expired HELD reservation. Never free another owner's
        // resources, or a confirmed booking whose integrity needs review.
        if (order.schedule && ['RESERVATION_EXPIRED', 'PAID_SLOT_NEEDS_ATTENTION'].includes(error.code)) {
            await reservations.release({ orderId: String(order._id), owner: String(order.user), expiredOnly: true, session });
        }
        if (order.schedule) order.schedule.state = 'needs_attention';
        order.mainOrderStatus = 'payment_review';
        order.paymentResult = { ...order.paymentResult, fulfillmentStatus: 'needs_attention', reviewReason: error.code,
            reviewOpenedAt: now(), reviewMessage: 'Payment received. Your order needs support review. Please do not pay again.' };
    }
    return { inspect, confirm, markVerifiedReview };
}

module.exports = { createScheduledOrderPaymentService, reviewCodes };
