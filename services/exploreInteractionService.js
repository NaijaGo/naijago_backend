const { REACTIONS, UGC_POLICY_VERSION, ExploreInputError, objectId, parseComment } = require('../utils/explorePolicy');

const unavailable = () => Object.assign(new Error('This feed item is no longer available.'), { status: 404 });
function requestKey(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value)) throw new ExploreInputError('A valid request ID is required.');
    return value;
}
function createExploreInteractionService({ connection, FeedReaction, FeedComment, FeedView, queue, explore, now = () => new Date() }) {
    async function transaction(work) {
        // Retry unique-key creation races with a fresh snapshot, never partially
        // save an interaction without its notification outbox record.
        for (let attempt = 0; attempt < 3; attempt++) {
            try { return await connection.transaction(work); }
            catch (error) { if (error.code !== 11000 || attempt === 2) throw error; }
        }
    }
    async function requireTarget(type, id, userId) {
        const target = await explore.loadTarget(type, id, userId);
        if (!target) throw unavailable();
        return target;
    }
    async function notify(target, actor, recipient, kind, key, session, commentId, parentId) {
        if (!recipient || String(actor) === String(recipient)) return;
        await queue.enqueue({ type: 'explore.notify', dedupeKey: `${key}:${recipient}`, owner: recipient,
            payload: { recipient: String(recipient), actor: String(actor), targetType: target.targetType,
                target: String(target.target), kind, ...(commentId ? { commentId: String(commentId) } : {}), ...(parentId ? { parentId: String(parentId) } : {}) },
        }, { session });
    }
    async function react({ type, id, userId, reaction }) {
        if (reaction !== null && !REACTIONS.includes(reaction)) throw new ExploreInputError('Choose a valid reaction.');
        const target = await requireTarget(type, id, userId);
        const identity = { targetType: type, target: id, user: userId };
        await transaction(async (session) => {
            if (reaction === null) { await FeedReaction.deleteOne(identity, { session }); return; }
            await FeedReaction.findOneAndUpdate(identity, { $set: { reaction } }, { upsert: true, new: true, runValidators: true, session });
            // Notify once per reaction kind/user/item, not on repeated taps/retries.
            await notify(target, userId, target.owner, 'reaction', `reaction:${type}:${id}:${userId}:${reaction}`, session);
        });
        return (await explore.statistics([{ type, id }], userId)).get(`${type}:${id}`);
    }
    async function addComment({ type, id, userId, input }) {
        const parsed = parseComment(input);
        const clientRequestId = requestKey(input.clientRequestId);
        const target = await requireTarget(type, id, userId);
        let saved;
        await transaction(async (session) => {
            const existing = await FeedComment.findOne({ user: userId, clientRequestId }).session(session);
            if (existing) {
                if (existing.targetType !== type || String(existing.target) !== id || existing.body !== parsed.body || String(existing.parent || '') !== String(parsed.parent || '')) {
                    throw Object.assign(new Error('That request ID was already used for another comment.'), { status: 409 });
                }
                saved = existing; return;
            }
            let parent;
            if (parsed.parent) {
                parent = await FeedComment.findOne({ _id: parsed.parent, targetType: type, target: id, state: 'visible', parent: null }).session(session);
                if (!parent) throw new ExploreInputError('Reply to an available top-level comment.');
                const blocked = await explore.blockedUsers(userId);
                if (blocked.some((entry) => String(entry) === String(parent.user))) throw unavailable();
            }
            [saved] = await FeedComment.create([{ targetType: type, target: id, user: userId, ...parsed, clientRequestId,
                policyVersion: UGC_POLICY_VERSION }], { session });
            await notify(target, userId, target.owner, parsed.parent ? 'reply' : 'comment', `comment:${saved._id}`, session, saved._id, parsed.parent);
            if (parent && String(parent.user) !== String(target.owner)) {
                await notify(target, userId, parent.user, 'reply', `comment:${saved._id}`, session, saved._id, parsed.parent);
            }
        });
        return { id: String(saved._id), body: saved.state === 'visible' ? saved.body : '', state: saved.state, parent: saved.parent, createdAt: saved.createdAt };
    }
    async function comments({ type, id, userId, parent, before }) {
        const target = await requireTarget(type, id, userId);
        if (before) objectId(before, 'comment cursor');
        let parentComment = null;
        if (parent) {
            objectId(parent, 'parent comment');
            const found = await FeedComment.findOne({ _id: parent, targetType: type, target: id, state: 'visible', parent: null }).lean();
            if (!found || (await explore.blockedUsers(userId)).some((entry) => String(entry) === String(found.user))) throw unavailable();
            parentComment = { id: String(found._id), body: found.body };
        }
        const blocked = await explore.blockedUsers(userId);
        const rows = await FeedComment.find({ targetType: type, target: id, parent: parent || null, state: 'visible',
            user: { $nin: blocked }, ...(before ? { _id: { $lt: before } } : {}),
        }).sort({ _id: -1 }).limit(21).populate('user', 'firstName businessName').lean();
        const page = rows.slice(0, 20);
        const replies = page.length && !parent ? await FeedComment.aggregate([
            { $match: { parent: { $in: page.map((row) => row._id) }, state: 'visible', user: { $nin: blocked } } },
            { $group: { _id: '$parent', count: { $sum: 1 } } },
        ]) : [];
        const counts = new Map(replies.map((entry) => [String(entry._id), entry.count]));
        return { parentComment, comments: page.map((row) => ({ id: String(row._id), body: row.body, createdAt: row.createdAt,
            authorId: row.user?._id ? String(row.user._id) : null,
            authorName: String(row.user?._id) === String(target.owner) ? row.user?.businessName || row.user?.firstName || 'Seller' : row.user?.firstName || 'NaijaGo member',
            isVendor: Boolean(target.owner && String(row.user?._id) === String(target.owner)),
            isMine: String(row.user?._id) === String(userId), parent: row.parent, replies: counts.get(String(row._id)) || 0,
        })), hasMore: rows.length > 20, nextCursor: rows.length > 20 ? String(page.at(-1)._id) : null };
    }
    async function startView({ type, id, userId }) {
        const target = await requireTarget(type, id, userId);
        const date = now();
        const identity = { targetType: type, target: id, user: userId, day: date.toISOString().slice(0, 10) };
        let view;
        try {
            view = await FeedView.findOneAndUpdate(identity, { $setOnInsert: {
                ...identity, startedAt: date, minimumMilliseconds: target.mediaKind === 'video' ? 3000 : 1000,
            } }, { upsert: true, new: true });
        } catch (error) { if (error.code !== 11000) throw error; view = await FeedView.findOne(identity); }
        if (!view.countedAt && date.getTime() - view.startedAt.getTime() > 3600000) {
            view = await FeedView.findOneAndUpdate({ _id: view._id, countedAt: { $exists: false } }, { $set: { startedAt: date } }, { new: true }) || view;
        }
        return { viewId: String(view._id), counted: Boolean(view.countedAt), minimumMilliseconds: view.minimumMilliseconds,
            media: explore.mediaFor(target.product || target.campaign),
            ...(target.campaign ? { expiresInMilliseconds: Math.max(0, target.campaign.endsAt.getTime() - date.getTime()) } : {}),
        };
    }
    async function finishView({ viewId, userId, watchedMilliseconds }) {
        objectId(viewId, 'view');
        if (!Number.isInteger(watchedMilliseconds) || watchedMilliseconds < 0 || watchedMilliseconds > 3600000) throw new ExploreInputError('Invalid watch duration.');
        const view = await FeedView.findOne({ _id: viewId, user: userId });
        if (!view) throw unavailable();
        await requireTarget(view.targetType, String(view.target), userId);
        const elapsed = now().getTime() - view.startedAt.getTime();
        if (!view.countedAt && watchedMilliseconds >= view.minimumMilliseconds && elapsed >= view.minimumMilliseconds && elapsed <= 3600000) {
            await FeedView.updateOne({ _id: view._id, user: userId, countedAt: { $exists: false } },
                { $set: { countedAt: now(), watchedMilliseconds: Math.min(watchedMilliseconds, elapsed) } });
            return { counted: true };
        }
        return { counted: Boolean(view.countedAt) };
    }
    return { react, addComment, comments, startView, finishView, requireTarget };
}
module.exports = { createExploreInteractionService, requestKey };
