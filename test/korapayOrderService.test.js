'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const sift = createRequire(require.resolve('mongoose'))('sift').default;
const { createKorapayOrderService } = require('../services/korapayOrderService');
const buyer = { email: 'buyer@example.invalid' };
function fixture(options = {}) {
    let row = { _id: '111111111111111111111111', user: 'owner', totalPrice: 2500,
        isPaid: false, mainOrderStatus: 'pending_payment', ...options.order };
    const calls = { initialize: [], verify: [], writes: 0 };
    const clone = value => value == null ? value : structuredClone(value);
    function set(target, path, value, remove = false) {
        const parts = path.split('.'), field = parts.pop();
        let part = target; for (const key of parts) part = part[key] ||= {};
        if (remove) delete part[field]; else part[field] = clone(value);
    }
    function update(changes) {
        for (const [key, value] of Object.entries(changes.$set || {})) set(row, key, value);
        for (const key of Object.keys(changes.$unset || {})) set(row, key, null, true);
        calls.writes++;
    }
    const Order = {
        async findById() { return clone(row); },
        async findOneAndUpdate(filter, changes, opts) {
            if (!sift(filter)(row)) return null;
            const before = clone(row); update(changes); return opts.new ? clone(row) : before;
        },
        async updateOne(filter, changes) { if (!sift(filter)(row)) return { modifiedCount: 0 };
            update(changes); return { modifiedCount: 1 }; },
    };
    const config = { mode: 'test', secretKey: 'synthetic' };
    const service = createKorapayOrderService({ Order, getConfig: ({ expectedMode } = {}) => {
        if (expectedMode && expectedMode !== config.mode) throw new Error('mode-mismatch'); return config;
    }, initiate: async args => {
        calls.initialize.push(args);
        if (options.initialize) return options.initialize(args);
        return { data: { reference: args.transactionRef, checkout_url: 'https://checkout.korapay.com/ref/pay' }, mode: 'test' };
    }, verify: async args => { calls.verify.push(args); return options.verified || { status: false, notFound: true }; },
    now: () => new Date('2026-09-28T12:00:00Z') });
    return { service, calls, config, Order, get row() { return clone(row); }, setRow(changes) { Object.assign(row, changes); } };
}
test('concurrent initialization keeps one receipt reference and one gateway call', async () => {
    const f = fixture(), initial = f.row;
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => f.service.initialize(structuredClone(initial), buyer)));
    assert.equal(f.calls.initialize.length, 1);
    assert.ok(results.some(result => result.status === 'fulfilled'));
    for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'PAYMENT_SETUP_PENDING');
    assert.equal(f.row.paymentResult.provider, 'korapay'); assert.equal(f.row.paymentResult.mode, 'test');
    assert.equal(f.row.paymentResult.tx_ref, f.calls.initialize[0].transactionRef);
    assert.equal(f.row.paymentResult.initializeToken, undefined);
    assert.equal(f.row.paymentResult.initializeLeaseUntil, undefined);
    assert.equal(f.row.isPaid, false);
});
test('a stored checkout is reused and never creates another charge', async () => {
    const f = fixture(); const first = await f.service.initialize(f.row, buyer);
    assert.deepEqual(await f.service.initialize(f.row, buyer), first);
    assert.equal(f.calls.initialize.length, 1); assert.equal(f.calls.verify.length, 0);
});
test('legacy payment identity is never overwritten and wrong-mode receipts are not reused', async () => {
    for (const provider of ['squad', 'flutterwave']) {
        const f = fixture({ order: { paymentResult: { provider, tx_ref: 'old-reference', checkoutUrl: 'https://pay.squadco.com/old' } } });
        await assert.rejects(f.service.initialize(f.row, buyer), { code: 'PAYMENT_ATTEMPT_EXISTS' });
        assert.equal(f.calls.writes, 0); assert.equal(f.calls.initialize.length, 0);
        assert.equal(f.row.paymentResult.tx_ref, 'old-reference');
    }
    const f = fixture(); await f.service.initialize(f.row, buyer); f.config.mode = 'live';
    await assert.rejects(f.service.initialize(f.row, buyer), /mode-mismatch/);
    assert.equal(f.calls.initialize.length, 1);
});
test('gateway timeout retains reference; retry verifies and uses the same reference only when absent', async () => {
    let attempts = 0;
    const f = fixture({ initialize: async args => {
        if (++attempts === 1) throw new Error('synthetic-timeout');
        return { data: { checkout_url: 'https://checkout.korapay.com/ref/pay', reference: args.transactionRef } };
    } });
    await assert.rejects(f.service.initialize(f.row, buyer), /synthetic-timeout/);
    const reference = f.row.paymentResult.tx_ref;
    assert.equal(f.row.paymentResult.initializationState, 'uncertain');
    assert.equal(f.row.paymentResult.initializeToken, undefined);
    const result = await f.service.initialize(f.row, buyer);
    assert.equal(result.tx_ref, reference); assert.equal(f.calls.verify.length, 1);
    assert.equal(f.calls.initialize[0].transactionRef, f.calls.initialize[1].transactionRef);
});
test('an existing uncertain provider charge is not initialized again', async () => {
    const f = fixture({ verified: { status: true, data: { status: 'pending' } },
        order: { paymentResult: { provider: 'korapay', mode: 'test', tx_ref: 'existing-reference', initializationState: 'uncertain' } } });
    await assert.rejects(f.service.initialize(f.row, buyer), { code: 'PAYMENT_CONFIRMATION_PENDING' });
    assert.equal(f.calls.verify.length, 1); assert.equal(f.calls.initialize.length, 0);
    assert.equal(f.row.isPaid, false);
});
test('an active setup lease prevents duplicate provider calls and a stale lease is recoverable', async () => {
    const f = fixture({ order: { paymentResult: { provider: 'korapay', mode: 'test', tx_ref: 'existing-reference',
        initializationState: 'initializing', initializeLeaseUntil: new Date('2026-09-28T12:02:00Z') } } });
    await assert.rejects(f.service.initialize(f.row, buyer), { code: 'PAYMENT_SETUP_PENDING' });
    assert.equal(f.calls.initialize.length, 0);
    f.setRow({ paymentResult: { ...f.row.paymentResult, initializeLeaseUntil: new Date(0) } });
    await f.service.initialize(f.row, buyer);
    assert.equal(f.calls.verify.length, 1); assert.equal(f.calls.initialize.length, 1);
});
test('changed ownership, amount or paid status while claiming cannot initialize a charge', async () => {
    for (const changes of [{ user: 'another-owner' }, { totalPrice: 3000 }, { isPaid: true }]) {
        const f = fixture(), initial = f.row; f.setRow(changes);
        await assert.rejects(f.service.initialize(initial, buyer), { code: 'PAYMENT_ATTEMPT_EXISTS' });
        assert.equal(f.calls.initialize.length, 0); assert.equal(f.calls.writes, 0);
    }
});
test('a persisted untrusted checkout URL is never returned', async () => {
    const f = fixture({ order: { paymentResult: { provider: 'korapay', mode: 'test', tx_ref: 'existing-reference', checkoutUrl: 'https://evil.example/pay' } } });
    await assert.rejects(f.service.initialize(f.row, buyer), { code: 'INVALID_CHECKOUT_URL' });
    assert.equal(f.calls.initialize.length, 0);
});

test('a receipt changed while the gateway responds cannot receive or expose the checkout URL', async () => {
    for (const changes of [{ user: 'another-owner' }, { totalPrice: 3000 }, { isPaid: true },
        { mainOrderStatus: 'cancelled' }]) {
        const f = fixture({ initialize: async args => {
            f.setRow(changes);
            return { data: { reference: args.transactionRef, checkout_url: 'https://checkout.korapay.com/ref/pay' } };
        } });
        await assert.rejects(f.service.initialize(f.row, buyer), { code: 'PAYMENT_STATE_CHANGED' });
        assert.equal(f.row.paymentResult.checkoutUrl, undefined);
        for (const [key, value] of Object.entries(changes)) assert.equal(f.row[key], value);
    }
});

test('post-commit notification and referral outages cannot turn a paid receipt into an error', async () => {
    const calls = [];
    const service = createKorapayOrderService({
        notify: async () => { calls.push('notification'); throw new Error('synthetic-notification-outage'); },
        referral: async () => { calls.push('referral'); throw new Error('synthetic-referral-outage'); },
    });
    await assert.doesNotReject(service.afterCommit({}, { user: 'owner', isPaid: true }));
    assert.deepEqual(calls, ['notification', 'referral']);
});
