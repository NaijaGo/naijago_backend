const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, definitions, argumentsFor } = require('../scripts/setupImageStudioDatabase');

test('Image Studio setup is read-only by default and apply requires an exact database confirmation', async () => {
  assert.deepEqual(argumentsFor([]), { apply: false, database: undefined });
  assert.throws(() => argumentsFor(['--apply']));
  assert.throws(() => argumentsFor(['--drop']));
  assert.deepEqual(argumentsFor(['--apply', '--database', 'fixture']), { apply: true, database: 'fixture' });
  const db = { databaseName: 'fixture' };
  assert.equal((await setup({ db, apply: true, database: 'other' })).status, 'BLOCKED');
  assert.equal((await setup({ db, apply: true })).writesAttempted, false);
});

test('setup manifest is limited to the three existing schema definitions and their unique/TTL indexes', () => {
  const specs = definitions();
  assert.deepEqual(specs.map(spec => spec.name), ['imagerefinements', 'backgroundjobs', 'aiusagebuckets']);
  assert.deepEqual(specs.map(spec => spec.indexes.length), [2, 5, 1]);
  assert.deepEqual(specs[0].indexes[0], { key: { product: 1, sourceKey: 1 }, unique: true });
  assert.deepEqual(specs[1].indexes[0], { key: { type: 1, dedupeKey: 1 }, unique: true });
  assert.deepEqual(specs[2].indexes[0], { key: { expiresAt: 1 }, expireAfterSeconds: 0 });
});

test('setup refuses a standalone server and does not attempt writes', async () => {
  const db = { databaseName: 'fixture', admin: () => ({ command: async () => ({}) }),
    collection: name => ({ collectionName: name, listIndexes: () => ({ toArray: async () => { throw Object.assign(new Error(), { code: 26 }); } }) }) };
  const report = await setup({ db, apply: true, database: 'fixture' });
  assert.equal(report.status, 'BLOCKED'); assert.equal(report.writesAttempted, false);
});

test('Image Studio setup creates only declared metadata in a disposable real MongoDB database',
  { skip: !process.env.INVENTORY_TEST_MONGO_URI, timeout: 60000 }, async t => {
    const { MongoClient } = require('mongoose').mongo;
    const client = new MongoClient(process.env.INVENTORY_TEST_MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    const name = 'naijago_image_studio_test_setup_' + Date.now();
    await client.connect(); const db = client.db(name);
    try {
      await t.test('default inspection does not create collections', async () => {
        const report = await setup({ db });
        assert.equal(report.mode, 'read-only'); assert.equal(report.writesAttempted, false);
        assert.equal(report.plan.length, 3);
        assert.equal((await db.listCollections().toArray()).length, 0);
      });
      await t.test('explicit apply creates collections and actual indexes without records', async () => {
        const report = await setup({ db, apply: true, database: name });
        assert.equal(report.status, 'READY'); assert.equal(report.after.ready, true);
        assert.equal(report.transactionsExecuted, false);
        assert.deepEqual((await db.listCollections().toArray()).map(row => row.name).sort(), definitions().map(spec => spec.name).sort());
        for (const spec of definitions()) assert.equal(await db.collection(spec.name).countDocuments(), 0);
        assert.equal((await db.collection('aiusagebuckets').listIndexes().toArray()).find(index => index.key.expiresAt).expireAfterSeconds, 0);
      });
      await t.test('a repeat apply is a no-op', async () => {
        const report = await setup({ db, apply: true, database: name });
        assert.equal(report.status, 'READY'); assert.equal(report.writesAttempted, false); assert.equal(report.plan.length, 0);
      });
      await t.test('existing populated unindexed collections block the whole rollout without changes', async () => {
        await db.collection('imagerefinements').drop();
        await db.collection('imagerefinements').insertOne({ test: true });
        await db.collection('backgroundjobs').drop();
        const report = await setup({ db, apply: true, database: name });
        assert.equal(report.status, 'BLOCKED'); assert.equal(report.writesAttempted, false);
        assert.equal((await db.listCollections({ name: 'backgroundjobs' }).toArray()).length, 0);
        assert.equal(await db.collection('imagerefinements').countDocuments(), 1);
      });
      await t.test('incompatible indexes are never dropped or replaced', async () => {
        await db.collection('imagerefinements').deleteMany({});
        await db.collection('imagerefinements').createIndex({ product: 1, sourceKey: 1 });
        const report = await setup({ db, apply: true, database: name });
        assert.equal(report.status, 'BLOCKED'); assert.equal(report.writesAttempted, false);
        const index = (await db.collection('imagerefinements').listIndexes().toArray()).find(index => index.key.product);
        assert.equal(index.unique, undefined);
      });
      await t.test('an interrupted empty rollout can safely resume', async () => {
        await db.collection('imagerefinements').drop(); await db.createCollection('imagerefinements');
        const report = await setup({ db, apply: true, database: name });
        assert.equal(report.status, 'READY'); assert.equal(report.after.ready, true);
      });
    } finally { try { await db.dropDatabase(); } finally { await client.close(); } }
  });
