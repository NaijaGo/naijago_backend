// Invoked only by an explicit operator CLI/Admin action. Importing this module
// never provisions metadata or starts background work.
const { inspectFeatureReadiness } = require('./adminFeatureReadiness');

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
  // Review all three collections before any changes. Never remove indexes or data.
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

function createImageStudioInitializer({ getDatabase, provision = setup }) {
  let active;
  return () => {
    if (!active) active = Promise.resolve().then(() => {
      const db = getDatabase();
      if (!db) throw new Error('Image Studio database connection unavailable.');
      return provision({ db, apply: true, database: db.databaseName });
    }).finally(() => { active = undefined; });
    return active;
  };
}
module.exports = { setup, definitions, createImageStudioInitializer };
