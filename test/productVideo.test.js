const test = require('node:test');
const assert = require('node:assert/strict');
const {
    validateVideoRequest, validateUploadedVideo, VIDEO_POLICY_VERSION,
    MAX_VIDEO_BYTES,
} = require('../utils/productVideoPolicy');
const { createProductVideoService } = require('../services/productVideoService');

const metadata = (overrides = {}) => ({
    public_id: 'owned/video', resource_type: 'video', type: 'authenticated',
    format: 'mp4', duration: 60, bytes: 1000, width: 1280, height: 720,
    version: 1, ...overrides,
});

test('video upload requires acknowledgement, genuine video MIME and bounded size', () => {
    const valid = { policyVersion: VIDEO_POLICY_VERSION, mimeType: 'video/mp4', bytes: 1000 };
    assert.doesNotThrow(() => validateVideoRequest(valid));
    for (const change of [{ policyVersion: '' }, { mimeType: 'image/png' },
        { bytes: 0 }, { bytes: MAX_VIDEO_BYTES + 1 }, { bytes: '1000' }]) {
        assert.throws(() => validateVideoRequest({ ...valid, ...change }));
    }
});

test('provider metadata enforces 60 seconds and correct owned authenticated asset', () => {
    assert.equal(validateUploadedVideo(metadata(), 'owned/video').duration, 60);
    for (const change of [{ duration: 60.01 }, { duration: NaN },
        { resource_type: 'image' }, { type: 'upload' }, { width: 0 },
        { format: 'mp3' }, { public_id: 'someone/else' }, { bytes: MAX_VIDEO_BYTES + 1 }]) {
        assert.throws(() => validateUploadedVideo(metadata(change), 'owned/video'));
    }
});

test('signed upload fixes owner path, protected delivery, formats and no overwrite', async () => {
    let saved;
    let signed;
    const service = createProductVideoService({
        cloudinary: {
            config: () => ({ cloud_name: 'test', api_key: 'public-test', api_secret: 'secret-test' }),
            utils: { api_sign_request: (parameters) => { signed = parameters; return 'signed'; } },
        },
        MediaAsset: { create: async (data) => { saved = data; return { ...data, _id: 'asset' }; } },
    });
    const ticket = await service.issueUpload('vendor', {
        policyVersion: VIDEO_POLICY_VERSION, mimeType: 'video/mp4', bytes: 1000,
    });
    assert.match(saved.publicId, /^naijago\/product_videos\/vendor\//);
    assert.equal(signed.type, 'authenticated');
    assert.equal(signed.overwrite, false);
    assert.equal(ticket.fields.signature, 'signed');
    assert.equal(JSON.stringify(ticket).includes('secret-test'), false);
});

test('completion trusts server metadata and moves video only to admin review', async () => {
    let inspected = 0;
    const asset = {
        _id: 'asset', publicId: 'owned/video', status: 'pending_upload',
        uploadExpiresAt: new Date(Date.now() + 10000), save: async () => {},
    };
    const service = createProductVideoService({
        cloudinary: {
            api: { resource: async () => { inspected++; return metadata(); } },
            url: () => 'https://signed.test/video',
        }, MediaAsset: {},
    });
    const completed = await service.completeUpload(asset);
    assert.equal(inspected, 1);
    assert.equal(completed.status, 'pending_review');
    assert.equal(service.serialize(asset).url, undefined);
    assert.equal(service.serialize({ ...asset, status: 'approved' }).url, 'https://signed.test/video');
});

test('expired upload is rejected before any provider request', async () => {
    const service = createProductVideoService({ cloudinary: {}, MediaAsset: {} });
    await assert.rejects(() => service.completeUpload({
        status: 'pending_upload', uploadExpiresAt: new Date(0),
    }), /expired/);
});
