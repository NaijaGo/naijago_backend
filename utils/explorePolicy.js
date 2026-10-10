const mongoose = require('mongoose');
class ExploreInputError extends Error { constructor(message) { super(message); this.status = 400; } }
const REACTIONS = ['like', 'love', 'wow', 'dislike'];
const UGC_POLICY_VERSION = 'community-2026-09';
const objectId = (value, label = 'ID') => {
    if (typeof value !== 'string' || !mongoose.isObjectIdOrHexString(value)) throw new ExploreInputError(`Invalid ${label}.`);
    return value;
};
const text = (value, max, label, required = false) => {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw new ExploreInputError(`Enter a valid ${label} (up to ${max} characters).`);
    return value.trim();
};
function safeHttpsUrl(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
    catch (_) { return false; }
}
function campaignFields(body) {
    if (body.placement !== 'explore') return {};
    const advertiserName = text(body.advertiserName, 140, 'advertiser name', true);
    const title = text(body.title, 180, 'campaign title', true);
    const subtitle = text(body.subtitle, 2000, 'campaign caption');
    text(body.actionValue, 2048, 'campaign destination');
    const startsAt = body.startsAt ? new Date(body.startsAt) : new Date();
    const endsAt = new Date(body.endsAt || '');
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) throw new ExploreInputError('Set a valid campaign start and expiry time.');
    if (body.imageRightsConfirmed !== true) throw new ExploreInputError('Confirm that the advertiser has permission to use this media.');
    const mediaKind = body.mediaKind || 'image';
    if (body.actionType && !['none', 'product', 'vendor', 'category', 'external'].includes(body.actionType)) throw new ExploreInputError('Choose a product, vendor, category or HTTPS campaign destination.');
    if (!['image', 'video'].includes(mediaKind)) throw new ExploreInputError('Invalid campaign media type.');
    if (!safeHttpsUrl(body.imageUrl)) throw new ExploreInputError('Upload a valid HTTPS campaign image or poster.');
    if (body.actionType === 'external' && !safeHttpsUrl(body.actionValue || body.linkUrl)) throw new ExploreInputError('External campaign destinations must use HTTPS.');
    if (['product', 'vendor'].includes(body.actionType)) objectId(body.actionValue, 'campaign destination');
    return { title, subtitle, advertiserName, startsAt, endsAt, mediaKind, imageRightsConfirmed: true,
        videoAssetId: mediaKind === 'video' ? objectId(body.videoAssetId, 'video') : null,
        vendor: body.vendor ? objectId(body.vendor, 'vendor') : null,
    };
}
function activeCampaignFilter(date = new Date()) {
    return { placement: 'explore', isActive: true, startsAt: { $lte: date }, endsAt: { $gt: date }, imageRightsConfirmed: true };
}
function parseTarget(type, id) {
    if (!['product', 'campaign'].includes(type)) throw new ExploreInputError('Invalid feed item.');
    return { targetType: type, target: new mongoose.Types.ObjectId(objectId(id, 'feed item')) };
}
function parseComment(body) {
    if (body.policyVersion !== UGC_POLICY_VERSION) throw new ExploreInputError('Please accept the current community guidelines before commenting.');
    return { body: text(body.body, 2000, 'comment', true), parent: body.parent ? objectId(body.parent, 'parent comment') : null };
}
module.exports = { ExploreInputError, REACTIONS, UGC_POLICY_VERSION, objectId, text, safeHttpsUrl, campaignFields, activeCampaignFilter, parseTarget, parseComment };
