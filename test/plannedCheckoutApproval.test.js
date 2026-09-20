'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlannedCheckoutApproval, assertCreatedOrder } = require('../utils/plannedCheckoutApproval');
const { normalizeItems } = require('../utils/groupOrderPolicy');
const { normalizeSelectedSize } = require('../utils/plannedItemSelection');
const owner = '111111111111111111111111', recordId = '222222222222222222222222';
const secret = 'synthetic-private-signing-secret-for-tests-only';
const context = { kind: 'group', owner, recordId, revision: 3, destination: { address: 'Private synthetic address', latitude: 9, longitude: 7 }, schedule: { mode: 'now' } };
const quote = { totalPrice: 3200.57, totalShippingPrice: 1000, items: [{ product: recordId, selectedSize: 'L', quantity: 1 }], sellerId: owner };
const clone = (value) => JSON.parse(JSON.stringify(value));
function fixture() {
    let clock = new Date('2100-01-01T08:00:00Z');
    return { approval: createPlannedCheckoutApproval({ secret, now: () => new Date(clock) }), advance: (ms) => { clock = new Date(clock.getTime() + ms); } };
}

test('planned approvals are private, deterministic across property order and valid only until expiry', () => {
    const f = fixture(), result = f.approval.issue({ context, quote });
    assert.equal(result.totalKobo, 320057); assert.equal(result.expiresAt, '2100-01-01T08:05:00.000Z');
    assert.equal(result.approvalToken.includes(owner), false); assert.equal(result.approvalToken.includes('Private'), false);
    assert.equal(f.approval.verify({ context: { ...context, destination: { longitude: 7, latitude: 9, address: 'Private synthetic address' } }, quote, token: result.approvalToken }), true);
    f.advance(300000);
    assert.throws(() => f.approval.verify({ context, quote, token: result.approvalToken }), { code: 'QUOTE_EXPIRED' });
});

test('approvals bind identity, version, destination, schedule, selection and every quoted price component', () => {
    const { approval } = fixture(), { approvalToken: token } = approval.issue({ context, quote });
    for (const change of [{ owner: recordId }, { recordId: owner }, { kind: 'recurring' }, { revision: 4 },
        { destination: { ...context.destination, latitude: 0 } }, { schedule: { mode: 'scheduled' } }]) {
        assert.throws(() => approval.verify({ context: { ...context, ...change }, quote, token }), { code: 'QUOTE_CHANGED' });
    }
    for (const change of [{ totalPrice: 3201 }, { totalShippingPrice: 0 }, { sellerId: recordId }, { items: [{ ...quote.items[0], selectedSize: 'M' }] }]) {
        assert.throws(() => approval.verify({ context, quote: { ...quote, ...change }, token }), { code: 'QUOTE_CHANGED' });
    }
    assert.throws(() => approval.verify({ context, quote, token: token.replace(/^v1\.\d+/, 'v1.4102474200000') }), { code: 'QUOTE_APPROVAL_REQUIRED' });
});

test('malformed or forged approval tokens, weak configuration and invalid totals fail closed', () => {
    const { approval } = fixture(), result = approval.issue({ context, quote });
    for (const token of [null, {}, '', result.approvalToken + '0', result.approvalToken.slice(0, -64) + '0'.repeat(64)]) {
        assert.throws(() => approval.verify({ context, quote, token }), { code: 'QUOTE_APPROVAL_REQUIRED' });
    }
    assert.throws(() => createPlannedCheckoutApproval({ secret: 'short' }), /private signing secret/);
    for (const totalPrice of [-1, NaN, Infinity, '3200', null]) assert.throws(() => approval.issue({ context, quote: { totalPrice } }), { code: 'QUOTE_UNAVAILABLE' });
    const other = createPlannedCheckoutApproval({ secret: secret + 'another', now: () => new Date('2100-01-01T08:00:00Z') });
    assert.throws(() => other.verify({ context, quote, token: result.approvalToken }), { code: 'QUOTE_APPROVAL_REQUIRED' });
});

test('planned sizes keep real legacy selections, strip commercial fields and deduplicate equivalent options', () => {
    const line = { product: recordId, quantity: 1 };
    assert.deepEqual(normalizeSelectedSize({ value: 'XL', label: 'Extra large', price: 1, sellerId: owner }), { value: 'XL', label: 'Extra large' });
    assert.deepEqual(normalizeSelectedSize({ length: 2, width: 3, unit: 'm', price: 1 }), { length: 2, width: 3, unit: 'm' });
    assert.throws(() => normalizeItems([{ ...line, selectedSize: 'XL' }, { ...line, selectedSize: { value: 'XL', label: 'Other' } }]), { code: 'DUPLICATE_ITEM' });
    assert.equal(normalizeItems([{ ...line, selectedSize: 'XL' }, { ...line, selectedSize: 'L' }]).length, 2);
    for (const selectedSize of ['', [], {}, { length: -1, unit: 'm' }, { length: '1', unit: 'm' }, { value: 'X', unit: [] }, { length: 2, unit: 'invalid' }]) {
        assert.throws(() => normalizeItems([{ ...line, selectedSize }]), { code: 'INVALID_SIZE' });
    }
});

test('planned order adapter must return an unpaid owned order with the approved amount and shipment count', () => {
    const order = { _id: recordId, user: owner, isPaid: false, mainOrderStatus: 'pending_payment', totalPrice: quote.totalPrice, shipments: [recordId] };
    assert.doesNotThrow(() => assertCreatedOrder({ order, owner, quote, shipmentCount: 1 }));
    for (const change of [{ isPaid: true }, { user: recordId }, { totalPrice: 1 }, { shipments: [recordId, owner] }, { _id: null }]) {
        assert.throws(() => assertCreatedOrder({ order: { ...clone(order), ...change }, owner, quote, shipmentCount: 1 }), { code: 'INVALID_ORDER' });
    }
});
