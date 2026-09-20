const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ATLAS_TEST_HOST, ATLAS_TEST_DATABASE, resolveTestDatabase,
    assertOwnedCollections, cleanupTestCollections, supportsTransactions,
} = require('../scripts/lib/integrationTestDatabase');

// Deliberately fictitious credentials. These tests never connect to a server.
const runId = 'a'.repeat(32);
const atlasUri = `mongodb+srv://test-user:fake-password@${ATLAS_TEST_HOST}/?appName=naijago-testing`;
const resolveAtlas = (uri = atlasUri, extra = {}) => resolveTestDatabase({ uri, allowAtlas: true, runId, ...extra });

test('Atlas test target requires explicit opt-in and the exact approved SRV host', () => {
    assert.throws(() => resolveTestDatabase({ uri: atlasUri }));
    for (const host of ['production.mongodb.net', `${ATLAS_TEST_HOST}.example.com`, 'localhost']) {
        assert.throws(() => resolveAtlas(atlasUri.replace(ATLAS_TEST_HOST, host)));
    }
    assert.throws(() => resolveAtlas(atlasUri.replace('mongodb+srv:', 'mongodb:')));
    assert.throws(() => resolveAtlas(atlasUri.replace(ATLAS_TEST_HOST, `${ATLAS_TEST_HOST}:27017`)));
});

test('Atlas test database and secure options are fixed; unsafe overrides are rejected', () => {
    const target = resolveAtlas();
    const parsed = new URL(target.uri);
    assert.equal(target.kind, 'atlas-test');
    assert.equal(target.dbName, ATLAS_TEST_DATABASE);
    assert.equal(parsed.pathname, `/${ATLAS_TEST_DATABASE}`);
    assert.deepEqual(Object.fromEntries(parsed.searchParams), {
        retryWrites: 'true', w: 'majority', authSource: 'admin', appName: 'NaijaGoIntegrationTests',
    });
    assert.equal(resolveAtlas(atlasUri.replace('/?', `/${ATLAS_TEST_DATABASE}?`)).dbName, ATLAS_TEST_DATABASE);
    for (const path of ['naijago_db', 'admin', 'other_tests']) {
        assert.throws(() => resolveAtlas(atlasUri.replace('/?', `/${path}?`)));
    }
    for (const query of ['tls=false', 'tlsAllowInvalidCertificates=true', 'authSource=naijago_db',
        'retryWrites=false', 'w=0', 'directConnection=true', 'appName=duplicate', 'unknown=true']) {
        assert.throws(() => resolveAtlas(`${atlasUri}&${query}`));
    }
    assert.throws(() => resolveAtlas(`${atlasUri}#fragment`));
});

test('credential placeholders are rejected and validation errors never echo credentials', () => {
    for (const credentials of ['test-user:<db_password>', 'test-user:', ':fake-password',
        'test-user:%3Cdb_password%3E', 'test-user:%00bad', 'test-user:%zz']) {
        assert.throws(() => resolveAtlas(`mongodb+srv://${credentials}@${ATLAS_TEST_HOST}/`),
            (error) => !error.message.includes(credentials) && error.message.includes('Unsafe test database'));
    }
    const target = resolveAtlas(`mongodb+srv://test-user:p%40ss%3Aword%2Ftest%25@${ATLAS_TEST_HOST}/`);
    assert.equal(decodeURIComponent(new URL(target.uri).password), 'p@ss:word/test%');
});

test('loopback replica-set tests stay supported with a generated isolated database', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
        const target = resolveTestDatabase({ uri: `mongodb://${host}:27018/?replicaSet=rs0&directConnection=true`, runId });
        assert.equal(target.kind, 'loopback');
        assert.equal(target.dbName, `naijago_test_${runId}`);
    }
    for (const uri of ['mongodb://remote.example:27017/', 'mongodb://user:fake@localhost/',
        'mongodb://localhost/naijago_db', 'mongodb://localhost/?directConnection=false',
        'mongodb://localhost/?tlsAllowInvalidCertificates=true', 'https://localhost/']) {
        assert.throws(() => resolveTestDatabase({ uri, runId }));
    }
});

