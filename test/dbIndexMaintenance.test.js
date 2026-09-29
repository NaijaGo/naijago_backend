const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanupObsoleteIndexes } = require('../utils/dbIndexMaintenance');

test('empty databases without a riders collection do not fail startup cleanup', async () => {
  const missingCollection = {
    async indexes() {
      const error = new Error('ns does not exist: sandbox.riders');
      error.code = 26;
      error.codeName = 'NamespaceNotFound';
      throw error;
    },
  };

  await assert.doesNotReject(() => cleanupObsoleteIndexes({ collection: missingCollection }));
});

test('obsolete rider withdrawal indexes are removed while unrelated indexes remain', async () => {
  const dropped = [];
  const collection = {
    async indexes() {
      return [
        { name: '_id_', key: { _id: 1 }, unique: true },
        {
          name: 'withdrawalHistory.reference_1',
          key: { 'withdrawalHistory.reference': 1 },
          unique: true,
        },
        {
          name: 'withdrawalHistory.reference_non_unique',
          key: { 'withdrawalHistory.reference': 1 },
          unique: false,
        },
      ];
    },
    async dropIndex(name) {
      dropped.push(name);
    },
  };

  await cleanupObsoleteIndexes({ collection, log: () => {} });
  assert.deepEqual(dropped, ['withdrawalHistory.reference_1']);
});

test('real index-listing failures are still surfaced', async () => {
  const collection = {
    async indexes() {
      const error = new Error('authentication failed');
      error.code = 18;
      throw error;
    },
  };

  await assert.rejects(
    () => cleanupObsoleteIndexes({ collection }),
    /authentication failed/,
  );
});
