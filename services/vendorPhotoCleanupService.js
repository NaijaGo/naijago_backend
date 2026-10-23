// Queues newly uploaded vendor product photos for Image Studio's white-background
// cleanup. This only schedules the existing reviewed pipeline: Photoroom budgets,
// duplicate detection and admin approval before publication are all unchanged.
// It never blocks or fails the vendor's product save.

const truthy = (value) => value === true || value === 'true' || value === '1' || value === 1;

const autoCleanupEnabled = (env = process.env) => env.VENDOR_PHOTO_AUTO_CLEANUP === 'true';

/**
 * Decide whether a product save should queue cleanup.
 * - feature flag VENDOR_PHOTO_AUTO_CLEANUP=true
 * - the vendor agreed to send the photos to the processing provider
 * - this request uploaded at least one new photo file
 * - the uploader is a vendor (admins use Image Studio directly)
 */
const shouldQueueVendorPhotoCleanup = ({ env = process.env, user, body, files } = {}) => {
  if (!autoCleanupEnabled(env)) return false;
  if (!user || user.isAdmin) return false;
  if (!truthy(body?.photoCleanupConsent)) return false;
  const uploaded = (files?.mainImage?.length || 0) + (files?.extraImages?.length || 0);
  return uploaded > 0;
};

let defaultService;
const loadService = () => {
  defaultService ??= require('./imageRefinementRuntime').service;
  return defaultService;
};

/** Fire-and-forget: resolves to the scheduling result, or null when skipped/failed. */
const queueVendorPhotoCleanup = async ({ productId, actor, service, logger = console } = {}) => {
  if (!productId) return null;
  try {
    const result = await (service || loadService()).requestBatch({
      productIds: [String(productId)], actor, profile: 'standard',
    });
    const state = result?.results?.[0]?.state;
    if (state !== 'scheduled') logger.warn?.(`[PHOTO CLEANUP] product ${productId} not queued: ${state || 'unknown'}`);
    return result;
  } catch (error) {
    logger.warn?.(`[PHOTO CLEANUP] product ${productId} not queued: ${error.message}`);
    return null;
  }
};

module.exports = { autoCleanupEnabled, shouldQueueVendorPhotoCleanup, queueVendorPhotoCleanup };
