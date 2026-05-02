const AnalyticsEvent = require('../models/AnalyticsEvent');

const allowedEvents = new Set([
  'carousel_click',
  'restaurant_card_click',
  'food_order_created',
  'pharmacy_consultation_start',
]);

function sanitizeText(value, maxLength = 120) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function sanitizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 30)
      .map(([key, entryValue]) => {
        if (entryValue === null || entryValue === undefined) return [key, entryValue];
        if (typeof entryValue === 'number' || typeof entryValue === 'boolean') {
          return [key, entryValue];
        }
        return [key, String(entryValue).slice(0, 500)];
      }),
  );
}

async function trackAnalyticsEvent(payload = {}, options = {}) {
  const eventType = sanitizeText(payload.eventType, 80);
  if (!allowedEvents.has(eventType)) {
    const error = new Error('Invalid analytics event type.');
    error.statusCode = 400;
    throw error;
  }

  const event = {
    eventType,
    user: payload.user || undefined,
    sessionId: sanitizeText(payload.sessionId, 120),
    source: sanitizeText(payload.source, 80),
    targetType: sanitizeText(payload.targetType, 60),
    targetId: sanitizeText(payload.targetId, 120),
    placement: sanitizeText(payload.placement, 40),
    city: sanitizeText(payload.city, 80),
    metadata: sanitizeMetadata(payload.metadata),
  };

  const [created] = await AnalyticsEvent.create([event], options);
  return created;
}

module.exports = {
  allowedEvents,
  trackAnalyticsEvent,
};
