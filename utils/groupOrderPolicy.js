'use strict';
const crypto = require('crypto');
const { fail, id, integer, instant } = require('./orderPlanningPolicy');

function normalizeItems(items) {
    if (!Array.isArray(items) || items.length > 100) fail('INVALID_ITEMS', 'Choose up to 100 items.');
    const seen = new Set();
    return items.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) fail('INVALID_ITEMS', 'Choose valid cart items.');
        const product = id(item.product); const offer = item.offer ? id(item.offer) : null;
        const variantId = item.variantId ? id(item.variantId) : null;
        if (item.selectedSize != null && !variantId) fail('VARIANT_REQUIRED', 'Choose this product variant again before adding it to the shared or recurring cart.');
        const quantity = integer(item.quantity, 1, 99, 'quantity');
        const note = item.customerNote == null ? '' : item.customerNote;
        if (typeof note !== 'string' || note.length > 500) fail('INVALID_NOTE', 'Order notes must be 500 characters or fewer.');
        const key = [product, offer, variantId].join(':');
        if (seen.has(key)) fail('DUPLICATE_ITEM', 'Combine duplicate product variants into one quantity.');
        seen.add(key);
        // Price, seller, stock and commercial display data come from the catalog.
        return { product, offer, variantId, quantity, customerNote: note.trim() };
    });
}
function createInvite() { const token = crypto.randomBytes(32).toString('base64url'); return { token, hash: inviteHash(token) }; }
function inviteHash(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail('INVALID_INVITE', 'This group invitation is invalid.', 404);
    return crypto.createHash('sha256').update(token).digest('hex');
}
function assertOpen(group, now = new Date()) {
    if (group.state !== 'open' || instant(group.cutoffAt) <= instant(now)) fail('GROUP_CLOSED', 'This group is closed. No items can be added or changed.', 409);
}
function assertOwner(group, actor) { if (String(group.owner) !== id(actor)) fail('OWNER_REQUIRED', 'Only the group owner can do this.', 403); }
function memberOf(group, actor) {
    const who = id(actor); const member = group.members.find((entry) => String(entry.user) === who && entry.state === 'active');
    if (!member) fail('GROUP_NOT_FOUND', 'Group not found.', 404);
    return member;
}
function groupView(group, actor) {
    const member = memberOf(group, actor); const owner = String(group.owner) === id(actor);
    const own = { items: normalizeItems(member.items || []), submittedAt: member.submittedAt || null };
    const view = { id: String(group._id), name: group.name, ownerName: group.ownerDisplayName,
        state: group.state, cutoffAt: group.cutoffAt, revision: group.revision,
        sellerType: group.sellerType, sellerId: group.sellerId ? String(group.sellerId) : null,
        destinationLabel: group.destinationLabel, schedule: group.schedule || null, isOwner: owner,
        own, memberCount: group.members.filter((entry) => entry.state === 'active').length };
    if (owner) {
        view.destination = group.destination;
        view.members = group.members.map((entry) => ({ user: String(entry.user), displayName: entry.displayName,
            state: entry.state, items: normalizeItems(entry.items || []), submittedAt: entry.submittedAt || null }));
        view.orderId = group.order ? String(group.order) : null;
    }
    return view;
}
function closedGroupItems(group, actor) {
    assertOwner(group, actor);
    if (group.state !== 'closed') fail('GROUP_NOT_CLOSED', 'Close the group before checkout.', 409);
    const result = [];
    for (const member of group.members.filter((entry) => entry.state === 'active' && entry.submittedAt)) {
        for (const item of normalizeItems(member.items || [])) result.push({ ...item, participant: String(member.user) });
    }
    if (!result.length) fail('EMPTY_GROUP', 'The group has no submitted items.', 409);
    // Do not deduplicate here: per-participant attribution is retained. Stock must
    // be validated against aggregated product/offer/variant quantities at checkout.
    return result;
}
module.exports = { normalizeItems, createInvite, inviteHash, assertOpen, assertOwner, memberOf, groupView, closedGroupItems };
