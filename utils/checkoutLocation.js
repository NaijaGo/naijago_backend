const { validateCoordinates } = require('./addressCoordinates');
const ADDRESS_FIELDS = ['address', 'street', 'area', 'landmark', 'city', 'state', 'country', 'postalCode'];
const normalizeCheckoutAddress = (value = {}) => Object.fromEntries(ADDRESS_FIELDS.map(key => [key, typeof value[key] === 'string' ? value[key].trim() : '']));
const validateCheckoutLocation = (address, location) => {
 const normalized = normalizeCheckoutAddress(address || {});
 if (!normalized.address || !normalized.city || !normalized.country) return 'Please complete the delivery address, city, and country.';
 return validateCoordinates(location?.latitude, location?.longitude, { required: true }).error || null;
};
module.exports = { normalizeCheckoutAddress, validateCheckoutLocation };
