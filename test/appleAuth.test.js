const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const express = require('express');
const { createAppleVerifier } = require('../services/appleIdentityService');
const { createAppleAuthService } = require('../services/appleAuthService');
const { createAppleRouter } = require('../routes/appleAuthRoutes');
const User = require('../models/User');
const { setupAppleAuth } = require('../scripts/setupAppleAuth');
const id = 'a'.repeat(24), nonce = 'b'.repeat(64), client = 'com.naijago.naijaGo';
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
const second = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sign = (patch = {}, options = {}) => jwt.sign(Object.fromEntries(Object.entries({ sub: 'apple-subject', iss: 'https://appleid.apple.com',
  aud: client, nonce, email: 'fixture@privaterelay.appleid.com', email_verified: 'true', exp: Math.floor(Date.now() / 1000) + 300, ...patch }).filter(([, value]) => value !== undefined)),
  options.key || pair.privateKey, { algorithm: 'RS256', keyid: options.kid || 'fixture', ...(options.jwt || {}) });

test('actual RSA/JWK verifier accepts Apple private relay identity and exact nonce', async () => {
  const verify = createAppleVerifier({ fetchKeys: async () => ({ keys: [key] }), audience: () => client });
  assert.deepEqual(await verify(sign(), nonce), { sub: 'apple-subject', email: 'fixture@privaterelay.appleid.com', emailVerified: true });
});
for (const [name, patch, options] of [
  ['expired', { exp: 1 }], ['wrong issuer', { iss: 'https://attacker.invalid' }], ['wrong audience', { aud: 'other.app' }],
  ['nonce mismatch', { nonce: 'c'.repeat(64) }], ['future issuance', { iat: Math.floor(Date.now() / 1000) + 600 }],
  ['missing expiry', { exp: undefined }], ['empty subject', { sub: '' }], ['array audience', { aud: [client, 'other'] }],
  ['forged signature', {}, { key: second.privateKey }], ['unknown key', {}, { kid: 'unknown' }],
]) test(`actual verifier rejects ${name}`, async () => {
  const verify = createAppleVerifier({ fetchKeys: async () => ({ keys: [key] }), audience: () => client });
  await assert.rejects(verify(sign(patch, options), nonce), { status: 401, code: 'APPLE_TOKEN_INVALID' });
});
test('JWKS is fixed, cached, shared and bounded; key outage never grants a session', async () => {
  let requests = 0;
  const verify = createAppleVerifier({ fetchKeys: async () => { requests++; return { keys: [key] }; }, audience: () => client });
  await Promise.all([verify(sign(), nonce), verify(sign(), nonce)]); assert.equal(requests, 1);
  await assert.rejects(createAppleVerifier({ fetchKeys: async () => { throw new Error('Fixture outage'); }, audience: () => client })(sign(), nonce), { status: 503 });
  await assert.rejects(createAppleVerifier({ audience: () => '' })(sign(), nonce), { status: 503 });
  await assert.rejects(verify('not-a-jwt', nonce), { status: 401 });
});

