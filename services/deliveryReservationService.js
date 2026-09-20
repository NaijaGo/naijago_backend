'use strict';
const crypto = require('crypto');
const { fail, id, integer, instant, schedulingTimes } = require('../utils/orderPlanningPolicy');

function createDeliveryReservationService({ Window, Reservation, connection, now = () => new Date() }) {
    async function transaction(work, session) {
        if (session) { if (!session.inTransaction()) fail('TRANSACTION_REQUIRED', 'An active checkout transaction is required.', 500); return work(session); }
        for (let attempt = 0; attempt < 3; attempt++) {
            try { return await connection.transaction(work); }
            catch (error) { if (error.code !== 11000 || attempt === 2) throw error; }
        }
    }
    async function reserve({ orderId, owner, windowIds, resourceKeys, policy, session }) {
        id(orderId); id(owner);
        if (!Array.isArray(windowIds) || !windowIds.length || windowIds.length > 22 || new Set(windowIds.map(String)).size !== windowIds.length) fail('INVALID_WINDOWS', 'Choose a valid delivery window.');
        const keys = windowIds.map(id).sort();
        // resourceKeys and policy MUST be derived by server-side cart/area/vendor
        // validation, not accepted from an HTTP request. All resources are required.
        if (!Array.isArray(resourceKeys) || resourceKeys.length !== keys.length || new Set(resourceKeys).size !== resourceKeys.length ||
            resourceKeys.some((key) => typeof key !== 'string' || !/^(area|vendor|platform|riders):[a-zA-Z0-9_-]{1,120}$/.test(key))) fail('INVALID_RESOURCES', 'Delivery capacity configuration is invalid.', 503);
        const revision = integer(policy?.revision, 1, Number.MAX_SAFE_INTEGER, 'policy revision');
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify([id(owner), keys, [...resourceKeys].sort(), revision])).digest('hex');
        return transaction(async (tx) => {
            const existing = await Reservation.findOne({ order: orderId }).session(tx);
            if (existing) {
                if (existing.fingerprint !== fingerprint || String(existing.owner) !== id(owner)) fail('RESERVATION_CHANGED', 'This checkout already has a different delivery reservation.', 409);
                if (existing.state === 'confirmed' || (existing.state === 'held' && existing.expiresAt > now())) return existing;
                fail('RESERVATION_EXPIRED', 'Your delivery reservation expired. Choose a new checkout.', 409);
            }
            const windows = await Window.find({ _id: { $in: keys } }).sort({ _id: 1 }).session(tx).lean();
            if (windows.length !== keys.length || windows.some((window) => !window.enabled || window.policyRevision !== revision) ||
                JSON.stringify(windows.map((window) => window.resourceKey).sort()) !== JSON.stringify([...resourceKeys].sort())) fail('WINDOW_UNAVAILABLE', 'This delivery window is unavailable.', 409);
            const times = schedulingTimes({ startAt: windows[0].startAt, endAt: windows[0].endAt, now: now(), policy });
            if (windows.some((window) => +window.startAt !== +times.startAt || +window.endAt !== +times.endAt)) fail('SPLIT_ORDER_REQUIRED', 'These vendors do not share a delivery window. Please split the order.', 409);
            for (const window of windows) {
                const result = await Window.updateOne({ _id: window._id, enabled: true, policyRevision: revision,
                    $expr: { $lt: ['$used', '$capacity'] } }, { $inc: { used: 1 } }, { session: tx });
                if (result.modifiedCount !== 1) fail('WINDOW_FULL', 'This delivery window just filled up. Choose another window.', 409);
            }
            const [row] = await Reservation.create([{ order: orderId, owner, windowIds: keys, fingerprint, state: 'held', policyRevision: revision, ...times }], { session: tx });
            return row;
        }, session);
    }
    async function confirm({ orderId, owner, session }) {
        id(orderId); id(owner);
        // Internal settlement hook: the caller verifies provider payment first.
        // Must share its transaction with inventory and the paid MainOrder write.
        if (!session?.inTransaction()) fail('TRANSACTION_REQUIRED', 'Payment confirmation requires the settlement transaction.', 500);
        const row = await Reservation.findOne({ order: orderId, owner }).session(session);
        if (!row) fail('RESERVATION_NOT_FOUND', 'Delivery reservation is missing.', 409);
        if (row.state === 'confirmed') return row;
        if (row.state !== 'held' || row.expiresAt <= now() || row.dispatchAt <= now()) fail('PAID_SLOT_NEEDS_ATTENTION', 'Payment must be reconciled because the delivery reservation expired.', 409);
        row.state = 'confirmed'; row.confirmedAt = now(); await row.save({ session }); return row;
    }
    async function release({ orderId, owner, expiredOnly = false, session }) {
        id(orderId); id(owner);
        return transaction(async (tx) => {
            const row = await Reservation.findOne({ order: orderId, owner }).session(tx);
            if (!row || ['released', 'expired'].includes(row.state)) return row;
            if (expiredOnly && (row.state !== 'held' || row.expiresAt > now())) return row;
            // Confirmed-order refunds/cancellation authorization belong to the
            // existing order service; never call this directly from a client.
            for (const windowId of row.windowIds) {
                const result = await Window.updateOne({ _id: windowId, used: { $gte: 1 } }, { $inc: { used: -1 } }, { session: tx });
                if (result.modifiedCount !== 1) fail('CAPACITY_INCONSISTENT', 'Delivery capacity needs operational review.', 503);
            }
            row.state = expiredOnly ? 'expired' : 'released'; row.releasedAt = now(); await row.save({ session: tx }); return row;
        }, session);
    }
    async function expire({ limit = 50, signal } = {}) {
        integer(limit, 1, 100, 'expiry batch size');
        const rows = await Reservation.find({ state: 'held', expiresAt: { $lte: instant(now()) } }).sort({ expiresAt: 1 }).limit(limit).lean();
        for (const row of rows) { signal?.throwIfAborted(); await release({ orderId: String(row.order), owner: String(row.owner), expiredOnly: true }); }
        return rows.length;
    }
    return { reserve, confirm, release, expire };
}
module.exports = { createDeliveryReservationService };
