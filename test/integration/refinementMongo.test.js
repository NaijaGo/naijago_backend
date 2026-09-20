const test = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { openIsolatedTestDatabase } = require('../../scripts/lib/openIsolatedTestDatabase');
const { createImageRefinementService } = require('../../services/imageRefinementService');
const { createImageRefinementWorkers } = require('../../services/imageRefinementWorkers');
const { createBackgroundJobService } = require('../../services/backgroundJobService');

test('isolated Mongo: image refinement quotas, original preservation and approval publication', {
    skip: !process.env.NAIJAGO_TEST_MONGO_URI, timeout: 240000,
}, async (t) => {
    const { connection, models } = await openIsolatedTestDatabase(t, ['ImageRefinement', 'Product', 'BackgroundJob', 'AiUsageBucket']);
    const { ImageRefinement: Refinement, Product, BackgroundJob: Job, AiUsageBucket: Usage } = models;
    const actor = new Types.ObjectId();
    const now = () => new Date('2100-01-01T12:00:00Z');
    const env = { IMAGE_REFINEMENT_ENABLED: 'true', BACKGROUND_JOBS_ENABLED: 'true', PHOTOROOM_API_KEY: 'synthetic-test-only',
        PHOTOROOM_DAILY_LIMIT: '30', PHOTOROOM_VENDOR_DAILY_LIMIT: '30', PHOTOROOM_SANDBOX: 'false',
        CLOUDINARY_CLOUD_NAME: 'test', CLOUDINARY_API_KEY: 'test', CLOUDINARY_API_SECRET: 'test' };
    const queue = createBackgroundJobService({ Job, allowedTypes: ['image.refine', 'image.publish'], now });
    const calls = [];
    const images = { url: () => null, publicUrl: (row) => `https://example.invalid/approved/${row._id}.png`,
        preserve: async (row) => ({ publicId: `original/${row._id}`, format: 'png', version: 1 }),
        refine: async (row) => { calls.push(String(row._id)); return { publicId: `candidate/${row._id}`, format: 'png', version: 1 }; },
        recover: async () => null,
        publish: async (row) => ({ publicId: `published/${row._id}`, format: 'png', version: 1 }) };
    const make = (options = {}) => createImageRefinementService({ Refinement, Product, Job, Usage, queue, connection, images, env, now, ...options });
    const service = make(), handlers = createImageRefinementWorkers({ Refinement, Product, service, images, now });
    const signal = new AbortController().signal;
    async function product() {
        const key = new Types.ObjectId(); const url = `https://res.cloudinary.com/test/image/upload/v1/naijago_products/${key}.png`;
        return Product.create({ _id: key, name: 'Synthetic refinement test product', description: 'Not live inventory', price: 1200,
            stockQuantity: 4, category: 'Fashion', sellerType: 'vendor', sellerId: actor, vendor: actor,
            imageUrls: [url], images: { main: url }, productStatus: 'draft' });
    }
    const first = await product(); let row;
    await t.test('concurrent batch retries retain one image identity, job and quota reservation', async () => {
        await Promise.all(Array.from({ length: 5 }, () => service.stage({ productId: String(first._id), actor })));
        assert.equal(await Refinement.countDocuments({ product: first._id }), 1);
        assert.equal(await Job.countDocuments({ type: 'image.refine' }), 1);
        const buckets = await Usage.find({}).lean(); assert.equal(buckets.length, 2); assert.ok(buckets.every((bucket) => bucket.used === 1));
        row = await Refinement.findOne({ product: first._id }).lean();
    });
    await t.test('outbox failure rolls back image review creation and both quota reservations', async () => {
        const item = await product();
        const broken = make({ now: () => new Date('2100-01-02T12:00:00Z'), queue: { enqueue: async () => { throw new Error('synthetic-refinement-outbox-failure'); } } });
        await assert.rejects(broken.stage({ productId: String(item._id), actor }), /synthetic-refinement-outbox-failure/);
        assert.equal(await Refinement.countDocuments({ product: item._id }), 0); assert.equal(await Usage.countDocuments({ _id: /^refine:2100-01-02:/ }), 0);
    });
    await t.test('generation preserves originals privately and cannot replace live product images', async () => {
        const job = await Job.findById(row.job).lean(); await handlers['image.refine'](job.payload, { job, signal });
        const saved = await Refinement.findById(row._id).lean();
        assert.equal(saved.state, 'pending_review'); assert.ok(saved.original.publicId); assert.ok(saved.candidate.publicId);
        const item = await Product.findById(first._id).lean(); assert.equal(item.imageUrls[0], first.imageUrls[0]); assert.equal(calls.length, 1);
        await assert.rejects(service.review({ refinementId: String(row._id), actor, input: { action: 'approve', revision: saved.revision, reason: 'Unchecked' } }), { status: 400 });
    });
    await t.test('concurrent approvals publish once and reject an older vendor image save', async () => {
        const saved = await Refinement.findById(row._id).lean(); const staleProduct = await Product.findById(first._id);
        const input = { action: 'approve', revision: saved.revision, reason: 'Synthetic identity check', identityConfirmed: true };
        const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => service.review({ refinementId: String(row._id), actor, input })));
        assert.ok(outcomes.some((outcome) => outcome.status === 'fulfilled'));
        for (const outcome of outcomes) if (outcome.status === 'rejected') assert.equal(outcome.reason.status, 409);
        assert.equal(await Job.countDocuments({ type: 'image.publish' }), 1);
        const pending = await Refinement.findById(row._id).lean(); const job = await Job.findById(pending.job).lean();
        await handlers['image.publish'](job.payload, { job, signal }); await handlers['image.publish'](job.payload, { job, signal });
        const item = await Product.findById(first._id).lean();
        assert.equal(item.imageUrls[0], images.publicUrl(row)); assert.equal(item.images.main, item.imageUrls[0]);
        assert.equal(item.price, 1200); assert.equal(item.stockQuantity, 4); assert.equal(item.productStatus, 'draft');
        assert.equal((await Refinement.findById(row._id)).history.filter((entry) => entry.action === 'approved').length, 1);
        staleProduct.imageUrls = ['https://example.invalid/old-edit.png'];
        await assert.rejects(staleProduct.save());
        assert.equal((await Product.findById(first._id)).imageUrls[0], images.publicUrl(row));
    });
    await t.test('seller reassignment prevents old publication and allows a separate new-owner review', async () => {
        const item = await product(); await service.stage({ productId: String(item._id), actor });
        const old = await Refinement.findOne({ product: item._id }); const newOwner = new Types.ObjectId();
        await Product.updateOne({ _id: item._id }, { $set: { sellerId: newOwner, vendor: newOwner } });
        const job = await Job.findById(old.job).lean(); await handlers['image.refine'](job.payload, { job, signal });
        assert.equal((await Refinement.findById(old._id)).state, 'obsolete');
        await service.stage({ productId: String(item._id), actor });
        assert.equal(await Refinement.countDocuments({ product: item._id }), 2);
    });
    await t.test('concurrent global reservations never exceed the configured processing budget', async () => {
        const limited = make({ env: { ...env, PHOTOROOM_DAILY_LIMIT: '2' }, now: () => new Date('2100-01-03T12:00:00Z') });
        const products = await Promise.all(Array.from({ length: 5 }, product));
        await Promise.all(products.map((item) => limited.stage({ productId: String(item._id), actor })));
        const global = await Usage.findById('refine:2100-01-03:global').lean(); assert.ok(global.used > 0 && global.used <= 2);
        assert.equal(await Refinement.countDocuments({ product: { $in: products.map((item) => item._id) } }), global.used);
        assert.equal((await Usage.findById(`refine:2100-01-03:seller:${actor}`)).used, global.used);
    });
    await t.test('new vendor uploads retain a durable marker and a worker scan recovers it once', async () => {
        const previous = process.env.IMAGE_REFINEMENT_ENABLED;
        let item;
        try { process.env.IMAGE_REFINEMENT_ENABLED = 'true'; item = await product(); }
        finally { if (previous === undefined) delete process.env.IMAGE_REFINEMENT_ENABLED; else process.env.IMAGE_REFINEMENT_ENABLED = previous; }
        assert.equal((await Product.findById(item._id).select('+refinementScanPending')).refinementScanPending, true);
        await service.schedule({ signal }); await service.schedule({ signal });
        assert.equal(await Refinement.countDocuments({ product: item._id }), 1);
        assert.equal((await Product.findById(item._id).select('+refinementScanPending')).refinementScanPending, false);
    });
});
