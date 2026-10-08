const express = require('express');
const axios = require('axios');
const { rateLimit } = require('express-rate-limit');
const { protect } = require('../middleware/authMiddleware');
const { normalizeGeoapifySuggestion } = require('../utils/locationSuggestions');

const router = express.Router();
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
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
const reverseCache = new Map();

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

router.get('/reverse', protect, autocompleteLimiter, async (req, res) => {
  if (typeof req.query.lat !== 'string' || !req.query.lat.trim()
      || typeof req.query.lng !== 'string' || !req.query.lng.trim()) {
    return res.status(400).json({ message: 'Valid latitude and longitude are required.' });
  }
  const latitude = Number(req.query.lat);
  const longitude = Number(req.query.lng);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || (latitude === 0 && longitude === 0)) {
    return res.status(400).json({ message: 'Valid latitude and longitude are required.' });
  }

  const cacheKey = `${latitude},${longitude}`;
  const cached = reverseCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt <= SUGGESTION_CACHE_TTL_MS) {
    return res.json({ address: cached.address, cached: true });
  }

  const apiKey = process.env.GEOAPIFY_API_KEY?.trim();
  if (!apiKey) {
    return res.status(503).json({ message: 'Automatic address lookup is temporarily unavailable.' });
  }

  try {
    const response = await axios.get('https://api.geoapify.com/v1/geocode/reverse', {
      params: { lat: latitude, lon: longitude, format: 'json', lang: 'en', apiKey },
      timeout: 10000,
    });
    const result = response.data?.results?.[0];
    if (!result) return res.status(404).json({ message: 'No address was found for these coordinates.' });

    const addressLine = clean(result.address_line1)
      || [clean(result.housenumber), clean(result.street)].filter(Boolean).join(' ')
      || clean(result.suburb);
    const city = clean(result.city) || clean(result.town) || clean(result.village)
      || clean(result.county);
    if (!addressLine && !city) {
      return res.status(404).json({ message: 'No address was found for these coordinates.' });
    }
    const address = {
      address: addressLine,
      addressLine,
      street: clean(result.street),
      area: clean(result.suburb) || clean(result.district),
      landmark: '',
      state: clean(result.state),
      city,
      postalCode: clean(result.postcode),
      country: clean(result.country),
      formattedAddress: clean(result.formatted)
        || [addressLine || city, city, clean(result.postcode), clean(result.country)]
          .filter(Boolean).join(', '),
      latitude,
      longitude,
    };
    reverseCache.set(cacheKey, { address, createdAt: Date.now() });
    if (reverseCache.size > SUGGESTION_CACHE_MAX_ENTRIES) {
      reverseCache.delete(reverseCache.keys().next().value);
    }
    return res.json({ address });
  } catch (error) {
    console.error('Geoapify reverse geocoding failed:', error.response?.status || error.message);
    return res.status(502).json({ message: 'Automatic address lookup is temporarily unavailable.' });
  }
});

module.exports = router;
