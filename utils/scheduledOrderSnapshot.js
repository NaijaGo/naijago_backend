'use strict';
const { fail, instant } = require('./orderPlanningPolicy');

function scheduleQuoteSnapshot(value) {
    if (!value || value.mode === 'now') return { mode: 'now' };
    if (value.mode !== 'scheduled' || value.timeZone !== 'Africa/Lagos' || !Number.isSafeInteger(value.policyRevision) || value.policyRevision < 1 ||
        typeof value.areaKey !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value.areaKey)) fail('SCHEDULE_CHANGED', 'Review and approve the current delivery window.', 409);
    return { mode: 'scheduled', timeZone: value.timeZone, policyRevision: value.policyRevision, areaKey: value.areaKey,
        startAt: instant(value.startAt).toISOString(), endAt: instant(value.endAt).toISOString(),
        dispatchAt: instant(value.dispatchAt).toISOString(), changeCutoffAt: instant(value.changeCutoffAt).toISOString() };
}
function assertScheduleQuoteUnchanged(expected, actual) {
    if (JSON.stringify(scheduleQuoteSnapshot(expected)) !== JSON.stringify(scheduleQuoteSnapshot(actual))) {
        fail('SCHEDULE_CHANGED', 'Your delivery window or its conditions changed. Review and approve the new window.', 409);
    }
}
function reservationSnapshot(row, areaKey) {
    const value = { mode: 'scheduled', reservation: row._id, state: row.state, timeZone: row.timeZone, areaKey,
        policyRevision: row.policyRevision, startAt: row.startAt, endAt: row.endAt, dispatchAt: row.dispatchAt,
        changeCutoffAt: row.changeCutoffAt, expiresAt: row.expiresAt, confirmedAt: row.confirmedAt };
    scheduleQuoteSnapshot(value);
    return value;
}

module.exports = { scheduleQuoteSnapshot, assertScheduleQuoteUnchanged, reservationSnapshot };
