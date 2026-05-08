const express = require('express');
const axios = require('axios');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

const allowedProfiles = new Set(['driving', 'driving-traffic', 'walking', 'cycling']);

const getMapboxPublicToken = () =>
  process.env.MAPBOX_PUBLIC_TOKEN || process.env.MAPBOX_ACCESS_TOKEN || '';

const getMapboxDirectionsToken = () =>
  process.env.MAPBOX_SECRET_TOKEN ||
  process.env.MAPBOX_ACCESS_TOKEN ||
  process.env.MAPBOX_PUBLIC_TOKEN ||
  '';

const readCoordinate = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const validLatitude = (value) => value !== null && value >= -90 && value <= 90;
const validLongitude = (value) => value !== null && value >= -180 && value <= 180;

router.get('/config', protect, (req, res) => {
  const token = getMapboxPublicToken();
  const styleOwner = process.env.MAPBOX_STYLE_OWNER || 'mapbox';
  const styleId = process.env.MAPBOX_STYLE_ID || 'streets-v12';

  res.json({
    success: true,
    hasToken: token.trim().length > 0,
    styleOwner,
    styleId,
    tileSize: 512,
    tileUrl: token
      ? `https://api.mapbox.com/styles/v1/${styleOwner}/${styleId}/tiles/512/{z}/{x}/{y}?access_token=${token}`
      : null,
  });
});

router.get('/directions', protect, async (req, res) => {
  const token = getMapboxDirectionsToken();
  if (!token) {
    return res.status(503).json({
      success: false,
      message: 'Mapbox is not configured on the backend.',
    });
  }

  const originLat = readCoordinate(req.query.originLat);
  const originLng = readCoordinate(req.query.originLng);
  const destinationLat = readCoordinate(req.query.destinationLat);
  const destinationLng = readCoordinate(req.query.destinationLng);
  const requestedProfile = req.query.profile?.toString() || 'driving';
  const profile = allowedProfiles.has(requestedProfile)
    ? requestedProfile
    : 'driving';

  if (
    !validLatitude(originLat) ||
    !validLongitude(originLng) ||
    !validLatitude(destinationLat) ||
    !validLongitude(destinationLng)
  ) {
    return res.status(400).json({
      success: false,
      message: 'Valid origin and destination coordinates are required.',
    });
  }

  try {
    const coordinates = `${originLng},${originLat};${destinationLng},${destinationLat}`;
    const { data } = await axios.get(
      `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coordinates}`,
      {
        params: {
          access_token: token,
          geometries: 'geojson',
          overview: 'full',
          steps: false,
        },
        timeout: 10000,
      }
    );

    const route = Array.isArray(data.routes) ? data.routes[0] : null;
    const mapboxCoordinates = route?.geometry?.coordinates || [];
    const points = mapboxCoordinates
      .filter((point) => Array.isArray(point) && point.length >= 2)
      .map(([lng, lat]) => [lat, lng]);

    res.json({
      success: true,
      profile,
      points,
      distanceMeters: route?.distance || 0,
      durationSeconds: route?.duration || 0,
    });
  } catch (error) {
    console.error('Mapbox directions error:', error.response?.data || error.message);
    res.status(error.response?.status || 502).json({
      success: false,
      message: 'Unable to fetch directions from Mapbox.',
      details: error.response?.data?.message,
    });
  }
});

module.exports = router;
