const crypto = require('crypto');
const AppSetting = require('../models/AppSetting');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const MainOrder = require('../models/MainOrder');
const DisputeRequest = require('../models/DisputeRequest');
const NotificationLog = require('../models/NotificationLog');
const OperationsDigest = require('../models/OperationsDigest');
const { publishAdminActivity } = require('./adminActivityService');

const DEFAULTS = Object.freeze({ visitorTrackingEnabled: false, updatesEnabled: false, pushEnabled: false, intervalMinutes: 60 });
const METRICS = Object.freeze({
  newOrders: 'New orders',
  paidOrders: 'Paid orders created in this period',
  pendingFulfillment: 'Paid orders awaiting fulfilment now',
  openDisputes: 'Open disputes now',
  failedNotifications: 'Failed notification records in this period',
  guestSessions: 'Anonymous guest sessions in this period',
  pageViews: 'Consented page views in this period',
});
const query = (operation) => operation.maxTimeMS(10000);

async function getSettings() {
  const setting = await query(AppSetting.findOne({ key: 'operations_monitor' }).select('operationsMonitor').lean());
  return { ...DEFAULTS, ...setting?.operationsMonitor };
}

function validateSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !Object.hasOwn(DEFAULTS, key))) throw new Error('Invalid monitoring settings.');
  for (const key of ['visitorTrackingEnabled', 'updatesEnabled', 'pushEnabled']) {
    if (typeof body[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
  }
  if (!Number.isSafeInteger(body.intervalMinutes) || body.intervalMinutes < 15 || body.intervalMinutes > 1440) {
    throw new Error('Update interval must be a whole number between 15 and 1440 minutes.');
  }
  return Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, body[key]]));
}

async function visitorStats(days = 1, page = 1) {
  const from = new Date(Date.now() - days * 86400000);
  const match = { eventType: 'visitor_page_view', user: { $exists: false }, createdAt: { $gte: from } };
  const [summary, pages, sources, recent, total] = await Promise.all([
    query(AnalyticsEvent.aggregate([{ $match: match }, { $group: { _id: '$sessionId', views: { $sum: 1 } } },
      { $group: { _id: null, sessions: { $sum: 1 }, views: { $sum: '$views' } } }])),
    query(AnalyticsEvent.aggregate([{ $match: match }, { $group: { _id: '$targetId', views: { $sum: 1 } } }, { $sort: { views: -1 } }, { $limit: 30 }])),
    query(AnalyticsEvent.aggregate([{ $match: match }, { $group: { _id: '$source', views: { $sum: 1 } } }])),
    query(AnalyticsEvent.find(match).select('sessionId source targetId metadata.deviceClass createdAt').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 30).limit(30).lean()),
    query(AnalyticsEvent.countDocuments(match)),
  ]);
  return { days, page, total, hasMore: page * 30 < total, sessions: summary[0]?.sessions || 0,
    views: summary[0]?.views || 0, pages, sources,
    recent: recent.map((event) => ({ session: event.sessionId.slice(0, 12), source: event.source, page: event.targetId,
      device: event.metadata?.deviceClass, createdAt: event.createdAt })) };
}

async function operationalSnapshot(from, to) {
  const createdAt = { $gte: from, $lt: to };
  const [newOrders, paidOrders, pendingFulfillment, openDisputes, failedNotifications, visitors] = await Promise.all([
    query(MainOrder.countDocuments({ createdAt })),
    query(MainOrder.countDocuments({ createdAt, isPaid: true })),
    query(MainOrder.countDocuments({ isPaid: true, mainOrderStatus: { $in: ['processing', 'partially_shipped'] } })),
    query(DisputeRequest.countDocuments({ status: { $in: ['pending', 'reviewing'] } })),
    query(NotificationLog.countDocuments({ createdAt, status: 'failed' })),
    query(AnalyticsEvent.aggregate([{ $match: { eventType: 'visitor_page_view', createdAt } }, { $facet: {
      views: [{ $count: 'count' }],
      guests: [{ $match: { user: { $exists: false } } }, { $group: { _id: '$sessionId' } }, { $count: 'count' }],
    } }])),
  ]);
  return { newOrders, paidOrders, pendingFulfillment, openDisputes, failedNotifications,
    guestSessions: visitors[0]?.guests[0]?.count || 0, pageViews: visitors[0]?.views[0]?.count || 0 };
}

function describe(snapshot, priorities) {
  return priorities.map((key) => `${METRICS[key]}: ${snapshot[key]}`).join('. ') || 'No activity recorded in this reporting period.';
}

async function runDigest(app) {
  const settings = await getSettings();
  if (!settings.updatesEnabled) return;
  const interval = settings.intervalMinutes * 60000;
  const to = new Date(Math.floor(Date.now() / interval) * interval);
  const from = new Date(to.getTime() - interval);
  const id = `operations:${settings.intervalMinutes}:${to.getTime()}`;
  const owner = crypto.randomUUID();
  let digest;
  try {
    digest = await OperationsDigest.findOneAndUpdate({ _id: id, status: { $ne: 'completed' },
      $or: [{ leaseUntil: { $lte: new Date() } }, { leaseUntil: { $exists: false } }] },
    { $set: { leaseOwner: owner, leaseUntil: new Date(Date.now() + 180000) },
      $setOnInsert: { status: 'processing', windowStart: from, windowEnd: to, expiresAt: new Date(Date.now() + 30 * 86400000) } },
    { upsert: true, new: true, setDefaultsOnInsert: true });
  } catch (error) {
    if (error.code === 11000) return;
    throw error;
  }
  if (digest.status === 'processing') {
    const snapshot = await operationalSnapshot(from, to);
    const priorities = ['openDisputes', 'failedNotifications', 'pendingFulfillment', 'newOrders', 'paidOrders', 'guestSessions', 'pageViews']
      .filter((key) => snapshot[key] > 0);
    digest = await OperationsDigest.findOneAndUpdate({ _id: id, leaseOwner: owner, leaseUntil: { $gt: new Date() } },
      { $set: { snapshot, priorities, generator: 'rules', status: 'ready' } }, { new: true });
    if (!digest) return;
  }
  const stillOwned = await OperationsDigest.findOneAndUpdate({ _id: id, leaseOwner: owner, leaseUntil: { $gt: new Date() } },
    { $set: { leaseUntil: new Date(Date.now() + 180000) } }, { new: true });
  if (!stillOwned || !(await getSettings()).updatesEnabled) return;
  const event = await publishAdminActivity(app, { eventId: id, eventType: 'operations_digest', category: 'system',
    severity: digest.snapshot.openDisputes || digest.snapshot.failedNotifications ? 'warning' : 'info',
    title: 'Operations update', message: describe(digest.snapshot, digest.priorities),
    destination: { page: 'operations-monitor.html' },
    metadata: { pushToAdmin: settings.pushEnabled, generator: 'rules', windowStart: from, windowEnd: to } });
  if (event) await OperationsDigest.updateOne({ _id: id, leaseOwner: owner }, { $set: { status: 'completed' } });
}

let timer;
function startOperationsMonitor(app) {
  if (timer) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runDigest(app); } catch (_) { console.warn('Operations monitor update unavailable.'); }
    finally { running = false; }
  };
  timer = setInterval(tick, 60000);
  timer.unref();
  void tick();
}

module.exports = { DEFAULTS, METRICS, getSettings, validateSettings, visitorStats, operationalSnapshot, startOperationsMonitor };