test('malformed inputs and duplicate query keys fail closed', () => {
    for (const uri of [undefined, null, {}, '', 'not a URI', 'x'.repeat(4097),
        `${atlasUri}&w=majority&w=majority`, 'mongodb://localhost/?replicaSet=a&replicaSet=b']) {
        assert.throws(() => resolveAtlas(uri, { uri }));
    }
    for (const id of ['', 'old_run', '../collection', 'a'.repeat(31), 'z'.repeat(32)]) {
        assert.throws(() => resolveAtlas(atlasUri, { runId: id }));
    }
});

test('each run gets unique collection names and immutable cleanup boundaries', () => {
    const target = resolveAtlas();
    const another = resolveAtlas(atlasUri, { runId: 'b'.repeat(32) });
    assert.equal(Object.keys(target.collections).length, 11);
    assert.equal(Object.isFrozen(target), true);
    assert.equal(Object.isFrozen(target.collections), true);
    for (const [model, name] of Object.entries(target.collections)) {
        assert.match(name, /^ngtest_[a-f0-9]{32}_[a-z]+$/);
        assert.notEqual(name, another.collections[model]);
    }
    assert.notEqual(resolveTestDatabase({ uri: 'mongodb://localhost/' }).runId,
        resolveTestDatabase({ uri: 'mongodb://localhost/' }).runId);
});

test('cleanup refuses other databases, existing application collections and other runs', () => {
    const target = resolveAtlas();
    const names = Object.values(target.collections);
    assert.doesNotThrow(() => assertOwnedCollections(target, target.dbName, names));
    assert.doesNotThrow(() => assertOwnedCollections(target, target.dbName, []));
    assert.throws(() => assertOwnedCollections(target, 'naijago_db', names));
    for (const unsafe of [['products'], [`ngtest_${runId}_unregistered`],
        [resolveAtlas(atlasUri, { runId: 'b'.repeat(32) }).collections.BackgroundJob],
        [names[0], names[0]], ['*'], null]) {
        assert.throws(() => assertOwnedCollections(target, target.dbName, unsafe));
    }
});

test('cleanup validates the entire deletion set before dropping any collection', async () => {
    const target = resolveAtlas(), dropped = [];
    const connection = { name: target.dbName, db: {
        collection: (name) => ({ drop: async () => dropped.push(name) }),
    } };
    await assert.rejects(cleanupTestCollections(connection, target, [target.collections.BackgroundJob, 'products']));
    assert.deepEqual(dropped, []);
    await assert.rejects(cleanupTestCollections({ ...connection, name: 'naijago_db' }, target,
        [target.collections.BackgroundJob]));
    assert.deepEqual(dropped, []);
    const owned = [target.collections.BackgroundJob, target.collections.FeedReaction];
    await cleanupTestCollections(connection, target, owned);
    assert.deepEqual(dropped, owned);
});

test('cleanup ignores only already-absent collections and reports other failures', async () => {
    const target = resolveAtlas(), owned = [target.collections.FeedComment];
    const connection = (code) => ({ name: target.dbName, db: { collection: () => ({
        drop: async () => { throw Object.assign(new Error('Simulated cleanup error'), { code }); },
    }) } });
    await cleanupTestCollections(connection(26), target, owned);
    await assert.rejects(cleanupTestCollections(connection(13), target, owned), { code: 13 });
});

test('transaction checks require a replica set or mongos and logical sessions', () => {
    assert.equal(supportsTransactions({ setName: 'rs0', logicalSessionTimeoutMinutes: 30 }), true);
    assert.equal(supportsTransactions({ msg: 'isdbgrid', logicalSessionTimeoutMinutes: 30 }), true);
    for (const hello of [null, {}, { setName: 'rs0' }, { logicalSessionTimeoutMinutes: 30 },
        { msg: 'isdbgrid', logicalSessionTimeoutMinutes: null }]) {
        assert.equal(supportsTransactions(hello), false);
    }
});
