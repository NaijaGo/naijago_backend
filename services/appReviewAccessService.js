const jwt = require('jsonwebtoken');
// A narrow, expiring password-authenticated demo-account exception to device OTP.
// Never bypass email verification, passwords, roles or normal business authorization.
function reviewAccessSeconds(user, env = process.env, now = Date.now()) {
  const id = env.APP_REVIEW_CUSTOMER_ID;
  const expiry = Date.parse(env.APP_REVIEW_ACCESS_EXPIRES_AT || '');
  if (!/^[a-f0-9]{24}$/i.test(id || '') || String(user?._id) !== id || !user?.isEmailVerified ||
      user.isAdmin || user.isVendor || !['user', undefined].includes(user.role) ||
      user.isSuspended || user.isBlocked || !Number.isFinite(expiry) || expiry <= now || expiry - now > 7 * 86400000) return 0;
  return Math.min(3600, Math.floor((expiry - now) / 1000));
}
function reviewToken(user, seconds) {
  return jwt.sign({ id: user._id, reviewAccess: true }, process.env.JWT_SECRET, { expiresIn: seconds });
}
module.exports = { reviewAccessSeconds, reviewToken };
