function createExploreNotificationService({ User, UserBlock, FeedComment, explore, notifications, now = () => new Date() }) {
    return async function notify(payload, { job, signal }) {
        signal.throwIfAborted();
        if (now().getTime() - new Date(job.createdAt).getTime() > 7 * 86400000) return { skipped: 'stale_activity' };
        const { recipient, actor, targetType, target: id, kind, commentId, parentId } = payload;
        if (recipient === actor) return { skipped: 'self_activity' };
        const blocked = await UserBlock.exists({ $or: [{ user: recipient, blockedUser: actor }, { user: actor, blockedUser: recipient }] });
        if (blocked) return { skipped: 'blocked' };
        const user = await User.findById(recipient).select('isVendor isAdmin notificationPreferences').lean();
        if (!user || user.notificationPreferences?.exploreActivity === false) return { skipped: 'preference_or_account' };
        const target = await explore.loadTarget(targetType, id, recipient);
        if (!target) return { skipped: 'unavailable_item' };
        if (commentId && !await FeedComment.exists({ _id: commentId, state: 'visible' })) return { skipped: 'removed_comment' };
        if (parentId && !await FeedComment.exists({ _id: parentId, state: 'visible' })) return { skipped: 'removed_thread' };
        if (String(target.owner) !== recipient && kind !== 'reply') return { skipped: 'seller_changed' };
        const message = kind === 'reaction' ? `New reaction on ${target.title}.` : kind === 'reply' ? `New reply in the conversation about ${target.title}.` : `New comment on ${target.title}.`;
        await User.updateOne({ _id: recipient, 'notifications._id': { $ne: job._id } }, { $push: { notifications: {
            _id: job._id, type: 'general', message, read: false, createdAt: now(), relatedId: id,
            relatedModel: targetType === 'product' ? 'Product' : 'CarouselSlide',
            explore: { targetType, target: id, ...(commentId ? { comment: commentId } : {}), ...(parentId ? { parent: parentId } : {}) },
        } } });
        signal.throwIfAborted();
        const audience = user.isVendor ? 'vendor' : user.isAdmin ? 'admin' : 'customer';
        if (!notifications.hasAudienceConfiguration(audience)) {
            throw Object.assign(new Error('Push audience is not configured.'), { jobCode: 'push_not_configured', retryable: false });
        }
        if (!job.deliveryKey) throw Object.assign(new Error('Missing delivery identity.'), { jobCode: 'missing_delivery_key', retryable: false });
        const response = await notifications.createNotification(audience, {
            headings: { en: 'NaijaGo Explore' }, contents: { en: message },
            include_aliases: { external_id: [recipient] }, target_channel: 'push',
            idempotency_key: job.deliveryKey,
            data: { type: 'explore_activity', targetType, targetId: id, ...(commentId ? { commentId } : {}), ...(parentId ? { parentId } : {}) },
            ...notifications.getPlatformOptions(audience),
        });
        if (!response.body?.id || response.body?.errors) {
            throw Object.assign(new Error('No confirmed push recipient.'), { jobCode: 'push_recipient_unavailable', retryable: false });
        }
        return { inApp: true, pushAccepted: true, providerId: response.body.id };
    };
}
module.exports = { createExploreNotificationService };
