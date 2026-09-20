const test = require('node:test');
const assert = require('node:assert/strict');
const RequestModel = require('../models/ProductRequest');
const { parseDraft, transition, RequestInputError, LABEL } = require('../utils/productRequestPolicy');
const { createProductRequestService } = require('../services/productRequestService');
const { createConceptImageAdapter, createRequestPreviewWorker, createRequestNotificationWorker } = require('../services/productRequestWorkers');
const owner = 'aaaaaaaaaaaaaaaaaaaaaaaa', other = 'bbbbbbbbbbbbbbbbbbbbbbbb', requestId = 'cccccccccccccccccccccccc', jobId = 'dddddddddddddddddddddddd';
const input = { query: 'purple canvas backpack', clientRequestId: 'request-retry-key-0001', criteria: { maxPrice: '20000' }, notes: 'Small size' };
const env = { PRODUCT_REQUESTS_ENABLED: 'true', BACKGROUND_JOBS_ENABLED: 'true', PRODUCT_REQUEST_PREVIEWS_ENABLED: 'true',
    GEMINI_API_KEY: 'synthetic-test-key', CLOUDINARY_CLOUD_NAME: 'test', CLOUDINARY_API_KEY: 'test', CLOUDINARY_API_SECRET: 'test', GEMINI_PREVIEW_DAILY_LIMIT: '10' };
