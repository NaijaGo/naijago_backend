const mongoose = require('mongoose');
const crypto = require('crypto');
const DeliveryReservation = require('../models/DeliveryReservation');
const DeliveryWindow = require('../models/DeliveryWindow');
const MainOrder = require('../models/MainOrder');
const SchedulingJob = require('../models/SchedulingJob');
const { getScheduledDeliveryConfiguration, validateDeliveryWindow } = require('./scheduledDeliveryService');
const { schedulingError } = require('../utils/schedulingTime');

function requireId(value) {
  if (!mongoose.isObjectIdOrHexString(value)) throw schedulingError('INVALID_SCHEDULING_ID', 'Invalid resource ID.');
  return new mongoose.Types.ObjectId(value).toHexString();
}
function validateReservationOwnership(reservation, userId) {
  requireId(userId);
  if (!reservation || String(reservation.user) !== String(userId)) {
    throw schedulingError('RESERVATION_NOT_FOUND', 'Reservation not found.', 404);
  }
}
function validateReservationRevision(reservation, revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw schedulingError('INVALID_RESERVATION_REVISION', 'A revision is required.');
  if (reservation.revision !== revision) throw schedulingError('RESERVATION_CONFLICT', 'Reservation changed. Refresh and retry.', 409);
}

function normalizeAllocations(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) {
    throw schedulingError('INVALID_INVENTORY_ALLOCATIONS', 'Provide between 1 and 100 inventory allocations.');
  }
  const merged = new Map();
  for (const item of items) {
    const allocation = { product: requireId(item?.product), offer: item.offer == null ? null : requireId(item.offer),
      variantId: item.variantId == null ? null : requireId(item.variantId), selectedSize: item.selectedSize ?? '', quantity: item.quantity };
    if (typeof allocation.selectedSize !== 'string' || allocation.selectedSize.length > 120 ||
        !Number.isSafeInteger(allocation.quantity) || allocation.quantity < 1 || allocation.quantity > 10000) {
      throw schedulingError('INVALID_INVENTORY_ALLOCATIONS', 'Invalid exact item or quantity.');
    }
    const key = JSON.stringify([allocation.product, allocation.offer, allocation.variantId, allocation.selectedSize]);
    if (merged.has(key)) merged.get(key).quantity += allocation.quantity;
    else merged.set(key, allocation);
    if (merged.get(key).quantity > 10000) throw schedulingError('INVALID_INVENTORY_ALLOCATIONS', 'Quantity exceeds reservation limit.');
  }
  return [...merged.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

async function transaction(operation) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await operation(session); });
    return result;
  } finally { await session.endSession(); }
}

