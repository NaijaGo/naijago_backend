const mongoose = require('mongoose');
const { activeCampaignFilter, parseTarget, ExploreInputError } = require('../utils/explorePolicy');
const keyFor = (type, id) => `${type}:${id}`;
const visibleProduct = { isActive: true, moderationStatus: 'approved', productStatus: 'active' };
const campaignVendorPopulate = { path: 'vendor', select: 'businessName vendorStatus',
    transform: (doc, id) => doc || (id ? { _id: id, vendorStatus: 'missing' } : null) };

function createExploreService({ Product, CarouselSlide, FeedReaction, FeedComment, FeedView, UserBlock, enrichProducts, videoService, now = () => new Date() }) {
    async function blockedUsers(userId) {
        if (!userId) return [];
        const blocks = await UserBlock.find({ $or: [{ user: userId }, { blockedUser: userId }] }).select('user blockedUser').limit(10001).lean();
        if (blocks.length > 10000) throw new Error('Block list requires paginated handling.');
        return blocks.map((entry) => String(entry.user) === String(userId) ? entry.blockedUser : entry.user);
    }
    async function loadTarget(type, id, userId) {
        const target = parseTarget(type, id);
        const blocked = new Set((await blockedUsers(userId)).map(String));
        if (type === 'product') {
            const product = await Product.findOne({ _id: id, ...visibleProduct }).populate('videoAssetId').populate('vendor', 'vendorStatus').lean();
            const owner = product?.vendor?._id || product?.sellerId;
            if (!product || blocked.has(String(owner)) || (product.sellerType === 'vendor' && product.vendor?.vendorStatus !== 'approved')) return null;
            return { ...target, owner: owner || null, title: product.name,
                mediaKind: product.videoAssetId?.status === 'approved' ? 'video' : 'image', product };
        }
        const campaign = await CarouselSlide.findOne({ _id: id, ...activeCampaignFilter(now()) }).populate('videoAssetId').populate(campaignVendorPopulate).lean();
        if (!campaign || blocked.has(String(campaign.vendor?._id || campaign.vendor)) || blocked.has(String(campaign.createdBy)) ||
            (campaign.vendor && campaign.vendor.vendorStatus !== 'approved') ||
            (campaign.mediaKind === 'video' && campaign.videoAssetId?.status !== 'approved')) return null;
        return { ...target, owner: campaign.vendor?._id || campaign.createdBy || null, title: campaign.title,
            mediaKind: campaign.mediaKind, campaign };
    }
    async function statistics(targets, userId) {
        if (!targets.length) return new Map();
        const conditions = targets.map(({ type, id }) => ({ targetType: type, target: new mongoose.Types.ObjectId(String(id)) }));
        const match = { $or: conditions };
        const [reactions, comments, views, mine] = await Promise.all([
            FeedReaction.aggregate([{ $match: match }, { $group: { _id: { type: '$targetType', target: '$target', reaction: '$reaction' }, count: { $sum: 1 } } }]),
            FeedComment.aggregate([{ $match: { ...match, state: 'visible' } }, { $group: { _id: { type: '$targetType', target: '$target' }, count: { $sum: 1 } } }]),
            FeedView.aggregate([{ $match: { ...match, countedAt: { $type: 'date' } } }, { $group: { _id: { type: '$targetType', target: '$target' }, count: { $sum: 1 } } }]),
            userId ? FeedReaction.find({ ...match, user: userId }).select('target targetType reaction').lean() : [],
        ]);
        const result = new Map(targets.map(({ type, id }) => [keyFor(type, id), { reactions: { like: 0, love: 0, wow: 0, dislike: 0 }, comments: 0, views: 0, myReaction: null }]));
        for (const item of reactions) result.get(keyFor(item._id.type, item._id.target)).reactions[item._id.reaction] = item.count;
        for (const item of comments) result.get(keyFor(item._id.type, item._id.target)).comments = item.count;
        for (const item of views) result.get(keyFor(item._id.type, item._id.target)).views = item.count;
        for (const item of mine) result.get(keyFor(item.targetType, item.target)).myReaction = item.reaction;
        return result;
    }
    function mediaFor(product) {
        if (product.videoAssetId?.status === 'approved') {
            const asset = videoService.serialize(product.videoAssetId);
            return { kind: 'video', url: asset.url, posterUrl: asset.posterUrl, duration: asset.duration };
        }
        return { kind: 'image', url: product.images?.main || product.imageUrls?.[0] || product.imageUrl || null };
    }
    async function feed({ before, userId, limit = 20 } = {}) {
        if (before && !mongoose.isObjectIdOrHexString(before)) throw new ExploreInputError('Invalid feed cursor.');
        limit = Number(limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new ExploreInputError('Feed size must be between 1 and 30.');
        const blocked = await blockedUsers(userId);
        const raw = await Product.find({ ...visibleProduct, vendor: { $nin: blocked },
            ...(before ? { _id: { $lt: new mongoose.Types.ObjectId(before) } } : {}),
        }).sort({ _id: -1 }).limit(limit + 1).populate('videoAssetId')
            .populate('vendor', 'businessName businessLogoUrl vendorStatus').lean();
        const page = raw.slice(0, limit);
        const eligible = page.filter((product) => product.sellerType !== 'vendor' || product.vendor?.vendorStatus === 'approved');
        const products = await enrichProducts(eligible);
        const campaigns = before ? [] : await CarouselSlide.find({ ...activeCampaignFilter(now()),
            vendor: { $nin: blocked }, createdBy: { $nin: blocked },
        }).sort({ sortOrder: 1, _id: -1 }).limit(10).populate('videoAssetId')
            .populate(campaignVendorPopulate).lean();
        const approvedCampaigns = campaigns.filter((campaign) => (!campaign.vendor || campaign.vendor.vendorStatus === 'approved') &&
            (campaign.mediaKind !== 'video' || campaign.videoAssetId?.status === 'approved'));
        const targets = [...products.map((product) => ({ type: 'product', id: product._id })),
            ...approvedCampaigns.map((campaign) => ({ type: 'campaign', id: campaign._id }))];
        const stats = await statistics(targets, userId);
        return {
            items: products.map((product) => ({
                id: String(product._id), type: 'product', sponsored: false,
                title: product.name, caption: String(product.description || '').slice(0, 600),
                vendorId: product.sellerId ? String(product.sellerId) : null,
                sellerName: product.sellerName, logoUrl: product.vendor?.businessLogoUrl || null,
                media: mediaFor(product), price: product.effectivePrice,
                action: { type: 'product', value: String(product._id) },
                ...stats.get(keyFor('product', product._id)),
            })),
            campaigns: approvedCampaigns.map((campaign) => ({
                id: String(campaign._id), type: 'campaign', sponsored: true,
                title: campaign.title, caption: campaign.subtitle, sellerName: campaign.advertiserName,
                vendorId: campaign.vendor?._id ? String(campaign.vendor._id) : null,
                expiresAt: campaign.endsAt,
                media: campaign.mediaKind === 'video' ? mediaFor(campaign) : { kind: 'image', url: campaign.imageUrl },
                action: { type: campaign.actionType, value: campaign.actionValue || campaign.linkUrl },
                ...stats.get(keyFor('campaign', campaign._id)),
            })),
            hasMore: raw.length > limit,
            nextCursor: raw.length > limit && page.length ? String(page.at(-1)._id) : null,
            serverTime: now(),
        };
    }
    return { feed, loadTarget, blockedUsers, statistics, mediaFor };
}
module.exports = { createExploreService, keyFor, visibleProduct };
