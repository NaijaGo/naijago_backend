const test = require('node:test');
const assert = require('node:assert/strict');
const { createPhotoReviewImages, SANITIZE, THUMBNAIL } = require('../services/photoReviewImages');
const owner = '000000000000000000000001', assetId = '000000000000000000000002';
const publicId = `naijago/review_photos/${owner}/${assetId}`;
const response = { public_id: publicId, resource_type: 'image', type: 'authenticated', format: 'jpg', version: 1, width: 1000, height: 750, bytes: 50000 };
function fixture(overrides = {}) {
    const calls = [];
    const cloudinary = { config: () => ({ cloud_name: 'test', api_key: 'synthetic', api_secret: 'synthetic' }),
        uploader: { upload: async (data, options) => { calls.push({ data, options }); return response; } },
        api: { resource: async () => response }, utils: { private_download_url: (key, format, options) => ({ key, format, options }) }, ...overrides };
    return { calls, cloudinary, images: createPhotoReviewImages({ cloudinary, now: () => new Date('2100-01-01T00:00:00Z') }) };
}
test('review photos use incoming metadata stripping, bounded JPEG output and a small eager thumbnail', async () => {
    const f = fixture(); const asset = await f.images.process({ owner, assetId, bytes: Buffer.from([255, 216, 255, 224]) });
    assert.equal(asset.publicId, publicId); assert.equal(asset.storageType, 'authenticated');
    const options = f.calls[0].options;
    assert.equal(options.type, 'authenticated'); assert.equal(options.overwrite, false);
    assert.equal(options.transformation, SANITIZE); assert.match(SANITIZE, /fl_force_strip/);
    assert.equal(options.eager, THUMBNAIL); assert.match(THUMBNAIL, /h_320/);
    assert.equal(options.format, 'jpg'); assert.equal(options.exif, false); assert.equal(options.image_metadata, false);
});
test('HEIC uploads request JPEG conversion rather than publishing an unsupported original', async () => {
    const f = fixture(); const bytes = Buffer.alloc(24); bytes.writeUInt32BE(24); bytes.write('ftyp', 4); bytes.write('heic', 8);
    const asset = await f.images.process({ owner, assetId, bytes });
    assert.match(f.calls[0].data, /^data:image\/heic;base64,/); assert.equal(asset.format, 'jpg');
});
test('unsupported input, invalid identity, disabled storage and pre-aborted work cannot call provider', async () => {
    const f = fixture();
    await assert.rejects(f.images.process({ owner, assetId, bytes: Buffer.from('<svg/>') }));
    await assert.rejects(f.images.process({ owner, assetId: '../escape', bytes: Buffer.from([255, 216, 255]) }));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.images.process({ owner, assetId, bytes: Buffer.from([255, 216, 255]), signal: controller.signal }));
    assert.equal(f.calls.length, 0);
    const empty = fixture({ config: () => ({}) });
    await assert.rejects(empty.images.process({ owner, assetId, bytes: Buffer.from([255, 216, 255]) }), { code: 'PHOTO_STORAGE_UNAVAILABLE' });
    assert.equal(empty.calls.length, 0);
});
test('provider errors are sanitized and not blindly retried after upload uncertainty', async () => {
    let calls = 0;
    const f = fixture({ uploader: { upload: async () => { calls++; throw new Error('secret=do-not-leak image=user-data'); } } });
    await assert.rejects(f.images.process({ owner, assetId, bytes: Buffer.from([255, 216, 255]) }), (error) => {
        assert.equal(error.code, 'PHOTO_UPLOAD_UNCERTAIN'); assert.ok(!error.message.includes('do-not-leak')); return true;
    });
    assert.equal(calls, 1); assert.equal((await f.images.recover({ owner, assetId })).publicId, publicId);
});
test('storage responses must match the exact private image identity and output bounds', async () => {
    for (const change of [{ type: 'upload' }, { format: 'heic' }, { public_id: 'someone-else' }, { width: 1601 }, { bytes: 20 * 1024 * 1024 }, { version: 0 }]) {
        const f = fixture({ uploader: { upload: async () => ({ ...response, ...change }) } });
        await assert.rejects(f.images.process({ owner, assetId, bytes: Buffer.from([255, 216, 255]) }), { code: 'PHOTO_PROCESSING_INVALID' });
    }
});
test('private preview links expire and cannot select another owner asset', async () => {
    const f = fixture(); const asset = await f.images.process({ owner, assetId, bytes: Buffer.from([255, 216, 255]) });
    const preview = f.images.privatePreview({ owner, assetId, asset });
    assert.equal(preview.options.expires_at, new Date('2100-01-01T00:05:00Z').getTime() / 1000);
    assert.equal(preview.options.type, 'authenticated'); assert.equal(preview.options.attachment, false);
    assert.throws(() => f.images.privatePreview({ owner: assetId, assetId, asset }), { code: 'PHOTO_NOT_FOUND' });
});
