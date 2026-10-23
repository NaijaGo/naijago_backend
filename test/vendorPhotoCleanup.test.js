const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldQueueVendorPhotoCleanup, queueVendorPhotoCleanup } = require('../services/vendorPhotoCleanupService');

const on = { VENDOR_PHOTO_AUTO_CLEANUP: 'true' };
const vendor = { _id: 'v1', isVendor: true };
const photo = { mainImage: [{ mimetype: 'image/jpeg' }] };
const consent = { photoCleanupConsent: 'true' };
const quiet = { warn() {} };

test('queues a consenting vendor upload when the feature is on', () => {
  assert.equal(shouldQueueVendorPhotoCleanup({ env: on, user: vendor, body: consent, files: photo }), true);
  assert.equal(shouldQueueVendorPhotoCleanup({ env: on, user: vendor, body: { photoCleanupConsent: true },
    files: { extraImages: [{}] } }), true);
});

test('does nothing unless every condition holds', () => {
  const base = { env: on, user: vendor, body: consent, files: photo };
  for (const [name, change] of Object.entries({
    'feature off': { env: {} },
    'feature not exactly true': { env: { VENDOR_PHOTO_AUTO_CLEANUP: '1' } },
    'no consent': { body: {} },
    'consent declined': { body: { photoCleanupConsent: 'false' } },
    'no new photo files (text-only edit)': { files: {} },
    'admin upload': { user: { _id: 'a1', isAdmin: true } },
    'no user': { user: undefined },
  })) {
    assert.equal(shouldQueueVendorPhotoCleanup({ ...base, ...change }), false, name);
  }
});

test('schedules exactly one product through the existing Image Studio service', async () => {
  const calls = [];
  const service = { async requestBatch(input) { calls.push(input); return { results: [{ state: 'scheduled' }] }; } };
  await queueVendorPhotoCleanup({ productId: { toString: () => 'p1' }, actor: 'v1', service, logger: quiet });
  assert.deepEqual(calls, [{ productIds: ['p1'], actor: 'v1', profile: 'standard' }]);
});

test('a provider/config failure never throws into the product save', async () => {
  const warnings = [];
  const service = { async requestBatch() { throw new Error('Image processing is not configured'); } };
  const result = await queueVendorPhotoCleanup({ productId: 'p1', actor: 'v1', service, logger: { warn: (m) => warnings.push(m) } });
  assert.equal(result, null);
  assert.match(warnings[0], /not configured/);
});

test('unscheduled outcomes are logged, not hidden', async () => {
  const warnings = [];
  const service = { async requestBatch() { return { results: [{ state: 'reupload_required' }] }; } };
  await queueVendorPhotoCleanup({ productId: 'p1', actor: 'v1', service, logger: { warn: (m) => warnings.push(m) } });
  assert.match(warnings[0], /reupload_required/);
});
