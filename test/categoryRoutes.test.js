const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createCategoryRouter } = require('../routes/categoryRoutes');
for (const ready of [false, true, 'error']) test(`public read-only hierarchy works with readiness ${ready}`, async t => {
    const app = express(); app.use('/api/categories', createCategoryRouter({ readiness: async () => { if (ready === 'error') throw Error('offline'); return ready; } }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/api/categories`;
    const response = await fetch(url); const data = await response.json();
    assert.equal(response.status, 200); assert.equal(data.categories.length, 23); assert.equal(data.referencesReady, ready === true);
    assert.equal((await fetch(url, { method: 'POST' })).status, 404);
    for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal((await fetch(url, { method })).status, 404);
});
