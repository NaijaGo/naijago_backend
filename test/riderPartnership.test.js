const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const { fixture, ids } = require('./support/riderPartnershipFixture');
const { canonicalContent, contentHash } = require('../services/riderAgreementService');
const { lagosDay } = require('../services/riderDailyBonusService');
const { createRiderAgreementRouter } = require('../routes/riderAgreementRoutes');
const { createRiderPartnershipAdminRouter } = require('../routes/riderPartnershipAdminRoutes');
const { createAgreementIdentity, createAgreementGuard } = require('../middleware/riderAgreementGuard');

async function api(t, router, request) {
  const app = express(); app.use(express.json()); app.use(router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return request(`http://127.0.0.1:${server.address().port}`);
}
const auth = (req, res, next) => { req.rider = { _id: ids.rider }; next(); };
test('canonical content has one exact UTF-8 SHA-256 representation', () => {
  assert.equal(canonicalContent('One\r\nTwo\rThree'), 'One\nTwo\nThree');
  assert.equal(contentHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.throws(() => canonicalContent('  '));
});
test('no required agreement fails closed without implicit initialization', async () => {
  const f = fixture({ configured: false });
  await assert.rejects(f.agreements.status(ids.rider), { code: 'RIDER_AGREEMENT_NOT_CONFIGURED', status: 503 });
  assert.equal(f.writes.length, 0);
});
test('acceptance is bound to server identity, hash and UTC clock, preserving history', async () => {
  const f = fixture();
  const result = await f.agreements.accept(ids.rider, f.acceptance(), { requestId: 'fixture-id' });
  assert.equal(result.acceptance.riderId, ids.rider); assert.equal(result.acceptance.actorId, ids.rider);
  assert.equal(result.acceptance.acceptedAt.toISOString(), '2026-10-13T10:00:00.000Z');
  assert.equal(result.acceptance.method, 'in_app_explicit_consent');
  assert.equal((await f.agreements.status(ids.other)).accepted, false);
  f.assertTransactionWrites();
});
for (const patch of [{ accepted: false }, { accepted: 'true' }, { version: '' }, { version: '1.1' },
  { agreementId: 'invalid' }, { contentHash: 'invalid' }, { contentHash: '0'.repeat(64) },
  { riderId: ids.other }, { acceptedAt: '1990-01-01' }, { actorId: ids.admin }, { platform: 'bad' }]) {
  test(`invalid/stale acceptance rejected: ${JSON.stringify(patch)}`, async () => {
    const f = fixture(); await assert.rejects(f.agreements.accept(ids.rider, { ...f.acceptance(), ...patch }));
    assert.equal(f.state.acceptances.length, 0);
  });
}
test('duplicate concurrent acceptance preserves one record and original timestamp', async () => {
  const f = fixture();
  const results = await Promise.all([f.agreements.accept(ids.rider, f.acceptance()), f.agreements.accept(ids.rider, f.acceptance())]);
  assert.equal(f.state.acceptances.length, 1); assert.equal(results[0].acceptance._id, results[1].acceptance._id);
  f.setTime(new Date('2026-10-14T00:00:00Z'));
  assert.equal((await f.agreements.accept(ids.rider, f.acceptance())).acceptance.acceptedAt.toISOString(), '2026-10-13T10:00:00.000Z');
});
test('database/index failures never produce saved acceptance or online success', async () => {
  for (const name of ['policies', 'acceptances', 'riders']) {
    const f = fixture(); f.fail(name);
    await assert.rejects(f.agreements.accept(ids.rider, f.acceptance()));
    assert.equal(f.state.acceptances.length, 0);
  }
  const f = fixture(); f.failReady(); await assert.rejects(f.agreements.accept(ids.rider, f.acceptance()));
  assert.equal(f.state.acceptances.length, 0);
});
test('unaccepted riders cannot enable availability, accept offers or enter dispatch', async () => {
  const f = fixture();
  for (const changes of [{ isAvailable: true }, { isActive: true }, { isAvailable: true, isActive: true }]) {
    await assert.rejects(f.agreements.updateAvailability(ids.rider, changes), { status: 403, code: 'RIDER_AGREEMENT_REQUIRED' });
  }
  let ran = false;
  await assert.rejects(f.agreements.eligibleWork(ids.rider, async () => { ran = true; }), { status: 403 });
  assert.equal(ran, false); assert.deepEqual(await f.agreements.acceptedRiderIds(), []);
  await f.agreements.updateAvailability(ids.rider, { isAvailable: false });
  assert.equal(f.state.riders[0].isAvailable, false);
});
test('accepted riders still need approval/online/capacity checks', async () => {
  const f = fixture(); await f.agreements.accept(ids.rider, f.acceptance());
  await f.agreements.eligibleWork(ids.rider, async session => assert.ok(session.fixtureTransaction));
  f.state.riders[0].status = 'suspended';
  await assert.rejects(f.agreements.updateAvailability(ids.rider, { isActive: true }), { status: 403 });
  await assert.rejects(f.agreements.eligibleWork(ids.rider, async () => assert.fail('restricted work executed')));
});
test('publication is immutable, requires revision and cannot silently change required version', async () => {
  const f = fixture(); const draft = await f.agreements.createDraft(ids.admin, { version: '1.1', content: 'Full second fixture agreement' });
  await f.agreements.publish(ids.admin, draft._id, { revision: 0 });
  assert.equal((await f.agreements.current()).agreement.version, '1.0');
  await assert.rejects(f.agreements.editDraft(draft._id, { revision: 1, content: 'Overwrite' }), { status: 409 });
  await assert.rejects(f.agreements.publish(ids.admin, draft._id, { revision: 1 }), { status: 409 });
});
test('new requirement suspends new work, releases unclaimed offers, preserves claimed deliveries/history', async () => {
  const f = fixture(); await f.agreements.accept(ids.rider, f.acceptance());
  const draft = await f.agreements.createDraft(ids.admin, { version: '1.1', content: 'New complete fixture agreement' });
  await f.agreements.publish(ids.admin, draft._id, { revision: 0 });
  f.state.orders.push({ _id: 'claimed', rider: ids.rider, isClaimed: true, mainOrderStatus: 'out_for_delivery' },
    { _id: 'offer', assignedRider: ids.rider, isClaimed: false, mainOrderStatus: 'processing' });
  await f.agreements.setRequired(ids.admin, { agreementId: draft._id, revision: 0, reason: 'Updated rider terms' });
  assert.equal(f.state.riders[0].isAvailable, false); assert.equal(f.state.riders[0].isActive, false);
  assert.equal(f.state.orders[1].assignedRider, undefined); assert.equal(f.state.orders[0].rider, ids.rider);
  assert.equal(f.state.orders[0].isClaimed, true); assert.equal(f.state.acceptances.length, 1);
  await assert.rejects(f.agreements.requireAccepted(ids.rider), { status: 403, requiredVersion: '1.1' });
});
test('concurrent required-version change cannot make a stale acceptance authorize new work', async () => {
  const f = fixture(); const draft = await f.agreements.createDraft(ids.admin, { version: '1.1', content: 'New agreement' });
  await f.agreements.publish(ids.admin, draft._id, { revision: 0 });
  const results = await Promise.allSettled([
    f.agreements.setRequired(ids.admin, { agreementId: draft._id, revision: 0, reason: 'New policy' }),
    f.agreements.accept(ids.rider, f.acceptance()),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'RIDER_AGREEMENT_CHANGED');
  await assert.rejects(f.agreements.eligibleWork(ids.rider, async () => assert.fail('stale dispatch')));
});
test('unauthenticated acceptance returns 401; current identity cannot read another rider', async t => {
  const f = fixture();
  const authenticate = createAgreementIdentity({ Riders: f.models.Rider, verify: () => ({ id: ids.rider }) });
  await api(t, createRiderAgreementRouter({ service: f.agreements, authenticate }), async base => {
    assert.equal((await fetch(`${base}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f.acceptance()) })).status, 401);
    const response = await fetch(`${base}/status?riderId=${ids.other}`, { headers: { Authorization: 'Bearer fixture' } });
    assert.equal(response.status, 200); assert.equal((await response.json()).accepted, false);
    const accept = await fetch(`${base}/accept`, { method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }, body: JSON.stringify(f.acceptance()) });
    assert.equal(accept.status, 200); assert.equal((await accept.json()).acceptance.riderId, ids.rider);
  });
});
test('database failures return structured 503 rather than false persistence success', async t => {
  const f = fixture(); f.fail('acceptances');
  await api(t, createRiderAgreementRouter({ service: f.agreements, authenticate: auth }), async base => {
    const response = await fetch(`${base}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f.acceptance()) });
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'RIDER_AGREEMENT_UNAVAILABLE');
  });
});
test('guard blocks direct API work with stable 403, accepted fixtures pass', async t => {
  const f = fixture(), router = express.Router(); router.use(auth, createAgreementGuard(f.agreements));
  router.post('/claim', (req, res) => res.json({ executed: true }));
  await api(t, router, async base => {
    const denied = await fetch(`${base}/claim`, { method: 'POST' });
    assert.equal(denied.status, 403); assert.equal((await denied.json()).code, 'RIDER_AGREEMENT_REQUIRED');
    await f.agreements.accept(ids.rider, f.acceptance());
    assert.equal((await fetch(`${base}/claim`, { method: 'POST' })).status, 200);
  });
});
test('unauthorized users cannot publish or access acceptance history', async t => {
  const f = fixture(); const router = createRiderPartnershipAdminRouter({ agreements: f.agreements,
    bonuses: f.bonuses, ...f.models, authenticate: (req, res, next) => { req.user = { _id: ids.rider }; next(); } });
  await api(t, router, async base => {
    assert.equal((await fetch(`${base}/agreements`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/acceptances?riderId=${ids.other}`)).status, 403);
  });
});
test('unique schema indexes exist and acceptance identity/time fields are immutable', () => {
  const Acceptance = require('../models/RiderAgreementAcceptance'), Agreement = require('../models/RiderAgreement');
  assert.ok(Acceptance.schema.indexes().some(([keys, options]) => keys.riderId && keys.version && options.unique));
  assert.ok(Agreement.schema.indexes().some(([keys, options]) => keys.version && options.unique));
  for (const key of ['riderId', 'agreementId', 'acceptedAt', 'contentHash', 'actorId']) assert.equal(Acceptance.schema.path(key).options.immutable, true);
  assert.equal(Acceptance.schema.options.autoIndex, false);
});
test('all real work entry points contain shared checks; active OTP paths stay finishable', () => {
  const source = fs.readFileSync('controllers/riderController.js', 'utf8');
  const claim = source.slice(source.indexOf('exports.claimOrder'), source.indexOf('exports.rejectAssignedOrder'));
  assert.match(claim, /requireAccepted\(riderId, \{ session, fence: true \}\)/);
  assert.match(claim, /isPaid/); assert.match(claim, /commitTransaction/);
  assert.doesNotMatch(source.slice(source.indexOf('exports.verifyPickupOTP'), source.indexOf('exports.getActiveDeliveries')), /requireAccepted/);
  const socket = fs.readFileSync('server.js', 'utf8').slice(0, fs.readFileSync('server.js', 'utf8').indexOf('// const CompanyRider'));
  assert.match(socket, /updateAvailability\(userId, changes\)/); assert.match(socket, /eligibleWork\(riderId, async session/);
  assert.match(fs.readFileSync('services/riderAssignmentService.js', 'utf8'), /eligibleWork\(nearestRider\._id, async session/);
  assert.match(fs.readFileSync('routes/adminRoutes.js', 'utf8'), /requireAccepted\(riderId, \{ session, fence: true \}\)/);
});
test('Lagos midnight uses UTC+1 and bonus counts complete orders, not shipments', async () => {
  const day = lagosDay(new Date('2026-10-12T23:00:00Z'));
  assert.equal(day.day, '2026-10-13'); assert.equal(day.start.toISOString(), '2026-10-12T23:00:00.000Z');
  const f = fixture(); f.complete(19); f.state.orders.push({ _id: 'unpaid', rider: ids.rider, isPaid: false, isDelivered: true, mainOrderStatus: 'delivered', deliveredAt: new Date('2026-10-13T10:00:00Z') });
  assert.equal((await f.bonuses.progress(ids.rider)).completedOrders, 19);
  await assert.rejects(f.bonuses.request(ids.rider), { code: 'BONUS_NOT_ELIGIBLE' });
});
test('bonus request does not credit wallet; admin approval credits exactly once', async () => {
  const f = fixture(); f.complete(); const claim = await f.bonuses.request(ids.rider);
  assert.equal(claim.state, 'pending'); assert.equal(f.state.riders[0].walletBalance, 10);
  assert.equal((await f.bonuses.request(ids.rider))._id, claim._id); assert.equal(f.state.bonuses.length, 1);
  await Promise.all([f.bonuses.review(ids.admin, claim._id, { state: 'approved', reason: 'Verified completed jobs' }),
    f.bonuses.review(ids.admin, claim._id, { state: 'approved', reason: 'Retry approval' })]);
  assert.equal(f.state.riders[0].walletBalance, 10010); assert.equal(f.state.riders[0].totalEarnings, 10010);
  assert.equal(f.state.bonuses[0].reviewedBy, ids.admin);
});
test('bonus rejection and transaction failure never credit a wallet', async () => {
  for (const scenario of ['rejected', 'failed']) {
    const f = fixture(); f.complete(); const claim = await f.bonuses.request(ids.rider);
    if (scenario === 'failed') { f.fail('bonuses'); await assert.rejects(f.bonuses.review(ids.admin, claim._id, { state: 'approved', reason: 'Fixture failure' })); }
    else await f.bonuses.review(ids.admin, claim._id, { state: 'rejected', reason: 'Fixture review' });
    assert.equal(f.state.riders[0].walletBalance, 10);
  }
});
test('database setup is dry-run by default and never publishes or credits', async () => {
  const { initializeRiderPartnership } = require('../scripts/initializeRiderPartnership');
  const db = { listCollections: () => ({ toArray: async () => [] }), createCollection: () => assert.fail('unexpected setup write') };
  const result = await initializeRiderPartnership(db);
  assert.equal(result.mode, 'dry-run'); assert.equal(result.plan.length, 4); assert.equal(result.publishesAgreement, false);
});

test('corrupt or future effective dates cannot authorize work or become required', async () => {
  for (const date of [null, 'bad-date', new Date('2099-01-01')]) {
    const f = fixture(); f.state.agreements[0].effectiveAt = date;
    await assert.rejects(f.agreements.status(ids.rider), { status: 503 });
    await assert.rejects(f.agreements.setRequired(ids.admin, { agreementId: ids.agreement, revision: 0, reason: 'Fixture test' }), { status: 400 });
  }
});
test('a unique index on incorrect keys or partial records fails readiness', async () => {
  const { checkUniqueIndex } = require('../services/riderAgreementService');
  for (const index of [ { name: 'rider_version_unique', unique: true, key: { riderId: 1 } },
    { name: 'rider_version_unique', unique: true, key: { riderId: 1, version: 1 }, sparse: true } ]) {
    await assert.rejects(checkUniqueIndex({ collection: { listIndexes: () => ({ toArray: async () => [index] }) } }, 'rider_version_unique'));
  }
});
test('pending rider can accept current terms but cannot activate delivery work', async () => {
  const f = fixture(); f.state.riders[0].status = 'pending';
  assert.equal((await f.agreements.accept(ids.rider, f.acceptance())).accepted, true);
  await assert.rejects(f.agreements.updateAvailability(ids.rider, { isActive: true }), { status: 403 });
  await assert.rejects(f.agreements.eligibleWork(ids.rider, () => assert.fail('pending dispatch')));
});
const mockResponse = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
test('actual operational auth guards reject agreement-only JWT before any database lookup', async t => {
  const original = process.env.JWT_SECRET; process.env.JWT_SECRET = 'local-fixture-secret';
  t.after(() => { if (original === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = original; });
  const { agreementToken } = require('../middleware/riderAgreementGuard');
  const token = agreementToken(ids.rider);
  for (const guard of [require('../middleware/authMiddleware').protect, require('../middleware/riderAuthMiddleware').riderProtect]) {
    const res = mockResponse(); await guard({ headers: { authorization: `Bearer ${token}` } }, res, () => assert.fail('limited token gained work access'));
    assert.equal(res.code, 401);
  }
});
test('actual login preserves pending restrictions and provides only opt-in agreement sessions', async t => {
  const original = process.env.JWT_SECRET; process.env.JWT_SECRET = 'local-fixture-secret';
  t.after(() => { if (original === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = original; });
  const { loginRider } = require('../controllers/riderController');
  const rider = { _id: ids.rider, status: 'pending', isEmailVerified: true, email: 'fixture@example.invalid' };
  let res = mockResponse(); await loginRider({ body: {}, googleAuthenticatedRider: rider }, res); assert.equal(res.code, 401);
  res = mockResponse(); await loginRider({ body: { agreementOnly: true }, googleAuthenticatedRider: rider }, res);
  assert.equal(res.code, 200); assert.equal(res.body.token, undefined); assert.ok(res.body.agreementToken);
  const decoded = require('jsonwebtoken').verify(res.body.agreementToken, process.env.JWT_SECRET);
  assert.equal(decoded.id, ids.rider); assert.equal(decoded.purpose, 'rider_agreement'); assert.equal(decoded.aud, 'rider-agreement');
  for (const patch of [{ isEmailVerified: false }, { status: 'suspended' }, { status: 'rejected' }]) {
    res = mockResponse(); await loginRider({ body: { agreementOnly: true }, googleAuthenticatedRider: { ...rider, ...patch } }, res);
    assert.equal(res.code, 401); assert.equal(res.body.agreementToken, undefined);
  }
});
test('actual claim handler aborts before touching orders when required acceptance is missing', async t => {
  const mongoose = require('mongoose'), service = require('../services/riderAgreementService'), Orders = require('../models/MainOrder');
  const f = fixture(); const oldSession = mongoose.startSession, oldService = service.getService, oldFind = Orders.findById;
  let aborted = 0, ended = 0;
  mongoose.startSession = async () => ({ startTransaction() {}, abortTransaction: async () => aborted++, endSession: () => ended++ });
  service.getService = () => f.agreements; Orders.findById = () => assert.fail('order DB should not be touched');
  t.after(() => { mongoose.startSession = oldSession; service.getService = oldService; Orders.findById = oldFind; });
  const res = mockResponse(); await require('../controllers/riderController').claimOrder({ rider: { _id: ids.rider }, params: { id: ids.agreement } }, res);
  assert.equal(res.code, 403); assert.equal(res.body.code, 'RIDER_AGREEMENT_REQUIRED'); assert.equal(aborted, 1); assert.equal(ended, 1);
});
test('actual acceptance hooks permit idempotent insert and reject history modification without a database', async () => {
  const Model = require('../models/RiderAgreementAcceptance');
  const pre = query => new Promise((resolve, reject) => Model.schema.s.hooks.execPre('findOneAndUpdate', query, [], error => error ? reject(error) : resolve()));
  await pre(Model.findOneAndUpdate({ riderId: ids.rider }, { $setOnInsert: { version: '1.0' } }));
  await assert.rejects(pre(Model.findOneAndUpdate({ riderId: ids.rider }, { $set: { acceptedAt: new Date() } })), /immutable/);
});

test('actual claim rechecks approval inside its transaction after authentication', async t => {
  const mongoose = require('mongoose'), service = require('../services/riderAgreementService'), Order = require('../models/MainOrder'), Rider = require('../models/Rider');
  const f = fixture(); await f.agreements.accept(ids.rider, f.acceptance());
  const oldSession = mongoose.startSession, oldService = service.getService, oldOrder = Order.findById, oldRider = Rider.findById;
  let aborted = false;
  mongoose.startSession = async () => ({ startTransaction() {}, abortTransaction: async () => { aborted = true; }, endSession() {} });
  service.getService = () => f.agreements;
  Order.findById = () => ({ populate() { return this; }, session: async () => ({ isPaid: true, isClaimed: false, mainOrderStatus: 'processing', shipments: [] }) });
  Rider.findById = () => ({ session: async () => ({ status: 'suspended', isActive: true, isAvailable: true }) });
  t.after(() => { mongoose.startSession = oldSession; service.getService = oldService; Order.findById = oldOrder; Rider.findById = oldRider; });
  const res = mockResponse(); await require('../controllers/riderController').claimOrder({ rider: { _id: ids.rider }, params: { id: ids.agreement } }, res);
  assert.equal(res.code, 403); assert.equal(res.body.code, 'RIDER_ACCOUNT_RESTRICTED'); assert.equal(aborted, true);
});
