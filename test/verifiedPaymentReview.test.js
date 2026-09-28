'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CheckoutCatalogError } = require('../services/checkoutCatalogService');
const { createVerifiedPaymentReviewService } = require('../services/verifiedPaymentReviewService');
const clone = value => structuredClone(value);
const tx = { id: 'synthetic-gateway-id', tx_ref: 'synthetic-ref', amount: 2500, currency: 'NGN', status: 'successful' };

function fixture(provider = 'squad') {
    let state = { order: { _id: 'order', user: 'buyer', totalPrice: 2500, isPaid: false, mainOrderStatus: 'pending_payment',
        paymentResult: { tx_ref: tx.tx_ref, provider, status: 'initiated', checkoutUrl: 'https://example.invalid/checkout' } },
        stock: 2, sales: 0, subscription: 4, wallet: 10000, shipment: 'pending_payment' };
    let chain = Promise.resolve(), writes = 0, transactions = 0, conflict = null, failSave = false;
    const connection = { transaction(work) {
        const run = chain.then(async () => {
            transactions++;
            const before = clone(state), session = { active: true, inTransaction() { return this.active; } };
            try { return await work(session); }
            catch (error) { state = before; throw error; }
            finally { session.active = false; }
        });
        chain = run.catch(() => {});
        return run;
    } };
    function document() {
        if (!state.order) return null;
        return { ...clone(state.order), async save({ session }) {
            assert.equal(session.inTransaction(), true);
            if (failSave) throw new Error('synthetic-review-write-failure');
            const { save, ...data } = this; state.order = clone(data); writes++; return this;
        } };
    }
    const query = value => ({ session(session) { assert.equal(session.inTransaction(), true); return Promise.resolve(value); } });
    const Order = { findById(id) { assert.equal(id, 'order'); return query(document()); },
        findOne(filter) { assert.equal(filter['paymentResult.tx_ref'], tx.tx_ref); assert.equal(filter._id.$ne, 'order'); return query(conflict); } };
    const service = createVerifiedPaymentReviewService({ Order, connection, now: () => new Date('2030-01-01T08:00:00Z') });
    async function failSettlement({ code = 'INSUFFICIENT_STOCK', verifiedTx = tx, error, beforeFailure } = {}) {
        let caught;
        try {
            await connection.transaction(async session => {
                const order = document();
                return service.attempt({ order, verifiedTx, provider, method: 'synthetic-verify', session }, async () => {
                    // Model a later item failing AFTER prior transactional writes.
                    state.stock--; state.sales++; state.subscription--; state.shipment = 'processing';
                    order.isPaid = true; order.mainOrderStatus = 'processing';
                    await order.save({ session });
                    if (beforeFailure) await beforeFailure(session);
                    throw error || new CheckoutCatalogError(code, 'Synthetic private diagnostic');
                });
            });
        } catch (error) { caught = error; }
        assert.ok(caught); return caught;
    }
    return { service, connection, failSettlement, get state() { return state; }, get writes() { return writes; },
        get transactions() { return transactions; }, set conflict(value) { conflict = value; }, set failSave(value) { failSave = value; } };
}

test('verified stock conflict rolls back partial inventory/benefits before recording a paid review', async () => {
    const f = fixture(), error = await f.failSettlement();
    assert.equal(f.state.order.isPaid, false); assert.equal(f.state.stock, 2); assert.equal(f.state.sales, 0);
    assert.equal(f.state.subscription, 4); assert.equal(f.state.shipment, 'pending_payment');
    const order = await f.service.recover(error);
    assert.equal(order.isPaid, true); assert.equal(order.mainOrderStatus, 'payment_review');
    assert.equal(order.paymentResult.reviewReason, 'INSUFFICIENT_STOCK');
    assert.equal(order.paymentResult.reviewInventoryState, 'not_committed');
    assert.equal(order.paymentResult.reviewPreviousOrderStatus, 'pending_payment');
    assert.equal(order.paymentResult.amount, 2500); assert.equal(order.paymentResult.tx_ref, tx.tx_ref);
    assert.equal(order.paymentResult.checkoutUrl, 'https://example.invalid/checkout');
    assert.doesNotMatch(JSON.stringify(order), /Synthetic private/);
    assert.equal(f.state.stock, 2); assert.equal(f.state.sales, 0); assert.equal(f.state.subscription, 4);
    assert.equal(f.state.wallet, 10000); assert.equal(f.state.shipment, 'pending_payment');
});

test('repeated recovery retains one receipt and the first review timestamp without another write', async () => {
    const f = fixture(), error = await f.failSettlement();
    await f.service.recover(error); const saved = clone(f.state), writes = f.writes;
    await Promise.all([f.service.recover(error), f.service.recover(error), f.service.recover(error)]);
    assert.deepEqual(f.state, saved); assert.equal(f.writes, writes);
});

