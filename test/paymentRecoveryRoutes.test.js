'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const express = require('express');
const sift = createRequire(require.resolve('mongoose'))('sift').default;
const { CheckoutCatalogError } = require('../services/checkoutCatalogService');
const O = '111111111111111111111111', U = '222222222222222222222222';
const S = '333333333333333333333333', P = '444444444444444444444444';
const ref = 'synthetic-payment-ref', secret = 'synthetic-only-webhook-secret';

async function fixture(t, provider, options = {}) {
    let state = { orders: [{ _id: O, user: U, totalPrice: 2500, isPaid: false, mainOrderStatus: 'pending_payment',
        paymentResult: { tx_ref: ref, ...(provider === 'squad' ? { provider } : {}), status: 'initiated' } }],
        shipments: [{ _id: S, mainOrder: O, shipmentStatus: 'pending_payment', sellerType: 'naijago',
            items: [{ product: P, quantity: 1 }] }], inventory: 2, sales: 0 };
    const calls = { verify: [], notices: 0, referrals: 0, commits: 0, aborts: 0, inventory: 0 };
    function session() {
        let before, active = false;
        return {
            inTransaction: () => active,
            startTransaction() { assert.equal(active, false); before = structuredClone(state); active = true; },
            async abortTransaction() { assert.equal(active, true); state = before; active = false; calls.aborts++; },
            async commitTransaction() { assert.equal(active, true); active = false; calls.commits++; },
            endSession() { assert.equal(active, false); },
            async withTransaction(work) { this.startTransaction(); try { const value = await work(); await this.commitTransaction(); return value; }
                catch (error) { await this.abortTransaction(); throw error; } },
        };
    }
    const connection = { async transaction(work) {
        const tx = session();
        try { return await tx.withTransaction(() => work(tx)); } finally { tx.endSession(); }
    } };
    function doc(row, collection) {
        if (!row) return null;
        return { ...structuredClone(row), async save({ session }) {
            assert.equal(session.inTransaction(), true);
            if (options.failReview && this.mainOrderStatus === 'payment_review') throw new Error('synthetic-review-persistence-failure');
            const { save, ...data } = this;
            state[collection] = state[collection].map(existing => existing._id === data._id ? structuredClone(data) : existing);
            return this;
        } };
    }
    const query = value => ({ session() { return this; }, select() { return this; }, sort() { return this; }, limit() { return this; },
        then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
    const models = {
        MainOrder: {
            findById(id) { return query(doc(state.orders.find(row => row._id === id), 'orders')); },
            findOne(filter) { return query(doc(state.orders.find(sift(filter)), 'orders')); },
            find(filter) { return query(state.orders.filter(sift(filter)).map(row => doc(row, 'orders'))); },
        },
        Shipment: { find(filter) { return query(state.shipments.filter(sift(filter)).map(row => doc(row, 'shipments'))); } },
        User: { findById() { return query({ _id: U, email: 'synthetic@example.invalid' }); } },
    };
    const verified = provider === 'squad'
        ? { data: { transaction_ref: ref, transaction_status: options.pending ? 'pending' : 'success', amount: 250000, currency: 'NGN', email: 'synthetic@example.invalid' } }
        : { status: 'success', data: { tx_ref: ref, status: options.pending ? 'pending' : 'successful', amount: 2500, currency: 'NGN', customer: { email: 'synthetic@example.invalid' } } };
    const file = path.join(__dirname, '../routes/orderRoutes.js'), actualRequire = createRequire(file), module = { exports: {} };
    const pure = new Set(['express', 'crypto', '../services/checkoutCatalogService', '../services/deliveryReservationService',
        '../services/scheduledOrderPaymentService', '../services/verifiedPaymentReviewService', '../services/checkoutPaymentFreshnessService', '../services/shipmentStatusService',
        '../utils/checkoutQuoteSnapshot', '../utils/orderPlanningPolicy', '../utils/orderFulfillmentPolicy',
        '../utils/deliveryScheduleAvailability', '../utils/scheduledOrderSnapshot', '../utils/flutterwavePayment', '../utils/squadPayment']);
    const forbidden = () => { throw new Error('Unregistered live integration forbidden.'); };
    function safeRequire(name) {
        if (pure.has(name)) return actualRequire(name);
        if (name === 'mongoose') return { connection, startSession: async () => session() };
        if (name.startsWith('../models/')) return models[name.split('/').pop()] || {};
        if (name === '../middleware/authMiddleware') return { protect(req, res, next) { req.user = { id: U }; next(); }, authorizeRoles: () => forbidden };
        if (name === '../services/checkoutInventoryService') return { createCheckoutInventoryService: () => ({ decrement: async ({ session }) => {
            assert.equal(session.inTransaction(), true);
            calls.inventory++; state.inventory--; state.sales++;
            if (!options.noStockFailure) throw new CheckoutCatalogError('INSUFFICIENT_STOCK', 'Synthetic stock conflict');
        } }) };
        if (name === '../services/squadPaymentService') return { verifySquadPayment: async () => { calls.verify.push('squad'); return verified; } };
        if (name === 'axios') return { get: async () => { calls.verify.push('flutterwave'); return { data: verified }; } };
        if (name === '../services/vendorOrderNotificationService') return { notifyVendorOfPaidShipment: async () => { calls.notices++; } };
        if (name === '../services/referralService') return { grantReferralRewardForVerifiedUser: async () => { calls.referrals++; } };
        if (name.startsWith('../services/')) return new Proxy({}, { get: () => forbidden });
        throw new Error('Unregistered route dependency.');
    }
    vm.runInThisContext('(function(require,module,exports,console,process){\n' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(
        safeRequire, module, module.exports, { log() {}, warn() {}, error() {} },
        { env: { SQUAD_SECRET_KEY: secret, FLUTTERWAVE_SECRET_KEY: 'FLWSECK-synthetic-only', FLUTTERWAVE_WEBHOOK_SECRET: secret } });
    const app = express();
    app.use(express.json({ verify(req, res, buffer) { req.rawBody = buffer; } }));
    app.use('/orders', module.exports);
    const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve));
    t.after(() => { listener.closeAllConnections(); return new Promise(resolve => listener.close(resolve)); });
    async function request(route, body, method = 'POST', signed = false) {
        const payload = JSON.stringify(body), headers = { 'Content-Type': 'application/json' };
        if (signed) {
            if (provider === 'squad') headers['x-squad-encrypted-body'] = crypto.createHmac('sha512', secret).update(payload).digest('hex');
            else headers['flutterwave-signature'] = crypto.createHmac('sha256', secret).update(payload).digest('base64');
        }
        const response = await fetch('http://127.0.0.1:' + listener.address().port + '/orders' + route,
            { method, body: payload, headers, signal: AbortSignal.timeout(15000) });
        return { status: response.status, data: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text() };
    }
    return { request, calls, get state() { return state; }, run: provider === 'squad' ? module.exports.processPendingSquadPayments : module.exports.processPendingFlutterwavePayments,
        wrongRunner: provider === 'squad' ? module.exports.processPendingFlutterwavePayments : module.exports.processPendingSquadPayments };
}

function assertReviewed(f) {
    assert.equal(f.state.orders[0].isPaid, true); assert.equal(f.state.orders[0].mainOrderStatus, 'payment_review');
    assert.equal(f.state.orders[0].paymentResult.reviewReason, 'INSUFFICIENT_STOCK');
    assert.equal(f.state.inventory, 2); assert.equal(f.state.sales, 0);
    assert.equal(f.state.shipments[0].shipmentStatus, 'pending_payment');
    assert.equal(f.calls.notices, 0); assert.equal(f.calls.referrals, 0);
}
for (const provider of ['squad', 'flutterwave']) {
    test(provider + ': direct confirmation records review after rollback and repeat payment returns the same receipt', async t => {
        const f = await fixture(t, provider);
        const first = await f.request('/' + O + '/pay', { transaction_id: ref }, 'PUT');
        assert.equal(first.status, 200); assertReviewed(f);
        assert.equal(first.data.paymentResult.fulfillmentStatus, 'needs_attention');
        const retry = await f.request('/' + O + '/pay', { transaction_id: ref }, 'PUT');
        assert.equal(retry.status, 200); assert.equal(f.calls.verify.length, 1); assert.equal(f.calls.inventory, 1);
        const intent = await f.request('/' + O + '/payment-intent', {});
        assert.equal(intent.status, 200); assert.equal(intent.data.status, 'payment_review');
        assert.equal(intent.data.checkout_url, undefined);
    });
    test(provider + ': signed webhook persists review and invalid signatures cannot verify or write', async t => {
        const f = await fixture(t, provider);
        const body = provider === 'squad' ? { Event: 'charge_successful', Body: { transaction_ref: ref } }
            : { event: 'charge.completed', data: { status: 'successful', tx_ref: ref } };
        assert.equal((await f.request('/webhooks/' + provider, body)).status, 401);
        assert.equal(f.calls.verify.length, 0); assert.equal(f.calls.inventory, 0);
        assert.equal((await f.request('/webhooks/' + provider, body, 'POST', true)).status, 200);
        assertReviewed(f);
        assert.equal((await f.request('/webhooks/' + provider, body, 'POST', true)).status, 200);
        assert.equal(f.calls.verify.length, 1);
    });
    test(provider + ': recovery uses only its own provider and stops retrying reconciled orders', async t => {
        const f = await fixture(t, provider);
        await f.wrongRunner({});
        assert.equal(f.calls.verify.length, 0);
        await f.run({}); assertReviewed(f);
        await f.run({}); assert.equal(f.calls.verify.length, 1); assert.equal(f.calls.inventory, 1);
    });
    test(provider + ': a failed review write is not acknowledged as successful payment recovery', async t => {
        const f = await fixture(t, provider, { failReview: true });
        const result = await f.request('/' + O + '/pay', { transaction_id: ref }, 'PUT');
        assert.equal(result.status, 503);
        assert.equal(result.data.code, 'PAYMENT_RECONCILIATION_PENDING');
        assert.match(result.data.message, /do not pay again/i);
        assert.equal(f.state.orders[0].isPaid, false); assert.equal(f.state.inventory, 2);
        assert.equal(f.calls.notices, 0); assert.equal(f.calls.referrals, 0);
    });
    test(provider + ': pending verification cannot consume stock or enter review', async t => {
        const f = await fixture(t, provider, { pending: true });
        const result = await f.request('/' + O + '/pay', { transaction_id: ref }, 'PUT');
        assert.equal(result.status, 202); assert.equal(f.state.orders[0].isPaid, false); assert.equal(f.calls.inventory, 0);
    });
    test(provider + ': normal successful settlement still commits stock and notifies after payment', async t => {
        const f = await fixture(t, provider, { noStockFailure: true });
        const result = await f.request('/' + O + '/pay', { transaction_id: ref }, 'PUT');
        assert.equal(result.status, 200); assert.equal(f.state.orders[0].mainOrderStatus, 'processing');
        assert.equal(f.state.inventory, 1); assert.equal(f.state.sales, 1); assert.equal(f.calls.notices, 1);
        assert.equal(f.calls.commits, 1); assert.equal(f.calls.aborts, 0);
    });
}
