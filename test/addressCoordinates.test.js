const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCoordinate, validateCoordinates } = require('../utils/addressCoordinates');

test('parses numeric coordinate strings', () => {
  assert.equal(parseCoordinate('9.0765'), 9.0765);
});

test('accepts a valid latitude and longitude pair', () => {
  assert.deepEqual(validateCoordinates('9.0765', '7.3986', { required: true }), {
    latitude: 9.0765,
    longitude: 7.3986,
  });
});

test('rejects missing, incomplete and out-of-range coordinates', () => {
  assert.match(validateCoordinates(undefined, undefined, { required: true }).error, /exact location/i);
  assert.match(validateCoordinates('9.0', undefined).error, /both latitude/i);
  assert.match(validateCoordinates('91', '7.0').error, /valid latitude/i);
  assert.match(validateCoordinates('9.0', '181').error, /valid longitude/i);
});
