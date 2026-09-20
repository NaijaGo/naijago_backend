const mongoose = require('mongoose');
const { resolveTestDatabase, cleanupTestCollections, supportsTransactions } = require('./integrationTestDatabase');

async function openIsolatedTestDatabase(t, modelNames) {
    const target = resolveTestDatabase({ uri: process.env.NAIJAGO_TEST_MONGO_URI,
        allowAtlas: process.env.NAIJAGO_ALLOW_ATLAS_TESTS === 'true' });
    if (!Array.isArray(modelNames) || !modelNames.length || new Set(modelNames).size !== modelNames.length ||
        modelNames.some((name) => !Object.hasOwn(target.collections, name))) throw new Error('Unregistered isolated test models.');
    let connection;
    try {
        connection = mongoose.createConnection(target.uri, { dbName: target.dbName, serverSelectionTimeoutMS: 10000,
            maxPoolSize: 20, autoCreate: false, autoIndex: false, ...(target.kind === 'atlas-test' ? { tls: true } : {}) });
        await connection.asPromise();
    } catch (_) {
        if (connection) await connection.close().catch(() => {});
        throw new Error('Isolated TEST database connection failed. Check test credentials and current IP access; do not share credentials.');
    }
    const owned = [];
    t.after(async () => {
        try { await cleanupTestCollections(connection, target, owned); }
        finally { await connection.close(); }
    });
    if (!supportsTransactions(await connection.db.admin().command({ hello: 1 }))) throw new Error('Test cluster must support sessions/transactions.');
    console.log('Isolated test run: ' + target.host + ' / ' + target.dbName + ' / ' + target.runId);
    const models = {};
    for (const name of modelNames) {
        const collection = target.collections[name];
        if (await connection.db.listCollections({ name: collection }, { nameOnly: true }).hasNext()) throw new Error('Refusing to reuse an existing test collection.');
        const schema = require('../../models/' + name).schema.clone();
        schema.set('autoCreate', false); schema.set('autoIndex', false);
        models[name] = connection.model(name, schema, collection);
        await models[name].createCollection();
        owned.push(collection);
        await models[name].createIndexes();
    }
    return { connection, target, models };
}

module.exports = { openIsolatedTestDatabase };
