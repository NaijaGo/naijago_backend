const test = require('node:test');
const assert = require('node:assert/strict');
const { createGeminiSearchService, validateIntent, preservesIdentifiers } = require('../services/geminiSearchService');
const { createCatalogSearchService, parseSearchInput, mergeInterpretedIntent } = require('../services/catalogSearchService');

const valid = () => ({ categoryFamily: 'fashion', gender: 'female', ageGroup: '', productTypes: ['dress'], terms: ['linen'], confidence: 0.95 });
function fixture(overrides = {}) {
    const rows = new Map(), usage = new Map(), calls = [];
    const Cache = {
        findById: (key) => ({ maxTimeMS() { return this; }, lean: async () => rows.get(key) }),
        async findOneAndUpdate(filter, update) {
            const current = rows.get(filter._id);
            if (current && current.expiresAt > date && (current.state === 'ready' || current.leaseUntil > date)) throw Object.assign(new Error('duplicate'), { code: 11000 });
            const value = { _id: filter._id, ...update.$set }; rows.set(filter._id, value); return value;
        },
        async updateOne(filter, update) {
            const current = rows.get(filter._id);
            if (current?.leaseToken === filter.leaseToken) {
                Object.assign(current, update.$set);
                for (const key of Object.keys(update.$unset || {})) delete current[key];
            }
        },
    };
    const Usage = { async findOneAndUpdate(filter) {
        const used = usage.get(filter._id) || 0;
        if (used >= filter.used.$lt) throw Object.assign(new Error('duplicate'), { code: 11000 });
        usage.set(filter._id, used + 1); return { used: used + 1 };
    } };
    const date = new Date('2026-09-20T10:00:00Z');
    const env = { SMART_SEARCH_AI_ENABLED: 'true', GEMINI_API_KEY: 'test-not-a-secret', GEMINI_SEARCH_MODEL: 'configured-model', GEMINI_SEARCH_DAILY_LIMIT: '2', ...overrides };
    let output = valid(), failure = null;
    const http = { async post(...args) {
        calls.push(args); if (failure) throw failure;
        return { data: { candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] } };
    } };
    const service = createGeminiSearchService({ Cache, Usage, http, env, now: () => date });
    return { ...service, calls, rows, usage, env, setOutput: (value) => output = value, fail: () => failure = new Error('provider unavailable') };
}

