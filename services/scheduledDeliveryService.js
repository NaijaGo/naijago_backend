const AppSetting = require('../models/AppSetting');
const { DEFAULTS, SCHEDULED_DELIVERY_SETTINGS_KEY } = require('../config/scheduledDelivery');
const { instant, calendarDate, schedulingError } = require('../utils/schedulingTime');

function normalizeConfiguration(value = {}) {
  const settings = { ...DEFAULTS, ...value };
  if (typeof settings.scheduledDeliveryEnabled !== 'boolean' ||
      !Number.isSafeInteger(settings.checkoutReservationMinutes) ||
      settings.checkoutReservationMinutes < 1 || settings.checkoutReservationMinutes > 60 ||
      settings.defaultTimeZone !== DEFAULTS.defaultTimeZone) {
    throw schedulingError('INVALID_SCHEDULING_CONFIG', 'Invalid scheduled delivery configuration.', 503);
  }
  return settings;
}

async function getScheduledDeliveryConfiguration(session) {
  let query = AppSetting.findOne({ key: SCHEDULED_DELIVERY_SETTINGS_KEY }).select('scheduledDelivery').lean();
  if (session) query = query.session(session);
  const settings = await query;
  return normalizeConfiguration(settings?.scheduledDelivery || {});
}

async function isScheduledDeliveryEnabled() {
  return (await getScheduledDeliveryConfiguration()).scheduledDeliveryEnabled;
}

function validateDeliveryWindow(window, now = new Date()) {
  try {
    if (!window || window.status !== 'open') return { eligible: false, code: 'WINDOW_CLOSED' };
    const startAt = instant(window.startAt);
    const endAt = instant(window.endAt);
    if (endAt <= startAt || startAt <= instant(now) ||
        calendarDate(startAt, window.timeZone) !== window.serviceDate ||
        !Number.isSafeInteger(window.capacity) || window.capacity < 1 ||
        !Number.isSafeInteger(window.reserved) || window.reserved < 0 ||
        !Number.isSafeInteger(window.confirmed) || window.confirmed < 0 ||
        window.reserved + window.confirmed > window.capacity) {
      return { eligible: false, code: 'INVALID_DELIVERY_WINDOW' };
    }
    return { eligible: true, code: null };
  } catch { return { eligible: false, code: 'INVALID_DELIVERY_WINDOW' }; }
}

function validateReservation({ reservation, userId, orderId, now = new Date(), confirmed = false }) {
  if (!reservation || userId == null || reservation.user == null || String(reservation.user) !== String(userId) ||
      (orderId != null && String(reservation.order) !== String(orderId))) {
    return { eligible: false, code: 'INVALID_RESERVATION_OWNER' };
  }
  if (confirmed) return { eligible: reservation.state === 'confirmed', code: reservation.state === 'confirmed' ? null : 'RESERVATION_NOT_CONFIRMED' };
  try {
    const eligible = reservation.state === 'held' && instant(reservation.expiresAt) > instant(now);
    return { eligible, code: eligible ? null : 'RESERVATION_NOT_HELD' };
  } catch { return { eligible: false, code: 'INVALID_RESERVATION' }; }
}

function evaluateScheduledOrder({ order, reservation, shipments = [], config = DEFAULTS, now = new Date(), phase = 'dispatch' }) {
  if (!order?.schedule || order.schedule.mode === 'now') return { applicable: false, eligible: false, code: 'IMMEDIATE_ORDER' };
  const settings = normalizeConfiguration(config);
  if (!settings.scheduledDeliveryEnabled) return { applicable: true, eligible: false, code: 'SCHEDULED_DELIVERY_DISABLED' };
  if (order.schedule.mode !== 'scheduled' || !['confirmed', 'preparing', 'ready', 'dispatchable'].includes(order.schedule.state)) {
    return { applicable: true, eligible: false, code: 'INVALID_SCHEDULE_STATE' };
  }
  if (!order._id || !order.user || order.isPaid !== true || order.fulfillmentHold?.active || order.paymentResult?.fulfillmentStatus === 'needs_attention' ||
      ['cancelled', 'delivered', 'completed'].includes(order.mainOrderStatus)) {
    return { applicable: true, eligible: false, code: 'PAYMENT_OR_FULFILLMENT_HOLD' };
  }
  const reservationResult = validateReservation({ reservation, userId: order.user, orderId: order._id, confirmed: true });
  if (!reservationResult.eligible || String(order.schedule.reservation) !== String(reservation?._id) ||
      String(order.schedule.window) !== String(reservation?.window)) {
    return { applicable: true, eligible: false, code: 'RESERVATION_NOT_CONFIRMED' };
  }
  try {
    const current = instant(now);
    const start = instant(order.schedule.startAt);
    const end = instant(order.schedule.endAt);
    const dispatchAt = instant(order.schedule.dispatchAt);
    const deadline = instant(order.schedule.dispatchDeadline);
    const prepareAt = instant(order.schedule.preparationAt);
    const prepareDeadline = instant(order.schedule.preparationDeadline);
    if (calendarDate(start, order.schedule.timeZone) !== reservation.windowSnapshot?.serviceDate ||
        start.getTime() !== instant(reservation.windowSnapshot?.startAt).getTime() ||
        end.getTime() !== instant(reservation.windowSnapshot?.endAt).getTime() ||
        end <= start || deadline <= dispatchAt || dispatchAt > start || deadline > end ||
        prepareAt > prepareDeadline || prepareDeadline > dispatchAt) {
      return { applicable: true, eligible: false, code: 'INVALID_SCHEDULE_TIMING' };
    }
    if (current >= deadline) return { applicable: true, eligible: false, code: 'DISPATCH_DEADLINE_PASSED' };
    if (phase !== 'dispatch' && phase !== 'preparation') throw new Error('Invalid phase');
    if (current < (phase === 'preparation' ? prepareAt : dispatchAt)) {
      return { applicable: true, eligible: false, code: 'SCHEDULE_NOT_DUE' };
    }
  } catch { return { applicable: true, eligible: false, code: 'INVALID_SCHEDULE_TIMING' }; }
  if (phase === 'dispatch') {
    const required = shipments.filter((shipment) => shipment.fulfillmentMethod !== 'pickup');
    if (!required.length || required.some((shipment) => shipment.shipmentStatus !== 'ready_for_pickup')) {
      return { applicable: true, eligible: false, code: 'SHIPMENTS_NOT_READY' };
    }
  }
  return { applicable: true, eligible: true, code: null };
}

