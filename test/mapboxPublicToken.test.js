const test = require('node:test');
const assert = require('node:assert/strict');
const mapboxRouter = require('../routes/mapboxRoutes');

test('client map configuration never falls back to a server access token', () => {
  const oldPublic = process.env.MAPBOX_PUBLIC_TOKEN;
  const oldAccess = process.env.MAPBOX_ACCESS_TOKEN;
  try {
    delete process.env.MAPBOX_PUBLIC_TOKEN;
    process.env.MAPBOX_ACCESS_TOKEN = 'server-only-test-value';
    assert.equal(mapboxRouter.getMapboxPublicToken(), '');
    process.env.MAPBOX_PUBLIC_TOKEN = 'client-public-test-value';
    assert.equal(mapboxRouter.getMapboxPublicToken(), 'client-public-test-value');
  } finally {
    if (oldPublic === undefined) delete process.env.MAPBOX_PUBLIC_TOKEN;
    else process.env.MAPBOX_PUBLIC_TOKEN = oldPublic;
    if (oldAccess === undefined) delete process.env.MAPBOX_ACCESS_TOKEN;
    else process.env.MAPBOX_ACCESS_TOKEN = oldAccess;
  }
});
