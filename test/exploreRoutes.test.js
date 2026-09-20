const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createExploreRouter } = require('../routes/exploreRoutes');
const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const commentId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
async function server(t, overrides = {}) {
    const calls = [];
    const app = express(); app.use(express.json());
    app.use('/api/explore', createExploreRouter({
        explore: { feed: async (args) => { calls.push(args); return { items: [], campaigns: [] }; } }, interactions: {},
        FeedComment: { updateOne: async (filter) => { calls.push(filter); return { matchedCount: 0 }; } },
        FeedReport: {}, UserBlock: {}, User: {}, Product: {}, CarouselSlide: {},
        authenticate: (req, res, next) => {
            if (!req.headers.authorization) return res.status(401).json({ message: 'Sign in.' });
            req.user = { _id: userId, constructor: { modelName: req.headers.authorization === 'rider' ? 'Rider' : 'User' } }; next();
        },
        admin: (_req, res) => res.status(403).json({ message: 'Admins only.' }),
        vendor: (_req, res) => res.status(403).json({ message: 'Vendors only.' }), enabled: () => true, ...overrides,
    }));
    const listener = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => listener.once('listening', resolve));
    t.after(() => { listener.closeAllConnections(); return new Promise((resolve) => listener.close(resolve)); });
    return { calls, request: (path, options = {}) => fetch(`http://127.0.0.1:${listener.address().port}/api/explore/${path}`, options) };
}
test('configuration is public, feed requires a customer/vendor account', async (t) => {
    const { request } = await server(t);
    assert.equal((await request('config')).status, 200);
    assert.equal((await request('feed')).status, 401);
    assert.equal((await request('feed', { headers: { authorization: 'rider' } })).status, 403);
    assert.equal((await request('feed', { headers: { authorization: 'customer' } })).status, 200);
});
test('disabled Explore never reaches database handlers', async (t) => {
    const { request, calls } = await server(t, { enabled: () => false });
    assert.equal((await request('feed', { headers: { authorization: 'customer' } })).status, 503);
    assert.equal(calls.length, 0);
});

test('missing uniqueness indexes hide Explore and reject writes and reads before handlers', async (t) => {
    const { request, calls } = await server(t, { ready: async () => false });
    assert.equal((await (await request('config')).json()).enabled, false);
    assert.equal((await request('feed', { headers: { authorization: 'customer' } })).status, 503);
    assert.equal(calls.length, 0);
});
test('comment deletion is scoped to the authenticated author, not a supplied user ID', async (t) => {
    const { request, calls } = await server(t);
    const response = await request(`comments/${commentId}`, { method: 'DELETE', headers: { authorization: 'customer' } });
    assert.equal(response.status, 404);
    assert.deepEqual(calls[0], { _id: commentId, user: userId, state: { $ne: 'deleted' } });
});
test('customer accounts cannot open admin reports or vendor activity', async (t) => {
    const { request } = await server(t);
    for (const path of ['admin/reports', 'vendor/activity']) assert.equal((await request(path, { headers: { authorization: 'customer' } })).status, 403);
});
test('provider and database errors do not leak to the app', async (t) => {
    const { request } = await server(t, { explore: { feed: async () => { throw new Error('secret-provider-credential'); } } });
    const response = await request('feed', { headers: { authorization: 'customer' } });
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes('secret-provider-credential'), false);
});
