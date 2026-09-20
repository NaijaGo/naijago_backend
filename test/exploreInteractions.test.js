const test = require('node:test');
const assert = require('node:assert/strict');
const { createExploreInteractionService, requestKey } = require('../services/exploreInteractionService');
const { UGC_POLICY_VERSION } = require('../utils/explorePolicy');
const id = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const userId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const owner = 'cccccccccccccccccccccccc';
const commentId = 'dddddddddddddddddddddddd';
const date = new Date('2026-09-20T12:00:00Z');
const target = { targetType: 'product', target: id, owner, title: 'Real product', mediaKind: 'video' };
const query = (value) => ({ session: async () => value, lean: async () => value });
function setup(overrides = {}) {
    const calls = [];
    const session = { transaction: 'test' };
    const service = createExploreInteractionService({
        connection: { transaction: async (work) => work(session) },
        FeedReaction: { findOneAndUpdate: async (...args) => calls.push(['reaction', ...args]), deleteOne: async () => calls.push(['remove']) },
        FeedComment: { findOne: () => query(null), create: async (docs) => [{ ...docs[0], _id: commentId, state: 'visible', createdAt: date }] },
        FeedView: {}, queue: { enqueue: async (...args) => calls.push(['job', ...args]) },
        explore: { loadTarget: async () => target, blockedUsers: async () => [], statistics: async () => new Map([[`product:${id}`, { myReaction: 'love' }]]) },
        now: () => date, ...overrides,
    });
    return { service, calls, session };
}
test('reaction persists in the same transaction as its deduplicated notification', async () => {
    const { service, calls, session } = setup();
    assert.equal((await service.react({ type: 'product', id, userId, reaction: 'love' })).myReaction, 'love');
    assert.equal(calls[0][3].session, session);
    assert.equal(calls[1][2].session, session);
    assert.equal(calls[1][1].dedupeKey, `reaction:product:${id}:${userId}:love:${owner}`);
    await assert.rejects(service.react({ type: 'product', id, userId, reaction: 'invalid' }));
});
test('removing a reaction does not send a vendor notification', async () => {
    const { service, calls } = setup();
    await service.react({ type: 'product', id, userId, reaction: null });
    assert.deepEqual(calls, [['remove']]);
});
test('comment validation rejects missing guidelines, invalid keys and missing parents', async () => {
    const { service } = setup();
    await assert.rejects(service.addComment({ type: 'product', id, userId, input: { body: 'Hello' } }), /guidelines/);
    assert.throws(() => requestKey('short'));
    await assert.rejects(service.addComment({ type: 'product', id, userId, input: { body: 'Hello', policyVersion: UGC_POLICY_VERSION, clientRequestId: 'request-1234567890', parent: owner } }), /top-level/);
});
test('comment retries return the same record without creating another notification', async () => {
    const input = { body: 'Is this available?', clientRequestId: 'request-1234567890', policyVersion: UGC_POLICY_VERSION };
    const existing = { ...input, _id: commentId, user: userId, targetType: 'product', target: id, state: 'visible', parent: null };
    const { service, calls } = setup({ FeedComment: { findOne: () => query(existing), create: async () => assert.fail('must not duplicate') } });
    assert.equal((await service.addComment({ type: 'product', id, userId, input })).id, commentId);
    assert.equal(calls.length, 0);
    await assert.rejects(service.addComment({ type: 'product', id, userId, input: { ...input, body: 'Changed' } }), { status: 409 });
});
test('a reply notifies the vendor and parent author without sending to self', async () => {
    const parentAuthor = 'eeeeeeeeeeeeeeeeeeeeeeee';
    const { service, calls } = setup({ FeedComment: {
        findOne: (filter) => query(filter.clientRequestId ? null : { _id: owner, user: parentAuthor }),
        create: async (docs) => [{ ...docs[0], _id: commentId, state: 'visible' }],
    } });
    await service.addComment({ type: 'product', id, userId, input: { body: 'Reply', parent: owner, policyVersion: UGC_POLICY_VERSION, clientRequestId: 'request-1234567890' } });
    assert.deepEqual(calls.map((call) => call[1].owner), [owner, parentAuthor]);
    assert.ok(calls.every((call) => call[1].payload.parentId === owner));
});
test('views are not counted before the server-observed minimum or for another account', async () => {
    let updates = 0;
    let startedAt = new Date(date.getTime() - 1000);
    const { service } = setup({ FeedView: { findOne: async (filter) => filter.user === userId ? { _id: id, targetType: 'product', target: id, startedAt, minimumMilliseconds: 3000 } : null,
        updateOne: async () => updates++ } });
    assert.deepEqual(await service.finishView({ viewId: id, userId, watchedMilliseconds: 3000 }), { counted: false });
    startedAt = new Date(date.getTime() - 4000);
    assert.deepEqual(await service.finishView({ viewId: id, userId, watchedMilliseconds: 3000 }), { counted: true });
    assert.equal(updates, 1);
    await assert.rejects(service.finishView({ viewId: id, userId: owner, watchedMilliseconds: 3000 }), { status: 404 });
});
test('expired or unavailable targets cannot receive new interactions', async () => {
    const { service } = setup({ explore: { loadTarget: async () => null } });
    await assert.rejects(service.react({ type: 'campaign', id, userId, reaction: 'like' }), { status: 404 });
    await assert.rejects(service.startView({ type: 'campaign', id, userId }), { status: 404 });
});
test('duplicate-key transaction races retry only a bounded number of times', async () => {
    let attempts = 0;
    const { service } = setup({ connection: { transaction: async () => { attempts++; throw Object.assign(new Error('duplicate'), { code: 11000 }); } } });
    await assert.rejects(service.react({ type: 'product', id, userId, reaction: 'like' }));
    assert.equal(attempts, 3);
});

test('starting playback returns freshly authorized media and the campaign expiry budget', async () => {
    const campaign = { endsAt: new Date(date.getTime() + 2500) };
    const { service } = setup({
        explore: { loadTarget: async () => ({ ...target, campaign, targetType: 'campaign' }),
            mediaFor: (row) => { assert.equal(row, campaign); return { kind: 'video', url: 'https://media.example/approved' }; } },
        FeedView: { findOneAndUpdate: async () => ({ _id: id, startedAt: date, minimumMilliseconds: 3000 }) },
    });
    const receipt = await service.startView({ type: 'campaign', id, userId });
    assert.equal(receipt.media.url, 'https://media.example/approved');
    assert.equal(receipt.expiresInMilliseconds, 2500);
    assert.equal(receipt.counted, false);
});

test('an abandoned uncounted receipt can be restarted after an hour without adding another row', async () => {
    let calls = 0;
    const row = { _id: id, startedAt: new Date(date.getTime() - 3600001), minimumMilliseconds: 3000 };
    const { service } = setup({
        explore: { loadTarget: async () => target, mediaFor: () => ({ kind: 'video' }) },
        FeedView: { findOneAndUpdate: async (filter, update) => {
            calls++;
            if (calls === 2) {
                assert.deepEqual(filter.countedAt, { $exists: false });
                assert.equal(update.$set.startedAt, date);
                return { ...row, startedAt: date };
            }
            return row;
        } },
    });
    assert.equal((await service.startView({ type: 'product', id, userId })).viewId, id);
    assert.equal(calls, 2);
});
