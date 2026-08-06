const crypto = require('crypto');

const ActivityEvent = require('../models/ActivityEvent');
const User = require('../models/User');
const notificationService = require('./notificationService');

const VALID_CATEGORIES = new Set([
  'customer', 'vendor', 'pharmacist', 'product', 'order', 'payment', 'rider',
  'delivery', 'wallet', 'withdrawal', 'dispute', 'return', 'subscription',
  'referral', 'chat', 'company', 'system',
]);
const VALID_SEVERITIES = new Set(['info', 'success', 'warning', 'critical']);

const cleanObjectId = (value) => {
  const normalized = value?._id || value;
  return normalized && /^[a-f\d]{24}$/i.test(String(normalized)) ? normalized : undefined;
};

const normalizeEvent = (payload = {}) => {
  const eventType = String(payload.eventType || 'system_activity').trim().toLowerCase();
  const category = VALID_CATEGORIES.has(payload.category) ? payload.category : 'system';
  const severity = VALID_SEVERITIES.has(payload.severity) ? payload.severity : 'info';
  const eventId = String(payload.eventId || `${eventType}:${crypto.randomUUID()}`);

  return {
    eventId,
    eventType,
    category,
    severity,
    title: String(payload.title || 'NaijaGo activity').trim(),
    message: String(payload.message || 'A platform activity occurred.').trim(),
    actor: payload.actor ? {
      type: String(payload.actor.type || '').trim(),
      id: cleanObjectId(payload.actor.id),
      name: String(payload.actor.name || '').trim(),
    } : undefined,
    target: payload.target ? {
      type: String(payload.target.type || '').trim(),
      id: cleanObjectId(payload.target.id),
      name: String(payload.target.name || '').trim(),
    } : undefined,
    order: cleanObjectId(payload.orderId || payload.order),
    shipment: cleanObjectId(payload.shipmentId || payload.shipment),
    session: cleanObjectId(payload.sessionId || payload.session),
    destination: {
      page: String(payload.destination?.page || payload.page || '').trim(),
      params: payload.destination?.params || payload.params || {},
    },
    metadata: payload.metadata || {},
  };
};

const socketPayload = (event) => ({
  id: String(event._id),
  eventId: event.eventId,
  eventType: event.eventType,
  category: event.category,
  severity: event.severity,
  title: event.title,
  message: event.message,
  actor: event.actor,
  target: event.target,
  orderId: event.order ? String(event.order) : null,
  shipmentId: event.shipment ? String(event.shipment) : null,
  sessionId: event.session ? String(event.session) : null,
  destination: event.destination,
  createdAt: event.createdAt,
});

async function publishAdminActivity(app, payload = {}) {
  const normalized = normalizeEvent(payload);
  let event;

  try {
    event = await ActivityEvent.findOneAndUpdate(
      { eventId: normalized.eventId },
      { $setOnInsert: normalized },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    console.error('Admin activity persistence failed:', error.message);
    return null;
  }

  const livePayload = socketPayload(event);
  app?.get('notifyAdmin')?.(livePayload);

  if (event.push?.status !== 'pending') return event;

  if (event.metadata?.pushToAdmin === false) {
    event.push = { status: 'skipped', errorMessage: 'Activity is feed-only.' };
    await event.save();
    return event;
  }

  try {
    const admins = await User.find({ isAdmin: true }).select('_id').lean();
    const adminIds = admins.map((admin) => String(admin._id));
    if (!adminIds.length || !notificationService.hasAudienceConfiguration('admin')) {
      event.push = { status: 'skipped', errorMessage: 'Admin push is not configured.' };
    } else {
      const response = await notificationService.sendToUsers(adminIds, {
        title: event.title,
        message: event.message,
        data: { ...livePayload, type: 'admin_activity' },
      }, { audience: 'admin' });
      event.push = {
        status: 'sent',
        sentAt: new Date(),
        providerResponse: response?.body || response || null,
      };
    }
  } catch (error) {
    event.push = { status: 'failed', errorMessage: error.message };
  }

  await event.save().catch((error) => {
    console.error('Admin activity push status update failed:', error.message);
  });
  return event;
}

module.exports = { normalizeEvent, publishAdminActivity, socketPayload };
