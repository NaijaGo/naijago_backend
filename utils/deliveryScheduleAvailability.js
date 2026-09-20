'use strict';
const { createHash } = require('node:crypto');
const { fail, instant, schedulingTimes } = require('./orderPlanningPolicy');
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MINUTE = 60000, DAY = 86400000, WAT_OFFSET = 60 * MINUTE;

function minutes(value) {
    if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
}
function watParts(value) {
    const date = new Date(new Date(value).getTime() + WAT_OFFSET);
    return { day: DAYS[date.getUTCDay()], minutes: date.getUTCHours() * 60 + date.getUTCMinutes() };
}
// Full interval coverage, including overnight hours from the previous WAT day.
// Equal opening/closing times mean 24 hours; missing/malformed hours fail closed.
function coversOpeningHours(hours, startAt, endAt) {
    const start = new Date(startAt).getTime(), end = new Date(endAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > DAY || !Array.isArray(hours)) return false;
    const midnight = Math.floor((start + WAT_OFFSET) / DAY) * DAY - WAT_OFFSET;
    const spans = [];
    for (let offset = -1; offset <= 1; offset++) {
        const dayStart = midnight + offset * DAY;
        for (const entry of hours.filter((row) => row?.day === watParts(dayStart).day && row.isClosed !== true)) {
            const from = minutes(entry.open), to = minutes(entry.close);
            if (from !== null && to !== null) spans.push([dayStart + from * MINUTE, dayStart + (to > from ? to : to + 1440) * MINUTE]);
        }
    }
    let coveredTo = start;
    for (const [from, to] of spans.sort((a, b) => a[0] - b[0])) {
        if (from > coveredTo) break;
        coveredTo = Math.max(coveredTo, to);
        if (coveredTo >= end) return true;
    }
    return false;
}
function validPoint(point) {
    return Number.isFinite(point?.latitude) && Math.abs(point.latitude) <= 90 && Number.isFinite(point?.longitude) && Math.abs(point.longitude) <= 180;
}
function distanceKm(a, b) {
    const rad = (n) => n * Math.PI / 180;
    const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
function locationResourceKey(line) {
    if (!['naijago', 'vendor'].includes(line?.sellerType) || !validPoint(line.sellerLocation) ||
        (line.sellerType === 'vendor' && !/^[a-f\d]{24}$/i.test(String(line.sellerId || ''))) ||
        (line.sellerType === 'naijago' && line.sellerId != null)) fail('SHOP_UNAVAILABLE', 'Choose a valid shop location.', 409);
    const identity = [line.sellerType, String(line.sellerId || ''), line.sellerLocation.latitude, line.sellerLocation.longitude];
    return `${line.sellerType === 'vendor' ? 'vendor' : 'platform'}:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}
// Policy and lines are server-owned data. No client area/window/capacity IDs are
// used. Explicitly configured operational capacity is not guessed from GPS.
function resolveScheduleResources({ lines, destination, schedule, policy, now = new Date() }) {
    if (policy?.enabled !== true || policy.timeZone !== 'Africa/Lagos' || !Number.isSafeInteger(policy.revision) || policy.revision < 1) fail('SCHEDULE_UNAVAILABLE', 'Scheduled delivery is not currently available.', 503);
    if (schedule?.mode !== 'scheduled' || schedule.timeZone !== 'Africa/Lagos') fail('INVALID_WINDOW', 'Choose a scheduled delivery time in Africa/Lagos.');
    if (!Array.isArray(lines) || !lines.length || lines.length > 100 || !validPoint(destination)) fail('INVALID_ADDRESS', 'Choose products and a valid delivery location.');
    const clock = instant(now);
    const times = schedulingTimes({ startAt: instant(schedule.startAt), endAt: instant(schedule.endAt), policy, now: clock });
    const areas = (Array.isArray(policy.areas) ? policy.areas : []).filter((area) => area?.enabled === true && /^[a-zA-Z0-9_-]{1,120}$/.test(area.key || '') &&
        validPoint(area.center) && Number.isFinite(area.radiusKm) && area.radiusKm > 0 && distanceKm(area.center, destination) <= area.radiusKm);
    if (areas.length !== 1) fail('SCHEDULE_AREA_UNAVAILABLE', 'Scheduled delivery is not available for this location.', 409);
    const area = areas[0];
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(area.riderPoolKey || '')) fail('SCHEDULE_UNAVAILABLE', 'Scheduled delivery capacity has not been configured.', 503);
    const resources = new Set([`area:${area.key}`, `riders:${area.riderPoolKey}`]);
    for (const line of lines) {
        const key = locationResourceKey(line);
        if (distanceKm(area.center, line.sellerLocation) > area.radiusKm) fail('SPLIT_ORDER_REQUIRED', 'Choose shops in the same scheduled delivery area or place separate orders.', 409);
        const shops = (Array.isArray(policy.shops) ? policy.shops : []).filter((entry) => entry?.resourceKey === key && entry.enabled === true);
        if (shops.length !== 1 || line.sellerVendor?.isTemporarilyClosed === true) fail('SHOP_UNAVAILABLE', 'This shop is not accepting scheduled orders.', 409);
        const shop = shops[0];
        if (!Number.isFinite(shop.deliveryRadiusKm) || shop.deliveryRadiusKm <= 0 || distanceKm(line.sellerLocation, destination) > shop.deliveryRadiusKm) fail('OUTSIDE_DELIVERY_RADIUS', 'The address is outside this shop\'s scheduled delivery area.', 409);
        const vendor = line.sellerVendor;
        if (vendor?.deliveryRadiusKm != null && (!Number.isFinite(vendor.deliveryRadiusKm) || vendor.deliveryRadiusKm <= 0 || distanceKm(line.sellerLocation, destination) > vendor.deliveryRadiusKm)) fail('OUTSIDE_DELIVERY_RADIUS', 'The address is outside this shop\'s current delivery area.', 409);
        if (!Number.isSafeInteger(shop.preparationMinutes) || shop.preparationMinutes < 0 || shop.preparationMinutes > 1440) fail('SCHEDULE_UNAVAILABLE', 'This shop\'s preparation time has not been configured.', 503);
        if (vendor?.prepTimeMinutes != null && (!Number.isSafeInteger(vendor.prepTimeMinutes) || vendor.prepTimeMinutes < 0 || vendor.prepTimeMinutes > 1440)) fail('SCHEDULE_UNAVAILABLE', 'This shop\'s preparation time needs review.', 503);
        const preparationAt = new Date(times.dispatchAt.getTime() - Math.max(shop.preparationMinutes, vendor?.prepTimeMinutes || 0) * MINUTE);
        if (preparationAt <= clock || !coversOpeningHours(shop.operatingHours, preparationAt, times.endAt)) fail('SHOP_CLOSED', 'Choose a time within the shop\'s preparation and opening hours.', 409);
        if (Array.isArray(vendor?.operatingHours) && vendor.operatingHours.length) {
            const currentHours = vendor.operatingHours.map((entry) => ({ day: entry.day, open: entry.openTime, close: entry.closeTime, isClosed: entry.isOpen === false }));
            if (!coversOpeningHours(currentHours, preparationAt, times.endAt)) fail('SHOP_CLOSED', 'The delivery window is outside the shop\'s current opening hours.', 409);
            // Preparation must begin before the current last-order cutoff too.
            const orderHours = vendor.operatingHours.map((entry) => ({ day: entry.day, open: entry.openTime, close: entry.lastOrderTime || entry.closeTime, isClosed: entry.isOpen === false }));
            if (!coversOpeningHours(orderHours, preparationAt, new Date(preparationAt.getTime() + 1))) fail('SHOP_CLOSED', 'The shop\'s last-order cutoff has passed for this window.', 409);
        }
        resources.add(key);
    }
    if (resources.size > 22) fail('SPLIT_ORDER_REQUIRED', 'Split this basket into smaller scheduled orders.', 409);
    return { times, resourceKeys: [...resources].sort(), areaKey: area.key };
}
module.exports = { watParts, coversOpeningHours, validPoint, distanceKm, locationResourceKey, resolveScheduleResources };
