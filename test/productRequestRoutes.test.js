const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createProductRequestRouter } = require('../routes/productRequestRoutes');
const owner = 'aaaaaaaaaaaaaaaaaaaaaaaa';
async function server(t, overrides = {}) {
    const calls = [], app = express(); app.use(express.json());
    const service = { enabled: () => true, previewEnabled: () => false,
        get: async (args) => { calls.push(args); return { id: args.requestId }; },
        list: async (args) => { calls.push(args); return { requests: [] }; }, create: async (args) => { calls.push(args); return { id: 'draft' }; }, ...overrides.service };
    app.use('/requests', createProductRequestRouter({ service, ready: overrides.ready,
        authenticate: (req, res, next) => { if (!req.headers.authorization) return res.sendStatus(401); req.user = { _id: owner, constructor: { modelName: req.headers.authorization === 'rider' ? 'Rider' : 'User' } }; next(); },
        admin: (req, res, next) => req.headers.authorization === 'admin' ? next() : res.sendStatus(403) }));
    const listener = app.listen(0, '127.0.0.1'); await new Promise((resolve) => listener.once('listening', resolve));
    t.after(() => { listener.closeAllConnections(); return new Promise((resolve) => listener.close(resolve)); });
    return { calls, request: (path, options = {}) => fetch(`http://127.0.0.1:${listener.address().port}/requests${path}`, options) };
}
test('requests enforce account authentication, admin authorization and server-owned identity', async (t) => {
    const { request, calls } = await server(t);
    assert.equal((await request('/config')).status, 200);
    assert.equal((await request('/')).status, 401);
    assert.equal((await request('/', { headers: { authorization: 'rider' } })).status, 403);
    assert.equal((await request('/admin', { headers: { authorization: 'customer' } })).status, 403);
    const response = await request('/?owner=forged&admin=true', { headers: { authorization: 'customer' } });
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(calls[0].owner, owner); assert.equal(calls[0].admin, undefined);
    await request('/admin?admin=false&owner=forged', { headers: { authorization: 'admin' } }); assert.equal(calls[1].admin, true); assert.equal(calls[1].owner, undefined);
});
test('disabled requests or unavailable indexes fail closed before database operations', async (t) => {
    for (const overrides of [{ service: { enabled: () => false } }, { ready: async () => false }]) {
        const { request, calls } = await server(t, overrides);
        assert.equal((await (await request('/config')).json()).enabled, false);
        assert.equal((await request('/', { headers: { authorization: 'customer' } })).status, 503); assert.equal(calls.length, 0);
    }
});
test('request routes never return raw database/provider exceptions', async (t) => {
    const { request } = await server(t, { service: { list: async () => { throw new Error('synthetic-secret-url'); } } });
    const response = await request('/', { headers: { authorization: 'customer' } }); assert.equal(response.status, 503);
    assert.equal((await response.text()).includes('synthetic-secret-url'), false);
});
