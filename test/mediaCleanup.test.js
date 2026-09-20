const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaCleanupService } = require('../services/mediaCleanupService');
const assetId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const owner = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const context = () => ({ signal: new AbortController().signal });

test('cleanup never deletes a video referenced by a product', async () => {
    const service = createMediaCleanupService({
        Product: { exists: async () => true },
        MediaAsset: { findOneAndUpdate: async () => assert.fail('must not mutate attached asset') },
        cloudinary: { uploader: { destroy: async () => assert.fail('must not delete') } },
    });
    assert.deepEqual(await service.cleanup({ assetId }, context()), { skipped: 'attached_to_product' });
});
test('cleanup claims only expired uncompleted/invalid assets, not approved or pending review', async () => {
    let filter;
    const service = createMediaCleanupService({
        Product: { exists: async () => false },
        MediaAsset: { findOneAndUpdate: async (query) => { filter = query; return null; } },
        cloudinary: { uploader: { destroy: async () => assert.fail('must not delete') } },
    });
    assert.deepEqual(await service.cleanup({ assetId }, context()), { skipped: 'not_eligible' });
    assert.deepEqual(filter.status.$in, ['invalid', 'pending_upload', 'abandoned']);
    assert.ok(filter.uploadExpiresAt.$lt instanceof Date);
});
test('cleanup refuses a provider path outside the recorded upload owner', async () => {
    const service = createMediaCleanupService({
        Product: { exists: async () => false },
        MediaAsset: { findOneAndUpdate: async () => ({ owner, publicId: 'another-folder/video' }) },
        cloudinary: { uploader: { destroy: async () => assert.fail('must not delete') } },
    });
    await assert.rejects(service.cleanup({ assetId }, context()), { jobCode: 'invalid_media_path', retryable: false });
});
test('a retried provider deletion records completion when the asset is already absent', async () => {
    const publicId = `naijago/product_videos/${owner}/unique-video`;
    let receipt;
    const service = createMediaCleanupService({
        Product: { exists: async () => false },
        MediaAsset: {
            findOneAndUpdate: async () => ({ _id: assetId, owner, publicId }),
            updateOne: async (_filter, update) => { receipt = update.$set; },
        },
        cloudinary: { uploader: { destroy: async (id, options) => {
            assert.equal(id, publicId);
            assert.equal(options.type, 'authenticated');
            assert.equal(options.resource_type, 'video');
            return { result: 'not found' };
        } } },
    });
    assert.deepEqual(await service.cleanup({ assetId }, context()), { cleaned: true, assetId });
    assert.ok(receipt.cleanedAt instanceof Date);
    assert.equal(receipt.cleanupReceipt.length, 64);
});
test('unconfirmed provider cleanup does not mark the database asset as deleted', async () => {
    const service = createMediaCleanupService({
        Product: { exists: async () => false },
        MediaAsset: {
            findOneAndUpdate: async () => ({ _id: assetId, owner, publicId: `naijago/product_videos/${owner}/unique-video` }),
            updateOne: async () => assert.fail('deletion is unconfirmed'),
        },
        cloudinary: { uploader: { destroy: async () => ({ result: 'pending' }) } },
    });
    await assert.rejects(service.cleanup({ assetId }, context()), { jobCode: 'media_cleanup_unconfirmed' });
});
