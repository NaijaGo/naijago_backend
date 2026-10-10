const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const Rider = require('../models/Rider');
const { verifyGoogleIdentity } = require('../services/googleIdentityService');
const { googleUserAuth } = require('../middleware/googleAuthMiddleware');
// Force all verification email delivery to a local stub before loading routers.
const resendModule = require('resend');
const resendPath = require.resolve('resend');
require.cache[resendPath].exports = { ...resendModule, Resend: class { constructor() { this.emails = { send: async () => ({ data: { id: 'local-mail-fixture' } }) }; } } };
const originalResendKey = process.env.RESEND_API_KEY;
process.env.RESEND_API_KEY = 'local-fixture-only';
const riderController = require('../controllers/riderController');
const authRouter = require('../routes/authRoutes');
const riderRouter = require('../routes/riderRoutes');
require.cache[resendPath].exports = resendModule;
if (originalResendKey === undefined) delete process.env.RESEND_API_KEY;
else process.env.RESEND_API_KEY = originalResendKey;

// Real JWT signature/audience/issuer/expiry validation against local RSA fixtures.
// Only Google's certificate download and database methods are substituted.
// These tests never load a MongoDB URI, send email, or call Google/production.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const ids = { customer: 'customer.apps.googleusercontent.com', vendor: 'vendor.apps.googleusercontent.com', rider: 'rider.apps.googleusercontent.com' };
const userId = '507f1f77bcf86cd799439011';
function token(overrides = {}, app = 'customer', key = privateKey) {
  return jwt.sign({ sub: 'google-subject-1', email: 'localfixture@gmail.com', email_verified: true,
    given_name: 'Local', family_name: 'Fixture', name: 'Local Fixture', aud: ids[app],
    iss: 'https://accounts.google.com', exp: Math.floor(Date.now() / 1000) + 1800, ...overrides,
  }, key, { algorithm: 'RS256', keyid: 'local-test' });
}
function setup(t) {
  for (const app of Object.keys(ids)) {
    const name = 'GOOGLE_' + app.toUpperCase() + '_CLIENT_ID', previous = process.env[name];
    process.env[name] = ids[app];
    t.after(() => previous === undefined ? delete process.env[name] : process.env[name] = previous);
  }
  const previous = process.env.JWT_SECRET; process.env.JWT_SECRET = 'isolated-local-google-test-secret';
  t.after(() => previous === undefined ? delete process.env.JWT_SECRET : process.env.JWT_SECRET = previous);
  t.mock.method(OAuth2Client.prototype, 'getFederatedSignonCertsAsync', async () => ({ certs: { 'local-test': publicKey } }));
}
function queryResult(account) {
  return Object.assign(Promise.resolve(account), { select: () => Promise.resolve(account) });
}
function user(t, fields = {}) {
  const doc = new User({ _id: userId, firstName: 'Local', lastName: 'Fixture', email: 'localfixture@gmail.com',
    phoneNumber: '08012345678', password: bcrypt.hashSync('existing-password', 4), isEmailVerified: true,
    googleSubject: 'google-subject-1', deviceFingerprint: 'test-device', trustedDevices: [], referralCode: 'NGLOCAL1', ...fields });
  t.mock.method(doc, 'save', async () => doc);
  return doc;
}
function stubLookup(t, Model, account, linked = true) {
  t.mock.method(Model, 'findOne', query => queryResult(query.googleSubject && !linked ? null : account));
}
async function post(t, url, body) {
  const app = express(); app.use(express.json()); app.use('/api/auth', authRouter); app.use('/api/riders', riderRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
const request = (extra = {}) => ({ app: 'customer', idToken: token(), deviceFingerprint: 'test-device', ...extra });
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

for (const app of Object.keys(ids)) test('Google verifies a signed token for ' + app, async t => {
  setup(t); const identity = await verifyGoogleIdentity(token({}, app), app);
  assert.equal(identity.sub, 'google-subject-1'); assert.equal(identity.email, 'localfixture@gmail.com');
  assert.equal(identity.authoritativeEmail, true);
});
for (const [name, claims] of Object.entries({
  'wrong audience': { aud: 'foreign.apps.googleusercontent.com' },
  'wrong issuer': { iss: 'https://attacker.invalid' },
  'expired token': { exp: Math.floor(Date.now() / 1000) - 600 },
  'recently expired token': { exp: Math.floor(Date.now() / 1000) - 1 },
  'unverified email': { email_verified: false },
  'missing subject': { sub: '' },
  'invalid subject type': { sub: 17 },
})) test('Google rejects ' + name, async t => {
  setup(t); await assert.rejects(verifyGoogleIdentity(token(claims), 'customer'), error => error.status === 401);
});
test('Google rejects a signature from a different private key', async t => {
  setup(t); const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(verifyGoogleIdentity(token({}, 'customer', other.privateKey), 'customer'), { code: 'GOOGLE_TOKEN_INVALID' });
});
test('Google fails closed when an app client ID is missing', async t => {
  setup(t); delete process.env.GOOGLE_CUSTOMER_CLIENT_ID;
  await assert.rejects(verifyGoogleIdentity(token(), 'customer'), { status: 503, code: 'GOOGLE_NOT_CONFIGURED' });
});
test('Google rejects unsupported app roles and malformed tokens', async t => {
  setup(t); await assert.rejects(verifyGoogleIdentity(token(), 'admin'), { status: 400 });
  await assert.rejects(verifyGoogleIdentity({}, 'customer'), { status: 400 });
});
test('third-party Google emails require NaijaGo email verification', async t => {
  setup(t); assert.equal((await verifyGoogleIdentity(token({ email: 'person@example.com' }), 'customer')).authoritativeEmail, false);
  assert.equal((await verifyGoogleIdentity(token({ email: 'person@example.com', hd: 'example.com' }), 'customer')).authoritativeEmail, true);
});
test('linked customer receives the existing session contract', async t => {
  setup(t); stubLookup(t, User, user(t));
  const result = await post(t, '/api/auth/google', request({ email: 'attacker@example.com', isAdmin: true }));
  assert.equal(result.status, 200); assert.equal(result.data.user.email, 'localfixture@gmail.com');
  assert.equal(result.data.user.isAdmin, false); assert.equal(jwt.verify(result.data.token, process.env.JWT_SECRET).id, userId);
});
test('new account requires profile and does not create an incomplete record', async t => {
  setup(t); stubLookup(t, User, null); const create = t.mock.method(User, 'create', async () => { throw Error('Must not create'); });
  const result = await post(t, '/api/auth/google', request());
  assert.equal(result.status, 202); assert.equal(result.data.code, 'GOOGLE_PROFILE_REQUIRED'); assert.equal(create.mock.callCount(), 0);
});
test('new vendor Google signup remains unapproved and ignores role fields', async t => {
  setup(t); stubLookup(t, User, null); let stored;
  t.mock.method(User, 'create', async fields => { stored = fields; return user(t, fields); });
  const result = await post(t, '/api/auth/google', request({ app: 'vendor', idToken: token({}, 'vendor'),
    profile: { firstName: 'Local', lastName: 'Fixture', phoneNumber: '08012345678', acceptedTerms: true, isVendor: true, vendorStatus: 'approved', email: 'fake@gmail.com' } }));
  assert.equal(result.status, 200); assert.equal(result.data.user.isVendor, false); assert.equal(result.data.user.vendorStatus, 'none');
  assert.equal(stored.email, 'localfixture@gmail.com'); assert.equal(stored.googleSubject, 'google-subject-1');
  assert.equal(stored.password.length, 96); assert.equal(stored.isAdmin, undefined);
});
for (const invalid of [{ acceptedTerms: false }, { phoneNumber: 'invalid' }, { firstName: '' }, { lastName: '' }]) test('Google signup rejects invalid required profile: ' + Object.keys(invalid)[0], async t => {
  setup(t); stubLookup(t, User, null); const create = t.mock.method(User, 'create', async () => { throw Error('Must not create'); });
  const result = await post(t, '/api/auth/google', request({ profile: { firstName: 'Local', lastName: 'Fixture', phoneNumber: '08012345678', acceptedTerms: true, ...invalid } }));
  assert.equal(result.status, 400); assert.equal(create.mock.callCount(), 0);
});
test('existing email is not silently linked', async t => {
  setup(t); const account = user(t, { googleSubject: undefined }); stubLookup(t, User, account, false);
  const result = await post(t, '/api/auth/google', request());
  assert.equal(result.status, 409); assert.equal(result.data.code, 'GOOGLE_LINK_REQUIRED'); assert.equal(account.googleSubject, undefined);
});
test('wrong linking password cannot authenticate', async t => {
  setup(t); stubLookup(t, User, user(t, { googleSubject: undefined }), false);
  assert.equal((await post(t, '/api/auth/google', request({ linkPassword: 'wrong' }))).status, 401);
});
test('existing account links only after password proof', async t => {
  setup(t); const account = user(t, { googleSubject: undefined }); stubLookup(t, User, account, false);
  t.mock.method(User, 'findOneAndUpdate', (_filter, update) => { Object.assign(account, update.$set); return queryResult(account); });
  assert.equal((await post(t, '/api/auth/google', request({ linkPassword: 'existing-password' }))).status, 200);
  assert.equal(account.googleSubject, 'google-subject-1');
});
test('Google never bypasses Admin login', async t => {
  setup(t); stubLookup(t, User, user(t, { isAdmin: true }));
  assert.equal((await post(t, '/api/auth/google', request())).status, 403);
});
test('missing stable device is rejected before database lookup', async t => {
  setup(t); const find = t.mock.method(User, 'findOne', () => { throw Error('Must not query'); });
  assert.equal((await post(t, '/api/auth/google', request({ deviceFingerprint: 'unknown-device' }))).status, 400);
  assert.equal(find.mock.callCount(), 0);
});
test('an untrusted Google login is not issued a session', async t => {
  setup(t); const account = user(t, { deviceFingerprint: 'original-device' }); stubLookup(t, User, account);
  // The real login calls the existing email/device-verification path; the email
  // provider itself is local, so no email is sent.
  const result = await post(t, '/api/auth/google', request());
  assert.equal(result.status, 403); assert.equal(result.data.code, 'DEVICE_VERIFICATION_REQUIRED'); assert.equal(result.data.token, undefined);
  assert.equal(account.pendingDeviceFingerprint, 'test-device');
});
test('non-Gmail signup sends the correct verification type and remains unverified', async t => {
  setup(t); stubLookup(t, User, null); let sent;
  t.mock.method(User, 'create', async fields => user(t, fields));
  const middleware = googleUserAuth(async (...args) => { sent = args; });
  const req = { body: request({ idToken: token({ email: 'person@example.com' }), profile: {
    firstName: 'Local', lastName: 'Fixture', phoneNumber: '08012345678', acceptedTerms: true,
  } }) }; let next = false;
  await middleware(req, response(), () => { next = true; });
  assert.equal(next, true); assert.equal(req.googleAuthenticatedUser.isEmailVerified, false);
  assert.equal(sent[2], 'email'); assert.equal(sent[0], 'person@example.com');
});
test('existing password login cannot be spoofed by request body Google fields', async t => {
  setup(t); stubLookup(t, User, user(t));
  const result = await post(t, '/api/auth/login', { email: 'localfixture@gmail.com', password: 'wrong', googleAuthenticatedUser: { isAdmin: true } });
  assert.equal(result.status, 400); assert.equal(result.data.token, undefined);
});
test('new Google rider is directed to document onboarding', async t => {
  setup(t); stubLookup(t, Rider, null);
  const result = await post(t, '/api/riders/google', { idToken: token({}, 'rider') });
  assert.equal(result.status, 202); assert.equal(result.data.code, 'GOOGLE_RIDER_ONBOARDING_REQUIRED'); assert.equal(result.data.token, undefined);
});
for (const status of ['pending', 'rejected', 'suspended']) test('Google rider cannot bypass ' + status + ' status', async t => {
  setup(t); const doc = new Rider({ _id: userId, email: 'localfixture@gmail.com', fullName: 'Local Fixture', googleSubject: 'google-subject-1', status, isEmailVerified: true });
  stubLookup(t, Rider, doc);
  const result = await post(t, '/api/riders/google', { idToken: token({}, 'rider') });
  assert.equal(result.status, 401); assert.equal(result.data.token, undefined);
});
test('approved Google rider receives the existing rider session', async t => {
  setup(t); const doc = new Rider({ _id: userId, email: 'localfixture@gmail.com', fullName: 'Local Fixture', googleSubject: 'google-subject-1', status: 'approved', isEmailVerified: true });
  t.mock.method(doc, 'save', async () => doc); stubLookup(t, Rider, doc);
  const result = await post(t, '/api/riders/google', { idToken: token({}, 'rider') });
  assert.equal(result.status, 200); assert.equal(result.data.status, 'approved'); assert.equal(result.data._id, userId);
});
test('Google rider registration retains document requirements', async t => {
  setup(t); t.mock.method(Rider, 'exists', async () => false); stubLookup(t, Rider, null);
  const res = response(); await riderController.registerRider({ body: { googleIdToken: token({}, 'rider'), acceptedTerms: true, fullName: 'Local Fixture', plateNumber: 'TEST123', phoneNumber: '08012345678' } }, res);
  assert.equal(res.statusCode, 400); assert.match(res.body.message, /document/i);
});
test('Google rider onboarding creates a pending account with no operational JWT', async t => {
  setup(t); t.mock.method(Rider, 'exists', async () => false); stubLookup(t, Rider, null); let stored;
  t.mock.method(Rider, 'create', async fields => { stored = fields; return new Rider(fields); });
  const res = response(); await riderController.registerRider({ body: { googleIdToken: token({}, 'rider'), acceptedTerms: true,
    fullName: 'Local Fixture', email: 'spoofed@gmail.com', password: 'client-password', status: 'approved', isVerified: true,
    plateNumber: 'TEST123', phoneNumber: '08012345678', documentUrls: { ninFront: 'local-front', ninBack: 'local-back', platePhoto: 'local-plate', selfie: 'local-selfie' } } }, res);
  assert.equal(res.statusCode, 201); assert.equal(res.body.status, 'pending'); assert.equal(res.body.token, undefined);
  assert.equal(stored.googleSubject, 'google-subject-1'); assert.equal(stored.email, 'localfixture@gmail.com'); assert.notEqual(stored.password, 'client-password');
});
test('Google subject indexes are unique without excluding legacy accounts', () => {
  for (const Model of [User, Rider]) {
    const index = Model.schema.indexes().find(([keys]) => keys.googleSubject === 1);
    assert.equal(index[1].unique, true); assert.deepEqual(index[1].partialFilterExpression, { googleSubject: { $type: 'string' } });
    assert.equal(Model.schema.path('googleSubject').isRequired, undefined);
  }
});
