const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PlanningError } = require('../utils/orderPlanningPolicy');
const { createPlannedOrderRouter } = require('../routes/plannedOrderRoutes');

const userId = '000000000000000000000001';
const recordId = '000000000000000000000002';

function runtime(overrides = {}) {
    const calls = [];
    const groups = {
        list: async (args) => (calls.push(['group.list', args]), { groups: [] }),
        create: async (args) => (calls.push(['group.create', args]), { group: { id: recordId }, inviteToken: 'private' }),
        join: async (args) => (calls.push(['group.join', args]), { id: recordId }),
        get: async (args) => (calls.push(['group.get', args]), { id: recordId }),
        rotateInvite: async (args) => (calls.push(['group.invite', args]), { group: { id: recordId }, inviteToken: 'new-private' }),
        edit: async (args) => (calls.push(['group.edit', args]), { id: recordId }),
        control: async (args) => (calls.push(['group.control', args]), { id: recordId }),
        quote: async (args) => (calls.push(['group.quote', args]), { approvalToken: 'signed' }),
    };
    const recurring = {
        list: async (args) => (calls.push(['recurring.list', args]), { plans: [] }),
        create: async (args) => (calls.push(['recurring.create', args]), { id: recordId }),
        get: async (args) => (calls.push(['recurring.get', args]), { plan: { id: recordId } }),
        editFuture: async (args) => (calls.push(['recurring.edit', args]), { id: recordId }),
        control: async (args) => (calls.push(['recurring.control', args]), { id: recordId }),
        editOccurrence: async (args) => (calls.push(['occurrence.control', args]), { id: recordId }),
        quote: async (args) => (calls.push(['occurrence.quote', args]), { approvalToken: 'signed' }),
    };
    const services = {
        groups, recurring,
        checkoutGroup: async (args) => (calls.push(['group.checkout', args]), { orderId: recordId }),
        checkoutRecurring: async (args) => (calls.push(['recurring.checkout', args]), { orderId: recordId }),
    };
    return {
        calls,
        enabled: () => true,
        ready: async () => true,
        services: () => services,
        ...overrides,
    };
}

async function setup(t, value = runtime()) {
    const app = express();
    app.use(express.json());
    app.use('/planned', createPlannedOrderRouter({
        runtime: value,
        authenticate: (req, res, next) => {
            if (!req.headers.authorization) return res.sendStatus(401);
            req.user = {
                _id: userId,
                firstName: 'Ada',
                lastName: 'Okafor',
                isVendor: req.headers.authorization === 'vendor',
                isAdmin: req.headers.authorization === 'admin',
                constructor: { modelName: req.headers.authorization === 'rider' ? 'Rider' : 'User' },
            };
            next();
        },
    }));
    const listener = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => listener.once('listening', resolve));
    t.after(() => {
        listener.closeAllConnections();
        return new Promise((resolve) => listener.close(resolve));
    });
    return {
        runtime: value,
        request: (path = '', options = {}) => fetch(
            `http://127.0.0.1:${listener.address().port}/planned${path}`,
            options,
        ),
    };
}

const json = (body) => ({
    method: 'POST',
    headers: { authorization: 'customer', 'content-type': 'application/json' },
    body: JSON.stringify(body),
});

test('planning config is public, honest and disabled until runtime readiness passes', async (t) => {
    const value = runtime({ ready: async () => false });
    const { request } = await setup(t, value);
    const config = await request('/config');
    assert.equal(config.status, 200);
    assert.deepEqual(await config.json(), {
        enabled: false,
        timeZone: 'Africa/Lagos',
        automaticCharges: false,
        paymentMode: 'reminder_to_pay',
    });
    assert.equal((await request('/groups')).status, 401);
});

test('only customer accounts can use planned-order APIs', async (t) => {
    const { request } = await setup(t);
    for (const authorization of ['vendor', 'admin', 'rider']) {
        const response = await request('/groups', { headers: { authorization } });
        assert.equal(response.status, 403);
    }
});

test('group create and checkout use authenticated identity and explicit approved fields', async (t) => {
    const { request, runtime: value } = await setup(t);
    const created = await request('/groups', json({ name: 'Office lunch', actor: 'forged' }));
    assert.equal(created.status, 201);
    assert.equal(value.calls[0][0], 'group.create');
    assert.equal(String(value.calls[0][1].actor), userId);
    assert.equal(value.calls[0][1].displayName, 'Ada Okafor');
    assert.equal(value.calls[0][1].input.actor, 'forged');

    const checkout = await request(`/groups/${recordId}/checkout`, json({
        revision: 4,
        approvalToken: 'signed',
        paymentMethod: 'Card',
        actor: 'forged',
    }));
    assert.equal(checkout.status, 201);
    const call = value.calls.at(-1);
    assert.equal(call[0], 'group.checkout');
    assert.deepEqual(call[1], {
        groupId: recordId,
        actor: userId,
        revision: 4,
        approvalToken: 'signed',
        paymentMethod: 'Card',
    });

    const invite = await request(`/groups/${recordId}/invite`, json({
        revision: 5,
        actor: 'forged',
    }));
    assert.equal(invite.status, 200);
    const inviteCall = value.calls.at(-1);
    assert.deepEqual(inviteCall, ['group.invite', {
        groupId: recordId,
        actor: userId,
        revision: 5,
    }]);
});

test('recurring and occurrence controls map only the current customer and revision', async (t) => {
    const { request, runtime: value } = await setup(t);
    const response = await request(`/occurrences/${recordId}/control`, json({
        revision: 2,
        action: 'skip',
        items: [{ product: recordId, quantity: 1 }],
    }));
    assert.equal(response.status, 200);
    const call = value.calls.at(-1);
    assert.equal(call[0], 'occurrence.control');
    assert.equal(call[1].actor, userId);
    assert.equal(call[1].occurrenceId, recordId);
    assert.equal(call[1].revision, 2);
});

test('planning errors stay concise and unexpected errors are redacted', async (t) => {
    const safeRuntime = runtime();
    safeRuntime.services().groups.get = async () => {
        throw new PlanningError('GROUP_NOT_FOUND', 'Group not found.', 404);
    };
    const safe = await setup(t, safeRuntime);
    const missing = await safe.request(`/groups/${recordId}`, { headers: { authorization: 'customer' } });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { message: 'Group not found.', code: 'GROUP_NOT_FOUND' });

    const brokenRuntime = runtime();
    brokenRuntime.services().groups.get = async () => {
        throw new Error('mongodb://private-user:private-password@example.invalid');
    };
    const broken = await setup(t, brokenRuntime);
    const failed = await broken.request(`/groups/${recordId}`, { headers: { authorization: 'customer' } });
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).message, 'Order planning is temporarily unavailable. Please try again.');
});
