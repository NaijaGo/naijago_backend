const express = require('express');
const axios = require('axios');
const { rateLimit } = require('express-rate-limit');
const { protect } = require('../middleware/authMiddleware');
const { normalizeGeoapifySuggestion } = require('../utils/locationSuggestions');

const router = express.Router();
const suggestionCache = new Map();
const SUGGESTION_CACHE_TTL_MS = 5 * 60 * 1000;
const SUGGESTION_CACHE_MAX_ENTRIES = 250;
const autocompleteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many location searches. Please wait a moment and try again.' },
});

router.get('/autocomplete', protect, autocompleteLimiter, async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2 || query.length > 160) {
    return res.status(400).json({ message: 'Enter at least 2 characters to search for an address.' });
  }

  const apiKey = process.env.GEOAPIFY_API_KEY?.trim();
  if (!apiKey) {
    return res.status(503).json({ message: 'Address suggestions are temporarily unavailable.' });
  }

  const latitude = Number(req.query.lat);
  const longitude = Number(req.query.lng);
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, ' ');
  const biasKey = Number.isFinite(latitude) && Number.isFinite(longitude)
    ? `${latitude.toFixed(2)},${longitude.toFixed(2)}`
    : 'ng';
  const cacheKey = `${normalizedQuery}|${biasKey}`;
  const cached = suggestionCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt <= SUGGESTION_CACHE_TTL_MS) {
    return res.json({ suggestions: cached.suggestions, cached: true });
  }
  const params = {
    text: query,
    format: 'json',
    filter: 'countrycode:ng',
    lang: 'en',
    limit: 15,
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
    let rawResults = response.data?.results || [];
    if (rawResults.length === 0) {
      const fallbackResponse = await axios.get('https://api.geoapify.com/v1/geocode/search', {
        params,
        timeout: 10000,
      });
      rawResults = fallbackResponse.data?.results || [];
    }
    const seen = new Set();
    const suggestions = rawResults
      .map(normalizeGeoapifySuggestion)
      .filter((suggestion) => suggestion && !seen.has(suggestion.id) && seen.add(suggestion.id));
    suggestionCache.set(cacheKey, { suggestions, createdAt: Date.now() });
    if (suggestionCache.size > SUGGESTION_CACHE_MAX_ENTRIES) {
      suggestionCache.delete(suggestionCache.keys().next().value);
    }
    return res.json({ suggestions });
  } catch (error) {
    console.error('Geoapify autocomplete failed:', error.response?.status || error.message);
    return res.status(502).json({ message: 'Address suggestions are temporarily unavailable.' });
  }
});

module.exports = router;