function chain(value) { return { session() { return this; }, select() { return this; }, sort() { return this; }, limit() { return this; },
    lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; }
function fixture(options = {}) {
    let row, used = 0; const jobs = [], writes = [];
    function document(value) { return Object.assign(value, { async save() { writes.push('save'); row = this; } }); }
    const Request = {
        findOne(filter) {
            const matches = row && (!filter._id || String(row._id) === filter._id) && (!filter.owner || row.owner === filter.owner) &&
                (!filter.clientRequestId || row.clientRequestId === filter.clientRequestId) && (!filter.submittedAt || row.submittedAt);
            return chain(matches ? row : null);
        },
        find(filter) { writes.push(filter); return chain(row && (!filter.owner || filter.owner === row.owner) && (!filter.submittedAt || row.submittedAt) ? [row] : []); },
        async create(data) { row = document({ _id: requestId, state: 'draft', revision: 0, statusRevision: 0, history: [], customerMessage: '', matchedProduct: null,
            createdAt: new Date(), preview: { state: 'not_requested', generation: 0 }, ...data }); return row; },
    };
    const connection = { async transaction(work) {
        const snapshot = row ? JSON.parse(JSON.stringify(row)) : undefined; const count = jobs.length, quota = used;
        try { return await work('transaction-session'); }
        catch (error) { row = snapshot ? document(snapshot) : undefined; jobs.length = count; used = quota; throw error; }
    } };
    const queue = { async enqueue(job, { session }) { assert.equal(session, 'transaction-session'); if (options.failQueue) throw new Error('synthetic-outbox-failure');
        const result = { ...job, _id: jobId, state: 'queued' }; jobs.push(result); return result; } };
    const Job = { findById: () => chain(jobs.at(-1) || null) };
    const Usage = { async findOneAndUpdate(_filter, _update, { session }) { assert.equal(session, 'transaction-session');
        if (options.fullQuota) throw Object.assign(new Error('quota'), { code: 11000 }); used++; return { used }; } };
    const catalog = { hasMatches: async () => options.hasMatches === true, available: async () => options.product || null };
    const service = createProductRequestService({ Request, Job, Usage, connection, queue, catalog, env: { ...env, ...options.env }, previewUrl: () => 'https://example.invalid/private-preview' });
    return { service, jobs, writes, get row() { return row; }, get used() { return used; } };
}
test('request drafts are separate from sellable inventory and validate bounded fields', async () => {
    const parsed = parseDraft(input);
    assert.equal(parsed.criteria.maxPrice, '20000');
    for (const bad of [{ ...input, query: 'a' }, { ...input, query: 'x'.repeat(201) }, { ...input, clientRequestId: 'bad' },
        { ...input, criteria: { maxPrice: '-5' } }, { ...input, criteria: { owner: other } }, { ...input, criteria: { maxPrice: 20 } }]) assert.throws(() => parseDraft(bad), RequestInputError);
    const doc = new RequestModel({ ...parsed, owner }); await doc.validate();
    assert.equal(doc.state, 'draft'); assert.equal(doc.preview.generation, 0);
    assert.equal(doc.price, undefined); assert.equal(doc.stockQuantity, undefined);
});
test('draft creation is idempotent, private and cannot reuse a key for different input', async () => {
    const f = fixture(); const first = await f.service.create({ owner, input });
    assert.equal((await f.service.create({ owner, input })).id, first.id);
    assert.equal(first.preview.label, LABEL); assert.equal(first.preview.purchasable, false);
    assert.equal(first.owner, undefined); assert.equal(first.inputHash, undefined); assert.equal(f.jobs.length, 0);
    await assert.rejects(f.service.create({ owner, input: { ...input, notes: 'Changed' } }), { status: 409 });
    await assert.rejects(f.service.get({ requestId, owner: other }), { status: 404 });
    await assert.rejects(f.service.get({ requestId, owner: other, admin: true }), { status: 404 });
});
test('submitted status and its notification commit together, retries cannot duplicate the outbox', async () => {
    const f = fixture(); await f.service.create({ owner, input });
    const data = { state: 'requested', revision: 0 };
    const row = await f.service.update({ owner, requestId, input: data });
    await f.service.update({ owner, requestId, input: data });
    assert.equal(row.state, 'requested'); assert.equal(row.history.length, 1); assert.equal(f.jobs.length, 1);
    assert.equal(f.jobs[0].type, 'request.notify'); assert.equal(f.row.statusRevision, 1);
});
test('failed outbox rolls back submission instead of losing the customer notification', async () => {
    const f = fixture({ failQueue: true }); await f.service.create({ owner, input });
    await assert.rejects(f.service.update({ owner, requestId, input: { state: 'requested', revision: 0 } }), /synthetic-outbox-failure/);
    assert.equal(f.row.state, 'draft'); assert.equal(f.row.history.length, 0); assert.equal(f.jobs.length, 0);
});
test('cancelled unsent drafts stay out of admin queues; owner filters cannot leak other accounts', async () => {
    const f = fixture(); await f.service.create({ owner, input });
    await f.service.update({ owner, requestId, input: { state: 'cancelled', revision: 0 } });
    assert.equal((await f.service.list({ admin: true })).requests.length, 0);
    assert.equal((await f.service.list({ owner: other })).requests.length, 0);
    assert.equal((await f.service.list({ owner })).requests.length, 1);
});
test('only admin can source or match; stale revisions, missing reasons and cancelled requests reject updates', () => {
    const row = { state: 'requested', revision: 1, history: [], customerMessage: '', matchedProduct: null };
    assert.throws(() => transition(row, { state: 'sourcing', expectedRevision: 1 }), { status: 403 });
    assert.throws(() => transition(row, { state: 'sourcing', expectedRevision: 0, admin: true, message: 'Checking' }), { status: 409 });
    assert.throws(() => transition(row, { state: 'matched', expectedRevision: 1, admin: true, message: '' }), { status: 400 });
    assert.throws(() => transition({ ...row, state: 'cancelled' }, { state: 'matched', expectedRevision: 1, admin: true, message: 'Found', productId: other }), { status: 409 });
});
test('unavailable listings cannot be matched and changed stock hides a previously matched product', async () => {
    const f = fixture(); await f.service.create({ owner, input }); await f.service.update({ owner, requestId, input: { state: 'requested', revision: 0 } });
    await assert.rejects(f.service.update({ owner: other, admin: true, requestId, input: { state: 'matched', revision: 1, productId: other, message: 'Found' } }), /approved, active product/);
    f.row.state = 'matched'; f.row.matchedProduct = other;
    const response = await f.service.get({ owner, requestId });
    assert.equal(response.matchedProduct, null); assert.equal(response.matchedUnavailable, true);
    await assert.rejects(f.service.matched({ owner, requestId }), { status: 409 });
});
test('available matching uses real listing data without making the concept purchasable', async () => {
    const f = fixture({ product: { id: other, name: 'Real product', effectivePrice: 42, sellerName: 'Verified seller' } });
    await f.service.create({ owner, input }); await f.service.update({ owner, requestId, input: { state: 'requested', revision: 0 } });
    const row = await f.service.update({ owner: other, admin: true, requestId, input: { state: 'matched', revision: 1, productId: other, message: 'Please check this actual listing.' } });
    assert.equal(row.matchedProduct.price, 42); assert.equal(row.preview.purchasable, false);
    assert.equal((await f.service.matched({ owner, requestId })).product.id, other);
});
test('preview generation requires consent, no matching inventory and configured finite budgets', async () => {
    for (const options of [{}, { hasMatches: true }, { env: { GEMINI_PREVIEW_DAILY_LIMIT: '0' } }, { env: { GEMINI_PREVIEW_USER_DAILY_LIMIT: '0' } }]) {
        const f = fixture(options); await f.service.create({ owner, input });
        await assert.rejects(f.service.generate({ owner, requestId, input: { revision: 0, aiConsent: Boolean(Object.keys(options).length) } }));
        assert.equal(f.jobs.length, 0); assert.equal(f.used, 0);
    }
});
test('preview quota and enqueue are transactional, duplicate taps reuse the queued generation', async () => {
    const f = fixture(); await f.service.create({ owner, input });
    const args = { owner, requestId, input: { revision: 0, aiConsent: true } };
    const first = await f.service.generate(args); await f.service.generate(args);
    assert.equal(first.preview.state, 'queued'); assert.equal(f.jobs.length, 1); assert.equal(f.used, 2);
    assert.equal(f.jobs[0].type, 'request.preview'); assert.equal(f.jobs[0].maxAttempts, 2);
    assert.deepEqual(f.jobs[0].payload, { requestId, generation: 1 });
    assert.equal(f.row.statusRevision, 0);
    for (const options of [{ fullQuota: true }, { failQueue: true }]) {
        const failed = fixture(options); await failed.service.create({ owner, input });
        await assert.rejects(failed.service.generate(args)); assert.equal(failed.used, 0); assert.equal(failed.row.preview.generation, 0);
    }
});
test('exhausted preview jobs are visible as uncertain and new explicit attempts are capped', async () => {
    const f = fixture(); await f.service.create({ owner, input }); await f.service.generate({ owner, requestId, input: { revision: 0, aiConsent: true } });
    f.jobs[0].state = 'failed'; f.row.preview.generation = 3;
    const row = await f.service.get({ owner, requestId }); assert.equal(row.preview.state, 'uncertain'); assert.equal(row.preview.canGenerate, false);
    await assert.rejects(f.service.generate({ owner, requestId, input: { revision: f.row.revision, aiConsent: true } }), { status: 429 });
});

function workerFixture({ state = 'queued', attempts = 1, recovered = null, fail = false, disabled = false } = {}) {
    const events = [], row = { _id: requestId, query: input.query, preview: { state } }, controller = new AbortController();
    const worker = createRequestPreviewWorker({ Request: { findOne: () => chain(row), updateOne: async (filter, update) => { events.push({ filter, update }); return { modifiedCount: 1 }; } },
        enabled: () => !disabled, images: { recover: async () => { events.push('recover'); return recovered; }, create: async (args) => { events.push(args); if (fail) throw new Error('synthetic-secret'); return { publicId: 'private-id', format: 'jpg' }; } } });
    return { events, controller, run: () => worker({ requestId, generation: 1 }, { job: { _id: jobId, attempts }, signal: controller.signal }) };
}
test('preview worker checkpoints before the paid call and writes only to its generation identity', async () => {
    const f = workerFixture(); assert.equal((await f.run()).state, 'ready');
    assert.equal(f.events[0].update.$set['preview.state'], 'generating');
    assert.equal(f.events[1].query, input.query); assert.equal(f.events[1].owner, undefined);
    assert.equal(f.events[2].filter['preview.job'], jobId);
});
test('crashed preview work recovers exact stored media or becomes uncertain without another generation', async () => {
    for (const recovered of [null, { publicId: 'private-id', format: 'jpg' }]) {
        const f = workerFixture({ state: 'generating', attempts: 2, recovered });
        assert.equal((await f.run()).state, recovered ? 'ready' : 'uncertain'); assert.equal(f.events[0], 'recover');
        assert.equal(f.events.some((event) => event?.query), false);
    }
});
test('provider errors become a safe failed preview; aborted workers leave recovery possible', async () => {
    const f = workerFixture({ fail: true }); assert.equal((await f.run()).state, 'failed');
    assert.equal(JSON.stringify(f.events).includes('synthetic-secret'), false);
    const aborted = workerFixture(); aborted.controller.abort(); await assert.rejects(aborted.run(), { name: 'AbortError' }); assert.equal(aborted.events.length, 0);
    const disabled = workerFixture({ disabled: true }); assert.equal((await disabled.run()).state, 'failed'); assert.equal(disabled.events.some((e) => e?.query), false);
});
test('image adapter requests one AI attempt, verifies binary type and stores authenticated immutable media', async () => {
    const calls = [];
    const adapter = createConceptImageAdapter({ generate: async (args) => { calls.push(args); return { model: 'test-model', mimeType: 'image/jpeg', data: Buffer.from([255, 216, 255, 217]).toString('base64') }; },
        cloudinary: { uploader: { upload: async (_, options) => { calls.push(options); return { public_id: options.public_id, type: options.type, resource_type: 'image', format: 'jpg' }; } },
            utils: { private_download_url: (...args) => { calls.push(args); return 'signed-private-url'; } } }, now: () => new Date(1000000) });
    const image = await adapter.create({ requestId, generation: 1, query: input.query, signal: new AbortController().signal });
    assert.equal(calls[0].attempts, 1); assert.equal(calls[0].concept, true); assert.equal(calls[1].type, 'authenticated'); assert.equal(calls[1].overwrite, false);
    assert.equal(adapter.url(image), 'signed-private-url'); assert.equal(calls[2][2].expires_at, 1300);
    assert.equal(adapter.url({ publicId: 'another-owner-path', format: 'jpg' }), null);
});
test('image adapter refuses HTML masquerading as an image before storage', async () => {
    const adapter = createConceptImageAdapter({ generate: async () => ({ mimeType: 'image/jpeg', data: Buffer.from('<html>unsafe</html>').toString('base64') }),
        cloudinary: { uploader: { upload: () => assert.fail('Invalid bytes cannot be uploaded.') } } });
    await assert.rejects(adapter.create({ requestId, generation: 1, query: input.query, signal: new AbortController().signal }), /Invalid concept image/);
});
test('request notifications use status revision, stable retry identities and generic private content', async () => {
    const pushes = [], writes = [];
    const row = { owner, state: 'sourcing', revision: 3, statusRevision: 1, _id: requestId, query: 'private-sensitive-query' };
    const notify = createRequestNotificationWorker({ Request: { findById: () => chain(row) }, User: { updateOne: async (...args) => writes.push(args) },
        notifications: { hasAudienceConfiguration: () => true, getPlatformOptions: () => ({}), createNotification: async (_, body) => { pushes.push(body); return { body: { id: 'accepted' } }; } } });
    const args = { job: { _id: jobId, deliveryKey: 'same-delivery-id' }, signal: new AbortController().signal };
    await notify({ requestId, revision: 1 }, args); await notify({ requestId, revision: 1 }, args);
    assert.equal(pushes[0].idempotency_key, pushes[1].idempotency_key); assert.equal(writes[0][0]['notifications._id'].$ne, jobId);
    assert.equal(writes[0][1].$push.notifications.relatedModel, 'ProductRequest'); assert.equal(JSON.stringify(pushes).includes(row.query), false);
    row.state = 'cancelled'; assert.equal((await notify({ requestId, revision: 1 }, args)).skipped, 'stale_request');
});
