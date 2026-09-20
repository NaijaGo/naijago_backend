const mongoose = require('mongoose');
const { resolveTestDatabase, supportsTransactions } = require('./lib/integrationTestDatabase');

async function main() {
    const target = resolveTestDatabase({ uri: process.env.NAIJAGO_TEST_MONGO_URI,
        allowAtlas: process.env.NAIJAGO_ALLOW_ATLAS_TESTS === 'true' });
    const client = new mongoose.mongo.MongoClient(target.uri, { serverSelectionTimeoutMS: 10000,
        maxPoolSize: 1, ...(target.kind === 'atlas-test' ? { tls: true } : {}) });
    try {
        await client.connect();
        await client.db(target.dbName).command({ ping: 1 });
        const hello = await client.db('admin').command({ hello: 1 });
        if (!supportsTransactions(hello)) throw new Error('Unsupported topology');
        console.log('TEST_DATABASE_CONNECTION_OK');
        console.log(`Cluster: ${target.host}`);
        console.log(`Test database: ${target.dbName}`);
        console.log('Connection checked only. No records were created, changed or deleted.');
    } finally { await client.close(); }
}
main().catch(() => {
    console.error('Test connection could not be verified. Check the TEST password, your current IP access, cluster readiness and internet connection. Production settings were not changed.');
    process.exitCode = 1;
});
