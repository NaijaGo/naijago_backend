const test = require('node:test');
const assert = require('node:assert/strict');
const { createExploreService } = require('../services/exploreService');
const id = 'aaaaaaaaaaaaaaaaaaaaaaaa', vendorId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const chain = (value) => ({ select() { return this; }, limit() { return this; }, sort() { return this; }, populate() { return this; }, lean: async () => value });
function fixture(campaign) {
    return createExploreService({
        Product: { find: () => chain([]) },
        CarouselSlide: { find: () => chain([campaign]), findOne: () => chain(campaign) },
        UserBlock: { find: () => chain([]) },
        FeedReaction: { aggregate: async () => [], find: () => chain([]) },
        FeedComment: { aggregate: async () => [] }, FeedView: { aggregate: async () => [] },
        enrichProducts: async (values) => values, videoService: { serialize: (value) => value },
    });
}
test('unapproved campaign vendors are excluded from feed and direct interaction', async () => {
    const service = fixture({ _id: id, mediaKind: 'image', vendor: { _id: vendorId, vendorStatus: 'suspended' } });
    assert.deepEqual((await service.feed()).campaigns, []);
    assert.equal(await service.loadTarget('campaign', id), null);
});
test('approved campaigns retain vendor ownership and actual metrics', async () => {
    const service = fixture({ _id: id, mediaKind: 'image', title: 'Campaign', imageUrl: 'https://example.com/image', vendor: { _id: vendorId, vendorStatus: 'approved' } });
    const feed = await service.feed();
    assert.equal(feed.campaigns.length, 1);
    assert.equal(feed.campaigns[0].sponsored, true);
    assert.equal(feed.campaigns[0].views, 0);
    assert.equal((await service.loadTarget('campaign', id)).owner, vendorId);
});
test('an unapproved video cannot appear in a published campaign', async () => {
    const service = fixture({ _id: id, mediaKind: 'video', videoAssetId: { status: 'rejected' } });
    assert.deepEqual((await service.feed()).campaigns, []);
    assert.equal(await service.loadTarget('campaign', id), null);
});
