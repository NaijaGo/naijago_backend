// utils/distanceCalculator.js
/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lon1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lon2 - Longitude of point 2
 * @returns {number} Distance in kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c; // Distance in km
  
  return parseFloat(distance.toFixed(2));
}

/**
 * Calculate shipping price based on distance
 * @param {number} distanceKm - Distance in kilometers
 * @returns {number} Shipping price
 */
function calculateShippingPrice(distanceKm) {
  const ratePerKm = 200;
  let shippingPrice = distanceKm * ratePerKm;
  
  // Minimum flat fee
  if (shippingPrice < 1000) {
    shippingPrice = 1000;
  }
  
  return parseFloat(shippingPrice.toFixed(2));
}

/**
 * Calculate rider earnings based on distance
 * @param {number} distanceKm - Distance in kilometers
 * @returns {number} Rider earnings (₦150 per km)
 */
function calculateRiderEarnings(distanceKm) {
  const ratePerKm = 150;
  let earnings = distanceKm * ratePerKm;
  
  // Minimum earnings per delivery
  if (earnings < 500) {
    earnings = 500;
  }
  
  return parseFloat(earnings.toFixed(2));
}

/**
 * Get optimized route for multiple pickups
 * @param {Array} locations - Array of location objects with lat, lng
 * @param {Object} startLocation - Starting location
 * @param {Object} endLocation - Ending location
 * @returns {Array} Optimized route order
 */
function optimizeRoute(locations, startLocation, endLocation) {
  // Simple nearest neighbor algorithm
  const route = [];
  let currentLocation = startLocation;
  const unvisited = [...locations];
  
  while (unvisited.length > 0) {
    // Find nearest unvisited location
    let nearestIndex = 0;
    let nearestDistance = calculateDistance(
      currentLocation.lat,
      currentLocation.lng,
      unvisited[0].lat,
      unvisited[0].lng
    );
    
    for (let i = 1; i < unvisited.length; i++) {
      const distance = calculateDistance(
        currentLocation.lat,
        currentLocation.lng,
        unvisited[i].lat,
        unvisited[i].lng
      );
      
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = i;
      }
    }
    
    // Add to route
    route.push({
      ...unvisited[nearestIndex],
      distanceFromPrevious: nearestDistance
    });
    
    // Update current location
    currentLocation = unvisited[nearestIndex];
    unvisited.splice(nearestIndex, 1);
  }
  
  // Add distance to end location
  const finalDistance = calculateDistance(
    currentLocation.lat,
    currentLocation.lng,
    endLocation.lat,
    endLocation.lng
  );
  
  route.push({
    ...endLocation,
    distanceFromPrevious: finalDistance,
    isDestination: true
  });
  
  return route;
}

module.exports = {
  calculateDistance,
  calculateShippingPrice,
  calculateRiderEarnings,
  optimizeRoute
};