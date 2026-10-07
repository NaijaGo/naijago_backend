const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const service = require('../services/plannedOrderService');
const router = require('../routes/plannedOrderRoutes');
const { GroupOrder, RecurringPlan, RecurringOccurrence } = require('../models/PlannedOrders');

test('actual local config route and unauthenticated API protection require no database', async () => {
  const previous = process.env.PLANNED_ORDERS_ENABLED;
  const app = express();
  app.use(express.json());
  app.use('/api/planned-orders', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/planned-orders`;
  try {
    delete process.env.PLANNED_ORDERS_ENABLED;
    const response = await fetch(`${base}/config`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      groupOrderingEnabled: false, recurringOrdersEnabled: false,
      scheduledDeliveryEnabled: false, automaticPaymentsEnabled: false,
    });
    // Only this isolated test process changes the flag. No database is connected.
    process.env.PLANNED_ORDERS_ENABLED = 'true';
    const enabled = await fetch(`${base}/config`);
    assert.deepEqual(await enabled.json(), {
      groupOrderingEnabled: true, recurringOrdersEnabled: true,
      scheduledDeliveryEnabled: false, automaticPaymentsEnabled: false,
    });
    for (const [method, path] of [['GET', '/groups'], ['POST', '/groups'],
      ['POST', '/groups/join'], ['GET', '/recurring'], ['POST', '/recurring']]) {
      const denied = await fetch(`${base}${path}`, { method });
      assert.equal(denied.status, 401, `${method} ${path}`);
    }
    assert.equal(mongoose.connection.readyState, 0);
  } finally {
    if (previous === undefined) delete process.env.PLANNED_ORDERS_ENABLED;
    else process.env.PLANNED_ORDERS_ENABLED = previous;
    await new Promise(resolve => server.close(resolve));
  }
});

test('all customer API operations have the expected registered HTTP methods', () => {
  const routes = new Set(router.stack.filter(layer => layer.route).flatMap(layer =>
    Object.keys(layer.route.methods).map(method => `${method.toUpperCase()} ${layer.route.path}`)));
  for (const route of [
    'GET /config', 'GET /groups', 'POST /groups', 'POST /groups/join',
    'GET /groups/:id', 'POST /groups/:id/invite', 'PUT /groups/:id/items',
    'POST /groups/:id/control', 'POST /groups/:id/quote', 'POST /groups/:id/checkout',
    'GET /recurring', 'POST /recurring', 'GET /recurring/:id', 'PUT /recurring/:id',
    'POST /recurring/:id/control', 'POST /occurrences/:id/control',
    'POST /occurrences/:id/quote', 'POST /occurrences/:id/checkout',
  ]) assert.ok(routes.has(route), route);
});

test('plan identity, revision, name, address and recurrence validation fail closed', () => {
  assert.equal(service.id('ABCDEF000000000000000001'), 'abcdef000000000000000001');
  for (const value of [null, '', 'bad', {}, 4]) assert.throws(() => service.id(value), { statusCode: 400 });
  for (const value of [-1, 1.5, '1', NaN, Infinity]) assert.throws(() => service.revision(value), { statusCode: 400 });
  assert.equal(service.revision(0), 0);
  assert.equal(service.name('  Family shop  '), 'Family shop');
  assert.throws(() => service.name(' '), { statusCode: 400 });
  const destination = { address: '3rd Avenue', city: 'Abuja', latitude: 9.08, longitude: 7.4 };
  assert.equal(service.destination(destination).postalCode, '');
  for (const patch of [{ latitude: NaN }, { longitude: 181 }, { address: '' }, { city: '' }]) {
    assert.throws(() => service.destination({ ...destination, ...patch }), { statusCode: 400 });
  }
  const startDate = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  for (const frequency of ['weekly', 'fortnightly', 'monthly']) {
    assert.equal(service.rule({ timeZone: 'Africa/Lagos', frequency, startDate }).frequency, frequency);
  }
  assert.throws(() => service.rule({ timeZone: 'UTC', frequency: 'weekly', startDate }), { statusCode: 400 });
});

test('group and recurring serialized responses preserve customer contract and hide private approval data', () => {
  const owner = new mongoose.Types.ObjectId();
  const member = new mongoose.Types.ObjectId();
  const destination = { address: '3rd Avenue', city: 'Abuja', latitude: 9.08, longitude: 7.4 };
  const group = new GroupOrder({ owner, name: 'Family', sellerType: 'naijago',
    destination, participantLimit: 3, closesAt: new Date(), inviteHash: 'private',
    members: [{ user: owner, items: [] }, { user: member, items: [] }],
    approval: { hash: 'private', fingerprint: 'private', expiresAt: new Date() } });
  const view = JSON.parse(JSON.stringify(service.groupView(group, owner)));
  assert.equal(view.id, String(group._id));
  assert.equal(view.memberCount, 2);
  assert.equal(view.isOwner, true);
  assert.equal(view.members[0].isYou, true);
  assert.equal(view.inviteHash, undefined);
  assert.equal(view.approval, undefined);
  const participant = service.groupView(group, member);
  assert.equal(participant.destination, undefined);
  assert.equal(participant.orderId, undefined);
  const plan = new RecurringPlan({ owner, name: 'Weekly', destination, nextGenerateAt: new Date() });
  assert.equal(String(service.planView(plan).id), String(plan._id));
  assert.equal(service.planView(plan).checkoutRevision, undefined);
  const occurrence = new RecurringOccurrence({ plan: plan._id, owner, sequence: 0,
    approval: { hash: 'private' }, reminderLeaseUntil: new Date() });
  assert.equal(service.occurrenceView(occurrence).approval, undefined);
  assert.equal(service.occurrenceView(occurrence).reminderLeaseUntil, undefined);
});

test('combined group basket quantities and recurrence dates are deterministic', () => {
  const product = '000000000000000000000001';
  const rows = service.consolidate([{ product, quantity: 2 }, { product, quantity: 3 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 5);
  const distinct = service.consolidate([
    { product, quantity: 1, selectedSize: 'A:B', customerNote: 'C' },
    { product, quantity: 1, selectedSize: 'A', customerNote: 'B:C' },
  ]);
  assert.equal(distinct.length, 2, 'different selections and notes must not merge');
  assert.throws(() => service.consolidate([]), { statusCode: 400 });
  assert.throws(() => service.consolidate([{ product, quantity: 1001 }]), { statusCode: 400 });
  const monthly = { startDate: '2027-01-31', frequency: 'monthly' };
  assert.equal(service.occurrenceDate(monthly, 1).toISOString(), '2027-02-28T08:00:00.000Z');
  assert.equal(service.occurrenceDate(monthly, 2).toISOString(), '2027-03-31T08:00:00.000Z');
});
