// One source of defaults. Stage 1 does not seed or enable this setting.
const SCHEDULED_DELIVERY_SETTINGS_KEY = 'scheduled_delivery';
const DEFAULTS = Object.freeze({
  scheduledDeliveryEnabled: false,
  checkoutReservationMinutes: 15,
  defaultTimeZone: 'Africa/Lagos',
});
const SCHEDULE_STATES = Object.freeze([
  'pending', 'reserved', 'confirmed', 'preparing', 'ready', 'dispatchable',
  'in_delivery', 'completed', 'cancelled', 'missed', 'needs_attention',
]);
const RESERVATION_STATES = Object.freeze(['held', 'confirmed', 'released', 'expired', 'review']);

module.exports = { DEFAULTS, SCHEDULED_DELIVERY_SETTINGS_KEY, SCHEDULE_STATES, RESERVATION_STATES };
