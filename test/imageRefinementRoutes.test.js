const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createImageRefinementRouter } = require('../routes/imageRefinementRoutes');
const actor = 'aaaaaaaaaaaaaaaaaaaaaaaa';
async function server(t, overrides = {}) {
    const calls = [], app = express(); app.use(express.json());
    const service = { enabled: () => true, processingEnabled: () => true, list: async () => ({ images: [] }),
        requestBatch: async (args) => { calls.push(args); return { results: [] }; }, review: async (args) => { calls.push(args); return {}; }, ...overrides.service };
    app.use('/images', createImageRefinementRouter({ service, ready: overrides.ready,
        authenticate: (req, res, next) => { if (!req.headers.authorization) return res.sendStatus(401); req.user = { _id: actor }; next(); },
        admin: (req, res, next) => req.headers.authorization === 'admin' ? next() : res.sendStatus(403) }));
    const listener = app.listen(0, '127.0.0.1'); await new Promise((resolve) => listener.once('listening', resolve));
    t.after(() => { listener.closeAllConnections(); return new Promise((resolve) => listener.close(resolve)); });
    const request = (path, options = {}) => fetch(`http://127.0.0.1:${listener.address().port}/images${path}`, options);
    const post = (body) => request('/batch', { method: 'POST', headers: { authorization: 'admin', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { calls, request, post };
}
test('image review including configuration is admin-only and never trusts a supplied actor', async (t) => {
    const { calls, request, post } = await server(t);
    assert.equal((await request('/config')).status, 401);
    assert.equal((await request('/', { headers: { authorization: 'vendor' } })).status, 403);
    const response = await post({ productIds: [actor], rightsConfirmed: true, actor: 'forged' });
    assert.equal(response.status, 202); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(calls[0].actor, actor);
});
test('batch image processing requires permission and a bounded list of valid product ids', async (t) => {
    const { calls, post } = await server(t);
    for (const input of [{ productIds: [] }, { productIds: [actor] }, { productIds: ['invalid'], rightsConfirmed: true }, { productIds: Array(21).fill(actor), rightsConfirmed: true }]) {
        assert.equal((await post(input)).status, 400);
    }
    assert.equal(calls.length, 0);
});
test('disabled feature or missing indexes blocks writes without leaking raw provider errors', async (t) => {
    for (const options of [{ service: { enabled: () => false } }, { ready: async () => false }, { service: { requestBatch: async () => { throw new Error('synthetic-secret-token'); } } }]) {
        const { post } = await server(t, options); const response = await post({ productIds: [actor], rightsConfirmed: true });
        assert.equal(response.status, 503); assert.equal((await response.text()).includes('synthetic-secret-token'), false);
    }
});
