const { validateCoordinates } = require('./addressCoordinates');
const clean = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeGeoapifySuggestion = (result = {}) => {
  const { latitude, longitude, error } = validateCoordinates(result.lat, result.lon, { required: true });
  if (error) return null;

  const city = clean(result.city) || clean(result.town) || clean(result.village) || clean(result.county);
  const addressLine = clean(result.formatted)
    || [clean(result.address_line1), clean(result.address_line2)].filter(Boolean).join(', ');
  if (!addressLine) return null;

  return {
    id: clean(result.place_id) || `${latitude},${longitude}`,
    label: addressLine,
    address: clean(result.address_line1) || addressLine,
    city,
    street: clean(result.street),
    area: clean(result.suburb) || clean(result.district),
    landmark: '',
    state: clean(result.state),
    postalCode: clean(result.postcode),
    country: clean(result.country),
    latitude,
    longitude,
  };
};

module.exports = { normalizeGeoapifySuggestion };