function createReservationService({ inventoryAdapter = null } = {}) {
  function requireInventoryAdapter() {
    // STOPPED Stage 1 portion: legacy stock deduction ignores holds. No unsafe ledger fallback.
    if (!inventoryAdapter || ['assertCompatible', 'validateEligibility', 'reserve', 'confirm', 'release'].some(
      (method) => typeof inventoryAdapter[method] !== 'function',
    )) throw schedulingError('INVENTORY_COORDINATION_REQUIRED', 'Inventory holds require coordination with every stock writer before activation.', 503);
    return inventoryAdapter;
  }

  async function retrieveReservation({ reservationId, userId, session }) {
    let query = DeliveryReservation.findById(requireId(reservationId));
    if (session) query = query.session(session);
    const reservation = await query;
    validateReservationOwnership(reservation, userId);
    return reservation;
  }

  async function createReservation({ userId, windowId, inventoryAllocations, idempotencyKey, expectedWindowRevision }) {
    userId = requireId(userId); windowId = requireId(windowId);
    if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9:_-]{8,120}$/.test(idempotencyKey) ||
        !Number.isSafeInteger(expectedWindowRevision) || expectedWindowRevision < 0) {
      throw schedulingError('INVALID_RESERVATION_REQUEST', 'A valid business key and window revision are required.');
    }
    const allocations = normalizeAllocations(inventoryAllocations);
    const requestHash = crypto.createHash('sha256').update(JSON.stringify({ windowId: String(windowId), allocations })).digest('hex');
    const existing = await DeliveryReservation.findOne({ user: userId, idempotencyKey });
    if (existing) {
      if (existing.requestHash !== requestHash) throw schedulingError('IDEMPOTENCY_CONFLICT', 'Key was used for a different reservation.', 409);
      return existing;
    }
    const config = await getScheduledDeliveryConfiguration();
    if (!config.scheduledDeliveryEnabled) throw schedulingError('SCHEDULED_DELIVERY_DISABLED', 'Scheduled delivery is disabled.', 409);
    const adapter = requireInventoryAdapter();
    await adapter.assertCompatible();
    try {
      return await transaction(async (session) => {
        // Re-read settings within the transaction and capture server time on each retry.
        const currentConfig = await getScheduledDeliveryConfiguration(session);
        if (!currentConfig.scheduledDeliveryEnabled) throw schedulingError('SCHEDULED_DELIVERY_DISABLED', 'Scheduled delivery is disabled.', 409);
        const now = new Date();
        const window = await DeliveryWindow.findById(windowId).session(session);
        const validity = validateDeliveryWindow(window, now);
        if (!validity.eligible) throw schedulingError(validity.code, 'Selected delivery window is unavailable.', 409);
        if (window.revision !== expectedWindowRevision) throw schedulingError('WINDOW_CONFLICT', 'Delivery window changed.', 409);
        await adapter.validateEligibility({ window, userId, allocations, session });
        const heldWindow = await DeliveryWindow.findOneAndUpdate({
          _id: windowId, revision: expectedWindowRevision, status: 'open', startAt: { $gt: now },
          $expr: { $lt: [{ $add: ['$reserved', '$confirmed'] }, '$capacity'] },
        }, { $inc: { reserved: 1, revision: 1 } }, { new: true, session, runValidators: true });
        if (!heldWindow) throw schedulingError('WINDOW_FULL_OR_CHANGED', 'Delivery window has no available capacity.', 409);
        await adapter.reserve({ userId, allocations, session, businessKey: `${userId}:${idempotencyKey}` });
        const [reservation] = await DeliveryReservation.create([{
          user: userId, window: windowId, inventoryAllocations: allocations, idempotencyKey, requestHash,
          expiresAt: new Date(now.getTime() + currentConfig.checkoutReservationMinutes * 60000),
          windowSnapshot: { serviceDate: window.serviceDate, startAt: window.startAt, endAt: window.endAt,
            timeZone: window.timeZone, revision: window.revision },
          history: [{ to: 'held', reason: 'checkout_hold', actor: userId, at: now }],
        }], { session });
        await SchedulingJob.create([{
          type: 'reservation_expiry', reservation: reservation._id, dueAt: reservation.expiresAt,
          nextAttemptAt: reservation.expiresAt, businessKey: `reservation:${reservation._id}:expiry`,
          notificationBusinessKey: `reservation:${reservation._id}:expiry:notice`,
        }], { session });
        return reservation;
      });
    } catch (error) {
      if (error.code === 11000) {
        const winner = await DeliveryReservation.findOne({ user: userId, idempotencyKey });
        if (winner?.requestHash === requestHash) return winner;
        if (winner) throw schedulingError('IDEMPOTENCY_CONFLICT', 'Key was used for a different reservation.', 409);
      }
      throw error;
    }
  }

  async function changeState({ reservationId, userId, revision, to, reason, orderId }) {
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) {
      throw schedulingError('RESERVATION_REASON_REQUIRED', 'A clear reason is required.');
    }
    if (orderId != null) requireId(orderId);
    return transaction(async (session) => {
      const reservation = await retrieveReservation({ reservationId, userId, session });
      if (reservation.state === to) {
        if (orderId != null && String(reservation.order) !== String(orderId)) throw schedulingError('RESERVATION_CONFLICT', 'Order linkage differs.', 409);
        return reservation;
      }
      validateReservationRevision(reservation, revision);
      const now = new Date();
      if (to === 'review') {
        if (!['held', 'confirmed'].includes(reservation.state)) throw schedulingError('RESERVATION_CONFLICT', 'Terminal reservation cannot enter review.', 409);
      } else if (to === 'confirmed') {
        // Review resolution remains a later-stage support operation.
        if (reservation.state !== 'held' || reservation.expiresAt <= now || !orderId) {
          throw schedulingError('RESERVATION_NOT_CONFIRMABLE', 'Reservation requires reconciliation.', 409);
        }
        if (reservation.order && String(reservation.order) !== String(orderId)) throw schedulingError('RESERVATION_CONFLICT', 'Reservation belongs to another order.', 409);
        const order = await MainOrder.findById(orderId).session(session);
        if (!order?.isPaid || String(order.user) !== String(userId) || order.schedule?.mode !== 'scheduled' ||
            String(order.schedule.reservation) !== String(reservation._id) ||
            String(order.schedule.window) !== String(reservation.window) || order.fulfillmentHold?.active ||
            ['cancelled', 'completed', 'delivered'].includes(order.mainOrderStatus)) {
          throw schedulingError('PAYMENT_NOT_CONFIRMED', 'Server-verified eligible payment is required.', 409);
        }
      } else {
        if (reservation.state !== 'held') throw schedulingError('RESERVATION_CONFLICT', 'Only temporary holds can be released.', 409);
        if (to === 'expired' && reservation.expiresAt > now) throw schedulingError('RESERVATION_NOT_DUE', 'Reservation has not expired.', 409);
        if (reservation.order) {
          const order = await MainOrder.findById(reservation.order).session(session);
          // No provider call and no invented financial conclusion. Retain pending/paid holds for review.
          if (!order || order.isPaid || order.paymentResult?.tx_ref) {
            return changeToReview(reservation, session, now, 'Payment reconciliation required before releasing inventory.');
          }
        }
      }
      if (to === 'review') return changeToReview(reservation, session, now, reason);
      const adapter = requireInventoryAdapter();
      await adapter.assertCompatible();
      const windowDelta = to === 'confirmed' ? { reserved: -1, confirmed: 1, revision: 1 } : { reserved: -1, revision: 1 };
      const window = await DeliveryWindow.findOneAndUpdate({ _id: reservation.window, reserved: { $gte: 1 } },
        { $inc: windowDelta }, { new: true, session, runValidators: true });
      if (!window) throw schedulingError('RESERVATION_CAPACITY_CONFLICT', 'Reservation capacity requires review.', 409);
      await adapter[to === 'confirmed' ? 'confirm' : 'release']({ reservation, allocations: reservation.inventoryAllocations, session });
      const updated = await DeliveryReservation.findOneAndUpdate({ _id: reservation._id, revision, state: 'held' }, {
        $set: { state: to, ...(orderId ? { order: orderId } : {}) }, $inc: { revision: 1 },
        $push: { history: { from: reservation.state, to, reason: reason.trim(), actor: userId, at: now } },
      }, { new: true, session, runValidators: true });
      if (!updated) throw schedulingError('RESERVATION_CONFLICT', 'Reservation changed.', 409);
      return updated;
    });
  }

  async function changeToReview(reservation, session, now, reason) {
    const updated = await DeliveryReservation.findOneAndUpdate({ _id: reservation._id, revision: reservation.revision, state: reservation.state }, {
      $set: { state: 'review' }, $inc: { revision: 1 },
      $push: { history: { from: reservation.state, to: 'review', reason, at: now } },
    }, { new: true, session, runValidators: true });
    if (!updated) throw schedulingError('RESERVATION_CONFLICT', 'Reservation changed.', 409);
    return updated;
  }

  return {
    assertInventoryCoordination: requireInventoryAdapter,
    createReservation, retrieveReservation, validateReservationOwnership, validateReservationRevision,
    confirmReservation: (input) => changeState({ ...input, to: 'confirmed' }),
    releaseReservation: (input) => changeState({ ...input, to: 'released' }),
    expireReservation: (input) => changeState({ ...input, to: 'expired' }),
    reconcileReservation: (input) => changeState({ ...input, to: 'review' }),
  };
}

module.exports = { ...createReservationService(), createReservationService, normalizeAllocations,
  validateReservationOwnership, validateReservationRevision };
