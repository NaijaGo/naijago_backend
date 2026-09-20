const crypto = require('node:crypto');

// This is the dedicated, user-confirmed TEST cluster, never the live cluster.
const ATLAS_TEST_HOST = 'naijago-testing.kwcvhix.mongodb.net';
const ATLAS_TEST_DATABASE = 'naijago_integration_tests';
const MODEL_COLLECTIONS = Object.freeze({ BackgroundJob: 'backgroundjobs', FeedReaction: 'feedreactions', FeedComment: 'feedcomments', FeedView: 'feedviews',
    Product: 'products', ProductOffer: 'productoffers', User: 'users', AiUsageBucket: 'aiusagebuckets', SearchIntentCache: 'searchintentcaches', ProductRequest: 'productrequests', ImageRefinement: 'imagerefinements',
    DeliveryWindow: 'deliverywindows', DeliveryReservation: 'deliveryreservations', GroupOrder: 'grouporders', RecurringPlan: 'recurringplans', RecurringOccurrence: 'recurringoccurrences',
    MainOrder: 'mainorders', Shipment: 'shipments', AppSetting: 'appsettings' });
const fail = () => { throw new Error('Unsafe test database configuration. Use the approved test cluster or a loopback replica set; never MONGO_URI.'); };

function resolveTestDatabase({ uri, allowAtlas = false, runId = crypto.randomUUID().replaceAll('-', '') }) {
    if (typeof uri !== 'string' || uri.length > 4096 || !/^[a-f0-9]{32}$/.test(runId)) fail();
    let parsed;
    try { parsed = new URL(uri); } catch (_) { fail(); }
    if (parsed.hash) fail();
    const keys = [...parsed.searchParams.keys()];
    if (new Set(keys).size !== keys.length) fail();
    let dbName, kind;
    if (parsed.protocol === 'mongodb+srv:') {
        if (!allowAtlas || parsed.hostname !== ATLAS_TEST_HOST || parsed.port || !parsed.username || !parsed.password) fail();
        if (!['', '/', `/${ATLAS_TEST_DATABASE}`].includes(parsed.pathname)) fail();
        const allowed = new Set(['appName', 'retryWrites', 'w', 'authSource']);
        if (keys.some((key) => !allowed.has(key))) fail();
        if (parsed.searchParams.has('retryWrites') && parsed.searchParams.get('retryWrites') !== 'true') fail();
        if (parsed.searchParams.has('w') && parsed.searchParams.get('w') !== 'majority') fail();
        if (parsed.searchParams.has('authSource') && parsed.searchParams.get('authSource') !== 'admin') fail();
        try {
            if ([parsed.username, parsed.password].some((part) => /[<>\u0000-\u001f]/.test(decodeURIComponent(part)))) fail();
        } catch (_) { fail(); }
        parsed.pathname = `/${ATLAS_TEST_DATABASE}`;
        parsed.search = '';
        parsed.searchParams.set('retryWrites', 'true');
        parsed.searchParams.set('w', 'majority');
        parsed.searchParams.set('authSource', 'admin');
        parsed.searchParams.set('appName', 'NaijaGoIntegrationTests');
        dbName = ATLAS_TEST_DATABASE; kind = 'atlas-test';
    } else if (parsed.protocol === 'mongodb:') {
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password || !['', '/'].includes(parsed.pathname)) fail();
        if (keys.some((key) => !['replicaSet', 'directConnection'].includes(key))) fail();
        if (parsed.searchParams.has('directConnection') && parsed.searchParams.get('directConnection') !== 'true') fail();
        dbName = `naijago_test_${runId}`; kind = 'loopback';
    } else { fail(); }
    const collections = Object.freeze(Object.fromEntries(Object.entries(MODEL_COLLECTIONS)
        .map(([model, suffix]) => [model, `ngtest_${runId}_${suffix}`])));
    return Object.freeze({ uri: parsed.href, host: parsed.hostname, dbName, kind, runId, collections });
}

function assertOwnedCollections(target, databaseName, names) {
    if (databaseName !== target.dbName || !Array.isArray(names) || new Set(names).size !== names.length) fail();
    const allowed = new Set(Object.values(target.collections));
    if (names.some((name) => !allowed.has(name) || !name.startsWith(`ngtest_${target.runId}_`))) fail();
}

async function cleanupTestCollections(connection, target, names) {
    // Validate the complete deletion set before deleting anything. No wildcard,
    // dropDatabase, production collection name or previous test run is accepted.
    assertOwnedCollections(target, connection.name, names);
    for (const name of names) {
        try { await connection.db.collection(name).drop(); }
        catch (error) { if (error.code !== 26) throw error; }
    }
}
function supportsTransactions(hello) {
    return Boolean(hello && (hello.setName || hello.msg === 'isdbgrid') && hello.logicalSessionTimeoutMinutes != null);
}
module.exports = { ATLAS_TEST_HOST, ATLAS_TEST_DATABASE, MODEL_COLLECTIONS, resolveTestDatabase, assertOwnedCollections, cleanupTestCollections, supportsTransactions };
