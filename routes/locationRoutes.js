const express = require('express');
const axios = require('axios');
const { rateLimit } = require('express-rate-limit');
const { protect } = require('../middleware/authMiddleware');
const { normalizeGeoapifySuggestion } = require('../utils/locationSuggestions');

const router = express.Router();
const autocompleteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many location searches. Please wait a moment and try again.' },
});

router.get('/autocomplete', protect, autocompleteLimiter, async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 3 || query.length > 160) {
    return res.status(400).json({ message: 'Enter at least 3 characters to search for an address.' });
  }

  const apiKey = process.env.GEOAPIFY_API_KEY?.trim();
  if (!apiKey) {
    return res.status(503).json({ message: 'Address suggestions are temporarily unavailable.' });
  }

  const latitude = Number(req.query.lat);
  const longitude = Number(req.query.lng);
  const params = {
    text: query,
    format: 'json',
    filter: 'countrycode:ng',
    lang: 'en',
    limit: 6,
    apiKey,
  };
  if (Number.isFinite(latitude) && Number.isFinite(longitude)
      && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
    params.bias = `proximity:${longitude},${latitude}`;
  } else {
    params.bias = 'countrycode:ng';
  }

  try {
    const response = await axios.get('https://api.geoapify.com/v1/geocode/autocomplete', {
      params,
      timeout: 10000,
    });
    const suggestions = (response.data?.results || [])
      .map(normalizeGeoapifySuggestion)
      .filter(Boolean);
    return res.json({ suggestions });
  } catch (error) {
    console.error('Geoapify autocomplete failed:', error.response?.status || error.message);
    return res.status(502).json({ message: 'Address suggestions are temporarily unavailable.' });
  }
});

module.exports = router;
