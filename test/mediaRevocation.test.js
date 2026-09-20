const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaRevocationService, beginVideoRevocation } = require('../services/mediaRevocationService');
const id = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const owner = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const date = new Date('2026-09-20T12:00:00Z');
function fixture(overrides = {}) {
    const asset = { _id: id, owner, publicId: `naijago/product_videos/${owner}/original`, status: 'rejected', version: 1 };
    asset.revocation = beginVideoRevocation(asset, date);
    const writes = [], provider = [];
    const resource = { public_id: asset.revocation.toPublicId, type: 'authenticated', resource_type: 'video', version: 2 };
    const MediaAsset = { findOne: () => ({ lean: async () => asset }), updateOne: async (...args) => { writes.push(args); return { matchedCount: 1 }; } };
    const cloudinary = {
        api: { resource: async (...args) => { provider.push(['lookup', ...args]); throw { http_code: 404 }; } },
        uploader: { rename: async (...args) => { provider.push(['rename', ...args]); return resource; } },
    };
    const service = createMediaRevocationService({ MediaAsset, cloudinary, queue: {}, now: () => date, ...overrides });
    const run = () => service.revoke({ assetId: id, token: asset.revocation.token }, { signal: new AbortController().signal });
    return { asset, writes, provider, cloudinary, resource, service, run };
}
test('rejection creates a unique owned destination while keeping the original identity', () => {
    const { asset } = fixture();
    assert.equal(asset.revocation.fromPublicId, asset.publicId);
    assert.ok(asset.revocation.toPublicId.startsWith(`naijago/product_videos/${owner}/revoked-`));
    assert.equal(asset.revocation.state, 'pending');
});
test('takedown renames authenticated media with CDN invalidation instead of deleting the original', async () => {
    const { run, provider, writes, asset } = fixture();
    assert.equal((await run()).revoked, true);
    const rename = provider.find(([method]) => method === 'rename');
    assert.equal(rename[1], asset.publicId);
    assert.equal(rename[3].invalidate, true);
    assert.equal(rename[3].overwrite, false);
    assert.equal(rename[3].type, 'authenticated');
    assert.equal(writes[0][0]['revocation.token'], asset.revocation.token);
    assert.equal(writes[0][1].$inc.__v, 1);
    assert.equal(writes[0][1].$set['revocation.state'], 'completed');
});
test('recovery after a provider success does not perform another rename', async () => {
    const { cloudinary, resource, run, provider } = fixture();
    cloudinary.api.resource = async () => resource;
    await run();
    assert.equal(provider.length, 0);
});
test('wrong owned path fails before contacting the provider', async () => {
    const { asset, run, provider } = fixture();
    asset.revocation.fromPublicId = 'someone-elses-file';
    await assert.rejects(run(), { jobCode: 'invalid_media_path' });
    assert.equal(provider.length, 0);
});
test('provider failure retains pending revocation and never records success', async () => {
    const { cloudinary, writes, run } = fixture();
    cloudinary.uploader.rename = async () => { throw Object.assign(new Error('Provider unavailable'), { http_code: 503 }); };
    await assert.rejects(run());
    assert.equal(writes.length, 0);
});
test('aborted jobs never modify provider media', async () => {
    const { asset, service, provider } = fixture();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(service.revoke({ assetId: id, token: asset.revocation.token }, { signal: controller.signal }));
    assert.equal(provider.length, 0);
});
