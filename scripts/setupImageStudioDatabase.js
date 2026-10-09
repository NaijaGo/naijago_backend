// Explicit operator rollout, never imported by web/worker startup.
// Default: metadata reads only. --apply requires the exact selected database name.
const { inspectFeatureReadiness } = require('../services/adminFeatureReadiness');

function definitions() {
  return [require('../models/ImageRefinement'), require('../models/BackgroundJob'), require('../models/AiUsageBucket')]
    .map(model => ({ name: model.collection.collectionName, indexes: model.schema.indexes().map(([key, options]) => ({
      key, ...(options.unique ? { unique: true } : {}),
      ...(options.expireAfterSeconds !== undefined ? { expireAfterSeconds: options.expireAfterSeconds } : {}),
    })) }));
}

async function setup({ db, apply = false, database } = {}) {
  if (apply && (!database || database !== db.databaseName)) {
    return { status: 'BLOCKED', reason: 'Apply requires --database matching the configured connection database.', writesAttempted: false };
  }
  const specs = definitions();
  const models = specs.map(spec => ({ collection: db.collection(spec.name), schema: { indexes: () =>
    spec.indexes.map(({ key, ...options }) => [key, options]) } }));
  const topology = await db.admin().command({ hello: 1 });
  const before = await inspectFeatureReadiness({ models });
  const report = { status: 'INSPECTED', mode: apply ? 'apply' : 'read-only', database: db.databaseName,
    transactionCapable: Boolean(topology.setName || topology.msg === 'isdbgrid'),
    transactionsExecuted: false, writesAttempted: false, before, plan: [] };
  if (!report.transactionCapable) return { ...report, status: 'BLOCKED', reason: 'A replica set or mongos is required.' };
  // Preflight every collection before making any metadata changes. Existing data
  // or conflicting index definitions require a separate manual rollout review.
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i], check = before.checks[i];
    if (check.status === 'ready') continue;
    if (check.status === 'collection_missing') {
      report.plan.push({ collection: spec.name, createCollection: true, indexes: spec.indexes });
      continue;
    }
    if (check.status !== 'missing_indexes') return { ...report, status: 'BLOCKED', reason: 'Collection metadata cannot be read. No changes attempted.' };
    const collection = db.collection(spec.name);
    if (await collection.countDocuments({}, { limit: 1 })) {
      return { ...report, status: 'BLOCKED', reason: 'A collection with missing indexes contains data. Manual rollout review required.' };
    }
    const actual = await collection.listIndexes().toArray();
    const indexes = check.missingIndexes.map(({ key, unique, ...options }) => ({ key, ...(unique ? { unique: true } : {}), ...options }));
    if (indexes.some(index => actual.some(existing => JSON.stringify(existing.key) === JSON.stringify(index.key)))) {
      return { ...report, status: 'BLOCKED', reason: 'An incompatible index exists. This command never drops or replaces indexes.' };
    }
    report.plan.push({ collection: spec.name, createCollection: false, indexes });
  }
  if (!apply) return report;
  for (const step of report.plan) {
    report.writesAttempted = true;
    if (step.createCollection) await db.createCollection(step.collection);
    await db.collection(step.collection).createIndexes(step.indexes);
  }
  report.after = await inspectFeatureReadiness({ models });
  report.status = report.after.ready ? 'READY' : 'BLOCKED';
  return report;
}

function argumentsFor(args) {
  let apply = false, database;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && !apply) apply = true;
    else if (args[i] === '--database' && !database && args[i + 1] && !args[i + 1].startsWith('--')) database = args[++i];
    else throw new Error('Invalid arguments');
  }
  if (apply && !database) throw new Error('Database confirmation required');
  return { apply, database };
}

async function main(args = process.argv.slice(2), env = process.env) {
  const options = argumentsFor(args);
  if (!env.MONGO_URI) throw new Error('MONGO_URI required');
  const { MongoClient } = require('mongoose').mongo;
  const client = new MongoClient(env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    // Never switch databases based on CLI input: it must confirm the existing URI.
    const report = await setup({ db: client.db(), ...options });
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'BLOCKED') process.exitCode = 1;
  } finally { await client.close(); }
}
if (require.main === module) {
  require('dotenv').config({ quiet: true });
  main().catch(() => {
    console.error('Image Studio setup failed or was refused. Usage: node scripts/setupImageStudioDatabase.js [--apply --database EXACT_DATABASE_NAME]. No credentials or raw database errors printed. Metadata changes may be partial; inspect before retrying.');
    process.exitCode = 1;
  });
}
module.exports = { setup, definitions, argumentsFor };
