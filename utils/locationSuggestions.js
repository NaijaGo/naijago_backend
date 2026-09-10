const clean = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeGeoapifySuggestion = (result = {}) => {
  const latitude = Number(result.lat);
  const longitude = Number(result.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const city = clean(result.city) || clean(result.town) || clean(result.village) || clean(result.county);
  const addressLine = clean(result.formatted)
    || [clean(result.address_line1), clean(result.address_line2)].filter(Boolean).join(', ');
  if (!addressLine) return null;

  return {
    id: clean(result.place_id) || `${latitude},${longitude}`,
    label: addressLine,
    address: clean(result.address_line1) || addressLine,
    city,
    state: clean(result.state),
    postalCode: clean(result.postcode),
    country: clean(result.country) || 'Nigeria',
    latitude,
    longitude,
  };
};

module.exports = { normalizeGeoapifySuggestion };
