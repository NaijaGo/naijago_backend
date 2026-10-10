const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Rider = require('../models/Rider');
const uri = process.env.INVENTORY_TEST_MONGO_URI;
// Deliberately local-only: no production credentials/fallback can be used here.
const local = uri && /^mongodb:\/\/(127\.0\.0\.1|localhost):27019\//.test(uri);

test('Google account persistence and unique-subject concurrency on local MongoDB', { skip: !local }, async t => {
  const name = 'naijago_google_test_' + crypto.randomUUID().replaceAll('-', '');
  const connection = await mongoose.createConnection(uri, { dbName: name, serverSelectionTimeoutMS: 10000 }).asPromise();
  try {
    const Users = connection.model('User', User.schema);
    const Riders = connection.model('Rider', Rider.schema);
    await Promise.all([Users.init(), Riders.init()]);
    const data = i => ({ firstName: 'Local', lastName: 'Fixture', email: 'user' + i + '@example.org',
      phoneNumber: '08012345' + String(i).padStart(3, '0'), password: 'local-fixture-password', isEmailVerified: true });
    await t.test('legacy accounts without Google subjects remain valid', async () => {
      await Users.create([data(1), data(2)]);
      assert.equal(await Users.countDocuments({ googleSubject: { $exists: false } }), 2);
    });
    await t.test('Google user subject persists without vendor/Admin approval', async () => {
      const created = await Users.create({ ...data(3), googleSubject: 'local-subject' });
      const saved = await Users.findById(created._id);
      assert.equal(saved.googleSubject, 'local-subject'); assert.equal(saved.vendorStatus, 'none');
      assert.equal(saved.isVendor, false); assert.equal(saved.isAdmin, false);
      assert.notEqual(saved.password, 'local-fixture-password');
    });
    await t.test('actual unique subject indexes exist', async () => {
      for (const Model of [Users, Riders]) {
        const indexes = await Model.collection.indexes();
        const index = indexes.find(item => item.key.googleSubject === 1);
        assert.equal(index.unique, true); assert.deepEqual(index.partialFilterExpression, { googleSubject: { $type: 'string' } });
      }
    });
    await t.test('concurrent user signups cannot duplicate a Google identity', async () => {
      const results = await Promise.allSettled([Users.create({ ...data(4), googleSubject: 'race-subject' }), Users.create({ ...data(5), googleSubject: 'race-subject' })]);
      assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
      assert.equal(results.find(item => item.status === 'rejected').reason.code, 11000);
      assert.equal(await Users.countDocuments({ googleSubject: 'race-subject' }), 1);
    });
    const riderData = i => ({ fullName: 'Local Rider', email: 'rider' + i + '@example.org', phoneNumber: '08012345678',
      password: 'local-fixture-password', plateNumber: 'LOCAL' + i, googleSubject: 'local-rider-subject', isEmailVerified: true,
      documents: { ninFront: 'https://example.invalid/front', ninBack: 'https://example.invalid/back', platePhoto: 'https://example.invalid/plate', selfie: 'https://example.invalid/selfie' } });
    await t.test('rider Google identity and pending onboarding persist', async () => {
      const created = await Riders.create(riderData(1));
      const saved = await Riders.findById(created._id);
      assert.equal(saved.googleSubject, 'local-rider-subject'); assert.equal(saved.status, 'pending');
      assert.equal(saved.isVerified, false); assert.equal(saved.isActive, false);
    });
    await t.test('concurrent rider identities remain unique', async () => {
      const results = await Promise.allSettled([Riders.create({ ...riderData(2), googleSubject: 'rider-race' }), Riders.create({ ...riderData(3), googleSubject: 'rider-race' })]);
      assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
      assert.equal(results.find(item => item.status === 'rejected').reason.code, 11000);
    });
  } finally {
    await connection.dropDatabase(); await connection.close();
  }
});
