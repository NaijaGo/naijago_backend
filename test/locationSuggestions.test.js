const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGeoapifySuggestion } = require('../utils/locationSuggestions');

test('normalizes a Geoapify Nigerian address suggestion', () => {
  assert.deepEqual(normalizeGeoapifySuggestion({
    place_id: 'abc', formatted: 'Adetokunbo Ademola Crescent, Wuse 2, Abuja, Nigeria',
    address_line1: 'Adetokunbo Ademola Crescent', city: 'Abuja', state: 'Federal Capital Territory',
    postcode: '904101', country: 'Nigeria', lat: 9.0765, lon: 7.3986,
  }), {
    id: 'abc', label: 'Adetokunbo Ademola Crescent, Wuse 2, Abuja, Nigeria',
    address: 'Adetokunbo Ademola Crescent', city: 'Abuja', state: 'Federal Capital Territory',
    street: '', area: '', landmark: '',
    postalCode: '904101', country: 'Nigeria', latitude: 9.0765, longitude: 7.3986,
  });
});

test('drops suggestions without valid coordinates', () => {
  assert.equal(normalizeGeoapifySuggestion({ formatted: 'Abuja' }), null);
});
