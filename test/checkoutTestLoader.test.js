'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCheckoutForTests } = require('../scripts/lib/loadCheckoutForTests');
const names = ['MainOrder', 'Shipment', 'Product', 'ProductOffer', 'User', 'AppSetting'];

test('isolated checkout loader rejects missing or mixed-connection models before loading route code', () => {
    const connection = {}, models = Object.fromEntries(names.map((name) => [name, { db: connection }]));
    assert.throws(() => loadCheckoutForTests({ models: {}, connection }), /isolated connection/);
    assert.throws(() => loadCheckoutForTests({ models: { ...models, MainOrder: { db: {} } }, connection }), /isolated connection/);
});

test('isolated checkout loader exposes only helpers and never connects, starts transactions or providers on import', async () => {
    let sessions = 0;
    const connection = { startSession() { sessions++; throw new Error('must not start'); } };
    const models = Object.fromEntries(names.map((name) => [name, { db: connection }]));
    const helpers = loadCheckoutForTests({ models, connection });
    assert.deepEqual(Object.keys(helpers).sort(), ['calculateCheckoutSummary', 'createUnpaidOrder']);
    assert.equal(sessions, 0);
    await assert.rejects(helpers.createUnpaidOrder({ input: {}, userId: '111111111111111111111111' }), { code: 'TRANSACTION_REQUIRED' });
    assert.equal(sessions, 0);
});
