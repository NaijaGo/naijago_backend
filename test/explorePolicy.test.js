const test = require('node:test');
const assert = require('node:assert/strict');
const { campaignFields, activeCampaignFilter, parseComment, parseTarget, UGC_POLICY_VERSION } = require('../utils/explorePolicy');
const { CarouselSlide } = require('../models/CarouselSlide');
const FeedReaction = require('../models/FeedReaction');

const campaign = () => ({ placement: 'explore', title: 'Real campaign', advertiserName: 'Verified advertiser',
    imageUrl: 'https://res.cloudinary.com/test/image.jpg', imageRightsConfirmed: true,
    startsAt: '2026-09-20T09:00:00+01:00', endsAt: '2026-09-21T09:00:00+01:00' });
test('campaign expiry and media rights are mandatory without changing home slides', () => {
    assert.deepEqual(campaignFields({ placement: 'main' }), {});
    const fields = campaignFields(campaign());
    assert.equal(fields.startsAt.toISOString(), '2026-09-20T08:00:00.000Z');
    assert.equal(fields.mediaKind, 'image');
    assert.throws(() => campaignFields({ ...campaign(), endsAt: '' }), /expiry/);
    assert.throws(() => campaignFields({ ...campaign(), imageRightsConfirmed: false }), /permission/);
    assert.throws(() => campaignFields({ ...campaign(), endsAt: '2020-01-01' }), /expiry/);
});
test('campaign destinations and video IDs are validated', () => {
    assert.throws(() => campaignFields({ ...campaign(), actionType: 'external', actionValue: 'javascript:alert(1)' }), /HTTPS/);
    assert.throws(() => campaignFields({ ...campaign(), mediaKind: 'video', videoAssetId: 'bad' }), /video/);
    assert.throws(() => campaignFields({ ...campaign(), actionType: 'vendor', actionValue: 'bad' }), /destination/);
    assert.throws(() => campaignFields({ ...campaign(), imageUrl: 'https://user:pass@example.com/img' }));
});
test('public campaign query excludes inactive, future and expired campaigns', () => {
    const date = new Date();
    assert.deepEqual(activeCampaignFilter(date), { placement: 'explore', isActive: true,
        startsAt: { $lte: date }, endsAt: { $gt: date }, imageRightsConfirmed: true });
});
test('comments require current guidelines and bounded non-empty text', () => {
    assert.throws(() => parseComment({ body: 'hello' }), /guidelines/);
    assert.throws(() => parseComment({ body: ' ', policyVersion: UGC_POLICY_VERSION }));
    assert.throws(() => parseComment({ body: 'x'.repeat(2001), policyVersion: UGC_POLICY_VERSION }));
    assert.deepEqual(parseComment({ body: ' Nice product ', policyVersion: UGC_POLICY_VERSION }), { body: 'Nice product', parent: null });
    assert.throws(() => parseTarget('user', 'aaaaaaaaaaaaaaaaaaaaaaaa'));
});
test('existing carousel payloads still validate and invalid reactions do not', async () => {
    const slide = new CarouselSlide({ placement: 'main', imageUrl: 'https://example.com/image.jpg' });
    await slide.validate();
    const reaction = new FeedReaction({ targetType: 'product', target: 'aaaaaaaaaaaaaaaaaaaaaaaa', user: 'bbbbbbbbbbbbbbbbbbbbbbbb', reaction: 'unknown' });
    await assert.rejects(reaction.validate(), /reaction/);
});
