const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { cleanupUploadedFiles } = require('../utils/uploadTempFiles');
test('cleanup only unlinks exact middleware files inside the designated temp directory', async () => {
    const root = path.resolve('test-temp'), removed = [];
    const inside = path.join(root, 'middleware-file');
    await cleanupUploadedFiles({ image: [{ tempFilePath: inside }, { tempFilePath: path.join(root, '..', 'outside') },
        { tempFilePath: root }, { tempFilePath: 'relative-file' }, { name: 'missing-path' }] },
        { tempRoot: root, unlink: async (file) => removed.push(file) });
    assert.deepEqual(removed, [inside]);
});
test('a missing temporary file cannot replace the upload response with an error', async () => {
    const root = path.resolve('test-temp');
    await cleanupUploadedFiles({ image: { tempFilePath: path.join(root, 'already-removed') } },
        { tempRoot: root, unlink: async () => { throw new Error('missing'); } });
});
