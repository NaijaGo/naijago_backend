const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { openIsolatedTestDatabase } = require('../scripts/lib/openIsolatedTestDatabase');
const { ATLAS_TEST_HOST, ATLAS_TEST_DATABASE } = require('../scripts/lib/integrationTestDatabase');

function harness(t, { exists = false, indexFailure = false, connectFailure = false } = {}) {
    const previousUri = process.env.NAIJAGO_TEST_MONGO_URI;
    const previousAllow = process.env.NAIJAGO_ALLOW_ATLAS_TESTS;
    process.env.NAIJAGO_TEST_MONGO_URI = 'mongodb+srv://fixture-user:synthetic-test-only@' + ATLAS_TEST_HOST;
    process.env.NAIJAGO_ALLOW_ATLAS_TESTS = 'true';
    t.after(() => {
        if (previousUri === undefined) delete process.env.NAIJAGO_TEST_MONGO_URI;
        else process.env.NAIJAGO_TEST_MONGO_URI = previousUri;
        if (previousAllow === undefined) delete process.env.NAIJAGO_ALLOW_ATLAS_TESTS;
        else process.env.NAIJAGO_ALLOW_ATLAS_TESTS = previousAllow;
    });
    const events = [], hooks = [], names = [];
    const connection = {
        name: ATLAS_TEST_DATABASE,
        async asPromise() { if (connectFailure) throw new Error('synthetic-test-only must not be echoed'); return this; },
        async close() { events.push('close'); },
        db: {
            admin: () => ({ command: async () => ({ setName: 'isolated-rs', logicalSessionTimeoutMinutes: 30 }) }),
            listCollections: () => ({ hasNext: async () => exists }),
            collection: (name) => ({ drop: async () => events.push('drop:' + name) }),
        },
        model(name, schema, collection) {
            assert.equal(schema.get('autoCreate'), false);
            assert.equal(schema.get('autoIndex'), false);
            names.push(collection);
            return { async createCollection() { events.push('create:' + collection); },
                async createIndexes() { if (indexFailure) throw new Error('injected index failure'); } };
        },
    };
    const connect = t.mock.method(mongoose, 'createConnection', (uri, options) => {
        events.push('connect');
        assert.equal(options.dbName, ATLAS_TEST_DATABASE); assert.equal(options.tls, true);
        assert.equal(options.autoCreate, false); assert.equal(options.autoIndex, false);
        return connection;
    });
    t.mock.method(console, 'log', () => {});
    return { events, hooks, names, connect, context: { after: (hook) => hooks.push(hook) } };
}

test('isolated search harness rejects unregistered/duplicate models before opening a connection', async (t) => {
    const f = harness(t);
    for (const names of [[], ['Unregistered'], ['User', 'User']]) {
        await assert.rejects(openIsolatedTestDatabase(f.context, names), /Unregistered isolated test models/);
    }
    assert.equal(f.connect.mock.callCount(), 0);
});
test('isolated search harness sanitizes connection errors and closes failed connections', async (t) => {
    const f = harness(t, { connectFailure: true });
    await assert.rejects(openIsolatedTestDatabase(f.context, ['User']), (error) => {
        assert.match(error.message, /Isolated TEST database connection failed/);
        assert.doesNotMatch(error.message, /synthetic-test-only|mongodb/); return true;
    });
    assert.deepEqual(f.events, ['connect', 'close']);
});
test('isolated search harness creates/indexes only requested models and cleans only owned collections', async (t) => {
    const f = harness(t);
    const result = await openIsolatedTestDatabase(f.context, ['User', 'Product']);
    assert.deepEqual(Object.keys(result.models), ['User', 'Product']);
    assert.equal(f.names.length, 2);
    assert.ok(f.names.every((name) => name.startsWith('ngtest_' + result.target.runId + '_')));
    await f.hooks[0]();
    assert.deepEqual(f.events.filter((event) => event.startsWith('drop:')), f.names.map((name) => 'drop:' + name));
    assert.equal(f.events.at(-1), 'close');
});
test('isolated search harness never cleans an existing collection it refused to own', async (t) => {
    const f = harness(t, { exists: true });
    await assert.rejects(openIsolatedTestDatabase(f.context, ['User']), /Refusing to reuse/);
    await f.hooks[0]();
    assert.deepEqual(f.events, ['connect', 'close']);
});
test('isolated search harness cleans a created collection if index setup fails', async (t) => {
    const f = harness(t, { indexFailure: true });
    await assert.rejects(openIsolatedTestDatabase(f.context, ['User', 'Product']), /injected index failure/);
    await f.hooks[0]();
    assert.equal(f.names.length, 1);
    assert.deepEqual(f.events.filter((event) => event.startsWith('drop:')), ['drop:' + f.names[0]]);
    assert.equal(f.events.at(-1), 'close');
});
