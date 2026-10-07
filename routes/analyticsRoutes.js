const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const { getSettings } = require('../services/operationsMonitorService');
const { trackAnalyticsEvent } = require('../services/analyticsService');

const router = express.Router();
const visitorLimiter = rateLimit({ windowMs: 15 * 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { message: 'Too many analytics requests. Please try later.' } });
const pages = new Set(['home', 'cart', 'categories', 'explore', 'account', 'about', 'contact', 'download', 'policies', 'privacy', 'delete_account']);
const devices = new Set(['android', 'ios', 'web_mobile', 'web_desktop', 'other']);

router.get('/visitor-config', visitorLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ enabled: (await getSettings()).visitorTrackingEnabled === true }); }
  catch (_) { res.status(503).json({ enabled: false }); }
});

router.post('/visitor', visitorLimiter, async (req, res) => {
  const body = req.body;
  const allowed = new Set(['sessionId', 'page', 'source', 'deviceClass', 'consent']);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !allowed.has(key)) || body.consent !== true
    || typeof body.sessionId !== 'string' || !/^[a-f0-9]{32}$/i.test(body.sessionId)
    || !pages.has(body.page) || !devices.has(body.deviceClass)
    || !['customer_app', 'website'].includes(body.source)) {
    return res.status(400).json({ message: 'Invalid visitor event or consent missing.' });
  }
  try {
    if (!(await getSettings()).visitorTrackingEnabled) return res.status(204).end();
    const user = optionalUserId(req);
    const sessionId = crypto.createHash('sha256').update(`${body.source}:${body.sessionId.toLowerCase()}`).digest('hex');
    const dedupeKey = crypto.createHash('sha256').update(`${sessionId}:${user || 'guest'}:${body.page}:${Math.floor(Date.now() / 60000)}`).digest('hex');
    await AnalyticsEvent.updateOne({ dedupeKey }, { $setOnInsert: {
      eventType: 'visitor_page_view', ...(user ? { user } : {}), sessionId, source: body.source,
      targetType: 'page', targetId: body.page, metadata: { deviceClass: body.deviceClass, consent: true },
      expiresAt: new Date(Date.now() + 30 * 86400000),
    } }, { upsert: true, runValidators: true });
    return res.status(204).end();
  } catch (error) {
    if (error.code === 11000) return res.status(204).end();
    return res.status(503).json({ message: 'Visitor analytics temporarily unavailable.' });
  }
});

function optionalUserId(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return undefined;

  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    return decoded.id;
  } catch (_) {
    return undefined;
  }
}

router.post('/track', async (req, res) => {
  try {
    const event = await trackAnalyticsEvent({
      ...req.body,
      user: optionalUserId(req),
    });

    res.status(201).json({ ok: true, id: event._id });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      message: error.statusCode ? error.message : 'Failed to track analytics event.',
    });
  }
});

module.exports = router;
