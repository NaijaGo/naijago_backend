const { DEFAULTS } = require('../config/scheduledDelivery');

function schedulingError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function instant(value) {
  if (value == null || value === '' || typeof value === 'boolean') {
    throw schedulingError('INVALID_SCHEDULE_TIME', 'A valid timestamp is required.');
  }
  if (typeof value === 'string' && !/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw schedulingError('INVALID_SCHEDULE_TIME', 'Timestamps must include an explicit UTC offset.');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw schedulingError('INVALID_SCHEDULE_TIME', 'Invalid timestamp.');
  return date;
}

function assertTimeZone(timeZone = DEFAULTS.defaultTimeZone) {
  // Stage 1 supports Nigeria business scheduling only. Fail closed for other zones.
  if (timeZone !== DEFAULTS.defaultTimeZone) {
    throw schedulingError('UNSUPPORTED_SCHEDULE_TIMEZONE', 'Scheduling timezone must be Africa/Lagos.');
  }
  return timeZone;
}

function calendarDate(value, timeZone = DEFAULTS.defaultTimeZone) {
  assertTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant(value));
  const read = (type) => parts.find((part) => part.type === type).value;
  return `${read('year')}-${read('month')}-${read('day')}`;
}

function validateServiceDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw schedulingError('INVALID_SERVICE_DATE', 'Service date must be YYYY-MM-DD.');
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw schedulingError('INVALID_SERVICE_DATE', 'Invalid calendar date.');
  }
  return value;
}

function localTimeToUtc(serviceDate, time, timeZone = DEFAULTS.defaultTimeZone) {
  validateServiceDate(serviceDate);
  assertTimeZone(timeZone);
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw schedulingError('INVALID_LOCAL_TIME', 'Time must be HH:mm.');
  }
  // Africa/Lagos uses UTC+01:00; conversion never depends on process.env.TZ.
  return instant(`${serviceDate}T${time}:00+01:00`);
}

function addCalendarDays(serviceDate, days) {
  validateServiceDate(serviceDate);
  if (!Number.isSafeInteger(days)) throw schedulingError('INVALID_INTERVAL', 'Days must be an integer.');
  const date = new Date(`${serviceDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addCalendarMonths(serviceDate, months) {
  validateServiceDate(serviceDate);
  if (!Number.isSafeInteger(months)) throw schedulingError('INVALID_INTERVAL', 'Months must be an integer.');
  const date = new Date(`${serviceDate}T00:00:00Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

function windowBoundaries({ serviceDate, startTime, endTime, timeZone = DEFAULTS.defaultTimeZone }) {
  const startAt = localTimeToUtc(serviceDate, startTime, timeZone);
  let endAt = localTimeToUtc(serviceDate, endTime, timeZone);
  if (endAt <= startAt) endAt = localTimeToUtc(addCalendarDays(serviceDate, 1), endTime, timeZone);
  return { serviceDate, startAt, endAt, timeZone };
}

function preparationTimes({ startAt, endAt, travelMinutes, preparationMinutes }) {
  const start = instant(startAt);
  const end = instant(endAt);
  if (end <= start || ![travelMinutes, preparationMinutes].every(
    (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1440,
  )) throw schedulingError('INVALID_SCHEDULE_TIMING', 'Invalid preparation or route timing.');
  const dispatchAt = new Date(start.getTime() - travelMinutes * 60000);
  return {
    dispatchAt, dispatchDeadline: new Date(end.getTime() - travelMinutes * 60000),
    preparationDeadline: dispatchAt,
    preparationAt: new Date(dispatchAt.getTime() - preparationMinutes * 60000),
  };
}

module.exports = {
  schedulingError, instant, assertTimeZone, calendarDate, validateServiceDate,
  localTimeToUtc, addCalendarDays, addCalendarMonths, windowBoundaries, preparationTimes,
};
