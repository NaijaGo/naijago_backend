const test = require('node:test');
const assert = require('node:assert/strict');
const { createFeatureReadiness } = require('../services/featureReadiness');

test('concurrent requests wait for one non-destructive index initialization', async () => {
    let collections = 0, indexes = 0;
    const ready = createFeatureReadiness({ models: [{ createCollection: async () => collections++, createIndexes: async () => indexes++ }] });
    assert.deepEqual(await Promise.all([ready(), ready(), ready()]), [true, true, true]);
    assert.equal(collections, 1); assert.equal(indexes, 1);
    assert.equal(await ready(), true); assert.equal(indexes, 1);
});
test('failed index initialization fails closed and has a bounded retry cadence', async () => {
    let clock = 100000, attempts = 0, fails = true;
    const ready = createFeatureReadiness({ now: () => clock, models: [{ createCollection: async () => {}, createIndexes: async () => {
        attempts++; if (fails) throw new Error('index conflict');
    } }] });
    assert.equal(await ready(), false);
    assert.equal(await ready(), false); assert.equal(attempts, 1);
    clock += 30001; fails = false;
    assert.equal(await ready(), true); assert.equal(attempts, 2);
});
