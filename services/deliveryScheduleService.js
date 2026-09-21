'use strict';
const { fail } = require('../utils/orderPlanningPolicy');
const { resolveScheduleResources } = require('../utils/deliveryScheduleAvailability');
const { assertScheduleQuoteUnchanged } = require('../utils/scheduledOrderSnapshot');

function createSchedulePolicyReader(AppSetting) {
    return async ({ session } = {}) => {
        const query = AppSetting.findOne({ key: 'scheduled_delivery_program' }).select('scheduledDelivery');
        if (session) query.session(session);
        return (await query.lean())?.scheduledDelivery || null;
    };
}

// No network calls or global models on import. Configuration, catalog lines and
// the active transaction come from server composition, never a request body.
function createDeliveryScheduleService({ Window, readPolicy, reservations, now = () => new Date() }) {
    if (!Window?.find || typeof readPolicy !== 'function') throw new TypeError('Schedule availability requires configured windows and a server policy reader.');
    async function resolve(args, requireCapacity) {
        const policy = await readPolicy({ session: args.session });
        const result = resolveScheduleResources({ ...args, policy, now: now() });
        const query = Window.find({ resourceKey: { $in: result.resourceKeys }, startAt: result.times.startAt,
            endAt: result.times.endAt, enabled: true, policyRevision: policy.revision }).sort({ resourceKey: 1 });
        if (args.session) query.session(args.session);
        const windows = await query.lean();
        if (windows.length !== result.resourceKeys.length || result.resourceKeys.some((key) => windows.filter((row) => row.resourceKey === key).length !== 1)) {
            fail('SCHEDULE_UNAVAILABLE', 'No common delivery window is available for these shops. Choose another time or split the order.', 409);
        }
        if (windows.some((row) => !Number.isSafeInteger(row.capacity) || row.capacity < 1 || !Number.isSafeInteger(row.used) || row.used < 0 || row.used > row.capacity)) {
            fail('SCHEDULE_UNAVAILABLE', 'Scheduled delivery capacity needs review.', 503);
        }
        if (requireCapacity && windows.some((row) => row.used >= row.capacity)) fail('WINDOW_FULL', 'This delivery window is full. Choose another time.', 409);
        return { ...result, windows, policy };
    }
    async function check(args) {
        const { times, areaKey, policy } = await resolve(args, true);
        // No resource IDs/operational capacity are accepted back as authority.
        return { eligible: true, schedule: { mode: 'scheduled', timeZone: 'Africa/Lagos',
            startAt: times.startAt, endAt: times.endAt, dispatchAt: times.dispatchAt,
            changeCutoffAt: times.changeCutoffAt, policyRevision: policy.revision, areaKey } };
    }
    async function reserve(args) {
        if (!args.session?.inTransaction() || !reservations?.reserve) fail('TRANSACTION_REQUIRED', 'Scheduled order creation requires an active transaction.', 500);
        // Do not reject a retry because its OWN existing hold filled a window.
        // The reservation service checks identity first, then atomically claims
        // all resources with used < capacity inside this same transaction.
        const { windows, resourceKeys, policy, times, areaKey } = await resolve(args, false);
        if (args.expectedSchedule) assertScheduleQuoteUnchanged(args.expectedSchedule, {
            mode: 'scheduled', timeZone: 'Africa/Lagos', startAt: times.startAt, endAt: times.endAt,
            dispatchAt: times.dispatchAt, changeCutoffAt: times.changeCutoffAt, policyRevision: policy.revision, areaKey,
        });
        return reservations.reserve({ orderId: args.orderId, owner: args.owner, windowIds: windows.map((row) => String(row._id)), resourceKeys, policy, session: args.session });
    }
    return { check, reserve };
}
module.exports = { createDeliveryScheduleService, createSchedulePolicyReader };