test('AI classification is disabled unless explicitly enabled with a bounded daily budget', async () => {
    for (const overrides of [{ SMART_SEARCH_AI_ENABLED: 'false' }, { GEMINI_API_KEY: '' }, { GEMINI_SEARCH_DAILY_LIMIT: '' }, { GEMINI_SEARCH_DAILY_LIMIT: '-1' }]) {
        const f = fixture(overrides);
        assert.equal(await f.interpret({ query: 'ladys linen frock', actorKey: 'test-ip' }), null);
        assert.equal(f.calls.length, 0);
    }
});
test('strict schema rejects invented fields, unsafe taxonomy and uncertain interpretations', () => {
    for (const invalid of [{ ...valid(), price: 10 }, { ...valid(), categoryFamily: 'unlisted' }, { ...valid(), confidence: NaN },
        { ...valid(), confidence: 0.6 }, { ...valid(), terms: [{ $ne: null }] }, { ...valid(), productTypes: ['anything'] }]) assert.equal(validateIntent(invalid), null);
    assert.equal(preservesIdentifiers('iphone 15 pro 256gb', { terms: ['iphone', 'pro'] }), false);
    assert.equal(preservesIdentifiers('iphone 15 pro 256gb', { terms: ['iphone', '15', 'pro', '256gb'] }), true);
});
test('classification uses the configured model, enum JSON format and bounded provider timeout; cached queries do not spend again', async () => {
    const f = fixture();
    const result = await f.interpret({ query: 'ladys linen frock', actorKey: 'test-ip' });
    assert.equal(result.gender, 'female');
    assert.equal(result.ageGroup, null);
    assert.match(f.calls[0][0], /configured-model:generateContent$/);
    assert.equal(f.calls[0][1].generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
    assert.equal(f.calls[0][2].timeout, 6000);
    assert.equal(f.calls[0][2].headers['x-goog-api-key'], 'test-not-a-secret');
    assert.deepEqual(await f.interpret({ query: 'ladys linen frock', actorKey: 'second-ip' }), result);
    assert.equal(f.calls.length, 1);
    assert.equal([...f.rows.keys()].some((key) => key.includes('linen')), false);
    assert.equal([...f.usage.keys()].some((key) => key.includes('test-ip')), false);
});
test('lost numeric/model constraints are rejected rather than broadened into unrelated inventory', async () => {
    const f = fixture();
    assert.equal(await f.interpret({ query: 'linen dress size 12', actorKey: 'test-ip' }), null);
});
test('provider failure falls back and releases the cache lease without exposing provider errors', async () => {
    const f = fixture(); f.fail();
    assert.equal(await f.interpret({ query: 'linen frock', actorKey: 'test-ip' }), null);
    assert.equal([...f.rows.values()][0].state, 'ready');
    assert.equal([...f.rows.values()][0].leaseToken, undefined);
    assert.equal(await f.interpret({ query: 'linen frock', actorKey: 'test-ip' }), null);
    assert.equal(f.calls.length, 1);
});
test('global and actor budgets limit uncached provider work', async () => {
    const f = fixture({ GEMINI_SEARCH_USER_DAILY_LIMIT: '1' });
    await f.interpret({ query: 'linen frock', actorKey: 'first' });
    assert.equal(await f.interpret({ query: 'cotton frock', actorKey: 'first' }), null);
    await f.interpret({ query: 'silk frock', actorKey: 'second' });
    assert.equal(await f.interpret({ query: 'red frock', actorKey: 'third' }), null);
    assert.equal(f.calls.length, 2);
});
test('concurrent identical queries claim one provider request', async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => f.interpret({ query: 'linen frock', actorKey: 'first' })));
    assert.equal(f.calls.length, 1);
    assert.ok(results.some(Boolean));
});
test('AI cannot override known audience, View All or explicit age controls', () => {
    const input = parseSearchInput({ q: 'female clothes', productType: 'all', ageGroup: 'all', maxPrice: '50000' });
    const merged = mergeInterpretedIntent(input, { ...valid(), gender: 'male', ageGroup: 'child' });
    assert.equal(merged.gender, 'female');
    assert.equal(merged.ageGroup, null);
    assert.deepEqual(merged.productTypes, []);
    assert.equal(input.maxPrice, 50000);
});

function catalogFixture(totals) {
    const pipelines = [], calls = [];
    const Product = {
        aggregate(pipeline) { pipelines.push(pipeline); return { option: async () => [{ products: [], totals: [{ count: totals.shift() || 0 }], types: [] }] }; },
        populate: async (items) => items,
    };
    const User = { find() { return { select() { return this; }, limit() { return this; }, maxTimeMS() { return this; }, lean: async () => [] }; } };
    const service = createCatalogSearchService({ Product, ProductOffer: { collection: { name: 'offers' } }, User,
        enrichProducts: async (items) => items, categoryFilter: (category) => ({ category }), vendorPopulateFields: '',
        aiSearch: { interpret: async (input) => { calls.push(input); return validateIntent(valid()); } } });
    return { ...service, pipelines, calls };
}
test('catalog results and explicit AI opt-out never call Gemini', async () => {
    const matches = catalogFixture([5]);
    assert.equal((await matches.search({ q: 'dress' }, { actorKey: 'ip' })).total, 5);
    assert.equal(matches.calls.length, 0);
    const optedOut = catalogFixture([0]);
    await optedOut.search({ q: 'frock', ai: 'false' }, { actorKey: 'ip' });
    assert.equal(optedOut.calls.length, 0);
});
test('zero-result interpretation reuses publication, seller, budget and stock filters', async () => {
    const f = catalogFixture([0, 2]);
    const result = await f.search({ q: 'linen frock', vendor: 'aaaaaaaaaaaaaaaaaaaaaaaa', maxPrice: '50000', inStock: 'true' }, { actorKey: 'ip' });
    assert.equal(result.interpretation, 'gemini_intent');
    assert.equal(result.total, 2);
    assert.equal(f.pipelines.length, 2);
    for (const pipeline of f.pipelines) {
        assert.equal(pipeline[0].$match.moderationStatus, 'approved');
        assert.equal(String(pipeline[0].$match.vendor), 'aaaaaaaaaaaaaaaaaaaaaaaa');
        assert.deepEqual(pipeline.find((stage) => stage.$match?.__searchPrice).$match.__searchPrice, { $lte: 50000 });
        assert.ok(pipeline.find((stage) => stage.$match?.__searchStock));
    }
});
