// Inspect only: index creation belongs to a separately reviewed database rollout.
async function inspectFeatureReadiness({ models }) {
  const checks = [];
  for (const model of models) {
    const collection = model.collection.collectionName || model.collection.name;
    try {
      const actual = await model.collection.listIndexes().toArray();
      const missingIndexes = model.schema.indexes().filter(([fields, options]) =>
        !actual.some(index => JSON.stringify(index.key) === JSON.stringify(fields)
            && Boolean(index.unique) === Boolean(options.unique)
            && !index.sparse && !index.partialFilterExpression
            && (options.expireAfterSeconds === undefined || index.expireAfterSeconds === options.expireAfterSeconds)))
        .map(([key, options]) => ({ key, unique: Boolean(options.unique),
          ...(options.expireAfterSeconds !== undefined ? { expireAfterSeconds: options.expireAfterSeconds } : {}) }));
      checks.push({ collection, status: missingIndexes.length ? 'missing_indexes' : 'ready', missingIndexes });
    } catch (error) {
      checks.push({ collection, status: error.code === 26 ? 'collection_missing'
        : error.code === 13 ? 'read_permission_missing' : 'database_read_unavailable' });
    }
  }
  return { ready: checks.every(check => check.status === 'ready'), checks };
}
function createFeatureReadiness({ models }) {
  return async function ready() {
    return (await inspectFeatureReadiness({ models })).ready;
  };
}
module.exports = { createFeatureReadiness, inspectFeatureReadiness };
