const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateDirectionsRoute,
  getMapboxDirectionsToken,
} = require('../services/mapboxDirectionsService');

const route = (distance = 3000, legs = [{ distance: 1000 }, { distance: 2000 }]) => ({
  distance,
  duration: 120,
  legs,
});

test('validates an ordered three-coordinate route with two matching legs', () => {
  assert.deepEqual(validateDirectionsRoute(route(), 3), {
    distanceMeters: 3000,
    durationSeconds: 120,
    legDistancesMeters: [1000, 2000],
  });
});

test('rejects absent, short, or extra route legs', () => {
  for (const candidate of [
    { distance: 3000, duration: 120 },
    route(3000, [{ distance: 3000 }]),
    route(3000, [{ distance: 1000 }, { distance: 1000 }, { distance: 1000 }]),
  ]) {
    assert.throws(() => validateDirectionsRoute(candidate, 3), {
      code: 'INVALID_ROUTING_RESPONSE', statusCode: 502,
    });
  }
});

test('rejects missing, non-finite, negative, and non-numeric leg distances', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, '1000']) {
    assert.throws(() => validateDirectionsRoute(route(1000, [{ distance: value }]), 2), {
      code: 'INVALID_ROUTING_RESPONSE', statusCode: 502,
    });
  }
});

test('rejects invalid total distances and material total-to-leg mismatches', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, '3000']) {
    assert.throws(() => validateDirectionsRoute(route(value), 3), {
      code: 'INVALID_ROUTING_RESPONSE', statusCode: 502,
    });
  }
  assert.throws(() => validateDirectionsRoute(route(3500), 3), {
    code: 'INVALID_ROUTING_RESPONSE', statusCode: 502,
  });
});

test('routing token uses only server-side token variables', () => {
  const oldValues = Object.fromEntries(
    ['MAPBOX_SECRET_TOKEN', 'MAPBOX_ACCESS_TOKEN', 'MAPBOX_PUBLIC_TOKEN']
      .map((key) => [key, process.env[key]]),
  );
  try {
    delete process.env.MAPBOX_SECRET_TOKEN;
    delete process.env.MAPBOX_ACCESS_TOKEN;
    process.env.MAPBOX_PUBLIC_TOKEN = 'public-test-value';
    assert.equal(getMapboxDirectionsToken(), '');
    process.env.MAPBOX_ACCESS_TOKEN = 'server-test-value';
    assert.equal(getMapboxDirectionsToken(), 'server-test-value');
    process.env.MAPBOX_SECRET_TOKEN = 'secret-test-value';
    assert.equal(getMapboxDirectionsToken(), 'secret-test-value');
  } finally {
    for (const [key, value] of Object.entries(oldValues)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
