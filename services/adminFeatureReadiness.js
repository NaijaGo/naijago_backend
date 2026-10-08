// Inspect only: index creation belongs to a separately reviewed database rollout.
function createFeatureReadiness({ models }) {
  return async function ready() {
    try {
      for (const model of models) {
        const actual = await model.collection.listIndexes().toArray();
        for (const [fields, options] of model.schema.indexes()) {
          if (!actual.some(index => JSON.stringify(index.key) === JSON.stringify(fields)
            && Boolean(index.unique) === Boolean(options.unique)
            && !index.sparse && !index.partialFilterExpression
            && (options.expireAfterSeconds === undefined || index.expireAfterSeconds === options.expireAfterSeconds))) return false;
        }
      }
      return true;
    } catch (_) { return false; }
  };
}
module.exports = { createFeatureReadiness };
