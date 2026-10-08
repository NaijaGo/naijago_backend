// Actual product router + server mount statement. No MongoDB or live AI call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const mongoose = require('mongoose');

test('customer AI POST reaches the real registered public backend route', async () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  // Established customer contract; this backend test also runs in a backend-only checkout.
  const customerPath = '/api/products/shopping-assistant';
  const mount = serverSource.match(/^\s*app\.use\((['"])([^'"]+)\1,\s*require\((['"])\.\/routes\/productRoutes\3\)\);/m);
  assert.ok(mount, 'Product router must be mounted by server.js');
  assert.ok(mount.index < serverSource.indexOf('app.use(notFound)'), 'Router must precede the 404 handler');
  const service = require('../services/shoppingAssistantService');
  const originalSuggest = service.suggest;
  const calls = [];
  const result = { products: [], maxPrice: null, question: null, message: 'Local fixture',
    budgetScope: 'per_listing', deliveryIncluded: false, notice: 'Fixture only', source: 'naijago_catalog', limitedResults: false };
  service.suggest = async (body, options) => {
    calls.push({ body, options });
    return result;
  };
  let server;
  try {
    const router = require('../routes/productRoutes');
    const route = router.stack.find(layer => layer.route?.path === '/shopping-assistant')?.route;
    assert.ok(route, 'Shopping Assistant route must exist');
    assert.deepEqual(Object.keys(route.methods), ['post']);
    assert.equal(mount[2] + route.path, customerPath);
    const app = express();
    app.use(express.json());
    // Execute the actual mount, rather than inventing a test-only prefix.
    vm.runInNewContext(mount[0], { app, require: name => {
      assert.equal(name, './routes/productRoutes'); return router;
    } });
    app.use((_req, res) => res.status(404).json({ message: 'Route not found' }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}${customerPath}`;
    // This endpoint is intentionally public; an optional app token does not change that contract.
    for (const headers of [{}, { Authorization: 'Bearer isolated-public-route-fixture' }]) {
      const response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Find a phone charger under 15000 naira' }) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), result);
    }
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.deepEqual(call.body, { message: 'Find a phone charger under 15000 naira' });
      assert.equal(typeof call.options.attachOffers, 'function');
    }
    assert.equal(mongoose.connection.readyState, 0, 'Route check must not connect to a database');
  } finally {
    service.suggest = originalSuggest;
    if (server) await new Promise(resolve => server.close(resolve));
  }
});
