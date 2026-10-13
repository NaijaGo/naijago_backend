const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { fixture, ids } = require('./support/riderPartnershipFixture');
const { agreementEnforcementEnabled } = require('../services/riderAgreementService');
const { createRiderAgreementRouter } = require('../routes/riderAgreementRoutes');
const { createAgreementIdentity, createAgreementGuard } = require('../middleware/riderAgreementGuard');
const { createRiderPartnershipAdminRouter } = require('../routes/riderPartnershipAdminRoutes');

async function api(t, router, action) {
  const app = express(); app.use(express.json(), router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return action(`http://127.0.0.1:${server.address().port}`);
}
function router(f) {
  const routes = createRiderAgreementRouter({ service: f.agreements,
    authenticate: createAgreementIdentity({ Riders: f.models.Rider,
      verify: token => { if (token !== 'fixture') throw Object.assign(new Error('Fixture bad session'), { name: 'JsonWebTokenError' }); return { id: ids.rider }; } }) });
  routes.post('/work', createAgreementGuard(f.agreements), (req, res) => res.json({ executed: true }));
  return routes;
}
const headers = { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' };

test('only exact false pauses the server setting; default and invalid values enforce', t => {
  const original = process.env.RIDER_AGREEMENT_ENFORCEMENT;
  t.after(() => { if (original === undefined) delete process.env.RIDER_AGREEMENT_ENFORCEMENT; else process.env.RIDER_AGREEMENT_ENFORCEMENT = original; });
  delete process.env.RIDER_AGREEMENT_ENFORCEMENT; assert.equal(agreementEnforcementEnabled(), true);
  for (const value of ['true', '', 'FALSE', '0', ' false ', 'disabled']) {
    process.env.RIDER_AGREEMENT_ENFORCEMENT = value; assert.equal(agreementEnforcementEnabled(), true);
  }
  process.env.RIDER_AGREEMENT_ENFORCEMENT = 'false'; assert.equal(agreementEnforcementEnabled(), false);
});

test('paused status uses rider approval only, never missing agreement storage or writes', async () => {
  const f = fixture({ enforcement: false }); f.state.policies = []; f.state.agreements = []; f.failReady();
  for (const model of ['policies', 'agreements', 'acceptances']) {
    f.fail(model);
    const status = await f.agreements.status(ids.rider);
    assert.equal(status.enforcementEnabled, false); assert.equal(status.enforcementPaused, true);
    assert.equal(status.accepted, false); assert.equal(status.requiresAcceptance, false); assert.equal(status.workAllowed, true);
    for (const key of ['agreement', 'acceptance', 'requiredVersion', 'acceptedAt', 'acceptedVersion']) assert.equal(status[key], null);
    assert.equal((await f.agreements.requireAccepted(ids.rider)).workAllowed, true);
  }
  assert.ok(f.reads.every(read => read.name === 'riders')); assert.equal(f.writes.length, 0);
});

test('actual authenticated current/status/guard routes work during pause with missing setup', async t => {
  const f = fixture({ enforcement: false }); f.state.policies = []; f.state.agreements = []; f.failReady();
  await api(t, router(f), async base => {
    for (const path of ['/current', '/status']) {
      const res = await fetch(base + path, { headers }); assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store'); const body = await res.json();
      assert.equal(body.agreement, null); assert.equal(body.accepted, false); assert.equal(body.workAllowed, true);
    }
    assert.equal((await fetch(base + '/work', { method: 'POST', headers })).status, 200);
    assert.equal((await fetch(base + '/status')).status, 401);
    assert.equal((await fetch(base + '/work', { method: 'POST', headers: { Authorization: 'Bearer invalid' } })).status, 401);
    assert.equal(f.writes.length, 0);
  });
});

test('pending riders may read pause status but cannot work; suspended/rejected accounts stay blocked', async t => {
  const f = fixture({ enforcement: false });
  await api(t, router(f), async base => {
    for (const status of ['pending', 'suspended', 'rejected']) {
      f.state.riders[0].status = status;
      const read = await fetch(base + '/status', { headers }); assert.equal(read.status, status === 'pending' ? 200 : 403);
      if (status === 'pending') assert.equal((await read.json()).workAllowed, false);
      const work = await fetch(base + '/work', { method: 'POST', headers }); assert.equal(work.status, 403);
      await assert.rejects(f.agreements.updateAvailability(ids.rider, { isActive: true }), { status: 403 });
    }
    f.state.riders = []; assert.equal((await fetch(base + '/status', { headers })).status, 401);
    assert.equal(f.writes.length, 0);
  });
});

test('pause never allows work when the rider database cannot be verified', async t => {
  const f = fixture({ enforcement: false }); f.fail('riders');
  await assert.rejects(f.agreements.requireAccepted(ids.rider), { status: 503, code: 'RIDER_AGREEMENT_UNAVAILABLE' });
  await assert.rejects(f.agreements.acceptedRiderIds());
  await assert.rejects(f.agreements.eligibleWork(ids.rider, () => assert.fail('No work on outage')));
  await api(t, router(f), async base => assert.equal((await fetch(base + '/status', { headers })).status, 503));
  assert.equal(f.writes.length, 0);
});

test('accept requests are rejected with 409 during pause without readiness, transaction or ledger writes', async t => {
  const f = fixture({ enforcement: false }); f.failReady(); f.state.policies = [];
  await api(t, router(f), async base => {
    const response = await fetch(base + '/accept', { method: 'POST', headers, body: JSON.stringify(f.acceptance()) });
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'RIDER_AGREEMENT_ENFORCEMENT_PAUSED');
    assert.deepEqual(f.state.acceptances, []); assert.equal(f.writes.length, 0);
  });
});

test('paused dispatch approval filter and online/capacity checks remain enforced', async () => {
  const f = fixture({ enforcement: false }); f.state.riders[1].status = 'pending';
  assert.deepEqual(await f.agreements.acceptedRiderIds(), [ids.rider]);
  f.state.riders[0].isActive = false; f.state.riders[0].isAvailable = false;
  await f.agreements.updateAvailability(ids.rider, { isActive: true, isAvailable: true });
  assert.equal(f.state.riders[0].isActive, true);
  assert.equal(await f.agreements.eligibleWork(ids.rider, (session, rider) => { assert.ok(session); return rider._id; }), ids.rider);
  for (const changes of [{ activeDeliveries: 5 }, { isActive: false }, { isAvailable: false }]) {
    Object.assign(f.state.riders[0], { activeDeliveries: 0, isActive: true, isAvailable: true }, changes);
    await assert.rejects(f.agreements.eligibleWork(ids.rider, () => assert.fail('Ineligible work')), { status: 403 });
  }
  assert.deepEqual(f.state.acceptances, []); assert.equal(f.state.riders[0].walletBalance, 10);
});

test('actual dispatch selector keeps approval, freshness, online, capacity, exclusions and distance during pause', async t => {
  const service = require('../services/riderAgreementService'), Rider = require('../models/Rider');
  const f = fixture({ enforcement: false }); f.state.policies = [];
  f.state.riders[1].status = 'pending';
  const originalService = service.getService, originalFind = Rider.find;
  t.after(() => { service.getService = originalService; Rider.find = originalFind; });
  service.getService = () => f.agreements;
  Rider.find = filter => {
    assert.equal(filter.status, 'approved'); assert.equal(filter.isActive, true); assert.equal(filter.isAvailable, true);
    assert.deepEqual(filter.activeDeliveries, { $lt: 5 }); assert.deepEqual(filter._id.$in, [ids.rider]);
    assert.deepEqual(filter._id.$nin, [ids.other]); assert.ok(filter['currentLocation.lastUpdated'].$gte instanceof Date);
    assert.equal(filter['currentLocation.lat'].$exists, true); assert.equal(filter['currentLocation.lng'].$exists, true);
    return { select() { return this; }, lean: async () => [
      { _id: ids.rider, currentLocation: { lat: 6.52, lng: 3.36, lastUpdated: new Date() } },
      { _id: 'far-away-fixture', currentLocation: { lat: 9.07, lng: 7.4, lastUpdated: new Date() } },
    ] };
  };
  const riders = await require('../services/riderAssignmentService').findEligibleRiders({
    pickupLocation: { latitude: 6.52, longitude: 3.36 }, radiusKm: 10, excludeRiderIds: [ids.other] });
  assert.deepEqual(riders.map(rider => rider._id), [ids.rider]); assert.equal(f.writes.length, 0);
});

test('resuming immediately restores policy/acceptance requirements without fabricating or deleting history', async () => {
  const f = fixture(); await f.agreements.accept(ids.other, f.acceptance()); const history = structuredClone(f.state.acceptances);
  f.setEnforcement(false); await f.agreements.requireAccepted(ids.rider);
  f.setEnforcement(true); await assert.rejects(f.agreements.requireAccepted(ids.rider), { status: 403, code: 'RIDER_AGREEMENT_REQUIRED' });
  assert.equal((await f.agreements.requireAccepted(ids.other)).accepted, true); assert.deepEqual(f.state.acceptances, history);
  f.state.policies = []; await assert.rejects(f.agreements.requireAccepted(ids.other), { status: 503 });
});

test('admin can prepare a required policy during pause without offlining riders or releasing offers', async t => {
  const f = fixture({ enforcement: false, configured: false });
  f.state.orders.push({ _id: 'offer', isClaimed: false, assignedRider: ids.rider, mainOrderStatus: 'processing' });
  const admin = createRiderPartnershipAdminRouter({ ...f.models, agreements: f.agreements, bonuses: f.bonuses,
    authenticate: (req, res, next) => { if (req.headers.authorization !== 'Bearer admin') return res.sendStatus(401); req.user = { _id: ids.admin }; next(); }, admin: (req, res, next) => next() });
  await api(t, admin, async base => {
    const auth = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
    let res = await fetch(base + '/agreements', { headers: auth }); assert.equal((await res.json()).enforcementEnabled, false);
    res = await fetch(base + '/required', { method: 'PUT', headers: auth, body: JSON.stringify({ agreementId: ids.agreement, revision: 0, reason: 'Prepare for resumed requirement' }) });
    assert.equal(res.status, 200); assert.equal(f.state.policies[0].revision, 1); assert.equal(f.state.policies[0].history.length, 1);
    assert.equal(f.state.riders[0].isActive, true); assert.equal(f.state.orders[0].assignedRider, ids.rider);
    assert.equal(f.state.riders[0].walletBalance, 10); assert.deepEqual(f.state.acceptances, []);
    res = await fetch(base + `/acceptances?riderId=${ids.rider}`, { headers: auth });
    assert.equal(res.status, 200); const body = await res.json(); assert.equal(body.status.enforcementPaused, true); assert.deepEqual(body.acceptances, []);
  });
  f.setEnforcement(true); await assert.rejects(f.agreements.requireAccepted(ids.rider), { status: 403 });
});

test('actual claim handler preserves payment, ownership, terminal status, suspension, online and capacity checks during pause', async t => {
  const mongoose = require('mongoose'), service = require('../services/riderAgreementService');
  const Order = require('../models/MainOrder'), Rider = require('../models/Rider');
  const original = { startSession: mongoose.startSession, service: service.getService, order: Order.findById, rider: Rider.findById };
  t.after(() => { mongoose.startSession = original.startSession; service.getService = original.service; Order.findById = original.order; Rider.findById = original.rider; });
  const f = fixture({ enforcement: false }); service.getService = () => f.agreements;
  let aborted = 0;
  mongoose.startSession = async () => ({ startTransaction() {}, abortTransaction: async () => aborted++, endSession() {} });
  let order, rider;
  Order.findById = () => ({ populate() { return this; }, session: async () => order });
  Rider.findById = () => ({ session: async () => rider });
  for (const scenario of ['unpaid', 'claimed', 'other-owner', 'other-assignee', 'completed', 'suspended', 'offline', 'capacity']) {
    order = { isPaid: scenario !== 'unpaid', isClaimed: scenario === 'claimed',
      mainOrderStatus: scenario === 'completed' ? 'completed' : 'processing', shipments: [],
      ...(scenario === 'other-owner' ? { rider: ids.other } : {}),
      ...(scenario === 'other-assignee' ? { assignedRider: ids.other } : {}) };
    rider = { status: scenario === 'suspended' ? 'suspended' : 'approved', isActive: scenario !== 'offline', isAvailable: true,
      activeDeliveries: scenario === 'capacity' ? 5 : 0 };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await require('../controllers/riderController').claimOrder({ rider: { _id: ids.rider }, params: { id: ids.agreement } }, res);
    assert.equal(res.code, ['other-assignee', 'suspended'].includes(scenario) ? 403 : 400, scenario);
  }
  assert.equal(aborted, 8); assert.equal(f.state.riders[0].walletBalance, 10); assert.equal(f.state.acceptances.length, 0);
});
