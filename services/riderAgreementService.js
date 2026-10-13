const crypto = require('node:crypto');
const mongoose = require('mongoose');
const POLICY_ID = 'rider-partnership';
function failure(status, code, message, extra = {}) { return Object.assign(new Error(message), { status, code, ...extra }); }
function canonicalContent(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200000 || value.includes('\0')) {
    throw failure(400, 'AGREEMENT_VALIDATION_ERROR', 'Provide the complete agreement text (up to 200,000 characters).');
  }
  return value.replace(/\r\n?/g, '\n').normalize('NFC');
}
function contentHash(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }
function validId(value) { return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value); }
function versionText(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(value)) {
    throw failure(400, 'AGREEMENT_VALIDATION_ERROR', 'Use a unique agreement version such as 1.0.');
  }
  return value;
}
function sendError(res, error) {
  const known = Number.isInteger(error.status) && error.code;
  return res.status(known ? error.status : 503).json({ success: false,
    code: known ? error.code : 'RIDER_AGREEMENT_UNAVAILABLE',
    message: known ? error.message : 'Agreement verification is unavailable. Please retry; acceptance has not been confirmed.',
    ...(error.requiredVersion ? { requiredVersion: error.requiredVersion } : {}),
  });
}
async function checkUniqueIndex(Model, name) {
  const indexes = await Model.collection.listIndexes().toArray();
  const keys = { agreement_version_unique: { version: 1 }, rider_version_unique: { riderId: 1, version: 1 },
    rider_bonus_day_unique: { riderId: 1, day: 1 } }[name];
  if (!keys || !indexes.some(index => index.name === name && index.unique === true &&
      JSON.stringify(index.key) === JSON.stringify(keys) && !index.partialFilterExpression && !index.sparse)) {
    throw failure(503, 'RIDER_AGREEMENT_SETUP_REQUIRED', 'Agreement database indexes require explicit administrator setup.');
  }
}
function createRiderAgreementService({ Agreement, Policy, Acceptance, Rider, MainOrder, Shipment,
  transact = operation => mongoose.connection.transaction(operation),
  now = () => new Date(), ready = async () => {
    await checkUniqueIndex(Agreement, 'agreement_version_unique');
    await checkUniqueIndex(Acceptance, 'rider_version_unique');
  },
}) {
  async function policy(session, fence = false) {
    const result = fence
      ? await Policy.findOneAndUpdate({ _id: POLICY_ID }, { $inc: { fence: 1 } }, { new: true, session }).lean()
      : await Policy.findById(POLICY_ID).session(session || null).lean();
    if (!result) throw failure(503, 'RIDER_AGREEMENT_NOT_CONFIGURED', 'An administrator must initialize and publish the Rider Partnership Agreement.');
    return result;
  }
  async function current({ session = null, fence = false } = {}) {
    const config = await policy(session, fence);
    const agreement = config.agreementId && await Agreement.findById(config.agreementId).session(session).lean();
    if (!agreement || agreement.status !== 'published' || !agreement.effectiveAt ||
        !Number.isFinite(new Date(agreement.effectiveAt).getTime()) ||
        new Date(agreement.effectiveAt) > now() || contentHash(agreement.content) !== agreement.contentHash) {
      throw failure(503, 'RIDER_AGREEMENT_NOT_CONFIGURED', 'No valid effective Rider Partnership Agreement is required yet. Please contact support.');
    }
    return { agreement, policy: config };
  }
  async function status(riderId, options = {}) {
    const { agreement } = await current(options);
    const acceptance = await Acceptance.findOne({ riderId, agreementId: agreement._id,
      version: agreement.version, contentHash: agreement.contentHash }).session(options.session || null).lean();
    const previous = acceptance || await Acceptance.findOne({ riderId }).sort({ acceptedAt: -1 }).session(options.session || null).lean();
    return { success: true, accepted: !!acceptance, requiresAcceptance: !acceptance,
      requiredVersion: agreement.version, agreement: { agreementId: String(agreement._id), version: agreement.version,
        content: agreement.content, contentHash: agreement.contentHash, publishedAt: agreement.publishedAt,
        effectiveAt: agreement.effectiveAt, companyName: 'NaijaGo App Ltd' },
      acceptedVersion: previous?.version || null, acceptedAt: acceptance?.acceptedAt || null,
      acceptance: acceptance || null };
  }
  async function requireAccepted(riderId, { session = null, fence = false } = {}) {
    let result;
    try { result = await status(riderId, { session, fence }); }
    catch (error) {
      if (error.code && error.status) throw error;
      throw failure(503, 'RIDER_AGREEMENT_UNAVAILABLE', 'Agreement verification is unavailable. Please retry before starting work.');
    }
    if (!result.accepted) throw failure(403, 'RIDER_AGREEMENT_REQUIRED',
      'Accept the current Rider Partnership Agreement before starting new delivery work.', { requiredVersion: result.requiredVersion });
    return result;
  }
  async function accept(riderId, body, audit = {}) {
    if (!riderId) throw failure(401, 'RIDER_AUTH_REQUIRED', 'Sign in to accept the agreement.');
    if (!body || body.accepted !== true || !validId(body.agreementId) ||
        typeof body.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.contentHash)) {
      throw failure(400, 'AGREEMENT_VALIDATION_ERROR', 'Explicit consent, agreement ID, version and hash are required.');
    }
    versionText(body.version);
    const allowed = new Set(['agreementId', 'version', 'contentHash', 'accepted', 'appVersion', 'platform']);
    if (Object.keys(body).some(key => !allowed.has(key))) throw failure(400, 'AGREEMENT_VALIDATION_ERROR', 'Client identity, timestamps and audit fields are not accepted.');
    if (body.appVersion != null && (typeof body.appVersion !== 'string' || body.appVersion.length > 50)) throw failure(400, 'AGREEMENT_VALIDATION_ERROR', 'Invalid application version.');
    if (body.platform != null && !['android', 'ios', 'web', 'unknown'].includes(body.platform)) throw failure(400, 'AGREEMENT_VALIDATION_ERROR', 'Invalid platform.');
    await ready();
    return transact(async session => {
      const result = await current({ session, fence: true });
      const agreement = result.agreement;
      if (String(agreement._id) !== body.agreementId || agreement.version !== body.version || agreement.contentHash !== body.contentHash) {
        throw failure(409, 'RIDER_AGREEMENT_CHANGED', 'The required agreement changed. Read the latest version before accepting.', { requiredVersion: agreement.version });
      }
      const rider = await Rider.findById(riderId).session(session).lean();
      if (!rider || !['pending', 'approved'].includes(rider.status)) throw failure(403, 'RIDER_ACCOUNT_RESTRICTED', 'This rider account cannot accept an agreement.');
      const acceptance = await Acceptance.findOneAndUpdate({ riderId, version: agreement.version }, {
        $setOnInsert: { riderId, actorId: riderId, agreementId: agreement._id, version: agreement.version,
          contentHash: agreement.contentHash, acceptedAt: now(), method: 'in_app_explicit_consent',
          requestId: String(audit.requestId || crypto.randomUUID()).replace(/[^\w.-]/g, '').slice(0, 100),
          appVersion: body.appVersion || '', platform: body.platform || 'unknown' },
      }, { upsert: true, new: true, runValidators: true, session, setDefaultsOnInsert: false }).lean();
      if (!acceptance || String(acceptance.agreementId) !== String(agreement._id) || acceptance.contentHash !== agreement.contentHash) {
        throw failure(409, 'RIDER_AGREEMENT_CHANGED', 'Acceptance history conflicts with this version. Contact support.');
      }
      return { success: true, accepted: true, requiredVersion: agreement.version, acceptance };
    });
  }
  async function acceptedRiderIds(options = {}) {
    const { agreement } = await current(options);
    return Acceptance.distinct('riderId', { agreementId: agreement._id, version: agreement.version,
      contentHash: agreement.contentHash }).session(options.session || null);
  }
  async function eligibleWork(riderId, action) {
    return transact(async session => {
      await requireAccepted(riderId, { session, fence: true });
      const rider = await Rider.findOne({ _id: riderId, status: 'approved', isActive: true, isAvailable: true,
        activeDeliveries: { $lt: 5 } }).session(session).lean();
      if (!rider) throw failure(403, 'RIDER_NOT_ELIGIBLE', 'Rider must be approved, online and eligible for new work.');
      return action(session, rider);
    });
  }
  async function updateAvailability(riderId, changes) {
    if (!Object.keys(changes).length || Object.entries(changes).some(([key, value]) =>
      !['isAvailable', 'isActive'].includes(key) || typeof value !== 'boolean')) {
      throw failure(400, 'RIDER_STATUS_INVALID', 'Availability and active status must be true or false.');
    }
    const update = async session => {
      if (Object.values(changes).includes(true)) await requireAccepted(riderId, { session, fence: true });
      const existingRider = await Rider.findById(riderId).session(session).lean();
      if (!existingRider) throw failure(404, 'RIDER_NOT_FOUND', 'Rider not found.');
      if (Object.values(changes).includes(true) && existingRider.status !== 'approved') {
        throw failure(403, 'RIDER_ACCOUNT_RESTRICTED', 'Only approved riders may go online.');
      }
      const online = (changes.isAvailable ?? existingRider.isAvailable) === true && (changes.isActive ?? existingRider.isActive) === true;
      const updatedRider = await Rider.findByIdAndUpdate(riderId, { $set: { ...changes, lastActive: now(),
        ...(!online ? { lastOnlineNotificationAt: null } : {}) } }, { new: true, session }).select('-password');
      return { existingRider, updatedRider };
    };
    return Object.values(changes).includes(true) ? transact(update) : update(null);
  }
  async function createDraft(actorId, body) {
    await ready();
    const content = canonicalContent(body.content);
    try { return await Agreement.create({ version: versionText(body.version), content, contentHash: contentHash(content),
      status: 'draft', createdBy: actorId }); }
    catch (error) { if (error.code === 11000) throw failure(409, 'AGREEMENT_VERSION_EXISTS', 'This agreement version already exists.'); throw error; }
  }
  async function editDraft(id, body) {
    if (!validId(id) || !Number.isInteger(body.revision) || body.revision < 0) throw failure(400, 'AGREEMENT_VALIDATION_ERROR', 'Reload the draft before editing.');
    const content = canonicalContent(body.content);
    const draft = await Agreement.findOneAndUpdate({ _id: id, status: 'draft', __v: body.revision },
      { $set: { content, contentHash: contentHash(content) }, $inc: { __v: 1 } }, { new: true, runValidators: true }).lean();
    if (!draft) throw failure(409, 'AGREEMENT_DRAFT_CHANGED', 'The draft changed or was published. Reload it.');
    return draft;
  }
  async function publish(actorId, id, body) {
    if (!validId(id) || !Number.isInteger(body.revision) || body.revision < 0) throw failure(400, 'AGREEMENT_VALIDATION_ERROR', 'Reload the draft before publishing.');
    const effectiveAt = body.effectiveAt ? new Date(body.effectiveAt) : now();
    if (!Number.isFinite(effectiveAt.getTime())) throw failure(400, 'AGREEMENT_VALIDATION_ERROR', 'Provide a valid effective timestamp.');
    await ready();
    return transact(async session => {
      await policy(session, true);
      const draft = await Agreement.findOne({ _id: id, status: 'draft', __v: body.revision }).session(session).lean();
      if (!draft) throw failure(409, 'AGREEMENT_DRAFT_CHANGED', 'This draft changed or was already published.');
      const hash = contentHash(canonicalContent(draft.content));
      const published = await Agreement.findOneAndUpdate({ _id: id, status: 'draft', __v: body.revision }, { $set: {
        status: 'published', contentHash: hash, publishedBy: actorId, publishedAt: now(), effectiveAt }, $inc: { __v: 1 } },
      { new: true, runValidators: true, session }).lean();
      if (!published) throw failure(409, 'AGREEMENT_DRAFT_CHANGED', 'The draft changed before publication. Reload it.');
      return published;
    });
  }
  async function setRequired(actorId, body) {
    if (!validId(body.agreementId) || !Number.isInteger(body.revision) || body.revision < 0 ||
        typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.length > 500) {
      throw failure(400, 'AGREEMENT_VALIDATION_ERROR', 'Select a published agreement, current policy revision and reason.');
    }
    await ready();
    return transact(async session => {
      const config = await policy(session, true);
      if (config.revision !== body.revision) throw failure(409, 'AGREEMENT_POLICY_CHANGED', 'The required version changed. Reload the page.');
      const agreement = await Agreement.findById(body.agreementId).session(session).lean();
      if (!agreement || agreement.status !== 'published' || !agreement.effectiveAt ||
          !Number.isFinite(new Date(agreement.effectiveAt).getTime()) || new Date(agreement.effectiveAt) > now() || contentHash(agreement.content) !== agreement.contentHash) {
        throw failure(400, 'AGREEMENT_NOT_EFFECTIVE', 'Select a published, effective, unmodified agreement.');
      }
      if (String(config.agreementId) === body.agreementId) return config;
      const updated = await Policy.findOneAndUpdate({ _id: POLICY_ID, revision: body.revision }, {
        $set: { agreementId: agreement._id, changedBy: actorId, changedAt: now() }, $inc: { revision: 1 },
        $push: { history: { previousAgreementId: config.agreementId, agreementId: agreement._id,
          changedBy: actorId, changedAt: now(), reason: body.reason.trim() } },
      }, { new: true, session }).lean();
      const acceptedIds = await Acceptance.distinct('riderId', { agreementId: agreement._id,
        version: agreement.version, contentHash: agreement.contentHash }).session(session);
      // Finish existing claimed deliveries; revoke only eligibility for new work.
      await Rider.updateMany({ status: 'approved', _id: { $nin: acceptedIds } },
        { $set: { isAvailable: false, isActive: false, lastOnlineNotificationAt: null } }, { session });
      if (MainOrder && Shipment) {
        const invalidOffer = { isClaimed: false, assignedRider: { $ne: null, $nin: acceptedIds } };
        await MainOrder.updateMany({ ...invalidOffer, mainOrderStatus: { $nin: ['delivered', 'completed', 'cancelled'] } },
          { $unset: { assignedRider: '', assignedAt: '' } }, { session });
        await Shipment.updateMany(invalidOffer, { $unset: { assignedRider: '', assignedAt: '' } }, { session });
      }
      return updated;
    });
  }
  return { current, status, requireAccepted, accept, acceptedRiderIds, eligibleWork,
    updateAvailability, createDraft, editDraft, publish, setRequired, policy };
}
let instance;
function getService() {
  return instance ||= createRiderAgreementService({ Agreement: require('../models/RiderAgreement'),
    Policy: require('../models/RiderAgreementPolicy'), Acceptance: require('../models/RiderAgreementAcceptance'),
    Rider: require('../models/Rider'), MainOrder: require('../models/MainOrder'), Shipment: require('../models/Shipment') });
}
module.exports = { createRiderAgreementService, getService, canonicalContent, contentHash, sendError, failure,
  validId, checkUniqueIndex, POLICY_ID };
