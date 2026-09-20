const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Product = require('../models/Product');
const MediaAsset = require('../models/MediaAsset');
const cloudinary = require('../utils/cloudinary');
const router = require('../routes/productMediaRoutes');
const { resolveProductVideoAttachment } = require('../services/productMediaAttachment');

const vendorId = '111111111111111111111111';
const otherVendorId = '222222222222222222222222';
const assetId = '333333333333333333333333';
const productId = '444444444444444444444444';
const query = (value) => ({
    select() { return this; },
    lean() { return Promise.resolve(value); },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
});

async function fixture(t, user = { _id: vendorId, isVendor: true, vendorStatus: 'approved' }) {
    const previousFlag = process.env.PRODUCT_VIDEO_ENABLED;
    const previousSecret = process.env.JWT_SECRET;
    process.env.PRODUCT_VIDEO_ENABLED = 'true';
    process.env.JWT_SECRET = 'isolated-media-route-test-secret';
    t.after(() => {
        if (previousFlag === undefined) delete process.env.PRODUCT_VIDEO_ENABLED;
        else process.env.PRODUCT_VIDEO_ENABLED = previousFlag;
        if (previousSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = previousSecret;
    });
    t.mock.method(User, 'findById', () => query(user));
    const app = express();
    app.use(express.json());
    app.use('/media', router);
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    return (path, options = {}) => fetch(`http://127.0.0.1:${server.address().port}/media${path}`, {
        ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
}

test('public product videos require approved media on an available product', async (t) => {
    const request = await fixture(t);
    t.mock.method(Product, 'findOne', (filter) => {
        assert.equal(filter.moderationStatus, 'approved');
        assert.deepEqual(filter.productStatus.$in, ['active', 'out_of_stock']);
        return query({ videoAssetId: assetId });
    });
    t.mock.method(MediaAsset, 'findOne', (filter) => {
        assert.equal(filter.status, 'approved');
        return query(null); // uploaded but not yet approved
    });
    const response = await request(`/products/${productId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { videos: [] });
});

test('vendor cannot inspect or finalize another vendors upload', async (t) => {
    const request = await fixture(t);
    t.mock.method(MediaAsset, 'findById', async () => ({ _id: assetId, owner: otherVendorId }));
    t.mock.method(cloudinary.api, 'resource', () => { throw new Error('Provider must not be called'); });
    for (const [path, options] of [
        [`/assets/${assetId}`, {}],
        [`/assets/${assetId}/complete`, { method: 'POST', body: '{}' }],
    ]) {
        assert.equal((await request(path, options)).status, 404);
    }
});

test('vendor cannot approve their own video', async (t) => {
    const request = await fixture(t);
    const response = await request(`/assets/${assetId}/review`, {
        method: 'PUT', body: JSON.stringify({ status: 'approved', revision: 0 }),
    });
    assert.equal(response.status, 403);
});

test('admin review requires a current revision and persists moderation audit', async (t) => {
    const request = await fixture(t, { _id: vendorId, isAdmin: true, role: 'admin' });
    let saves = 0;
    const asset = { _id: assetId, owner: otherVendorId, status: 'pending_review',
        __v: 2, reviewHistory: [], save: async () => { saves++; } };
    t.mock.method(MediaAsset, 'findById', async () => asset);
    let response = await request(`/assets/${assetId}/review`, {
        method: 'PUT', body: JSON.stringify({ status: 'approved', revision: 1 }),
    });
    assert.equal(response.status, 409);
    assert.equal(saves, 0);
    response = await request(`/assets/${assetId}/review`, {
        method: 'PUT', body: JSON.stringify({ status: 'rejected', revision: 2, reason: '' }),
    });
    assert.equal(response.status, 400);
    response = await request(`/assets/${assetId}/review`, {
        method: 'PUT', body: JSON.stringify({ status: 'rejected', revision: 2, reason: 'Unrelated product' }),
    });
    assert.equal(response.status, 200);
    assert.equal(saves, 1);
    assert.equal(asset.reviewHistory[0].action, 'rejected');
    assert.equal(asset.reviewHistory[0].actor, vendorId);
});

test('product attachment enforces uploader ownership and excludes unverified files', async (t) => {
    await fixture(t);
    t.mock.method(MediaAsset, 'findOne', (filter) => {
        assert.equal(filter.owner, vendorId);
        assert.deepEqual(filter.status.$in, ['pending_review', 'approved']);
        return query(null);
    });
    await assert.rejects(() => resolveProductVideoAttachment(assetId, { _id: vendorId }), /Finish uploading/);
    assert.deepEqual(await resolveProductVideoAttachment(undefined, { _id: vendorId }), { supplied: false });
    assert.deepEqual(await resolveProductVideoAttachment('', { _id: vendorId }), { supplied: true, id: undefined });
});

test('feature flag disables public media without a database or provider call', async (t) => {
    const request = await fixture(t);
    process.env.PRODUCT_VIDEO_ENABLED = 'false';
    t.mock.method(Product, 'findOne', () => { throw new Error('Database must not be called'); });
    assert.deepEqual(await (await request(`/products/${productId}`)).json(), { videos: [] });
});
