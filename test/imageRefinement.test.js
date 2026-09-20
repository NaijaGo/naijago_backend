const test = require('node:test');
const assert = require('node:assert/strict');
const { RefinementError, sourceIdentity, sourceImages, replacement, imageBytes } = require('../utils/imageRefinementPolicy');
const { createImageRefinementService } = require('../services/imageRefinementService');
const { createImageRefinementWorkers } = require('../services/imageRefinementWorkers');
const { createImageRefinementAdapter } = require('../services/imageRefinementAdapter');
const { imageRefinementProductHooks } = require('../services/imageRefinementProductHooks');
const productId = 'aaaaaaaaaaaaaaaaaaaaaaaa', actor = 'bbbbbbbbbbbbbbbbbbbbbbbb', imageId = 'cccccccccccccccccccccccc';
const source = 'https://res.cloudinary.com/test/image/upload/v1/naijago_products/source.png';
const extra = 'https://res.cloudinary.com/test/image/upload/v1/naijago_product_views/extra.png';
const env = { IMAGE_REFINEMENT_ENABLED: 'true', BACKGROUND_JOBS_ENABLED: 'true', PHOTOROOM_API_KEY: 'synthetic-key',
    PHOTOROOM_DAILY_LIMIT: '10', PHOTOROOM_VENDOR_DAILY_LIMIT: '5', PHOTOROOM_SANDBOX: 'false',
    CLOUDINARY_CLOUD_NAME: 'test', CLOUDINARY_API_KEY: 'test', CLOUDINARY_API_SECRET: 'test' };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const chain = (value) => ({ session() { return this; }, select() { return this; }, sort() { return this; }, limit() { return this; },
    lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
function fixture(options = {}) {
    let rows = [], quotas = {}, jobs = [], serial = 0;
    const product = { _id: productId, name: 'Real product', sellerId: actor, imageUrls: [source], images: { main: source }, updatedAt: 'original-date', price: 500, stockQuantity: 7 };
    const doc = (data) => Object.assign(data, { async save() {
        const value = JSON.parse(JSON.stringify(this)); const index = rows.findIndex((row) => row._id === this._id);
        if (index >= 0) rows[index] = value; else rows.push(value);
    } });
    function Refinement(data) { return doc({ _id: imageId, generation: 1, revision: 0, state: 'queued', code: '', ...data }); }
    Refinement.findOne = (filter) => chain(docOrNull(rows.find((row) => Object.entries(filter).every(([key, value]) => row[key] === value))));
    Refinement.findById = (value) => chain(docOrNull(rows.find((row) => row._id === value)));
    Refinement.find = () => chain(rows);
    function docOrNull(row) { return row ? doc(JSON.parse(JSON.stringify(row))) : null; }
    const Product = { findById: () => chain(product), async updateOne(filter, update) {
        assert.equal(filter.updatedAt, product.updatedAt);
        for (const [key, value] of Object.entries(update.$set)) {
            if (key === 'images.main') product.images.main = value; else product[key] = value;
        }
        return { modifiedCount: 1, matchedCount: 1 };
    } };
    const Job = { findById: (value) => chain(jobs.find((job) => job._id === value)) };
    const Usage = { findById: (key) => chain(quotas[key] === undefined ? null : { used: quotas[key] }), async findOneAndUpdate(filter, _update, { session }) {
        if (options.collideOnce) { options.collideOnce = false; throw Object.assign(new Error('synthetic-upsert-race'), { code: 11000 }); }
        assert.equal(session, 'test-session'); const used = quotas[filter._id] || 0;
        if (used >= filter.used.$lt) throw Object.assign(new Error('quota'), { code: 11000 });
        quotas[filter._id] = used + 1; return { used: used + 1 };
    } };
    const queue = { async enqueue(input, { session }) {
        assert.equal(session, 'test-session'); if (options.failQueue) throw new Error('test-outbox-failure');
        const job = { ...input, _id: (++serial).toString(16).padStart(24, '0'), state: 'queued' }; jobs.push(job); return job;
    } };
    const connection = { async transaction(work) {
        const snapshot = JSON.stringify({ rows, quotas, jobs, product });
        try { return await work('test-session'); } catch (error) {
            const prior = JSON.parse(snapshot); rows = prior.rows; quotas = prior.quotas; jobs = prior.jobs; Object.assign(product, prior.product); throw error;
        }
    } };
    const service = createImageRefinementService({ Refinement, Product, Job, Usage, queue, connection, env: { ...env, ...options.env },
        images: { url: (asset) => asset ? 'private-url' : null, publicUrl: () => 'https://example.invalid/approved.png' } });
    return { service, product, get rows() { return rows; }, get quotas() { return quotas; }, get jobs() { return jobs; } };
}
test('refinement only accepts owned versioned product image URLs and rejects arbitrary inputs', () => {
    assert.equal(sourceIdentity(source, 'test').publicId, 'naijago_products/source');
    for (const url of [source.replace('/test/', '/foreign/'), source.replace('https:', 'http:'), source + '?x=1', source.replace('/v1/', '/w_100/'),
        source.replace('/naijago_products/', '/other/'), 'http://127.0.0.1/private', source.replace('source.png', 'source.svg')]) assert.throws(() => sourceIdentity(url, 'test'), RefinementError);
    assert.throws(() => imageBytes(Buffer.from('<html>not an image</html>'), 'image/png'), RefinementError);
});
test('image replacement updates all presentation mirrors without changing inventory or variants', () => {
    const product = { imageUrls: [source, extra], images: { main: source, others: [source] }, variants: [{ imageUrls: [source], price: 42, stockQuantity: 3 }] };
    assert.equal(sourceImages(product).length, 2);
    const patch = replacement(product, source, 'approved');
    assert.deepEqual(patch.imageUrls, ['approved', extra]); assert.equal(patch['images.main'], 'approved');
    assert.deepEqual(patch['variants.0.imageUrls'], ['approved']); assert.equal(patch.variants, undefined); assert.equal(patch.price, undefined);
    assert.throws(() => replacement(product, 'removed', 'approved'), { status: 409 });
});
test('automatic upload marker and stale-image guard are saved with product edits', () => {
    const callbacks = {};
    imageRefinementProductHooks({ post: (event, fn) => { callbacks[event] = fn; }, pre: (_event, fn) => { callbacks.before = fn; } }, env);
    const doc = { updatedAt: new Date(1000), $locals: {}, isNew: false, sellerId: actor, isModified: (field) => field === 'imageUrls', modifiedPaths: () => [] };
    callbacks.init(doc); callbacks.before.call(doc);
    assert.equal(doc.refinementScanPending, true); assert.equal(doc.$where.updatedAt.getTime(), 1000);
    doc.updatedAt = new Date(2000); callbacks.save(doc); assert.equal(doc.$where.updatedAt, undefined);
    const noChange = { $locals: {}, isModified: () => false, modifiedPaths: () => [] }; callbacks.before.call(noChange); assert.equal(noChange.refinementScanPending, undefined);
});
test('duplicate staging reuses one review, one job and one pair of quotas', async () => {
    const f = fixture(); await f.service.stage({ productId, actor }); await f.service.stage({ productId, actor });
    assert.equal(f.rows.length, 1); assert.equal(f.jobs.length, 1); assert.deepEqual(Object.values(f.quotas), [1, 1]);
    assert.equal(f.product.imageUrls[0], source); assert.equal(f.rows[0].sandbox, false);
    assert.equal((await f.service.get(imageId)).candidateUrl, null);
});
test('bulk requests only record pending work and spend no provider quota in the HTTP path', async () => {
    const f = fixture(); const result = await f.service.requestBatch({ productIds: [productId, productId], actor, profile: 'relight' });
    assert.equal(result.results.length, 1); assert.equal(result.results[0].state, 'scheduled');
    assert.equal(f.product.refinementScanPending, true); assert.equal(f.product.refinementScanProfile, 'relight');
    assert.equal(f.rows.length, 0); assert.equal(f.jobs.length, 0); assert.deepEqual(f.quotas, {});
});
test('a first-bucket upsert race retries the transaction without a false quota failure', async () => {
    const f = fixture({ collideOnce: true }); const result = await f.service.stage({ productId, actor });
    assert.equal(result.images[0].state, 'recorded'); assert.equal(f.rows.length, 1); assert.equal(f.jobs.length, 1);
    assert.deepEqual(Object.values(f.quotas), [1, 1]);
});
test('cancelled scheduling creates no image record, job or paid reservation', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await assert.rejects(f.service.stage({ productId, actor, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(f.rows.length, 0); assert.equal(f.jobs.length, 0); assert.deepEqual(f.quotas, {});
});
test('missing configuration and exhausted quota cannot create paid work; outbox errors roll back reservations', async () => {
    const disabled = fixture({ env: { PHOTOROOM_DAILY_LIMIT: '0' } }); await assert.rejects(disabled.service.stage({ productId, actor }), { status: 503 });
    const broken = fixture({ failQueue: true }); await assert.rejects(broken.service.stage({ productId, actor }), /test-outbox-failure/);
    assert.equal(broken.jobs.length, 0); assert.equal(broken.rows.length, 0); assert.deepEqual(broken.quotas, {});
    const limited = fixture({ env: { PHOTOROOM_VENDOR_DAILY_LIMIT: '0' } }); await assert.rejects(limited.service.stage({ productId, actor }), { status: 503 });
});
test('review requires identity confirmation and original/candidate pair; sandbox cannot publish', async () => {
    const f = fixture(); await f.service.stage({ productId, actor });
    const args = { refinementId: imageId, actor, input: { action: 'approve', revision: 0, reason: 'Checked' } };
    await assert.rejects(f.service.review(args), { status: 409 });
    Object.assign(f.rows[0], { state: 'pending_review', original: { publicId: 'original' }, candidate: { publicId: 'candidate' } });
    await assert.rejects(f.service.review(args), { status: 400 });
    f.rows[0].sandbox = true; args.input.identityConfirmed = true; await assert.rejects(f.service.review(args), { status: 409 });
    assert.equal(f.product.imageUrls[0], source);
});
test('approval queues publication; only confirmed publication swaps image fields transactionally', async () => {
    const f = fixture(); await f.service.stage({ productId, actor });
    Object.assign(f.rows[0], { state: 'pending_review', original: { publicId: 'original' }, candidate: { publicId: 'candidate' } });
    await f.service.review({ refinementId: imageId, actor, input: { action: 'approve', revision: 0, reason: 'Identity checked', identityConfirmed: true } });
    assert.equal(f.rows[0].state, 'publishing'); assert.equal(f.jobs[1].type, 'image.publish'); assert.equal(f.product.imageUrls[0], source);
    await f.service.completePublication(f.rows[0], { publicId: 'published' });
    assert.equal(f.product.imageUrls[0], 'https://example.invalid/approved.png'); assert.equal(f.product.images.main, f.product.imageUrls[0]);
    assert.equal(f.product.price, 500); assert.equal(f.product.stockQuantity, 7); assert.equal(f.rows[0].original.publicId, 'original');
});
test('a failed publication outbox rolls back approval and keeps the original customer image', async () => {
    const options = {}, f = fixture(options); await f.service.stage({ productId, actor });
    Object.assign(f.rows[0], { state: 'pending_review', original: {}, candidate: {} }); options.failQueue = true;
    await assert.rejects(f.service.review({ refinementId: imageId, actor, input: { action: 'approve', revision: 0, reason: 'Checked', identityConfirmed: true } }), /test-outbox-failure/);
    assert.equal(f.rows[0].state, 'pending_review'); assert.equal(f.rows[0].revision, 0); assert.equal(f.product.imageUrls[0], source);
});
test('changed sellers, changed images and stale review versions cannot publish', async () => {
    for (const change of [(f) => { f.product.sellerId = productId; }, (f) => { f.product.imageUrls = []; f.product.images = {}; }, (f) => { f.rows[0].revision = 2; }]) {
        const f = fixture(); await f.service.stage({ productId, actor });
        Object.assign(f.rows[0], { state: 'pending_review', original: {}, candidate: {} }); change(f);
        await assert.rejects(f.service.review({ refinementId: imageId, actor, input: { action: 'approve', revision: 0, reason: 'Checked', identityConfirmed: true } }), { status: 409 });
        assert.equal(f.jobs.length, 1);
    }
});
test('regeneration retains previous candidate history and is bounded to three attempts', async () => {
    const f = fixture(); await f.service.stage({ productId, actor });
    Object.assign(f.rows[0], { state: 'rejected', candidate: { publicId: 'prior-candidate' }, original: { publicId: 'saved-original' } });
    await f.service.review({ refinementId: imageId, actor, input: { action: 'regenerate', revision: 0, reason: 'Try lighting', profile: 'relight' } });
    assert.equal(f.rows[0].generation, 2); assert.equal(f.rows[0].candidate, undefined); assert.equal(f.rows[0].history.at(-1).candidate.publicId, 'prior-candidate');
    f.rows[0].generation = 3; f.rows[0].state = 'rejected';
    await assert.rejects(f.service.review({ refinementId: imageId, actor, input: { action: 'regenerate', revision: 1, reason: 'Again' } }), { status: 409 });
});
function workerFixture(state, recovered = null) {
    const row = { _id: imageId, product: productId, owner: actor, sourceUrl: source, generation: 1, state, budgetDay: new Date().toISOString().slice(0, 10) }, calls = [];
    const model = { findOne: () => chain({ ...row }), async updateOne(filter, update) {
        if (filter.state !== row.state) return { modifiedCount: 0 };
        calls.push(update.$set.state); Object.assign(row, update.$set); return { modifiedCount: 1 };
    } };
    const handlers = createImageRefinementWorkers({ Refinement: model, Product: { findById: () => chain({}) },
        service: { enabled: () => true, processingEnabled: () => true, applicable: () => true }, images: {
            preserve: async () => { calls.push('preserve'); return { publicId: 'original' }; },
            refine: async () => { calls.push('provider'); return { publicId: 'candidate' }; }, recover: async () => { calls.push('recover'); return recovered; },
        } });
    return { calls, row, run: () => handlers['image.refine']({ refinementId: imageId, generation: 1 }, { job: { _id: productId }, signal: new AbortController().signal }) };
}
test('worker preserves original then durably checkpoints before paid generation', async () => {
    const f = workerFixture('queued'); assert.equal((await f.run()).state, 'pending_review');
    assert.deepEqual(f.calls, ['preserving', 'preserve', 'generating', 'provider', 'pending_review']); assert.equal(f.row.original.publicId, 'original');
});
test('crashed generation never repeats a possibly charged provider call', async () => {
    for (const recovered of [null, { publicId: 'already-stored' }]) {
        const f = workerFixture('generating', recovered); assert.equal((await f.run()).state, recovered ? 'pending_review' : 'uncertain');
        assert.equal(f.calls.includes('provider'), false); assert.equal(f.calls[0], 'recover');
    }
});
test('expired queued reservations cannot spend the next days provider budget', async () => {
    const f = workerFixture('queued'); f.row.budgetDay = '2000-01-01';
    assert.equal((await f.run()).state, 'failed'); assert.equal(f.row.code, 'budget_window_expired'); assert.equal(f.calls.includes('provider'), false);
});
test('provider adapter stores immutable private originals/candidates and exposes only approved public copies', async () => {
    const calls = [], assets = new Map();
    const metadata = (publicId, type) => ({ public_id: publicId, type, resource_type: 'image', format: 'png', bytes: 12, version: 1, width: 10, height: 10 });
    const cloudinary = { api: { resource: async (publicId) => {
        if (publicId === 'naijago_products/source') return metadata(publicId, 'upload');
        if (assets.has(publicId)) return assets.get(publicId); throw { http_code: 404 };
    } }, uploader: { upload: async (_data, options) => { calls.push(options); const asset = metadata(options.public_id, options.type); assets.set(options.public_id, asset); return asset; } },
        utils: { private_download_url: (publicId, _format, options) => { assert.equal(options.type, 'authenticated'); return `https://example.invalid/${publicId}`; } },
        url: (publicId) => `https://example.invalid/${publicId}` };
    const http = { get: async (address, options) => { calls.push({ address, ...options }); return { data: png, headers: { 'content-type': 'image/png' } }; } };
    const adapter = createImageRefinementAdapter({ cloudinary, http, env });
    const row = { _id: imageId, generation: 1, sourceUrl: source, sandbox: true, profile: 'standard' }, signal = new AbortController().signal;
    row.original = await adapter.preserve(row, signal); row.candidate = await adapter.refine(row, signal);
    const provider = calls.find((call) => call.address === 'https://image-api.photoroom.com/v2/edit');
    assert.equal(provider.headers['x-api-key'], 'sandbox_synthetic-key'); assert.equal(provider.params['lighting.mode'], undefined);
    assert.equal(provider.maxRedirects, 0); assert.equal(provider.timeout, 180000);
    assert.ok(calls.filter((call) => call.public_id).every((call) => call.type === 'authenticated' && call.overwrite === false));
    await assert.rejects(adapter.publish(row, signal), /Human approval/);
    row.state = 'publishing'; row.sandbox = false; row.history = [{ action: 'approve', generation: 1 }];
    const published = await adapter.publish(row, signal); assert.equal(calls.at(-1).type, 'upload');
    await adapter.publish(row, signal); assert.equal(calls.filter((call) => call.public_id === published.publicId).length, 1);
    assert.equal(adapter.url({ publicId: 'unowned', format: 'png' }), null);
});
