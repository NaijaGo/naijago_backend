'use strict';

// Abuja launch: explicit WAT calendar arithmetic, independent of server timezone.
const MINUTE = 60000;
const DAY = 86400000;
const WAT_OFFSET = 60 * MINUTE;
const TIME_ZONE = 'Africa/Lagos';

class PlanningError extends Error {
    constructor(code, message, statusCode = 400) {
        super(message); this.name = 'PlanningError'; this.code = code; this.statusCode = statusCode;
    }
}
const fail = (code, message, status = 400) => { throw new PlanningError(code, message, status); };
function integer(value, min, max, label) {
    if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INPUT', `Invalid ${label}.`);
    return value;
}
function id(value) {
    const result = String(value || '');
    if (!/^[a-f\d]{24}$/i.test(result)) fail('INVALID_ID', 'Invalid record identifier.');
    return result.toLowerCase();
}
function instant(value) {
    // Never accept timezone-less request timestamps or JS date rollover.
    if (!(value instanceof Date) && (typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))) {
        fail('INVALID_TIME', 'Choose a date and time with an explicit timezone.');
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) fail('INVALID_TIME', 'Invalid date or time.');
    if (typeof value === 'string') {
        calendarDate(value.slice(0, 10));
        const hour = Number(value.slice(11, 13)); const minute = Number(value.slice(14, 16)); const second = Number(value.slice(17, 19));
        if (hour > 23 || minute > 59 || second > 59) fail('INVALID_TIME', 'Invalid date or time.');
    }
    return date;
}
function calendarDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('INVALID_DATE', 'Use a valid calendar date.');
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('INVALID_DATE', 'Use a valid calendar date.');
    return date;
}
function clockMinutes(value) {
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('INVALID_TIME', 'Use a valid 24-hour time.');
    return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function watInstant(date, time) {
    return new Date(calendarDate(date).getTime() + clockMinutes(time) * MINUTE - WAT_OFFSET);
}
function normalizeRecurrence(input) {
    if (!input || input.timeZone !== TIME_ZONE) fail('INVALID_TIME_ZONE', 'This launch supports West Africa Time (Africa/Lagos).');
    const start = calendarDate(input.startDate);
    const frequency = input.frequency;
    if (!['weekly', 'biweekly', 'monthly', 'custom_days'].includes(frequency)) fail('INVALID_FREQUENCY', 'Choose a supported repeat frequency.');
    const intervalDays = frequency === 'custom_days' ? integer(input.intervalDays, 1, 365, 'repeat interval') : null;
    const startMinute = clockMinutes(input.windowStart); const endMinute = clockMinutes(input.windowEnd);
    if (endMinute <= startMinute) fail('INVALID_WINDOW', 'Delivery windows must end after they start on the same day.');
    const endDate = input.endDate ? calendarDate(input.endDate) : null;
    if (endDate && endDate < start) fail('INVALID_DATE', 'End date must not precede the start date.');
    const maxOccurrences = input.maxOccurrences == null ? null : integer(input.maxOccurrences, 1, 1000, 'occurrence limit');
    if (input.paymentMode && input.paymentMode !== 'reminder_to_pay') fail('AUTOPAY_UNAVAILABLE', 'Automatic charges are not enabled. Each order needs your approval and payment.');
    return { timeZone: TIME_ZONE, startDate: input.startDate, frequency, intervalDays,
        windowStart: input.windowStart, windowEnd: input.windowEnd, endDate: input.endDate || null,
        maxOccurrences, paymentMode: 'reminder_to_pay' };
}
function occurrenceAt(input, index) {
    const rule = normalizeRecurrence(input); integer(index, 0, 999, 'occurrence number');
    if (rule.maxOccurrences !== null && index >= rule.maxOccurrences) return null;
    const anchor = calendarDate(rule.startDate);
    let day;
    if (rule.frequency === 'monthly') {
        // Always retain the original day: Jan 31 -> Feb 28 -> Mar 31, not Mar 28.
        const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + index, 1));
        const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
        day = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(anchor.getUTCDate(), lastDay)));
    } else {
        const days = rule.frequency === 'weekly' ? 7 : rule.frequency === 'biweekly' ? 14 : rule.intervalDays;
        day = new Date(anchor.getTime() + days * index * DAY);
    }
    const date = day.toISOString().slice(0, 10);
    if (rule.endDate && date > rule.endDate) return null;
    return { number: index + 1, date, timeZone: TIME_ZONE, startAt: watInstant(date, rule.windowStart), endAt: watInstant(date, rule.windowEnd) };
}
function upcomingOccurrences(input, { after = new Date(), limit = 12 } = {}) {
    integer(limit, 1, 52, 'preview count'); const cutoff = instant(after);
    const result = [];
    for (let index = 0; index < 1000 && result.length < limit; index++) {
        const value = occurrenceAt(input, index);
        if (!value) break;
        if (value.startAt > cutoff) result.push(value);
    }
    return result;
}
function schedulingTimes({ startAt, endAt, now = new Date(), policy }) {
    const start = instant(startAt); const end = instant(endAt); const clock = instant(now);
    if (!policy || policy.timeZone !== TIME_ZONE) fail('INVALID_POLICY', 'Delivery scheduling is not configured.', 503);
    const lead = integer(policy.minimumLeadMinutes, 1, 10080, 'minimum lead time');
    const advance = integer(policy.maximumAdvanceDays, 1, 365, 'advance booking limit');
    const dispatch = integer(policy.dispatchLeadMinutes, 0, lead, 'dispatch lead time');
    const change = integer(policy.changeCutoffMinutes, dispatch, 10080, 'change deadline');
    const hold = integer(policy.paymentHoldMinutes, 1, 60, 'checkout hold');
    if (start <= clock || end <= start || end - start > DAY || start - clock < lead * MINUTE || start - clock > advance * DAY) {
        fail('WINDOW_UNAVAILABLE', 'This delivery window is outside the available booking period.', 409);
    }
    const dispatchAt = new Date(start.getTime() - dispatch * MINUTE);
    const changeCutoffAt = new Date(start.getTime() - change * MINUTE);
    const expiresAt = new Date(Math.min(clock.getTime() + hold * MINUTE, dispatchAt.getTime(), changeCutoffAt.getTime()));
    if (expiresAt <= clock) fail('WINDOW_UNAVAILABLE', 'It is too late to reserve this delivery window.', 409);
    return { timeZone: TIME_ZONE, startAt: start, endAt: end, dispatchAt, changeCutoffAt, expiresAt };
}
function canDispatch(order, now = new Date()) {
    if (!order?.isPaid || ['pending_payment', 'cancelled', 'completed', 'delivered'].includes(order.mainOrderStatus)) return false;
    if (!order.schedule || order.schedule.mode === 'now') return true;
    if (order.schedule.mode !== 'scheduled' || order.schedule.state !== 'confirmed') return false;
    try { return instant(order.schedule.dispatchAt) <= instant(now) && instant(order.schedule.endAt) > instant(now); }
    catch (_) { return false; }
}
function assertScheduleChange(order, now = new Date()) {
    if (order?.schedule?.mode !== 'scheduled' || order.schedule.state !== 'confirmed' || !order.isPaid ||
        order.isClaimed || order.rider || order.assignedRider || order.mainOrderStatus !== 'processing' ||
        instant(now) >= instant(order.schedule.changeCutoffAt)) fail('SCHEDULE_LOCKED', 'This order can no longer be changed automatically. Please contact support.', 409);
}

module.exports = { PlanningError, fail, integer, id, instant, calendarDate, clockMinutes, watInstant,
    normalizeRecurrence, occurrenceAt, upcomingOccurrences, schedulingTimes, canDispatch, assertScheduleChange, TIME_ZONE };
