const mongoose = require('mongoose');
const { resolveTestDatabase, supportsTransactions } = require('./lib/integrationTestDatabase');
const { testDatabaseDiagnostic } = require('./lib/testDatabaseDiagnostics');

async function checkTestDatabase({ uri, allowAtlas = false, MongoClient = mongoose.mongo.MongoClient } = {}) {
    let stage = 'configuration', client, result;
    try {
        const target = resolveTestDatabase({ uri, allowAtlas });
        stage = 'client setup';
        client = new MongoClient(target.uri, { serverSelectionTimeoutMS: 10000,
            maxPoolSize: 1, ...(target.kind === 'atlas-test' ? { tls: true } : {}) });
        stage = 'connection';
        await client.connect();
        stage = 'ping';
        await client.db(target.dbName).command({ ping: 1 });
        stage = 'topology';
        const hello = await client.db('admin').command({ hello: 1 });
        if (!supportsTransactions(hello)) throw Object.assign(new Error('Unsupported topology'), { code: 'NAIJAGO_TEST_TOPOLOGY' });
        result = { ok: true, host: target.host, dbName: target.dbName };
    } catch (error) {
        result = { ok: false, ...testDatabaseDiagnostic(error, stage) };
    } finally {
        if (client) {
            try { await client.close(); } catch (error) {
                if (result?.ok) result = { ok: false, ...testDatabaseDiagnostic(error, 'close') };
            }
        }
    }
    return result;
}

if (require.main === module) {
    checkTestDatabase({ uri: process.env.NAIJAGO_TEST_MONGO_URI,
        allowAtlas: process.env.NAIJAGO_ALLOW_ATLAS_TESTS === 'true' }).then((result) => {
        if (result.ok) {
            console.log('TEST_DATABASE_CONNECTION_OK');
            console.log(`Cluster: ${result.host}`);
            console.log(`Test database: ${result.dbName}`);
        } else {
            console.error(result.code);
            console.error(`Stage: ${result.stage}`);
            console.error(result.guidance);
            process.exitCode = 1;
        }
        console.log('Connection check only. No records were created, changed or deleted. Production settings were not changed.');
    }).catch(() => {
        console.error('TEST_DATABASE_UNKNOWN: Unexpected diagnostic failure. Do not share credentials.');
        process.exitCode = 1;
    });
}
module.exports = { checkTestDatabase };
