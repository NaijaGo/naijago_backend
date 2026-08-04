const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('delayed Flutterwave verification preserves the order and returns pending', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'orderRoutes.js'),
    'utf8',
  );
  const start = source.indexOf("router.put('/:id/pay', protect");
  const end = source.indexOf("router.put('/shipments/:id/deliver'", start);
  assert.notEqual(start, -1, 'payment confirmation route must exist');
  assert.notEqual(end, -1, 'payment route boundary must exist');

  const paymentRoute = source.slice(start, end);
  assert.match(paymentRoute, /mainOrder\.save\(\{ session \}\)/);
  assert.match(paymentRoute, /res\.status\(202\)\.json/);
  assert.doesNotMatch(paymentRoute, /MainOrder\.deleteOne/);
  assert.doesNotMatch(paymentRoute, /Shipment\.deleteMany/);
});
