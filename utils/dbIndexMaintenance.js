const Rider = require('../models/Rider');

const dropIndexIfExists = async (collection, indexName) => {
  try {
    await collection.dropIndex(indexName);
    console.log(`Dropped obsolete MongoDB index: ${indexName}`);
  } catch (error) {
    if (error?.codeName === 'IndexNotFound' || error?.code === 27) {
      return;
    }
    throw error;
  }
};

const cleanupObsoleteIndexes = async () => {
  const indexes = await Rider.collection.indexes();
  const obsoleteRiderWithdrawalIndexes = indexes.filter((index) => {
    const key = index.key || {};
    return (
      index.unique === true &&
      Object.prototype.hasOwnProperty.call(key, 'withdrawalHistory.reference')
    );
  });

  for (const index of obsoleteRiderWithdrawalIndexes) {
    await dropIndexIfExists(Rider.collection, index.name);
  }
};

module.exports = { cleanupObsoleteIndexes };
