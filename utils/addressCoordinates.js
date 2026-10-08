const parseCoordinate = (value) => {
  if (value === undefined || value === null || (typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const validateCoordinates = (latitudeValue, longitudeValue, { required = false } = {}) => {
  const latitude = parseCoordinate(latitudeValue);
  const longitude = parseCoordinate(longitudeValue);
  const latitudeProvided = latitudeValue !== undefined && latitudeValue !== null && latitudeValue !== '';
  const longitudeProvided = longitudeValue !== undefined && longitudeValue !== null && longitudeValue !== '';

  if (required && (!latitudeProvided || !longitudeProvided)) {
    return { error: 'Select a valid address so its exact location can be saved.' };
  }
  if (latitudeProvided !== longitudeProvided) {
    return { error: 'Both latitude and longitude are required.' };
  }
  if (!latitudeProvided && !longitudeProvided) return { latitude, longitude };
  if (latitude === undefined || latitude < -90 || latitude > 90) {
    return { error: 'Enter a valid latitude.' };
  }
  if (longitude === undefined || longitude < -180 || longitude > 180) {
    return { error: 'Enter a valid longitude.' };
  }
  if (latitude === 0 && longitude === 0) return { error: 'Please select a valid delivery location.' };
  return { latitude, longitude };
};

module.exports = { parseCoordinate, validateCoordinates };
