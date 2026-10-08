const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { getDrivingRoute } = require('../services/mapboxDirectionsService');
const { parseCoordinate } = require('../utils/addressCoordinates');

const router = express.Router();

const allowedProfiles = new Set(['driving', 'driving-traffic', 'walking', 'cycling']);

const getMapboxPublicToken = () =>
  process.env.MAPBOX_PUBLIC_TOKEN || '';

const readCoordinate = (value) => {
  return parseCoordinate(value) ?? null;
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
    const route = await getDrivingRoute(
      [
        { latitude: originLat, longitude: originLng },
        { latitude: destinationLat, longitude: destinationLng },
      ],
      { profile, overview: 'full', steps: true },
    );

    res.json({
      success: true,
      profile,
      points: route.points,
      steps: route.steps,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
    });
  } catch (error) {
    console.error('Mapbox directions error:', error.code || error.message);
    res.status(error.statusCode || error.response?.status || 502).json({
      success: false,
      message: 'Unable to fetch directions from Mapbox.',
    });
  }
});

router.getMapboxPublicToken = getMapboxPublicToken;
module.exports = router;
