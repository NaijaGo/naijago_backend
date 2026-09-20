const test = require('node:test');
const assert = require('node:assert/strict');
const { testDatabaseDiagnostic } = require('../scripts/lib/testDatabaseDiagnostics');
const { checkTestDatabase } = require('../scripts/checkTestDatabase');
const { ATLAS_TEST_HOST, ATLAS_TEST_DATABASE } = require('../scripts/lib/integrationTestDatabase');
const uri = `mongodb+srv://fake-user:fake-password@${ATLAS_TEST_HOST}/`;

test('database diagnostics identify known failures without returning raw provider data', () => {
    const cases = [
        [{ code: 18 }, 'AUTHENTICATION'], [{ code: 8000, message: 'bad auth : authentication failed' }, 'AUTHENTICATION'],
        [{ code: 13 }, 'PERMISSION'], [{ code: 'ENOTFOUND' }, 'DNS'],
        [{ message: 'querySrv ECONNREFUSED' }, 'DNS'], [{ code: 'CERT_HAS_EXPIRED' }, 'TLS'],
        [{ code: 'NAIJAGO_TEST_TOPOLOGY' }, 'TOPOLOGY'],
        [{ name: 'MongoServerSelectionError' }, 'NETWORK_OR_ACCESS'], [{ name: 'MongooseServerSelectionError' }, 'NETWORK_OR_ACCESS'],
        [{ code: 'ECONNRESET' }, 'NETWORK_OR_ACCESS'],
        [{ name: 'MongoParseError' }, 'CONFIGURATION'], [{ message: 'unexpected' }, 'UNKNOWN'],
    ];
    for (const [error, suffix] of cases) {
        const result = testDatabaseDiagnostic({ ...error, stack: uri, response: { secret: 'PRIVATE_MARKER' } }, 'connection');
        assert.equal(result.code, `TEST_DATABASE_${suffix}`);
        assert.equal(JSON.stringify(result).includes('fake-password'), false);
        assert.equal(JSON.stringify(result).includes('PRIVATE_MARKER'), false);
    }
    const raw = testDatabaseDiagnostic(new Error(uri), uri);
    assert.equal(raw.stage, 'unknown');
    assert.equal(JSON.stringify(raw).includes(uri), false);
    assert.equal(testDatabaseDiagnostic(new Error(uri), 'configuration').code, 'TEST_DATABASE_CONFIGURATION');
});

test('database diagnostics unwrap nested topology errors and tolerate cycles', () => {
    const error = { name: 'MongoServerSelectionError', reason: { servers: new Map([
        ['private-host', { error: { cause: { code: 18, message: uri } } }],
    ]) } };
    error.cause = error;
    assert.equal(testDatabaseDiagnostic(error, 'connection').code, 'TEST_DATABASE_AUTHENTICATION');
});

function mockClient({ failAt, error, hello = { setName: 'test-rs', logicalSessionTimeoutMinutes: 30 }, closeError } = {}) {
    const calls = [];
    class MongoClient {
        constructor(_uri, options) { assert.equal(options.tls, true); }
        async connect() { calls.push('connect'); if (failAt === 'connection') throw error; }
        db(dbName) { return { command: async (command) => {
            calls.push({ dbName, command });
            const stage = command.ping ? 'ping' : 'topology';
            if (failAt === stage) throw error;
            return command.ping ? { ok: 1 } : hello;
        } }; }
        async close() { calls.push('close'); if (closeError) throw closeError; }
    }
    return { MongoClient, calls };
}

test('connection checker issues only ping and hello then closes; never writes data', async () => {
    const { MongoClient, calls } = mockClient();
    assert.deepEqual(await checkTestDatabase({ uri, allowAtlas: true, MongoClient }),
        { ok: true, host: ATLAS_TEST_HOST, dbName: ATLAS_TEST_DATABASE });
    assert.deepEqual(calls, ['connect', { dbName: ATLAS_TEST_DATABASE, command: { ping: 1 } },
        { dbName: 'admin', command: { hello: 1 } }, 'close']);
});

test('connection checker returns precise safe stages and closes even on failure', async () => {
    for (const stage of ['connection', 'ping', 'topology']) {
        const { MongoClient, calls } = mockClient({ failAt: stage, error: { code: 13, message: uri }, closeError: new Error(uri) });
        const result = await checkTestDatabase({ uri, allowAtlas: true, MongoClient });
        assert.equal(result.ok, false);
        assert.equal(result.stage, stage);
        assert.equal(result.code, 'TEST_DATABASE_PERMISSION');
        assert.equal(JSON.stringify(result).includes('fake-password'), false);
        assert.equal(calls.at(-1), 'close');
    }
});

test('invalid configuration stops before any connection; unsupported topology is explicit', async () => {
    const { MongoClient, calls } = mockClient({ hello: { ok: 1 } });
    const rejected = await checkTestDatabase({ uri: 'mongodb+srv://fake:fake@production.example/', allowAtlas: true, MongoClient });
    assert.equal(rejected.code, 'TEST_DATABASE_CONFIGURATION');
    assert.deepEqual(calls, []);
    const standalone = await checkTestDatabase({ uri, allowAtlas: true, MongoClient });
    assert.equal(standalone.code, 'TEST_DATABASE_TOPOLOGY');
    assert.equal(calls.at(-1), 'close');
});

test('failure to close cannot be reported as a successful check', async () => {
    const { MongoClient } = mockClient({ closeError: new Error(uri) });
    const result = await checkTestDatabase({ uri, allowAtlas: true, MongoClient });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'close');
    assert.equal(JSON.stringify(result).includes('fake-password'), false);
});
