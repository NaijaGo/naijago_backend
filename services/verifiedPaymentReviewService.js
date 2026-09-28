'use strict';
const { CheckoutCatalogError } = require('./checkoutCatalogService');

const reviewableCodes = new Set(['INSUFFICIENT_STOCK', 'INVALID_QUANTITY', 'SUBSCRIPTION_BENEFIT_UNAVAILABLE', 'ORDER_ITEMS_UNAVAILABLE']);
const message = 'Payment received. Your order needs support review. Please do not pay again.';
const fail = (code, text) => { throw new CheckoutCatalogError(code, text); };

// Internal only: attempt() is called AFTER server-to-server gateway verification.
// Evidence is held privately, never accepted from a request body or an error field.
// The failed inventory transaction MUST abort before recover() starts a fresh one.
function createVerifiedPaymentReviewService({ Order, connection, now = () => new Date() }) {
    const evidence = new WeakMap();
    async function attempt(args, settle) {
        const { order, verifiedTx, provider = 'flutterwave', method, session } = args;
        const snapshot = {
            orderId: String(order._id), owner: String(order.user), total: Number(order.totalPrice),
            reference: verifiedTx.tx_ref, provider, method, session,
            payment: { id: verifiedTx.id, status: verifiedTx.status, tx_ref: verifiedTx.tx_ref,
                provider, gateway_ref: verifiedTx.gateway_ref, flw_ref: verifiedTx.flw_ref,
                amount: verifiedTx.amount, currency: verifiedTx.currency,
                email_address: verifiedTx.customer?.email || verifiedTx.email },
        };
        try { return await settle(); }
        catch (error) {
            if (error instanceof CheckoutCatalogError && reviewableCodes.has(error.code)) {
                evidence.set(error, { ...snapshot, reason: error.code });
            }
            throw error;
        }
    }
    async function recover(error) {
        const proof = evidence.get(error);
        if (!proof) return null; // Wallet, provider/network and database errors are NOT paid evidence.
        if (proof.session?.inTransaction()) fail('ROLLBACK_REQUIRED', 'Payment review must wait for settlement rollback.');
        if (!['squad', 'flutterwave'].includes(proof.provider) || proof.payment.status !== 'successful' ||
            typeof proof.reference !== 'string' || !proof.reference.trim() ||
            String(proof.payment.currency).toUpperCase() !== 'NGN' ||
            !Number.isFinite(proof.total) || proof.total < 0 ||
            proof.payment.amount == null || proof.payment.amount === '' ||
            !Number.isFinite(Number(proof.payment.amount)) || Number(proof.payment.amount) < proof.total) {
            fail('VERIFIED_PAYMENT_REQUIRED', 'Payment evidence does not match this order.');
        }
        return connection.transaction(async (session) => {
            // Never save the mutated Mongoose document from the aborted transaction.
            const order = await Order.findById(proof.orderId).session(session);
            if (!order || String(order.user) !== proof.owner || Number(order.totalPrice) !== proof.total ||
                (order.paymentResult?.tx_ref && order.paymentResult.tx_ref !== proof.reference) ||
                String(order.paymentResult?.provider || 'flutterwave') !== proof.provider) {
                fail('PAYMENT_REVIEW_CONFLICT', 'Payment needs support reconciliation. Please do not pay again.');
            }
            if (order.isPaid) {
                if (order.paymentResult?.tx_ref !== proof.reference) fail('PAYMENT_REVIEW_CONFLICT', message);
                return order; // A concurrent callback already settled or recorded this payment.
            }
            const used = await Order.findOne({ _id: { $ne: order._id }, 'paymentResult.tx_ref': proof.reference }).session(session);
            if (used) fail('PAYMENT_REFERENCE_USED', 'Payment reference belongs to another order.');
            const date = now();
            order.paymentResult = { ...(order.paymentResult || {}), ...proof.payment,
                verifiedAt: date, verificationMethod: proof.method, fulfillmentStatus: 'needs_attention',
                reviewReason: proof.reason, reviewOpenedAt: date, reviewMessage: message,
                reviewPreviousOrderStatus: order.mainOrderStatus, reviewInventoryState: 'not_committed' };
            order.isPaid = true;
            order.paidAt = order.paidAt || date;
            order.mainOrderStatus = 'payment_review';
            if (order.schedule) order.schedule.state = 'needs_attention';
            // No stock, wallet, subscription, shipment, capacity or external writes.
            // Existing review guards stop fulfilment; resolution needs an audited flow.
            return order.save({ session });
        });
    }
    return { attempt, recover, hasEvidence: error => evidence.has(error) };
}
module.exports = { createVerifiedPaymentReviewService };