function fixture(t) {
  const before = process.env.APPLE_CUSTOMER_CLIENT_ID; process.env.APPLE_CUSTOMER_CLIENT_ID = client;
  t.after(() => before === undefined ? delete process.env.APPLE_CUSTOMER_CLIENT_ID : process.env.APPLE_CUSTOMER_CLIENT_ID = before);
  let rows = { users: [], identities: [], challenges: [] }, fail = '', tail = Promise.resolve(), writes = 0;
  let identity = { sub: 'apple-subject', email: 'fixture@privaterelay.appleid.com', emailVerified: true };
  const copy = x => structuredClone(x);
  const match = (row, filter) => Object.entries(filter).every(([k, v]) =>
    v && typeof v === 'object' && !(v instanceof Date) ? row[k] > v.$gt : String(row[k]) === String(v));
  function doc(row) {
    if (!row) return null;
    return { ...copy(row), async save() {
      if (fail === 'save') throw new Error('Fixture save failure');
      const record = rows.users.find(u => String(u._id) === String(this._id));
      Object.assign(record, Object.fromEntries(Object.entries(this).filter(([,v]) => typeof v !== 'function'))); writes++;
      return this;
    } };
  }
  function query(name, run, document = false) {
    const q = { session() { return this; }, lean() { return this; }, select() { return this; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        if (fail === name) throw new Error('Fixture database outage');
        const value = run(); return document ? doc(value) : copy(value);
      }).then(resolve, reject); } };
    return q;
  }
  function model(name) {
    return {
      findById(id) { return query(name, () => rows[name].find(r => String(r._id) === String(id)) || null, name === 'users'); },
      findOne(filter) { return query(name, () => rows[name].find(r => match(r, filter)) || null, name === 'users'); },
      async create(body) {
        if (fail === name) throw new Error('Fixture write outage');
        const many = Array.isArray(body), inputs = many ? body : [body];
        const output = inputs.map(input => {
          const row = { _id: id, role: 'user', isAdmin: false, isVendor: false, ...copy(input) };
          if (rows[name].some(r => name === 'users' ? r.email === row.email : r._id === row._id)) throw Object.assign(new Error('Duplicate fixture'), { code: 11000 });
          if (name === 'users') row.password = bcrypt.hashSync(row.password, 4);
          rows[name].push(row); writes++; return name === 'users' ? doc(row) : copy(row);
        });
        return many ? output : output[0];
      },
      findOneAndUpdate(filter, update) { return query(name, () => {
        const row = rows[name].find(r => match(r, filter)); if (!row) return null;
        Object.assign(row, copy(update.$set)); writes++; return row;
      }); },
    };
  }
  const models = { User: model('users'), Identity: model('identities'), Challenge: model('challenges') };
  const service = createAppleAuthService({ ...models, ready: async () => { if (fail === 'ready') throw new Error('Fixture indexes unavailable'); },
    verify: async (token, expected) => { if (token !== 'fixture-token' || expected !== nonce) throw Object.assign(new Error('Invalid fixture identity'), { status: 401, code: 'APPLE_TOKEN_INVALID' });
      return identity; },
    referral: async () => {},
    transact: async action => {
      const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous;
      const snapshot = copy(rows), oldWrites = writes;
      try { return await action({ fixtureSession: true }); }
      catch (e) { rows = snapshot; writes = oldWrites; throw e; } finally { release(); }
    },
  });
  const body = () => {
    const challengeId = crypto.randomBytes(32).toString('hex');
    rows.challenges.push({ _id: challengeId, nonce, fingerprint: crypto.createHash('sha256').update('fixture-device').digest('hex'), expiresAt: new Date(Date.now() + 300000), usedAt: null });
    return { app: 'customer', challengeId, idToken: 'fixture-token', deviceFingerprint: 'fixture-device', profile: { acceptedTerms: true } };
  };
  return { service, models, body, get rows() { return rows; }, get writes() { return writes; }, fail: name => { fail = name; },
    setIdentity: patch => { identity = { ...identity, ...patch }; } };
}

