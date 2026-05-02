const express = require('express');
const jwt = require('jsonwebtoken');
const { trackAnalyticsEvent } = require('../services/analyticsService');

const router = express.Router();

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
