// Explicit setup only. Importing this module never connects to a database.
const taxonomy = require('../services/catalogTaxonomyService');
async function initializeCatalogTaxonomy({ collection, records = taxonomy.databaseRecords(), apply = false }) {
    const existing = await collection.find({}).toArray();
    const expected = new Map(records.map(row => [String(row._id), row]));
    for (const row of existing) {
        const target = expected.get(String(row._id));
        if (!target || ['key', 'label', 'sortOrder', 'taxonomyVersion'].some(key => row[key] !== target[key]) || String(row.parentId || '') !== String(target.parentId || '')) throw new Error('Existing category records conflict with the manifest. No setup writes were started.');
    }
    const ids = new Set(existing.map(row => String(row._id)));
    const missing = records.filter(row => !ids.has(String(row._id)));
    if (apply) {
        // Create the uniqueness guard before inserting records. Never sync/drop indexes.
        await collection.createIndex({ key: 1 }, { unique: true });
        await collection.createIndex({ parentId: 1, sortOrder: 1 });
        for (const row of missing) await collection.updateOne({ _id: row._id }, { $setOnInsert: row }, { upsert: true });
        if (!taxonomy.recordsMatch(await collection.find({}).toArray())) throw new Error('Category setup verification failed; leave reference writes disabled.');
    }
    return { mode: apply ? 'apply' : 'dry-run', existing: existing.length, missing: missing.length };
}
async function main() {
    const args = process.argv.slice(2);
    const dbName = args.find(arg => arg.startsWith('--database='))?.slice(11);
    const uri = process.env.CATEGORY_SETUP_MONGO_URI;
    if (!uri || !dbName || !/^[a-zA-Z0-9_-]+$/.test(dbName)) throw new Error('Provide CATEGORY_SETUP_MONGO_URI and --database=<explicit database>. MONGO_URI/.env are never used.');
    const apply = args.includes('--apply');
    if (apply && !args.includes(`--confirm-database=${dbName}`)) throw new Error('Apply requires --confirm-database matching the explicit database.');
    const mongoose = require('mongoose');
    try {
        await mongoose.connect(uri, { dbName, autoCreate: false, autoIndex: false });
        const records = taxonomy.databaseRecords().map(row => ({ ...row, _id: new mongoose.Types.ObjectId(row._id), parentId: row.parentId ? new mongoose.Types.ObjectId(row.parentId) : null }));
        console.log(JSON.stringify(await initializeCatalogTaxonomy({ collection: mongoose.connection.db.collection('categories'), records, apply }), null, 2));
    } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(() => { console.error('Category setup failed. Inspect database identity, permissions and manifest conflicts; reference writes must remain disabled.'); process.exitCode = 1; });
module.exports = { initializeCatalogTaxonomy };