test('review recovery cannot run while the original settlement transaction is active', async () => {
    const f = fixture();
    await f.connection.transaction(async session => {
        const order = f.state.order;
        let error;
        try { await f.service.attempt({ order, verifiedTx: tx, provider: 'squad', session },
            async () => { throw new CheckoutCatalogError('INSUFFICIENT_STOCK', 'stock'); }); } catch (e) { error = e; }
        await assert.rejects(f.service.recover(error), { code: 'ROLLBACK_REQUIRED' });
    });
    assert.equal(f.writes, 0);
});

test('database/provider exceptions and forged error evidence never become paid receipts', async () => {
    for (const error of [new Error('database'), Object.assign(new Error('network'), { code: 'INSUFFICIENT_STOCK' }),
        new CheckoutCatalogError('UNRELATED_ERROR', 'not inventory')]) {
        const f = fixture(), caught = await f.failSettlement({ error });
        assert.equal(await f.service.recover(caught), null);
        assert.equal(f.transactions, 1); assert.equal(f.state.order.isPaid, false);
    }
    const f = fixture();
    const forged = Object.assign(new CheckoutCatalogError('INSUFFICIENT_STOCK', 'stock'), { verifiedPaymentReview: { verifiedTx: tx } });
    assert.equal(await f.service.recover(forged), null); assert.equal(f.transactions, 0);
});

test('pending, underpaid, wrong-currency, missing-reference and non-finite verification cannot record a review', async () => {
    for (const change of [{ status: 'pending' }, { amount: 2499 }, { amount: Infinity }, { amount: null },
        { amount: '' }, { currency: 'USD' }, { tx_ref: '' }]) {
        const f = fixture(), error = await f.failSettlement({ verifiedTx: { ...tx, ...change } });
        await assert.rejects(f.service.recover(error), { code: 'VERIFIED_PAYMENT_REQUIRED' });
        assert.equal(f.state.order.isPaid, false); assert.equal(f.transactions, 1);
    }
});

test('fresh ownership, amount, reference and provider are rechecked after rollback', async () => {
    for (const mutate of [
        order => { order.user = 'other-buyer'; }, order => { order.totalPrice = 3000; },
        order => { order.paymentResult.tx_ref = 'other-reference'; }, order => { order.paymentResult.provider = 'flutterwave'; },
    ]) {
        const f = fixture(), error = await f.failSettlement();
        mutate(f.state.order);
        await assert.rejects(f.service.recover(error), { code: 'PAYMENT_REVIEW_CONFLICT' });
        assert.equal(f.state.order.isPaid, false); assert.equal(f.state.stock, 2);
    }
});

test('another order owning the payment reference prevents reconciliation', async () => {
    const f = fixture(), error = await f.failSettlement();
    f.conflict = { _id: 'different-order' };
    await assert.rejects(f.service.recover(error), { code: 'PAYMENT_REFERENCE_USED' });
    assert.equal(f.state.order.isPaid, false);
});

test('a concurrent successful settlement is returned unchanged, never downgraded to review', async () => {
    const f = fixture(), error = await f.failSettlement();
    Object.assign(f.state.order, { isPaid: true, mainOrderStatus: 'processing' });
    f.state.order.paymentResult.status = 'successful';
    const before = clone(f.state), writes = f.writes;
    await f.service.recover(error);
    assert.deepEqual(f.state, before); assert.equal(f.writes, writes);
});

test('failed review persistence remains retryable and cannot claim payment was recorded', async () => {
    const f = fixture(), error = await f.failSettlement();
    f.failSave = true;
    await assert.rejects(f.service.recover(error), /synthetic-review-write-failure/);
    assert.equal(f.state.order.isPaid, false); assert.equal(f.state.stock, 2);
    f.failSave = false;
    await f.service.recover(error);
    assert.equal(f.state.order.mainOrderStatus, 'payment_review');
});

test('legacy Flutterwave reference without provider remains supported and preserves overpayment evidence', async () => {
    const f = fixture('flutterwave'); delete f.state.order.paymentResult.provider;
    const error = await f.failSettlement({ verifiedTx: { ...tx, amount: 3000 } });
    const order = await f.service.recover(error);
    assert.equal(order.paymentResult.provider, 'flutterwave'); assert.equal(order.paymentResult.amount, 3000);
});

test('schedule review blocks dispatch without releasing confirmed or another booking capacity', async () => {
    const f = fixture();
    f.state.order.schedule = { state: 'held', reservation: 'owned-reservation' };
    const error = await f.failSettlement();
    await f.service.recover(error);
    assert.deepEqual(f.state.order.schedule, { state: 'needs_attention', reservation: 'owned-reservation' });
});

test('subscription expiry and missing shipment items produce a review instead of losing verified payment', async () => {
    for (const code of ['SUBSCRIPTION_BENEFIT_UNAVAILABLE', 'ORDER_ITEMS_UNAVAILABLE', 'INVALID_QUANTITY']) {
        const f = fixture(), error = await f.failSettlement({ code });
        await f.service.recover(error);
        assert.equal(f.state.order.paymentResult.reviewReason, code);
        assert.equal(f.state.subscription, 4); assert.equal(f.state.stock, 2);
    }
});
