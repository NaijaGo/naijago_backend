const axios = require('axios');

const getMapboxDirectionsToken = () =>
  process.env.MAPBOX_SECRET_TOKEN ||
  process.env.MAPBOX_ACCESS_TOKEN ||
  '';

const validateDirectionsRoute = (route, coordinateCount) => {
  const expectedLegCount = coordinateCount - 1;
  const distance = route?.distance;
  const duration = route?.duration;
  const invalid = () => {
    const error = new Error('Unable to calculate a road route for these locations.');
    error.statusCode = 502;
    error.code = 'INVALID_ROUTING_RESPONSE';
    return error;
  };

  if (
    !route ||
    typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0 ||
    typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 ||
    !Array.isArray(route.legs) || route.legs.length !== expectedLegCount
  ) throw invalid();

  const legDistancesMeters = route.legs.map((leg) => leg?.distance);
  if (legDistancesMeters.some((legDistance) =>
    typeof legDistance !== 'number' || !Number.isFinite(legDistance) || legDistance < 0
  )) throw invalid();

  const legTotal = legDistancesMeters.reduce((sum, value) => sum + value, 0);
  // Mapbox returns meter values; tolerate at most 0.5m per leg or 1ppm for rounding.
  const toleranceMeters = Math.max(1, expectedLegCount * 0.5, distance * 1e-6);
  if (Math.abs(legTotal - distance) > toleranceMeters) throw invalid();

  return { distanceMeters: distance, durationSeconds: duration, legDistancesMeters };
};

const getDrivingRoute = async (
  coordinates,
  { overview = 'false', steps = false, profile = 'driving' } = {},
) => {
  const token = getMapboxDirectionsToken();
  if (!token) {
    const error = new Error('Road distance pricing is temporarily unavailable.');
    error.statusCode = 503;
    error.code = 'MAPBOX_NOT_CONFIGURED';
    throw error;
  }

  if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > 25) {
    const error = new Error('A route must contain between 2 and 25 locations.');
    error.statusCode = 422;
    error.code = 'INVALID_ROUTE_STOPS';
    throw error;
  }

  const coordinatePath = coordinates
    .map(({ latitude, longitude }) => `${longitude},${latitude}`)
    .join(';');

  try {
    const { data } = await axios.get(
      `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coordinatePath}`,
      {
        params: {
          access_token: token,
          geometries: 'geojson',
          overview,
          steps,
        },
        timeout: 10000,
      },
    );

    const route = Array.isArray(data?.routes) ? data.routes[0] : null;
    const validated = validateDirectionsRoute(route, coordinates.length);

    return {
      ...validated,
      points: (route.geometry?.coordinates || [])
        .filter((point) => Array.isArray(point) && point.length >= 2)
        .map(([longitude, latitude]) => [latitude, longitude]),
      steps: (route.legs || []).flatMap((leg, legIndex) =>
        (leg?.steps || [])
          .map((step) => ({
            instruction: step?.maneuver?.instruction || '',
            roadName: step?.name || '',
            distanceMeters: Number(step?.distance || 0),
            durationSeconds: Number(step?.duration || 0),
            maneuverType: step?.maneuver?.type || '',
            modifier: step?.maneuver?.modifier || '',
            legIndex,
          }))
          .filter((step) => step.instruction),
      ),
    };
  } catch (error) {
    if (error.statusCode) throw error;
    const routeError = new Error('Unable to calculate delivery distance right now. Please try again.');
    routeError.statusCode = 502;
    routeError.code = 'ROUTING_PROVIDER_ERROR';
    throw routeError;
  }
};

module.exports = { getDrivingRoute, getMapboxDirectionsToken, validateDirectionsRoute };
