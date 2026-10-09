const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Product = require('../models/Product');
const Refinement = require('../models/ImageRefinement');
const Job = require('../models/BackgroundJob');
const Usage = require('../models/AiUsageBucket');
const { createImageStudioInitializer } = require('../services/imageStudioDatabaseSetup');
const { inspectFeatureReadiness } = require('../services/adminFeatureReadiness');
const { createImageRefinementService } = require('../services/imageRefinementService');
const { createImageRefinementRouter } = require('../routes/imageRefinementRoutes');

test('Admin Image Studio setup API against a disposable real MongoDB database',
  { skip: !process.env.INVENTORY_TEST_MONGO_URI, timeout: 60000 }, async t => {
    const name = 'naijago_image_studio_test_api_' + Date.now();
    await mongoose.connect(process.env.INVENTORY_TEST_MONGO_URI, { dbName: name, autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 });
    const oldSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = require('node:crypto').randomBytes(32).toString('hex');
    let server;
    try {
      await User.createCollection(); await Product.createCollection();
      const admin = await User.create({ firstName: 'Local', lastName: 'Admin', email: 'setup-admin@example.invalid',
        phoneNumber: '08000000001', password: 'local-test-password', isAdmin: true });
      const member = await User.create({ firstName: 'Local', lastName: 'Member', email: 'setup-member@example.invalid',
        phoneNumber: '08000000002', password: 'local-test-password' });
      const product = await Product.create({ name: 'Setup preservation fixture', description: 'Dedicated local test', category: 'Test',
        price: 200, stockQuantity: 20, sellerType: 'vendor', sellerId: admin._id, vendor: admin._id,
        productStatus: 'active', moderationStatus: 'approved' });
      const original = product.toObject(), originalUser = (await User.findById(admin._id)).toObject();
      const env = { IMAGE_REFINEMENT_ENABLED: 'true', BACKGROUND_JOBS_ENABLED: 'true', PHOTOROOM_API_KEY: 'fixture',
        PHOTOROOM_SANDBOX: 'true', PHOTOROOM_DAILY_LIMIT: '100', CLOUDINARY_CLOUD_NAME: 'fixture', CLOUDINARY_API_KEY: 'fixture', CLOUDINARY_API_SECRET: 'fixture' };
      const service = createImageRefinementService({ env });
      const inspectReadiness = () => inspectFeatureReadiness({ models: [Refinement, Job, Usage] });
      const initialize = createImageStudioInitializer({ getDatabase: () => mongoose.connection.db });
      let setupCalls = 0;
      const app = express(); app.use(express.json());
      app.use('/api/image-refinements', createImageRefinementRouter({ service, inspectReadiness,
        ready: async () => (await inspectReadiness()).ready,
        initializeDatabase: () => { setupCalls++; return initialize(); } }));
      server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}/api/image-refinements`;
      const input = { confirmation: 'CREATE_IMAGE_STUDIO_COLLECTIONS_AND_INDEXES' };
      const headers = user => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '5m' })}` });
      const request = (body, user = admin) => fetch(base + '/setup', { method: 'POST', headers: user ? headers(user) : { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      await t.test('unauthenticated and non-Admin setup requests cannot create collections', async () => {
        assert.equal((await request(input, null)).status, 401);
        assert.equal((await request(input, member)).status, 403);
        assert.equal(setupCalls, 0); assert.equal((await inspectReadiness()).ready, false);
      });
      await t.test('read-only config offers setup while all three collections are missing', async () => {
        const response = await fetch(base + '/config', { headers: headers(admin) });
        const config = await response.json();
        assert.equal(response.status, 200); assert.equal(config.setupAvailable, true); assert.equal(config.databaseReady, false);
        assert.ok(config.databaseChecks.every(check => check.status === 'collection_missing')); assert.equal(setupCalls, 0);
      });
      await t.test('setup requires exact confirmation and refuses caller-selected databases', async () => {
        for (const body of [{}, { confirmation: true }, { ...input, database: 'other_database' }]) assert.equal((await request(body)).status, 400);
        assert.equal(setupCalls, 0); assert.equal((await inspectReadiness()).ready, false);
      });
      await t.test('concurrent confirmed Admin setup creates real indexes without product or user changes', async () => {
        const [response, duplicate] = await Promise.all([request(input), request(input)]), result = await response.json();
        assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).ready, true);
        assert.equal(response.status, 200); assert.equal(result.ready, true); assert.ok(result.checks.every(check => check.status === 'ready'));
        assert.equal(result.database, undefined); assert.doesNotMatch(JSON.stringify(result), /mongodb:\/\/|local-test-password/);
        assert.deepEqual((await Product.findById(product._id)).toObject(), original);
        assert.deepEqual((await User.findById(admin._id)).toObject(), originalUser);
        for (const model of [Refinement, Job, Usage]) assert.equal(await model.countDocuments(), 0);
        const indexes = await Refinement.collection.listIndexes().toArray();
        assert.equal(indexes.find(index => index.key.product).unique, true);
        assert.equal((await Usage.collection.listIndexes().toArray()).find(index => index.key.expiresAt).expireAfterSeconds, 0);
      });
      await t.test('repeated setup is harmless and config clears the setup action', async () => {
        assert.equal((await request(input)).status, 200);
        const config = await (await fetch(base + '/config', { headers: headers(admin) })).json();
        assert.equal(config.databaseReady, true); assert.equal(config.processingEnabled, true); assert.equal(config.setupAvailable, false);
        assert.equal(config.workerStatus, 'not_verified');
      });
      await t.test('disabled Image Studio blocks setup', async () => {
        env.IMAGE_REFINEMENT_ENABLED = 'false'; const before = setupCalls;
        assert.equal((await request(input)).status, 503); assert.equal(setupCalls, before);
        const config = await (await fetch(base + '/config', { headers: headers(admin) })).json();
        assert.equal(config.setupAvailable, false); env.IMAGE_REFINEMENT_ENABLED = 'true';
      });
      await t.test('populated collections with missing indexes fail closed without replacing data', async () => {
        const indexes = await Refinement.collection.listIndexes().toArray();
        await Refinement.collection.dropIndex(indexes.find(index => index.key.product).name);
        await Refinement.collection.insertOne({ localFixture: true });
        const response = await request(input), result = await response.json();
        assert.equal(response.status, 409); assert.equal(result.ready, false);
        assert.match(result.message, /Manual rollout review required/);
        assert.equal(await Refinement.countDocuments(), 1);
        assert.deepEqual((await Product.findById(product._id)).toObject(), original);
      });
    } finally {
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
      assert.match(mongoose.connection.name, /^naijago_image_studio_test_/);
      try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
    }
  });
