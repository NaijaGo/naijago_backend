const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAdminJobsRouter, SAFE_FIELDS } = require('../routes/adminJobRoutes');
const id = 'aaaaaaaaaaaaaaaaaaaaaaaa';
async function setup(t, Job = {}) {
    const app = express(); app.use(express.json());
    app.use('/jobs', createAdminJobsRouter({ Job,
        authenticate: (req, res, next) => {
            if (!req.headers.authorization) return res.sendStatus(401);
            req.user = { _id: id, role: req.headers.authorization }; next();
        },
        admin: (req, res, next) => req.user.role === 'admin' ? next() : res.sendStatus(403),
        now: () => new Date('2026-09-20T12:00:00Z'),
    }));
    const listener = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => listener.once('listening', resolve));
    t.after(() => { listener.closeAllConnections(); return new Promise((resolve) => listener.close(resolve)); });
    return (path = '', options = {}) => fetch(`http://127.0.0.1:${listener.address().port}/jobs${path}`, options);
}
const auth = { authorization: 'admin', 'content-type': 'application/json' };
test('job administration is authenticated and admin-only', async (t) => {
    const request = await setup(t);
    assert.equal((await request()).status, 401);
    assert.equal((await request('', { headers: { authorization: 'vendor' } })).status, 403);
});
test('job list excludes raw payload, result and provider identity', async (t) => {
    for (const name of ['payload', 'result', 'deliveryKey', 'lockToken', 'dedupeKey']) assert.equal(SAFE_FIELDS.split(' ').includes(name), false);
    const chain = { select(fields) { assert.equal(fields, SAFE_FIELDS); return this; }, sort() { return this; }, limit(size) { assert.equal(size, 26); return this; }, lean: async () => [] };
    const request = await setup(t, { find: () => chain });
    const response = await request('?state=failed', { headers: auth });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).jobs, []);
});
test('retry is conditional, audited and preserves provider deduplication identity', async (t) => {
    let args;
    const request = await setup(t, { findOneAndUpdate: (...values) => { args = values; return { select: () => ({ lean: async () => ({ _id: id, state: 'queued' }) }) }; } });
    const response = await request(`/${id}/retry`, { method: 'POST', headers: auth, body: JSON.stringify({ revision: 2, reason: 'Configured vendor push.' }) });
    assert.equal(response.status, 200);
    assert.equal(args[0].__v, 2);
    assert.equal(args[0].state, 'failed');
    assert.deepEqual(args[0].type.$in, ['explore.notify', 'media.cleanup', 'media.revoke']);
    assert.equal(args[0].createdAt.$gt.toISOString(), '2026-09-13T12:00:00.000Z');
    assert.equal(args[1].$inc.manualRetries, 1);
    assert.equal(args[1].$push.reviewHistory.actor, id);
    assert.equal(args[1].$set.deliveryKey, undefined);
    assert.equal(args[1].$set.createdAt, undefined);
});
test('stale or exhausted retries are rejected and never forced', async (t) => {
    const request = await setup(t, { findOneAndUpdate: () => ({ select: () => ({ lean: async () => null }) }) });
    assert.equal((await request(`/${id}/retry`, { method: 'POST', headers: auth, body: JSON.stringify({ revision: 0, reason: 'Check' }) })).status, 409);
    assert.equal((await request(`/${id}/retry`, { method: 'POST', headers: auth, body: JSON.stringify({ revision: 0, reason: '' }) })).status, 400);
});
