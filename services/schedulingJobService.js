const crypto = require('crypto');
const SchedulingJob = require('../models/SchedulingJob');
const DeliveryReservation = require('../models/DeliveryReservation');
const reservations = require('./deliveryReservationService');
const { getScheduledDeliveryConfiguration } = require('./scheduledDeliveryService');
const { instant, schedulingError } = require('../utils/schedulingTime');

async function enqueueSchedulingJob({ type, order, reservation, dueAt, businessKey, session }) {
  if (typeof businessKey !== 'string' || businessKey.length < 3 || businessKey.length > 200) {
    throw schedulingError('INVALID_JOB_KEY', 'A stable scheduling business key is required.');
  }
  const due = instant(dueAt);
  const identity = { type, dueAt: due, businessKey, ...(order ? { order } : {}), ...(reservation ? { reservation } : {}) };
  // Reusing a key cannot silently retarget an existing job.
  const existing = await SchedulingJob.findOne({ businessKey }).session(session || null);
  if (existing) {
    if (existing.type !== type || existing.dueAt.getTime() !== due.getTime() ||
        String(existing.order || '') !== String(order || '') || String(existing.reservation || '') !== String(reservation || '')) {
      throw schedulingError('JOB_KEY_CONFLICT', 'Scheduling job key belongs to another operation.', 409);
    }
    return existing;
  }
  try {
    const [job] = await SchedulingJob.create([{ ...identity, nextAttemptAt: due,
      notificationBusinessKey: `${businessKey}:notice` }], session ? { session } : {});
    return job;
  } catch (error) {
    // Inside a transaction the caller must retry the entire transaction after duplicate key.
    if (error.code === 11000 && !session) return enqueueSchedulingJob({ ...identity });
    throw error;
  }
}

async function claimSchedulingJob({ workerId, leaseMilliseconds = 60000 }) {
  if (typeof workerId !== 'string' || !workerId.trim() || workerId.length > 120 ||
      !Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1000 || leaseMilliseconds > 300000) {
    throw schedulingError('INVALID_WORKER_LEASE', 'Invalid scheduling worker lease.');
  }
  const now = new Date();
  return SchedulingJob.findOneAndUpdate({
    dueAt: { $lte: now }, nextAttemptAt: { $lte: now },
    $expr: { $lt: ['$attempts', '$maxAttempts'] },
    $or: [{ state: 'queued' }, { state: 'running', leaseExpiresAt: { $lte: now } }],
  }, {
    $set: { state: 'running', leaseOwner: workerId, leaseToken: crypto.randomUUID(),
      leaseExpiresAt: new Date(now.getTime() + leaseMilliseconds) },
    $inc: { attempts: 1 },
  }, { new: true, sort: { dueAt: 1, _id: 1 }, runValidators: true });
}

async function finishSchedulingJob(job, { state = 'completed', errorCode = '' } = {}) {
  const now = new Date();
  return SchedulingJob.findOneAndUpdate({
    _id: job._id, state: 'running', leaseToken: job.leaseToken, leaseExpiresAt: { $gt: now },
  }, {
    $set: { state, lastError: errorCode, nextAttemptAt: now },
    $unset: { leaseToken: '', leaseOwner: '', leaseExpiresAt: '' },
  }, { new: true, runValidators: true });
}

async function failSchedulingJob(job, error) {
  const now = new Date();
  // Persist a bounded code, not a provider response, stack trace or customer data.
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,120}$/.test(error.code) ? error.code : 'SCHEDULING_OPERATION_FAILED';
  const blocked = ['INVENTORY_COORDINATION_REQUIRED', 'SCHEDULING_HANDLER_NOT_INTEGRATED'].includes(code);
  return SchedulingJob.findOneAndUpdate({
    _id: job._id, state: 'running', leaseToken: job.leaseToken, leaseExpiresAt: { $gt: now },
  }, {
    $set: { state: blocked ? 'blocked' : job.attempts >= job.maxAttempts ? 'failed' : 'queued',
      lastError: code, nextAttemptAt: new Date(now.getTime() + Math.min(300000, 1000 * (2 ** job.attempts))) },
    $unset: { leaseToken: '', leaseOwner: '', leaseExpiresAt: '' },
  }, { new: true, runValidators: true });
}

async function handleSchedulingJob(job) {
  if (job.type !== 'reservation_expiry') {
    // Persisted boundaries exist; Stage 1 never prepares, dispatches or marks missed orders.
    throw schedulingError('SCHEDULING_HANDLER_NOT_INTEGRATED', 'Order lifecycle handlers belong to later stages.', 503);
  }
  const reservation = await DeliveryReservation.findById(job.reservation);
  if (!reservation || ['confirmed', 'released', 'expired', 'review'].includes(reservation.state)) return;
  await reservations.expireReservation({ reservationId: reservation._id, userId: reservation.user,
    revision: reservation.revision, reason: 'Checkout reservation expired.' });
}

async function processSchedulingJobs({ workerId, limit = 20 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw schedulingError('INVALID_JOB_LIMIT', 'Invalid job batch limit.');
  const config = await getScheduledDeliveryConfiguration();
  if (!config.scheduledDeliveryEnabled) return { disabled: true, processed: 0 };
  const now = new Date();
  // Recover a crash on the final attempt without leaving permanently running records.
  await SchedulingJob.updateMany({ state: 'running', leaseExpiresAt: { $lte: now },
    $expr: { $gte: ['$attempts', '$maxAttempts'] } }, {
    $set: { state: 'failed', lastError: 'LEASE_EXPIRED_ATTEMPTS_EXHAUSTED' },
    $unset: { leaseToken: '', leaseOwner: '', leaseExpiresAt: '' },
  });
  let processed = 0;
  for (; processed < limit; processed += 1) {
    const job = await claimSchedulingJob({ workerId });
    if (!job) break;
    try {
      await handleSchedulingJob(job);
      await finishSchedulingJob(job);
    } catch (error) { await failSchedulingJob(job, error); }
  }
  return { disabled: false, processed };
}

module.exports = { enqueueSchedulingJob, claimSchedulingJob, finishSchedulingJob, failSchedulingJob, handleSchedulingJob, processSchedulingJobs };
