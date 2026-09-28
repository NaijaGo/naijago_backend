'use strict';
const crypto = require('node:crypto');
const { normalizeKorapayTransaction, korapayPaymentMatchesOrder, buildKorapayPendingPaymentResult,
    verifyKorapayWebhookSignature, safeKorapayCheckoutUrl } = require('../utils/korapayPayment');

const fail = (code, message, statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode }); };
// Reuses MainOrder and the existing transactional inventory/payment settlement.
// Gateway calls are injectable: automated tests never need a provider key/network.
function createKorapayOrderService({ Order, User, startSession, getConfig, initiate, verify,
    settle, recover, notify, referral, now = () => new Date() }) {
    const receiptMode = order => {
        const mode = order.paymentResult?.mode;
        if (!['test', 'live'].includes(mode)) fail('PAYMENT_MODE_MISSING', 'Payment needs support review. Please do not pay again.');
        getConfig({ expectedMode: mode });
        return mode;
    };
    const response = order => ({ provider: 'korapay', orderId: order._id,
        tx_ref: order.paymentResult.tx_ref, checkout_url: order.paymentResult.checkoutUrl,
        amount: order.totalPrice, currency: 'NGN', mode: order.paymentResult.mode,
        status: order.paymentResult.status });

    async function initialize(order, buyer) {
        const owner = String(order.user), approvedTotal = order.totalPrice;
        const config = getConfig({ checkout: true });
        if (!buyer?.email) fail('PAYMENT_EMAIL_REQUIRED', 'An email address is required for payment.', 400);
        if (!order.paymentResult?.tx_ref) {
            const ref = `NGK_${order._id}_${crypto.randomBytes(12).toString('hex')}`;
            const claimed = await Order.findOneAndUpdate({ _id: order._id, user: order.user, totalPrice: approvedTotal, isPaid: false,
                mainOrderStatus: 'pending_payment', $or: [{ 'paymentResult.tx_ref': { $exists: false } },
                    { 'paymentResult.tx_ref': null }, { 'paymentResult.tx_ref': '' }] },
            { $set: { paymentResult: { provider: 'korapay', tx_ref: ref, mode: config.mode,
                status: 'initiated', expectedAmount: order.totalPrice, currency: 'NGN',
                initiatedAt: now(), initializationState: 'reserved' } } }, { new: true });
            order = claimed || await Order.findById(order._id);
        }
        if (!order || String(order.user) !== owner || order.totalPrice !== approvedTotal || order.isPaid || order.mainOrderStatus !== 'pending_payment' ||
            order.paymentResult?.provider !== 'korapay') fail('PAYMENT_ATTEMPT_EXISTS', 'Check your existing order before trying another payment.');
        receiptMode(order);
        if (order.paymentResult.checkoutUrl) {
            if (!safeKorapayCheckoutUrl(order.paymentResult.checkoutUrl)) fail('INVALID_CHECKOUT_URL', 'The payment link needs support review.');
            return response(order);
        }
        const ref = order.paymentResult.tx_ref, token = crypto.randomBytes(16).toString('hex');
        const claimFilter = { _id: order._id, user: order.user, totalPrice: approvedTotal, isPaid: false, mainOrderStatus: 'pending_payment',
            'paymentResult.provider': 'korapay', 'paymentResult.tx_ref': ref, 'paymentResult.mode': config.mode,
            'paymentResult.checkoutUrl': { $exists: false },
            $or: [{ 'paymentResult.initializeLeaseUntil': { $exists: false } },
                { 'paymentResult.initializeLeaseUntil': { $lte: now() } }] };
        const previous = await Order.findOneAndUpdate(claimFilter, { $set: {
            'paymentResult.initializeToken': token, 'paymentResult.initializeLeaseUntil': new Date(now().getTime() + 120000),
            'paymentResult.initializationState': 'initializing' } }, { new: false });
        if (!previous) fail('PAYMENT_SETUP_PENDING', 'Payment setup is already in progress. Please wait and check this order.');
        const owned = { _id: order._id, user: order.user, totalPrice: approvedTotal, isPaid: false,
            mainOrderStatus: 'pending_payment', 'paymentResult.provider': 'korapay',
            'paymentResult.mode': config.mode, 'paymentResult.tx_ref': ref, 'paymentResult.initializeToken': token };
        try {
            if (previous.paymentResult.initializationState !== 'reserved') {
                const existing = await verify({ transactionRef: ref, mode: config.mode });
                if (existing?.notFound !== true) fail('PAYMENT_CONFIRMATION_PENDING', 'An existing payment is being checked. Please do not pay again.');
            }
            const result = await initiate({ amountNaira: order.totalPrice, email: buyer.email,
                customerName: `${buyer.firstName || ''} ${buyer.lastName || ''}`.trim() || buyer.email,
                transactionRef: ref, orderId: order._id, mode: config.mode });
            const saved = await Order.findOneAndUpdate(owned, { $set: {
                'paymentResult.checkoutUrl': result.data.checkout_url, 'paymentResult.initializationState': 'ready',
            }, $unset: { 'paymentResult.initializeToken': '', 'paymentResult.initializeLeaseUntil': '' } }, { new: true });
            if (!saved) fail('PAYMENT_STATE_CHANGED', 'Payment state changed. Check My Orders before paying.');
            return response(saved);
        } catch (error) {
            // Preserve reference/mode on timeout; a retry verifies it before reusing it.
            await Order.updateOne(owned, { $set: { 'paymentResult.initializationState': 'uncertain',
                'paymentResult.initializeLeaseUntil': new Date(0) }, $unset: { 'paymentResult.initializeToken': '' } });
            throw error;
        }
    }

    async function confirm({ order, buyer, session, app, method }) {
        const txRef = order.paymentResult.tx_ref;
        const result = await verify({ transactionRef: txRef, mode: receiptMode(order) });
        if (!korapayPaymentMatchesOrder(result, order, txRef)) {
            order.paymentResult = buildKorapayPendingPaymentResult(order.paymentResult, result, txRef, now());
            await order.save({ session });
            return { settled: false, order };
        }
        const tx = normalizeKorapayTransaction(result);
        const updated = await settle({ order, buyer, session, app, method, provider: 'korapay',
            verifiedTx: { id: tx.id, status: 'successful', tx_ref: txRef, gateway_ref: tx.gateway_ref,
                amount: tx.amountKobo / 100, currency: 'NGN', email: tx.email || buyer.email } });
        return { settled: true, order: updated };
    }
    async function afterCommit(app, order) {
        // A notification outage must never turn a committed payment into a failure.
        try { await notify({ app, order, paymentMethod: 'KoraPay' }); }
        catch { console.error('[KORAPAY] Vendor notification needs retry.'); }
        try { await referral(order.user); }
        catch { console.error('[KORAPAY] Referral processing needs retry.'); }
    }
    async function reconcile(filter, app, method) {
        const session = await startSession();
        let settled;
        try {
            await session.withTransaction(async () => {
                settled = null;
                const order = await Order.findOne({ ...filter, isPaid: false, 'paymentResult.provider': 'korapay' }).session(session);
                if (!order) return;
                const buyer = await User.findById(order.user).session(session);
                if (!buyer) throw new Error('Buyer account missing.');
                const result = await confirm({ order, buyer, session, app, method });
                if (result.settled) settled = result.order;
            });
            if (settled) await afterCommit(app, settled);
        } catch (error) {
            if (!await recover(error)) throw error;
        } finally { await session.endSession(); }
    }
    async function webhook(req, res) {
        let config;
        try { config = getConfig(); } catch { return res.status(503).send('Payment configuration unavailable'); }
        if (!verifyKorapayWebhookSignature({ body: req.body, signature: req.headers['x-korapay-signature'], secretKey: config.secretKey })) {
            return res.status(401).send('Signature mismatch');
        }
        const ref = req.body.data.reference;
        if (!['charge.success', 'charge.failed'].includes(req.body.event) ||
            typeof ref !== 'string' || !/^[a-zA-Z0-9_-]{8,120}$/.test(ref)) return res.sendStatus(200);
        try {
            await reconcile({ 'paymentResult.tx_ref': ref }, req.app, 'webhook');
            return res.sendStatus(200);
        } catch (error) {
            console.error('[KORAPAY WEBHOOK] Confirmation deferred:', { code: error.code || 'RECONCILIATION_FAILED' });
            return res.status(503).send('Confirmation deferred');
        }
    }
    let running = false;
    async function recoverPending(app) {
        if (running) return;
        try { getConfig(); } catch { return; }
        running = true;
        try {
            const candidates = await Order.find({ isPaid: false, mainOrderStatus: 'pending_payment',
                'paymentResult.provider': 'korapay', 'paymentResult.tx_ref': { $exists: true, $ne: '' } })
                .sort({ 'paymentResult.lastCheckedAt': 1, createdAt: 1 }).limit(20);
            for (const order of candidates) {
                try { await reconcile({ _id: order._id, 'paymentResult.tx_ref': order.paymentResult.tx_ref }, app, 'scheduled_reconciliation'); }
                catch (error) { console.error('[KORAPAY RECOVERY] Confirmation deferred:', { code: error.code || 'RECONCILIATION_FAILED' }); }
            }
        } finally { running = false; }
    }
    return { initialize, confirm, afterCommit, webhook, recoverPending };
}
module.exports = { createKorapayOrderService };
