const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Refinement = require('../models/ImageRefinement');
const Job = require('../models/BackgroundJob');
const Usage = require('../models/AiUsageBucket');
const User = require('../models/User');
const { createImageRefinementService } = require('../services/imageRefinementService');
const { createImageRefinementWorkers } = require('../services/imageRefinementWorkers');
const { createBackgroundJobService, createJobRunner } = require('../services/backgroundJobService');
const { inspectFeatureReadiness } = require('../services/adminFeatureReadiness');

// Real MongoDB transactions, indexes and service/worker code. Storage/provider
// adapters are controlled fixtures: these tests DO NOT verify live Photoroom.
test('Image Studio real dedicated MongoDB integration', { skip: !process.env.INVENTORY_TEST_MONGO_URI, timeout: 120000 }, async t => {
  const database = 'naijago_image_studio_test_' + Date.now() + '_' + new mongoose.Types.ObjectId().toString().slice(0, 12);
  await mongoose.connect(process.env.INVENTORY_TEST_MONGO_URI, { dbName: database, autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 });
  const models = [Product, Refinement, Job, Usage, User];
  const actor = String(new mongoose.Types.ObjectId()), owner = String(new mongoose.Types.ObjectId());
  const env = { IMAGE_REFINEMENT_ENABLED: 'true', BACKGROUND_JOBS_ENABLED: 'true', PHOTOROOM_API_KEY: 'fixture-key',
    PHOTOROOM_SANDBOX: 'true', PHOTOROOM_DAILY_LIMIT: '100', PHOTOROOM_VENDOR_DAILY_LIMIT: '100',
    CLOUDINARY_CLOUD_NAME: 'fixture', CLOUDINARY_API_KEY: 'fixture', CLOUDINARY_API_SECRET: 'fixture' };
  const signal = new AbortController().signal, assets = new Map();
  let providerCalls = 0;
  const asset = (row, kind) => ({ publicId: `${row._id}/${kind}/${row.generation}`, format: 'png', version: 1 });
  const images = {
    url: value => value ? `https://example.invalid/${value.publicId}` : null,
    preserve: async row => { const result = asset(row, 'original'); assets.set(`${row._id}:original`, result); return result; },
    refine: async row => { providerCalls++; const result = asset(row, 'candidate'); assets.set(`${row._id}:candidate`, result); return result; },
    recover: async (row, kind) => assets.get(`${row._id}:${kind}`) || null,
    publish: async row => asset(row, 'published'),
    publicUrl: (row, value) => `https://res.cloudinary.com/fixture/image/upload/v1/naijago/refinements/${value.publicId.replaceAll('/', '_')}.png`,
  };
  const queue = createBackgroundJobService({ Job, allowedTypes: ['image.refine', 'image.publish'] });
  const service = createImageRefinementService({ Refinement, Product, Job, Usage, queue, connection: mongoose.connection, images, env });
  const handlers = createImageRefinementWorkers({ Refinement, Product, service, images });
  const errors = [], runner = createJobRunner({ queue, handlers, onError: error => errors.push(error) });
  async function reset() {
    await Promise.all(models.map(model => model.deleteMany({})));
    assets.clear(); providerCalls = 0; errors.length = 0;
    env.PHOTOROOM_SANDBOX = 'true'; env.PHOTOROOM_DAILY_LIMIT = env.PHOTOROOM_VENDOR_DAILY_LIMIT = '100';
  }
  async function product() {
    const url = `https://res.cloudinary.com/fixture/image/upload/v1/naijago_products/${new mongoose.Types.ObjectId()}.png`;
    return Product.create({ name: 'Image integration fixture', description: 'Dedicated test only', category: 'Test',
      price: 200, stockQuantity: 20, sellerType: 'vendor', sellerId: owner, vendor: owner,
      imageUrls: [url], images: { main: url }, productStatus: 'active', moderationStatus: 'approved' });
  }
  async function candidate(p, live = false) {
    env.PHOTOROOM_SANDBOX = live ? 'false' : 'true';
    const result = await service.stage({ productId: String(p._id), actor, signal });
    assert.equal(result.images[0].state, 'recorded');
    assert.equal(await runner.tick(), true, errors.map(error => error.message).join('; '));
    return service.get(result.images[0].id);
  }
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    assert.ok(hello.setName || hello.msg === 'isdbgrid', 'Dedicated replica set or mongos required');
    await t.test('missing collections fail readiness without automatic provisioning', async () => {
      const result = await inspectFeatureReadiness({ models: [Refinement, Job, Usage] });
      assert.equal(result.ready, false);
      assert.ok(result.checks.every(check => check.status === 'collection_missing'));
    });
    // Explicitly provision only this randomly named, disposable test database.
    for (const model of models) { await model.createCollection(); await model.createIndexes(); }
    await t.test('actual declared unique and TTL indexes satisfy readiness', async () => {
      assert.equal((await inspectFeatureReadiness({ models: [Refinement, Job, Usage] })).ready, true);
    });
    await t.test('preview is read-only and reports every eligible original', async () => {
      await reset(); const p = await product(); const before = p.toObject();
      const preview = await service.previewBatch({ productIds: [String(p._id)] });
      assert.equal(preview.newImages, 1);
      assert.deepEqual((await Product.findById(p._id)).toObject(), before);
      assert.equal(await Job.countDocuments(), 0); assert.equal(await Usage.countDocuments(), 0); assert.equal(providerCalls, 0);
    });
    await t.test('batch scheduler persists hidden scan fields and queues a worker job', async () => {
      await reset(); const p = await product();
      assert.equal((await service.requestBatch({ productIds: [String(p._id)], actor })).results[0].state, 'scheduled');
      await service.schedule({ signal });
      assert.equal(await Job.countDocuments({ type: 'image.refine', state: 'queued' }), 1);
      assert.equal((await Product.findById(p._id).select('+refinementScanPending')).refinementScanPending, false);
    });
    await t.test('concurrent duplicate staging reserves allowance once and unique index rejects duplicate rows', async () => {
      await reset(); const p = await product();
      const results = await Promise.all([1, 2].map(() => service.stage({ productId: String(p._id), actor, signal })));
      assert.equal(results[0].images[0].id, results[1].images[0].id);
      assert.equal(await Refinement.countDocuments(), 1); assert.equal(await Job.countDocuments(), 1);
      assert.equal((await Usage.findById(`refine:${new Date().toISOString().slice(0, 10)}:global`)).used, 1);
      const row = (await Refinement.findOne()).toObject();
      await assert.rejects(Refinement.create({ ...row, _id: new mongoose.Types.ObjectId() }), error => error.code === 11000);
    });
    await t.test('concurrent daily-limit competition cannot overspend', async () => {
      await reset(); env.PHOTOROOM_DAILY_LIMIT = '1'; const a = await product(), b = await product();
      const results = await Promise.all([a, b].map(p => service.stage({ productId: String(p._id), actor, signal })));
      assert.equal(results.flatMap(result => result.images).filter(image => image.state === 'recorded').length, 1);
      assert.equal(results.flatMap(result => result.images).filter(image => image.status === 429).length, 1);
      assert.equal(await Job.countDocuments(), 1);
    });
    await t.test('a failed enqueue rolls back budgets, job and refinement together', async () => {
      await reset(); const p = await product();
      const failing = createImageRefinementService({ Refinement, Product, Job, Usage, connection: mongoose.connection, images, env,
        queue: { enqueue: async (...args) => { await queue.enqueue(...args); throw new Error('Forced rollback fixture'); } } });
      await assert.rejects(failing.stage({ productId: String(p._id), actor, signal }), /Forced rollback fixture/);
      assert.equal(await Job.countDocuments(), 0); assert.equal(await Refinement.countDocuments(), 0); assert.equal(await Usage.countDocuments(), 0);
    });
    await t.test('sandbox processing preserves original and cannot publish', async () => {
      await reset(); const p = await product(), original = p.imageUrls[0], row = await candidate(p);
      assert.equal(row.state, 'pending_review'); assert.ok(row.originalUrl); assert.ok(row.candidateUrl);
      await assert.rejects(service.review({ refinementId: row.id, actor, input: { action: 'approve', revision: row.revision,
        reason: 'Test review', identityConfirmed: true } }), /Sandbox images cannot be published/);
      assert.equal((await Product.findById(p._id)).imageUrls[0], original);
    });
    await t.test('rejection leaves product unchanged and stale moderation revision fails', async () => {
      await reset(); const p = await product(), original = p.imageUrls[0], row = await candidate(p);
      const rejected = await service.review({ refinementId: row.id, actor, input: { action: 'reject', revision: row.revision, reason: 'Fixture rejection' } });
      assert.equal(rejected.state, 'rejected'); assert.equal((await Product.findById(p._id)).imageUrls[0], original);
      await assert.rejects(service.review({ refinementId: row.id, actor, input: { action: 'regenerate', revision: row.revision, reason: 'Stale fixture' } }), /review changed/);
    });
    await t.test('reviewed publication atomically updates image fields without changing price/stock', async () => {
      await reset(); const p = await product(), original = p.imageUrls[0], stale = await Product.findById(p._id), row = await candidate(p, true);
      await service.review({ refinementId: row.id, actor, input: { action: 'approve', revision: row.revision, reason: 'Fixture approved', identityConfirmed: true } });
      assert.equal(await runner.tick(), true, errors.map(error => error.message).join('; '));
      const current = await Product.findById(p._id), reviewed = await Refinement.findById(row.id);
      assert.equal(reviewed.state, 'approved'); assert.ok(reviewed.original); assert.ok(reviewed.published);
      assert.notEqual(current.imageUrls[0], original); assert.equal(current.images.main, current.imageUrls[0]);
      assert.equal(current.price, 200); assert.equal(current.stockQuantity, 20);
      stale.markModified('imageUrls'); await assert.rejects(stale.save());
    });
    async function sourceCandidate(p, source) {
      env.PHOTOROOM_SANDBOX = 'false';
      const result = await service.stage({ productId: String(p._id), actor, signal });
      for (const image of result.images) {
        assert.equal(image.state, 'recorded');
        assert.equal(await runner.tick(), true, errors.map(error => error.message).join('; '));
      }
      return service.get(String((await Refinement.findOne({ product: p._id, sourceUrl: source }))._id));
    }
    async function galleryProduct() {
      const p = await product(), primary = p.imageUrls[0], side = primary.replace('.png', '_side.png');
      await Product.updateOne({ _id: p._id }, { $set: { imageUrls: [primary, side], 'images.front': side } });
      return { p, primary, side };
    }
    await t.test('explicit main approval persists its target and atomically promotes a gallery image', async () => {
      await reset(); const { p, primary, side } = await galleryProduct(), row = await sourceCandidate(p, side);
      assert.equal(row.canSetAsMain, true);
      const before = (await Product.findById(p._id)).toObject();
      const approved = await service.review({ refinementId: row.id, actor, input: { action: 'approve', revision: row.revision,
        reason: 'Use the checked live image as the main customer photo', identityConfirmed: true, setAsMain: true } });
      assert.equal(approved.publicationTarget, 'main');
      assert.equal(approved.history.at(-1).publicationTarget, 'main');
      assert.deepEqual((await Product.findById(p._id)).toObject(), before, 'Approval alone must not replace product photos');
      assert.equal((await Refinement.findById(row.id)).publicationTarget, 'main');
      assert.equal(await runner.tick(), true, errors.map(error => error.message).join('; '));
      const current = await Product.findById(p._id), review = await service.get(row.id);
      assert.equal(review.state, 'approved'); assert.equal(review.publicationTarget, 'main');
      assert.equal(current.imageUrls[0], current.images.main); assert.equal(current.images.front, current.images.main);
      assert.equal(current.imageUrls[1], primary); assert.equal(current.imageUrls.length, 2);
      assert.notEqual(current.images.main, primary); assert.notEqual(current.images.main, side);
      assert.equal(current.price, 200); assert.equal(current.stockQuantity, 20);
      assert.ok((await Refinement.findById(row.id)).original);
    });
    await t.test('ordinary gallery approval keeps the existing main image', async () => {
      await reset(); const { p, primary, side } = await galleryProduct(), row = await sourceCandidate(p, side);
      await service.review({ refinementId: row.id, actor, input: { action: 'approve', revision: row.revision,
        reason: 'Update the gallery only', identityConfirmed: true } });
      assert.equal(await runner.tick(), true);
      const current = await Product.findById(p._id);
      assert.equal(current.imageUrls[0], primary); assert.equal(current.images.main, primary);
      assert.notEqual(current.imageUrls[1], side); assert.equal(current.imageUrls[1], current.images.front);
      assert.equal((await Refinement.findById(row.id)).publicationTarget, 'source');
    });
    await t.test('main-image option rejects malformed input and sandbox approval', async () => {
      await reset(); const p = await product(), row = await candidate(p);
      for (const setAsMain of ['true', 1, null, {}]) {
        await assert.rejects(service.review({ refinementId: row.id, actor, input: { action: 'approve', revision: row.revision,
          reason: 'Invalid option fixture', identityConfirmed: true, setAsMain } }), error => error.status === 400);
      }
      await assert.rejects(service.review({ refinementId: row.id, actor, input: { action: 'approve', revision: row.revision,
        reason: 'Sandbox fixture', identityConfirmed: true, setAsMain: true } }), /Sandbox images cannot be published/);
      assert.equal(await Job.countDocuments({ type: 'image.publish' }), 0);
      assert.equal((await Refinement.findById(row.id)).state, 'pending_review');
    });
    await t.test('already published live gallery image can become main without another provider call or job', async () => {
      await reset(); const { p, primary, side } = await galleryProduct(), row = await sourceCandidate(p, side);
      await service.review({ refinementId: row.id, actor, input: { action: 'approve', revision: row.revision,
        reason: 'Gallery fixture', identityConfirmed: true } });
      assert.equal(await runner.tick(), true);
      const reviewed = await service.get(row.id), before = (await Product.findById(p._id)).toObject();
      assert.equal(reviewed.canSetAsMain, true);
      const calls = providerCalls, jobs = await Job.countDocuments(), usage = await Usage.find().sort({ _id: 1 }).lean();
      await assert.rejects(service.review({ refinementId: row.id, actor, input: { action: 'set_main', revision: reviewed.revision,
        reason: 'Missing confirmation' } }), /Confirm the product/);
      const promoted = await service.review({ refinementId: row.id, actor, input: { action: 'set_main', revision: reviewed.revision,
        reason: 'Promote the approved image', identityConfirmed: true } });
      const current = (await Product.findById(p._id)).toObject();
      assert.equal(promoted.state, 'approved'); assert.equal(promoted.publicationTarget, 'main'); assert.equal(promoted.canSetAsMain, false);
      assert.equal(promoted.history.at(-1).action, 'set_main');
      assert.equal(current.imageUrls[0], before.imageUrls[1]); assert.equal(current.images.main, current.imageUrls[0]);
      assert.equal(current.imageUrls[1], primary);
      const unchangedFields = ({ imageUrls, images, __v, updatedAt, ...rest }) => rest;
      assert.deepEqual(unchangedFields(current), unchangedFields(before));
      assert.equal(providerCalls, calls); assert.equal(await Job.countDocuments(), jobs);
      assert.deepEqual(await Usage.find().sort({ _id: 1 }).lean(), usage);
      await assert.rejects(service.review({ refinementId: row.id, actor, input: { action: 'set_main', revision: reviewed.revision,
        reason: 'Duplicate request', identityConfirmed: true } }), /review changed/);
    });
    await t.test('already published variant-only photo cannot be promoted to main', async () => {
      await reset(); const p = await product(), variant = p.imageUrls[0].replace('.png', '_variant.png');
      await Product.updateOne({ _id: p._id }, { $set: { variants: [{ imageUrls: [variant] }] } });
      const row = await sourceCandidate(p, variant);
      await service.review({ refinementId: row.id, actor, input: { action: 'approve', revision: row.revision,
        reason: 'Variant fixture', identityConfirmed: true } });
      assert.equal(await runner.tick(), true);
      const reviewed = await service.get(row.id), before = (await Product.findById(p._id)).toObject();
      assert.equal(reviewed.canSetAsMain, false);
      await assert.rejects(service.review({ refinementId: row.id, actor, input: { action: 'set_main', revision: reviewed.revision,
        reason: 'Invalid variant promotion', identityConfirmed: true } }), /variant-only/);
      assert.deepEqual((await Product.findById(p._id)).toObject(), before);
    });
    await t.test('removed or reassigned published image cannot be promoted to main', async () => {
      for (const reassign of [false, true]) {
        await reset(); const { p, primary, side } = await galleryProduct(), row = await sourceCandidate(p, side);
        await service.review({ refinementId: row.id, actor, input: { action: 'approve', revision: row.revision,
          reason: 'Gallery fixture', identityConfirmed: true } });
        assert.equal(await runner.tick(), true);
        const reviewed = await service.get(row.id);
        await Product.updateOne({ _id: p._id }, { $set: reassign ? { sellerId: new mongoose.Types.ObjectId() }
          : { imageUrls: [primary], 'images.front': '' } });
        const before = (await Product.findById(p._id)).toObject();
        await assert.rejects(service.review({ refinementId: row.id, actor, input: { action: 'set_main', revision: reviewed.revision,
          reason: 'Stale publication fixture', identityConfirmed: true } }), error => error.status === 409);
        assert.deepEqual((await Product.findById(p._id)).toObject(), before);
      }
    });
    await t.test('sandbox and unpublished candidates cannot use already-published promotion', async () => {
      for (const live of [false, true]) {
        await reset(); const p = await product(), row = await candidate(p, live);
        const before = (await Product.findById(p._id)).toObject();
        await assert.rejects(service.review({ refinementId: row.id, actor, input: { action: 'set_main', revision: row.revision,
          reason: 'Not published fixture', identityConfirmed: true } }), /Only an approved live image/);
        assert.deepEqual((await Product.findById(p._id)).toObject(), before);
      }
    });
    await t.test('variant-only photo cannot be approved as the main product image', async () => {
      await reset(); const p = await product(), variant = p.imageUrls[0].replace('.png', '_variant.png');
      await Product.updateOne({ _id: p._id }, { $set: { variants: [{ name: 'Specific variant', imageUrls: [variant] }] } });
      const row = await sourceCandidate(p, variant);
      assert.equal(row.canSetAsMain, false);
      await assert.rejects(service.review({ refinementId: row.id, actor, input: { action: 'approve', revision: row.revision,
        reason: 'Invalid variant promotion', identityConfirmed: true, setAsMain: true } }), /variant-only/);
      assert.equal(await Job.countDocuments({ type: 'image.publish' }), 0);
    });
    await t.test('main publication revalidates image scope if product photos change after approval', async () => {
      await reset(); const { p, primary, side } = await galleryProduct(), row = await sourceCandidate(p, side);
      await service.review({ refinementId: row.id, actor, input: { action: 'approve', revision: row.revision,
        reason: 'Main photo fixture', identityConfirmed: true, setAsMain: true } });
      await Product.updateOne({ _id: p._id }, { $set: { imageUrls: [primary], 'images.front': '', variants: [{ imageUrls: [side] }] } });
      const before = (await Product.findById(p._id)).toObject();
      assert.equal(await runner.tick(), false);
      assert.match(errors.at(-1).message, /variant-only/);
      assert.deepEqual((await Product.findById(p._id)).toObject(), before);
      assert.equal((await Refinement.findById(row.id)).state, 'publishing');
    });
    await t.test('source change after review makes publication obsolete', async () => {
      await reset(); const p = await product(), row = await candidate(p, true);
      await service.review({ refinementId: row.id, actor, input: { action: 'approve', revision: row.revision, reason: 'Fixture approved', identityConfirmed: true } });
      await Product.updateOne({ _id: p._id }, { $set: { imageUrls: [], images: {} } });
      assert.equal(await runner.tick(), true);
      assert.equal((await Refinement.findById(row.id)).state, 'obsolete');
      assert.equal((await Product.findById(p._id)).imageUrls.length, 0);
    });
    await t.test('interrupted generating job does not repeat the provider request', async () => {
      await reset(); const p = await product();
      const staged = await service.stage({ productId: String(p._id), actor, signal });
      await Refinement.updateOne({ _id: staged.images[0].id }, { $set: { state: 'generating' } });
      assert.equal(await runner.tick(), true);
      assert.equal(providerCalls, 0); assert.equal((await Refinement.findById(staged.images[0].id)).state, 'uncertain');
    });
    await t.test('actual HTTP routes enforce Admin authentication and preview/batch contracts', async () => {
      await reset(); const p = await product(), express = require('express'), jwt = require('jsonwebtoken');
      const previousSecret = process.env.JWT_SECRET;
      process.env.JWT_SECRET = require('node:crypto').randomBytes(32).toString('hex');
      const admin = await User.create({ firstName: 'Local', lastName: 'Admin', email: 'studio-admin@example.invalid',
        phoneNumber: '08000000001', password: 'local-test-password', isAdmin: true });
      const member = await User.create({ firstName: 'Local', lastName: 'Member', email: 'studio-member@example.invalid',
        phoneNumber: '08000000002', password: 'local-test-password' });
      const app = express(); app.use(express.json());
      app.use('/api/image-refinements', require('../routes/imageRefinementRoutes').createImageRefinementRouter({ service,
        inspectReadiness: () => inspectFeatureReadiness({ models: [Refinement, Job, Usage] }),
        ready: async () => (await inspectFeatureReadiness({ models: [Refinement, Job, Usage] })).ready }));
      const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}/api/image-refinements`;
      const headers = user => ({ Authorization: `Bearer ${jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '5m' })}`,
        'Content-Type': 'application/json' });
      try {
        assert.equal((await fetch(base + '/config')).status, 401);
        assert.equal((await fetch(base + '/config', { headers: headers(member) })).status, 403);
        const response = await fetch(base + '/config', { headers: headers(admin) }); assert.equal(response.status, 200);
        const config = await response.json(); assert.equal(config.databaseReady, true); assert.equal(config.processingEnabled, true);
        assert.equal(config.workerStatus, 'not_verified');
        const body = { productIds: [String(p._id)] };
        const preview = await fetch(base + '/preview', { method: 'POST', headers: headers(admin), body: JSON.stringify(body) });
        assert.equal(preview.status, 200); assert.equal((await preview.json()).newImages, 1);
        assert.equal(await Job.countDocuments(), 0);
        assert.equal((await fetch(base + '/batch', { method: 'POST', headers: headers(admin), body: JSON.stringify(body) })).status, 400);
        const batch = await fetch(base + '/batch', { method: 'POST', headers: headers(admin), body: JSON.stringify({ ...body, rightsConfirmed: true }) });
        assert.equal(batch.status, 202); assert.equal((await batch.json()).results[0].state, 'scheduled');
      } finally {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
      }
    });
  } finally {
    runner.stop();
    assert.match(mongoose.connection.name, /^naijago_image_studio_test_/);
    try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
  }
});
