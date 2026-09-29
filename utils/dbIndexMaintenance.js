const Rider = require('../models/Rider');

const isMissingNamespace = (error) => (
  error?.codeName === 'NamespaceNotFound' || error?.code === 26
);

const dropIndexIfExists = async (collection, indexName, log = console.log) => {
  try {
    await collection.dropIndex(indexName);
    log(`Dropped obsolete MongoDB index: ${indexName}`);
  } catch (error) {
    if (error?.codeName === 'IndexNotFound' || error?.code === 27) {
      return;
    }
    throw error;
  }
};

const cleanupObsoleteIndexes = async ({
  collection = Rider.collection,
  log = console.log,
} = {}) => {
  let indexes;
  try {
    indexes = await collection.indexes();
  } catch (error) {
    // A newly provisioned database has no riders collection yet. There cannot
    // be an obsolete index to remove, so startup should continue and let
    // Mongoose create the collection when the first rider is written.
    if (isMissingNamespace(error)) return;
    throw error;
  }

  const obsoleteRiderWithdrawalIndexes = indexes.filter((index) => {
    const key = index.key || {};
    return (
      index.unique === true &&
      Object.prototype.hasOwnProperty.call(key, 'withdrawalHistory.reference')
    );
  });

  for (const index of obsoleteRiderWithdrawalIndexes) {
    await dropIndexIfExists(collection, index.name, log);
  }
};

module.exports = { cleanupObsoleteIndexes };
