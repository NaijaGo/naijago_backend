const crypto = require('crypto');

const normalizeFingerprint = (value) => String(value || '').trim();

const trustedFingerprints = (user) => {
  const fingerprints = new Set();
  const primary = normalizeFingerprint(user?.deviceFingerprint);
  if (primary) fingerprints.add(primary);
  for (const device of user?.trustedDevices || []) {
    const fingerprint = normalizeFingerprint(device?.fingerprint);
    if (fingerprint) fingerprints.add(fingerprint);
  }
  return fingerprints;
};

const isTrustedDevice = (user, fingerprint) => {
  const normalized = normalizeFingerprint(fingerprint);
  return Boolean(normalized && trustedFingerprints(user).has(normalized));
};

const addTrustedDevice = (user, fingerprint, details = {}) => {
  const normalized = normalizeFingerprint(fingerprint);
  if (!normalized) return false;
  if (!Array.isArray(user.trustedDevices)) user.trustedDevices = [];
  const existing = user.trustedDevices.find(
    (device) => normalizeFingerprint(device?.fingerprint) === normalized,
  );
  if (existing) {
    existing.lastUsedAt = new Date();
    return false;
  }
  user.trustedDevices.push({
    fingerprint: normalized,
    label: String(details.label || 'NaijaGo device').trim(),
    platform: String(details.platform || 'unknown').trim().toLowerCase(),
    verifiedAt: new Date(),
    lastUsedAt: new Date(),
  });
  return true;
};

const beginDeviceVerification = (user, fingerprint) => {
  const normalized = normalizeFingerprint(fingerprint);
  if (!normalized || normalized === 'unknown-device') {
    const error = new Error('A stable device identifier is required. Please update the app and try again.');
    error.code = 'INVALID_DEVICE_FINGERPRINT';
    throw error;
  }
  const token = crypto.randomBytes(32).toString('hex');
  user.pendingDeviceFingerprint = normalized;
  user.deviceVerificationToken = token;
  user.deviceVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  user.isDeviceVerified = false;
  return token;
};

const completeDeviceVerification = (user) => {
  const pending = normalizeFingerprint(user?.pendingDeviceFingerprint);
  if (!pending) return false;
  addTrustedDevice(user, pending);
  user.deviceFingerprint = pending;
  user.pendingDeviceFingerprint = undefined;
  user.deviceVerificationToken = undefined;
  user.deviceVerificationExpires = undefined;
  user.isDeviceVerified = true;
  return true;
};

module.exports = {
  addTrustedDevice,
  beginDeviceVerification,
  completeDeviceVerification,
  isTrustedDevice,
  normalizeFingerprint,
  trustedFingerprints,
};
