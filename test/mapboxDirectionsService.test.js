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
    assert.throws(() => validateDirectionsRoute({ ...route(), distance: value }, 3), {
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

test('directions endpoint rejects missing or malformed coordinates before routing', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const handlers = {};
  let calls = 0;
  let received;
  const router = { get(path, ...middleware) { handlers[path] = middleware.at(-1); } };
  const dependencies = {
    express: { Router: () => router },
    '../middleware/authMiddleware': { protect: () => {} },
    '../utils/addressCoordinates': require('../utils/addressCoordinates'),
    '../services/mapboxDirectionsService': {
      getDrivingRoute: async (coordinates) => {
        calls++;
        received = coordinates;
        return { points: [], steps: [], distanceMeters: 1000, durationSeconds: 120 };
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../routes/mapboxRoutes'), 'utf8'), {
    require: name => dependencies[name], module: { exports: {} }, process: { env: {} }, console,
  });
  const response = () => ({
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  });
  const valid = { originLat: '9.08', originLng: '7.46', destinationLat: '9.1', destinationLng: '7.5' };
  for (const field of Object.keys(valid)) {
    for (const invalid of [undefined, null, '', ' ', 'NaN', 'Infinity', false, [], ['9'], {}]) {
      const res = response();
      await handlers['/directions']({ query: { ...valid, [field]: invalid } }, res);
      assert.equal(res.statusCode, 400, `${field}: ${String(invalid)}`);
    }
  }
  assert.equal(calls, 0);
  const res = response();
  await handlers['/directions']({ query: { ...valid, originLat: '0' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 1);
  assert.equal(received[0].latitude, 0, 'A valid individual zero axis is preserved');
  assert.equal(received[0].longitude, 7.46);
});
