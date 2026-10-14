const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const authRouter = require('../routes/authRoutes');
const { protect } = require('../middleware/authMiddleware');
const { reviewAccessSeconds } = require('../services/appReviewAccessService');
const id = 'd'.repeat(24), password = 'long-fixture-review-password';
const user = { _id: id, isEmailVerified: true, role: 'user', isAdmin: false, isVendor: false };
test('review exception is off by default and bound to one verified ordinary account for at most seven days', () => {
  const now = Date.now(), env = { APP_REVIEW_CUSTOMER_ID: id, APP_REVIEW_ACCESS_EXPIRES_AT: new Date(now + 7200000).toISOString() };
  assert.equal(reviewAccessSeconds(user, {}, now), 0); assert.equal(reviewAccessSeconds(user, env, now), 3600);
  for (const patch of [{ _id: 'e'.repeat(24) }, { isEmailVerified: false }, { isAdmin: true }, { isVendor: true }, { role: 'pharmacist' }, { isSuspended: true }]) {
    assert.equal(reviewAccessSeconds({ ...user, ...patch }, env, now), 0);
  }
  for (const expiry of ['bad', new Date(now - 1).toISOString(), new Date(now + 8 * 86400000).toISOString()]) {
    assert.equal(reviewAccessSeconds(user, { ...env, APP_REVIEW_ACCESS_EXPIRES_AT: expiry }, now), 0);
  }
});
test('actual password login returns a bounded demo JWT without email/device verification mutations', async t => {
  for (const [key, value] of Object.entries({ JWT_SECRET: 'fixture-review-jwt', APP_REVIEW_CUSTOMER_ID: id,
    APP_REVIEW_ACCESS_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString() })) {
    const old = process.env[key]; process.env[key] = value;
    t.after(() => old === undefined ? delete process.env[key] : process.env[key] = old);
  }
  const doc = new User({ ...user, firstName: 'Review', lastName: 'Fixture', email: 'review@example.invalid',
    phoneNumber: '08012345678', password: bcrypt.hashSync(password, 4), deviceFingerprint: 'original', trustedDevices: [] });
  t.mock.method(doc, 'save', async () => assert.fail('Review exception must not change trust or verification'));
  t.mock.method(User, 'findOne', async () => doc);
  t.mock.method(User, 'findById', () => ({ select: async () => doc }));
  const app = express(); app.use(express.json()); app.use('/auth', authRouter);
  app.get('/protected', protect, (req, res) => res.json({ id: String(req.user._id) }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = body => fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: doc.email, password, deviceFingerprint: 'review-device', ...body }) });
  let response = await login({}); assert.equal(response.status, 200); const result = await response.json();
  const claims = jwt.verify(result.token, process.env.JWT_SECRET); assert.equal(claims.reviewAccess, true); assert.ok(claims.exp - claims.iat <= 3600);
  assert.equal(doc.deviceFingerprint, 'original'); assert.equal(doc.isEmailVerified, true); assert.deepEqual(doc.trustedDevices, []);
  response = await login({ password: 'incorrect-long-password' }); assert.equal(response.status, 400); assert.equal((await response.json()).token, undefined);
  doc.isEmailVerified = false; response = await login({}); assert.equal(response.status, 403); doc.isEmailVerified = true;
  response = await fetch(base + '/protected', { headers: { Authorization: `Bearer ${result.token}` } }); assert.equal(response.status, 200);
  delete process.env.APP_REVIEW_CUSTOMER_ID;
  response = await fetch(base + '/protected', { headers: { Authorization: `Bearer ${result.token}` } }); assert.equal(response.status, 401);
});
