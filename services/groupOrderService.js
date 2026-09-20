'use strict';
const { fail, id, integer, instant } = require('../utils/orderPlanningPolicy');
const { normalizeItems, createInvite, inviteHash, assertOpen, assertOwner, memberOf, groupView, closedGroupItems } = require('../utils/groupOrderPolicy');

// Domain service, not a public router. The catalog and order adapters must reuse
// existing authoritative checkout validation. Never pass request-supplied prices.
function createGroupOrderService({ Group, connection, queue, validateItems, now = () => new Date() }) {
    if (typeof validateItems !== 'function' || !queue?.enqueue) throw new TypeError('Group orders require catalog validation and a transactional notification outbox.');
    const active = (row) => row.members.filter((member) => member.state === 'active');
    async function load(groupId, session) {
        const row = await Group.findById(id(groupId)).select('+destination').session(session);
        if (!row) fail('GROUP_NOT_FOUND', 'Group not found.', 404);
        return row;
    }
    async function record(row, actor, event, session) {
        row.revision += 1;
        if (row.history.length >= 1000) fail('GROUP_LIMIT_REACHED', 'This group has reached its edit limit. Please start another group.', 409);
        row.history.push({ action: event, actor, at: now(), revision: row.revision });
        await row.save({ session });
        await queue.enqueue({ type: 'group.notify', dedupeKey: `${row._id}:${row.revision}`, owner: row.owner,
            payload: { groupId: String(row._id), revision: row.revision, event }, maxAttempts: 5 }, { session });
    }
    async function create({ actor, displayName, input }) {
        id(actor); integer(input.participantLimit ?? 10, 2, 50, 'participant limit');
        const cutoffAt = instant(input.cutoffAt);
        if (cutoffAt <= now() || cutoffAt - now() > 7 * 86400000) fail('INVALID_CUTOFF', 'Choose a cutoff within the next seven days.');
        if (!['vendor', 'naijago'].includes(input.sellerType)) fail('INVALID_SELLER', 'Choose one seller.');
        const sellerId = input.sellerType === 'vendor' ? id(input.sellerId) : null;
        if (input.sellerType === 'naijago' && input.sellerId) fail('INVALID_SELLER', 'NaijaGo products cannot use a vendor identity.');
        const schedule = input.schedule || { mode: 'now' };
        if (!['now', 'scheduled'].includes(schedule.mode)) fail('INVALID_SCHEDULE', 'Choose now or a scheduled delivery.');
        let safeSchedule = { mode: 'now', timeZone: 'Africa/Lagos' };
        if (schedule.mode === 'scheduled') {
            const startAt = instant(schedule.startAt); const endAt = instant(schedule.endAt);
            if (startAt <= cutoffAt || endAt <= startAt) fail('INVALID_SCHEDULE', 'The group must close before its delivery window.');
            safeSchedule = { mode: 'scheduled', startAt, endAt, timeZone: 'Africa/Lagos' };
        }
        // This adapter also verifies the configured vendor/fulfilment point for an empty cart.
        const context = await validateItems({ items: [], sellerType: input.sellerType, sellerId, fulfillmentKey: input.fulfillmentKey });
        if (!context?.fulfillmentKey) fail('INVALID_SELLER', 'This shop is not available for group orders.', 409);
        const invite = createInvite();
        const result = await connection.transaction(async (session) => {
            const row = new Group({ owner: actor, ownerDisplayName: displayName, name: input.name,
                sellerType: input.sellerType, sellerId, fulfillmentKey: context.fulfillmentKey,
                inviteHash: invite.hash, destination: input.destination, destinationLabel: input.destinationLabel,
                schedule: safeSchedule, cutoffAt, participantLimit: input.participantLimit ?? 10,
                members: [{ user: actor, displayName, state: 'active', items: [], joinedAt: now() }] });
            await record(row, actor, 'group_created', session);
            return groupView(row, actor);
        });
        return { group: result, inviteToken: invite.token };
    }
    async function get({ groupId, actor }) {
        const row = await load(groupId, null); return groupView(row, actor);
    }
    async function join({ token, actor, displayName }) {
        id(actor); const hash = inviteHash(token);
        return connection.transaction(async (session) => {
            const row = await Group.findOne({ inviteHash: hash }).select('+destination').session(session);
            if (!row) fail('GROUP_NOT_FOUND', 'This invitation is unavailable.', 404);
            assertOpen(row, now());
            const existing = row.members.find((member) => String(member.user) === id(actor));
            if (existing?.state === 'removed') fail('GROUP_NOT_FOUND', 'This invitation is unavailable.', 404);
            if (existing) return groupView(row, actor);
            if (active(row).length >= row.participantLimit) fail('GROUP_FULL', 'This group has reached its participant limit.', 409);
            if (row.members.length >= 100) fail('GROUP_FULL', 'This group cannot accept more participants.', 409);
            row.members.push({ user: actor, displayName, state: 'active', items: [], joinedAt: now() });
            await record(row, actor, 'participant_joined', session); return groupView(row, actor);
        });
    }
    async function edit({ groupId, actor, revision, items }) {
        integer(revision, 0, Number.MAX_SAFE_INTEGER, 'group revision'); const safeItems = normalizeItems(items);
        return connection.transaction(async (session) => {
            const row = await load(groupId, session); const member = memberOf(row, actor); assertOpen(row, now());
            if (row.revision !== revision) fail('GROUP_CHANGED', 'The group changed. Refresh before editing.', 409);
            await validateItems({ items: safeItems, sellerType: row.sellerType, sellerId: row.sellerId,
                fulfillmentKey: row.fulfillmentKey, session });
            member.items = safeItems; member.submittedAt = now();
            await record(row, actor, 'items_submitted', session); return groupView(row, actor);
        });
    }
    async function control({ groupId, actor, revision, action, memberId, cutoffAt }) {
        integer(revision, 0, Number.MAX_SAFE_INTEGER, 'group revision');
        return connection.transaction(async (session) => {
            const row = await load(groupId, session); memberOf(row, actor); assertOwner(row, actor);
            if (row.revision !== revision) fail('GROUP_CHANGED', 'The group changed. Refresh before editing.', 409);
            if (!['open', 'closed'].includes(row.state)) fail('GROUP_LOCKED', 'Use the order controls after checkout begins.', 409);
            let event;
            if (action === 'close') { if (row.state === 'closed') return groupView(row, actor); row.state = 'closed'; event = 'group_closed'; }
            else if (action === 'cancel') { row.state = 'cancelled'; event = 'group_cancelled'; }
            else if (action === 'extend') {
                assertOpen(row, now()); const next = instant(cutoffAt);
                if (next <= row.cutoffAt || next - now() > 7 * 86400000 ||
                    (row.schedule.mode === 'scheduled' && next >= row.schedule.startAt)) fail('INVALID_CUTOFF', 'Choose a later cutoff before delivery and within seven days.');
                row.cutoffAt = next; event = 'group_extended';
            } else if (action === 'remove_member') {
                assertOpen(row, now());
                if (id(memberId) === String(row.owner)) fail('OWNER_REQUIRED', 'The owner cannot be removed.');
                const member = memberOf(row, memberId); member.state = 'removed'; event = 'participant_removed';
            } else fail('INVALID_ACTION', 'Unsupported group action.');
            await record(row, actor, event, session); return groupView(row, actor);
        });
    }
    async function checkout({ groupId, actor, revision, session, createOrder }) {
        if (!session?.inTransaction() || typeof createOrder !== 'function') fail('TRANSACTION_REQUIRED', 'Checkout must use the order transaction.', 500);
        const row = await load(groupId, session); memberOf(row, actor); assertOwner(row, actor);
        if (['checkout', 'ordered'].includes(row.state) && row.order) return { orderId: String(row.order), reused: true };
        if (row.revision !== integer(revision, 0, Number.MAX_SAFE_INTEGER, 'group revision')) fail('GROUP_CHANGED', 'Refresh the group before checkout.', 409);
        const items = closedGroupItems(row, actor);
        const quote = await validateItems({ items, sellerType: row.sellerType, sellerId: row.sellerId,
            fulfillmentKey: row.fulfillmentKey, destination: row.destination, schedule: row.schedule, session });
        // The shared order adapter must revalidate totals and create exactly one
        // shipment/fee for this fulfilment point; no payment is charged here.
        const order = await createOrder({ owner: row.owner, group: row, items, quote, session });
        if (!order?._id || String(order.user) !== String(row.owner)) fail('INVALID_ORDER', 'Group checkout did not create a valid owner order.', 500);
        row.order = order._id; row.state = 'checkout'; await record(row, actor, 'checkout_started', session);
        return { orderId: String(order._id), reused: false };
    }
    async function closeDue({ signal, limit = 50 } = {}) {
        integer(limit, 1, 100, 'batch limit');
        const rows = await Group.find({ state: 'open', cutoffAt: { $lte: now() } }).sort({ cutoffAt: 1 }).limit(limit).lean();
        for (const candidate of rows) {
            signal?.throwIfAborted();
            await connection.transaction(async (session) => {
                const row = await load(String(candidate._id), session);
                if (row.state !== 'open' || row.cutoffAt > now()) return;
                signal?.throwIfAborted(); row.state = 'closed'; await record(row, row.owner, 'group_closed', session);
            });
        }
        return rows.length;
    }
    return { create, get, join, edit, control, checkout, closeDue };
}
module.exports = { createGroupOrderService };
