const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const taxonomy = require('../services/catalogTaxonomyService');
const service = require('../services/productImageAnalysisService');
const { createRouter } = require('../routes/productImageAnalysisRoutes');
const photo = Buffer.from([255, 216, 255, ...Array(20).fill(0)]);
const selected = taxonomy.resolveLabels('Photography', 'Content Creator Equipment');
const raw = (overrides = {}) => ({ name: 'Ring light', description: 'A black circular light on a stand.', brand: '', modelNumber: '',
    categoryId: selected.parent.id, subcategoryId: selected.child.id, confidence: 0.95,
    ambiguous: false, medicineEvidence: false, foodEvidence: false, tags: ['ring light'],
    attributes: { colour: 'black', material: '', visibleSize: '' }, warnings: [], ...overrides });
const env = { PRODUCT_IMAGE_ANALYSIS_ENABLED: 'true', GEMINI_API_KEY: 'fixture-key' };
test('analysis remains disabled without explicit configuration and backend key', () => {
    assert.equal(service.configuration({ GEMINI_API_KEY: 'fixture' }).enabled, false);
    assert.equal(service.configuration({ PRODUCT_IMAGE_ANALYSIS_ENABLED: 'true' }).enabled, false);
});
test('category matching uses scoped stable IDs and the unchanged taxonomy', () => {
    const result = service.validateSuggestion(raw());
    assert.equal(result.classification.categoryId, selected.parent.id);
    assert.equal(result.classification.subcategoryId, selected.child.id);
    assert.equal(result.taxonomyChecksum, taxonomy.checksum);
    assert.equal(result.reviewRequired, true);
    assert.equal(taxonomy.manifest.categories.length, 23);
    assert.equal(taxonomy.manifest.categories.reduce((sum, parent) => sum + parent.children.length, 0), 186);
    assert.equal(result.suggestions.price, undefined); assert.equal(result.suggestions.stock, undefined);
});
test('uncertain, invented, duplicate-parent and contradictory evidence never select categories', () => {
    const other = taxonomy.resolveLabels('Fashion', 'Accessories') || { parent: taxonomy.manifest.categories[0], child: taxonomy.manifest.categories[0].children[0] };
    for (const overrides of [{ confidence: 0.5 }, { ambiguous: true }, { categoryId: 'f'.repeat(24) },
        { subcategoryId: other.child.id }, { subcategoryId: '' }, { medicineEvidence: true }, { foodEvidence: true }]) {
        const result = service.validateSuggestion(raw(overrides));
        assert.equal(result.classification, null); assert.equal(result.needsManualCategory, true);
    }
});
test('unexpected commercial fields, malformed attributes and out-of-range confidence fail closed', () => {
    for (const overrides of [{ price: 10 }, { stockQuantity: 1 }, { productStatus: 'active' }, { confidence: 2 },
        { attributes: { colour: 'black', authenticity: 'genuine' } }, { tags: Array(13).fill('tag') }, { brand: {} }]) {
        assert.throws(() => service.validateSuggestion(raw(overrides)), service.AnalysisError);
    }
});
test('only bounded supported image signatures are accepted', () => {
    assert.equal(service.imageMime(photo), 'image/jpeg');
    assert.equal(service.imageMime(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])), 'image/png');
    assert.equal(service.imageMime(Buffer.from('RIFF0000WEBP')), 'image/webp');
    for (const buffer of [undefined, Buffer.from('<svg>bad</svg>'), Buffer.alloc(5 * 1024 * 1024 + 1)]) assert.throws(() => service.imageMime(buffer));
});
test('Gemini request contains actual taxonomy and inline photo, backend headers, bounded output and no tools/retry', async () => {
    let calls = 0;
    const result = await service.analyze(photo, { env, post: async (url, body, options) => {
        calls++; assert.match(url, /gemini-2.5-flash:generateContent$/);
        assert.equal(options.headers['x-goog-api-key'], 'fixture-key'); assert.equal(options.timeout, 30000);
        assert.equal(body.contents[0].parts[1].inlineData.data, photo.toString('base64'));
        assert.match(body.systemInstruction.parts[0].text, new RegExp(selected.child.id));
        assert.equal(body.generationConfig.maxOutputTokens, 2048); assert.equal(body.tools, undefined);
        assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
        return { data: { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'ignored' }, { text: JSON.stringify(raw()) }] } }] } };
    } });
    assert.equal(calls, 1); assert.equal(result.imageHash.length, 64); assert.equal(result.model, 'gemini-2.5-flash');
});
test('provider secrets, blocks and truncated JSON are not exposed', async () => {
    for (const post of [async () => { throw new Error('secret fixture-key uploaded bytes'); },
        async () => ({ data: { candidates: [{ finishReason: 'SAFETY' }] } }),
        async () => ({ data: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{' }] } }] } })]) {
        await assert.rejects(service.analyze(photo, { env, post }), error => error instanceof service.AnalysisError && !error.message.includes('fixture-key'));
    }
    await assert.rejects(service.analyze(photo, { env, post: async () => { throw { response: { status: 429 } }; } }), error => error.status === 429);
});

async function fixture(t, { user = { _id: 'fixture', isVendor: true, vendorStatus: 'approved', role: 'vendor' },
    config = env, result = service.validateSuggestion(raw()), failure, actualAuth = false } = {}) {
    const reads = []; let calls = 0;
    const products = { find: query => {
        reads.push(query);
        return { select: () => ({ limit: () => ({ maxTimeMS: () => ({ lean: async () => [{ _id: 'duplicate', name: 'Ring light' }] }) }) }) };
    } };
    const mocked = { ...service, analyze: async () => { calls++; if (failure) throw failure; return structuredClone(result); } };
    const options = { service: mocked, products, env: config };
    if (!actualAuth) options.authenticate = (req, res, next) => { req.user = user; next(); };
    const app = express(); app.use('/api/products/image-analysis', createRouter(options));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/api/products/image-analysis`;
    async function request({ bytes = photo, extra = false, headers = {}, path = '', method = 'POST' } = {}) {
        const body = new FormData(); if (bytes) body.append('image', new Blob([bytes]), 'fixture.jpg');
        if (extra) body.append('categoryId', 'untrusted');
        const response = await fetch(url + path, { method, headers, ...(method === 'POST' ? { body } : {}) });
        return { status: response.status, body: await response.json() };
    }
    return { request, reads, calls: () => calls };
}
test('actual authentication rejects absent tokens and uses fresh approved user fields', async t => {
    const original = process.env.JWT_SECRET; process.env.JWT_SECRET = 'local-fixture';
    t.after(() => { if (original === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = original; });
    t.mock.method(User, 'findById', () => ({ select: async () => ({ _id: 'fixture', isVendor: true, vendorStatus: 'pending' }) }));
    const f = await fixture(t, { actualAuth: true });
    assert.equal((await f.request()).status, 401);
    assert.equal((await f.request({ headers: { Authorization: `Bearer ${jwt.sign({ id: 'fixture' }, 'local-fixture')}` } })).status, 403);
    assert.equal(f.calls(), 0);
});
test('only admins and approved vendors can analyze; claimed roles cannot bypass approval', async t => {
    for (const user of [{ _id: '1', role: 'admin' }, { _id: '1', isVendor: true, vendorStatus: 'pending' }, { _id: '1', role: 'pharmacist' }]) {
        const f = await fixture(t, { user }); assert.equal((await f.request()).status, 403); assert.equal(f.calls(), 0);
    }
    const f = await fixture(t, { user: { _id: 'admin', isAdmin: true } }); assert.equal((await f.request()).status, 200);
});
test('disabled provider, invalid/missing/oversized image and arbitrary extra fields make no AI calls', async t => {
    const disabled = await fixture(t, { config: {} }); assert.equal((await disabled.request()).status, 503);
    const f = await fixture(t);
    assert.equal((await f.request({ bytes: null })).status, 400);
    assert.equal((await f.request({ bytes: Buffer.from('not an image') })).status, 400);
    assert.equal((await f.request({ extra: true })).status, 400);
    assert.equal(f.calls(), 0);
    const large = await fixture(t); assert.equal((await large.request({ bytes: Buffer.alloc(5 * 1024 * 1024 + 1) })).status, 413);
    assert.equal(large.calls(), 0);
});
test('duplicate lookup is bounded, account-scoped and read-only; suggestions never save products', async t => {
    const f = await fixture(t); const response = await f.request(); assert.equal(response.status, 200);
    assert.equal(response.body.reviewRequired, true); assert.equal(response.body.possibleDuplicates[0].id, 'duplicate');
    assert.equal(f.reads.length, 1); assert.deepEqual(f.reads[0].$or, [{ sellerId: 'fixture' }, { vendor: 'fixture' }]);
    assert.equal(f.reads[0].sellerType, 'vendor');
});
test('medicine evidence keeps pharmacy eligibility and review warnings', async t => {
    const medicine = taxonomy.resolveLabels('Cosmetics & Beauty', 'Medicine');
    const result = service.validateSuggestion(raw({ categoryId: medicine.parent.id, subcategoryId: medicine.child.id, medicineEvidence: true }));
    const f = await fixture(t, { result }); const response = await f.request();
    assert.equal(response.body.classification, null); assert.match(response.body.warnings.join(' '), /not eligible/);
    const pharmacist = await fixture(t, { result, user: { _id: 'pharmacist', isVendor: true, vendorStatus: 'approved', role: 'pharmacist', pharmacistStatus: 'approved' } });
    assert.equal((await pharmacist.request()).body.classification.subcategory, 'Medicine');
});
test('global daily budget and per-account minute limit stop extra provider calls', async t => {
    const budget = await fixture(t, { config: { ...env, PRODUCT_IMAGE_ANALYSIS_DAILY_LIMIT: '1' } });
    assert.equal((await budget.request()).status, 200); assert.equal((await budget.request()).status, 429); assert.equal(budget.calls(), 1);
    const f = await fixture(t); for (let i = 0; i < 3; i++) assert.equal((await f.request()).status, 200);
    assert.equal((await f.request()).status, 429); assert.equal(f.calls(), 3);
});
test('endpoint catches unexpected failures without exposing provider details', async t => {
    const f = await fixture(t, { failure: new Error('secret key') }); const response = await f.request();
    assert.equal(response.status, 502); assert.equal(response.body.message.includes('secret'), false);
});