function hasDispatchDeadlinePassed(schedule, now = new Date()) {
  return instant(now) >= instant(schedule.dispatchDeadline);
}
function hasDeliveryWindowBeenMissed(order, now = new Date()) {
  return order?.schedule?.mode === 'scheduled' && !order.isDelivered &&
    !['cancelled', 'completed', 'delivered'].includes(order.mainOrderStatus) &&
    instant(now) >= instant(order.schedule.endAt);
}

async function assertImmediateOrderRequest(body) {
  if (body?.schedule == null) return;
  if (body.schedule.mode === 'now') return;
  if (body.schedule.mode !== 'scheduled') throw schedulingError('INVALID_SCHEDULE_MODE', 'Invalid schedule mode.');
  const enabled = await isScheduledDeliveryEnabled();
  throw schedulingError(enabled ? 'SCHEDULED_CHECKOUT_NOT_AVAILABLE' : 'SCHEDULED_DELIVERY_DISABLED',
    'Scheduled checkout is not available in this release.', 409);
}

function vendorFulfillmentEligibility(order) {
  const paid = order?.isPaid === true;
  const held = Boolean(order?.fulfillmentHold?.active || order?.paymentResult?.fulfillmentStatus === 'needs_attention');
  const scheduled = order?.schedule?.mode === 'scheduled';
  return {
    paymentVerified: paid,
    fulfillmentHold: held,
    preparationEligible: paid && !held && !scheduled &&
      !['cancelled', 'completed', 'delivered'].includes(order?.mainOrderStatus),
    reason: scheduled ? 'SCHEDULED_PREPARATION_NOT_ACTIVATED' : held ? 'FULFILLMENT_HOLD' : !paid ? 'WAITING_FOR_PAYMENT' : null,
  };
}

function buildOrderScheduleSnapshot({ reservation, timing }) {
  if (!reservation || !['held', 'confirmed'].includes(reservation.state) || !timing) {
    throw schedulingError('INVALID_SCHEDULE_SNAPSHOT', 'A valid reservation and server-derived timing are required.');
  }
  const snapshot = reservation.windowSnapshot;
  return {
    mode: 'scheduled', window: reservation.window, reservation: reservation._id,
    startAt: instant(snapshot.startAt), endAt: instant(snapshot.endAt), timeZone: snapshot.timeZone,
    preparationAt: instant(timing.preparationAt), preparationDeadline: instant(timing.preparationDeadline),
    dispatchAt: instant(timing.dispatchAt), dispatchDeadline: instant(timing.dispatchDeadline),
    state: reservation.state === 'confirmed' ? 'confirmed' : 'reserved', revision: 0,
    changeHistory: [{ action: 'snapshot_created', at: new Date() }],
  };
}

module.exports = {
  normalizeConfiguration, getScheduledDeliveryConfiguration, isScheduledDeliveryEnabled,
  validateDeliveryWindow, validateReservation, evaluateScheduledOrder,
  isEligibleForPreparation: (input) => evaluateScheduledOrder({ ...input, phase: 'preparation' }),
  isEligibleForDispatch: (input) => evaluateScheduledOrder({ ...input, phase: 'dispatch' }),
  hasDispatchDeadlinePassed, hasDeliveryWindowBeenMissed, assertImmediateOrderRequest, vendorFulfillmentEligibility,
  buildOrderScheduleSnapshot,
};