test('Apple creates one account without invented name/phone and retrieves it by subject without email', async t => {
  const f = fixture(t); const result = await f.service.authenticate(f.body());
  assert.equal(result.user.appleSubject, 'apple-subject'); assert.equal(result.user.isEmailVerified, true);
  assert.equal(result.user.firstName, undefined); assert.equal(result.user.phoneNumber, undefined);
  f.setIdentity({ email: null, emailVerified: false });
  await f.service.authenticate(f.body()); assert.equal(f.rows.users.length, 1); assert.equal(f.rows.identities.length, 1);
  assert.equal(f.rows.users[0].isAdmin, false); assert.equal(f.rows.users[0].role, 'user');
});
test('missing/unverified email cannot create a new account; mapped unverified local accounts remain blocked', async t => {
  const f = fixture(t); f.setIdentity({ email: null, emailVerified: false });
  await assert.rejects(f.service.authenticate(f.body()), { status: 401 }); assert.equal(f.rows.users.length, 0);
  f.setIdentity({ email: 'fixture@privaterelay.appleid.com', emailVerified: true }); await f.service.authenticate(f.body());
  f.rows.users[0].isEmailVerified = false;
  await assert.rejects(f.service.authenticate(f.body()), { status: 403 });
});
test('different fresh nonces for the same subject converge on one account', async t => {
  const f = fixture(t), bodies = [f.body(), f.body()];
  await Promise.all(bodies.map(body => f.service.authenticate(body)));
  assert.equal(f.rows.users.length, 1); assert.equal(f.rows.identities.length, 1);
});
test('algorithm confusion and unverified token claims cannot select keys or authorize accounts', async () => {
  let fetches = 0;
  const verify = createAppleVerifier({ fetchKeys: async () => { fetches++; return { keys: [key] }; }, audience: () => client });
  await assert.rejects(verify(jwt.sign({ sub: 'attacker', nonce }, 'fixture-secret', { algorithm: 'HS256' }), nonce), { status: 401 });
  await assert.rejects(verify(jwt.sign({ sub: 'attacker', nonce }, null, { algorithm: 'none' }), nonce), { status: 401 });
  assert.equal(fetches, 0);
});
test('onboarding and password-link responses never consume nonce or create an account', async t => {
  const f = fixture(t), body = f.body(); delete body.profile;
  assert.equal((await f.service.authenticate(body)).status, 202); assert.equal(f.rows.challenges[0].usedAt, null);
  f.rows.users.push({ _id: id, email: 'fixture@privaterelay.appleid.com', password: bcrypt.hashSync('existing-password', 4), isEmailVerified: true, role: 'user' });
  assert.equal((await f.service.authenticate(body)).status, 409); assert.equal(f.rows.identities.length, 0);
  await assert.rejects(f.service.authenticate({ ...body, linkPassword: 'wrong' }), { status: 401 });
  await f.service.authenticate({ ...body, linkPassword: 'existing-password', email: 'attacker.invalid', isAdmin: true });
  assert.equal(f.rows.users.length, 1); assert.equal(f.rows.users[0].email, 'fixture@privaterelay.appleid.com');
  assert.equal(f.rows.users[0].appleSubject, 'apple-subject');
});
test('concurrent attempts with one challenge cannot create duplicate accounts or issue two sessions', async t => {
  const f = fixture(t), body = f.body();
  const outcomes = await Promise.allSettled([f.service.authenticate(body), f.service.authenticate(body)]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(r => r.status === 'rejected').reason.code, 'APPLE_CHALLENGE_EXPIRED');
  assert.equal(f.rows.users.length, 1); assert.equal(f.rows.identities.length, 1);
});
for (const scenario of ['expired', 'used', 'wrong-device', 'vendor-app', 'invalid-token']) test(`Apple rejects ${scenario} before saving identity`, async t => {
  const f = fixture(t), body = f.body();
  if (scenario === 'expired') f.rows.challenges[0].expiresAt = new Date(1);
  if (scenario === 'used') f.rows.challenges[0].usedAt = new Date();
  if (scenario === 'wrong-device') body.deviceFingerprint = 'another-device';
  if (scenario === 'vendor-app') body.app = 'vendor';
  if (scenario === 'invalid-token') body.idToken = 'bad';
  await assert.rejects(f.service.authenticate(body)); assert.equal(f.rows.users.length, 0); assert.equal(f.rows.identities.length, 0);
});
for (const restriction of [{ isAdmin: true }, { role: 'admin' }, { vendorStatus: 'suspended' }, { pharmacistStatus: 'suspended' }]) {
  test(`Apple refuses restricted existing account ${JSON.stringify(restriction)}`, async t => {
    const f = fixture(t); f.rows.users.push({ _id: id, email: 'fixture@privaterelay.appleid.com', ...restriction });
    await assert.rejects(f.service.authenticate(f.body()), { status: 403 }); assert.equal(f.writes, 0);
  });
}
for (const stage of ['ready', 'users', 'identities', 'save']) test(`failure at ${stage} never confirms a session or leaves partial identity`, async t => {
  const f = fixture(t), body = f.body(); f.fail(stage);
  await assert.rejects(f.service.authenticate(body)); assert.equal(f.rows.users.length, 0);
  assert.equal(f.rows.identities.length, 0); assert.equal(f.rows.challenges[0].usedAt, null);
});
test('actual HTTP handler issues existing-format JWT only after persisted identity; no secrets leak on failure', async t => {
  const f = fixture(t); const app = express(); app.use(express.json(), createAppleRouter({ service: f.service,
    sign: u => jwt.sign({ id: u._id }, 'fixture-jwt-secret', { expiresIn: '30d' }) }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(base + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let response = await post(f.body()); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const session = await response.json(); assert.equal(jwt.verify(session.token, 'fixture-jwt-secret').id, id);
  assert.equal(session.loginProvider, 'apple'); assert.equal(session.user.email, 'fixture@privaterelay.appleid.com');
  assert.equal(session.user.password, undefined); assert.equal(session.user.appleSubject, undefined);
  f.fail('ready'); response = await post(f.body()); assert.equal(response.status, 503);
  const failure = await response.json(); assert.equal(failure.token, undefined); assert.doesNotMatch(JSON.stringify(failure), /fixture-token|Fixture indexes/);
});
test('actual User validation keeps legacy phone/name requirements, permits Apple customers, requires vendor details', async () => {
  const fields = { email: 'fixture@example.invalid', password: 'long-fixture-password' };
  await assert.rejects(new User(fields).validate(), /First name|Last name|Phone number/);
  await new User({ ...fields, appleSubject: 'apple-subject' }).validate();
  await assert.rejects(new User({ ...fields, appleSubject: 'apple-subject', isVendor: true }).validate(), /First name|Last name|Phone number/);
  const index = User.schema.indexes().find(([keys]) => keys.phoneNumber);
  assert.equal(index[1].unique, true); assert.equal(index[1]._autoIndex, false);
  assert.deepEqual(index[1].partialFilterExpression, { phoneNumber: { $type: 'string' } });
  for (const name of ['AppleIdentity', 'AppleAuthChallenge']) {
    const Model = require('../models/' + name); assert.equal(Model.schema.options.autoIndex, false); assert.equal(Model.schema.options.autoCreate, false);
  }
});
test('setup dry run never creates/drops indexes or writes users; apply builds uniqueness before replacement', async () => {
  const calls = []; const db = {
    admin: () => ({ command: async () => ({ maxWireVersion: 13, setName: 'fixture-replica' }) }),
    listCollections: () => ({ toArray: async () => [{ name: 'users' }] }),
    collection: name => ({ listIndexes: () => ({ toArray: async () => [{ name: 'phoneNumber_1', key: { phoneNumber: 1 }, unique: true }, { name: 'email_1', key: { email: 1 }, unique: true }] }),
      aggregate: () => ({ toArray: async () => [] }), createIndex: async () => calls.push('create:' + name), dropIndex: async () => calls.push('drop:' + name) }),
    createCollection: async name => calls.push('collection:' + name),
  };
  const plan = await setupAppleAuth(db); assert.equal(plan.mode, 'dry-run'); assert.deepEqual(calls, []);
  await assert.rejects(setupAppleAuth(db, { apply: true }), /explicit approval/); assert.deepEqual(calls, []);
  await setupAppleAuth(db, { apply: true, replacePhoneIndex: true }); assert.equal(calls[0], 'create:users'); assert.equal(calls[1], 'drop:users');
});
test('actual automatic User index initialization never replaces the phone index', async t => {
  const indexes = [];
  const originalCollection = User.collection.collection;
  User.collection.collection = {}; // Native collection metadata fixture; no connection.
  t.after(() => { User.collection.collection = originalCollection; });
  t.mock.method(User.collection, 'createIndex', async keys => { indexes.push(keys); return 'fixture'; });
  await User.ensureIndexes({ _automatic: true });
  assert.equal(indexes.some(keys => keys.phoneNumber), false);
  assert.equal(indexes.some(keys => keys.googleSubject), true);
});
test('actual save hooks refuse unprotected phone creation and accept either safe legacy or partial uniqueness', async t => {
  let indexes = [];
  t.mock.method(User.collection, 'listIndexes', () => ({ toArray: async () => indexes }));
  const fields = { firstName: 'Local', lastName: 'Fixture', email: 'fixture@example.invalid', phoneNumber: '08012345678', password: 'long-fixture-password' };
  const pre = doc => new Promise((resolve, reject) => User.schema.s.hooks.execPre('save', doc, [], error => error ? reject(error) : resolve()));
  await assert.rejects(pre(new User(fields)), /uniqueness requires explicit/);
  for (const index of [{ key: { phoneNumber: 1 }, unique: true },
    { key: { phoneNumber: 1 }, unique: true, partialFilterExpression: { phoneNumber: { $type: 'string' } } }]) {
    indexes = [index]; await pre(new User(fields));
  }
});
