const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addTrustedDevice,
  beginDeviceVerification,
  completeDeviceVerification,
  isTrustedDevice,
} = require('../services/deviceTrustService');

test('a verified pending fingerprint becomes trusted', () => {
  const user = { trustedDevices: [] };
  const token = beginDeviceVerification(user, 'android-abc');
  assert.equal(token.length, 64);
  assert.equal(isTrustedDevice(user, 'android-abc'), false);
  assert.equal(completeDeviceVerification(user), true);
  assert.equal(user.deviceFingerprint, 'android-abc');
  assert.equal(user.pendingDeviceFingerprint, undefined);
  assert.equal(user.deviceVerificationToken, undefined);
  assert.equal(isTrustedDevice(user, 'android-abc'), true);
});

test('unknown devices are never silently trusted', () => {
  const user = { deviceFingerprint: 'original', trustedDevices: [] };
  assert.equal(isTrustedDevice(user, 'different'), false);
  assert.throws(
    () => beginDeviceVerification(user, 'unknown-device'),
    /stable device identifier/i,
  );
});

test('adding the same trusted device is idempotent', () => {
  const user = { trustedDevices: [] };
  assert.equal(addTrustedDevice(user, 'ios-1'), true);
  assert.equal(addTrustedDevice(user, 'ios-1'), false);
  assert.equal(user.trustedDevices.length, 1);
});
