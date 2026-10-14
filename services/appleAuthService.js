const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { authError } = require('./googleIdentityService');
const { verifyAppleIdentity } = require('./appleIdentityService');
const { normalizeFingerprint, addTrustedDevice } = require('./deviceTrustService');
const { ensureReferralCode } = require('./referralService');
function assertCustomer(user) {
  if (!user || user.isAdmin || user.role === 'admin' || user.isBlocked === true || user.isSuspended === true ||
      user.vendorStatus === 'suspended' || user.pharmacistStatus === 'suspended') {
    throw authError(403, 'APPLE_ACCOUNT_RESTRICTED', 'This account cannot use Apple customer sign-in.');
  }
}
function createAppleAuthService({ User, Identity, Challenge, verify = verifyAppleIdentity,
  transact = action => mongoose.connection.transaction(action), now = () => new Date(),
  ready = async () => {
    const indexes = await User.collection.listIndexes().toArray();
    if (!indexes.some(i => i.unique && !i.sparse && !i.partialFilterExpression && JSON.stringify(i.key) === '{"email":1}')) {
      throw authError(503, 'APPLE_SETUP_REQUIRED', 'Unique customer email storage must be verified before Apple sign-in.');
    }
    if (!indexes.some(i => i.unique && !i.sparse && JSON.stringify(i.key) === '{"phoneNumber":1}' &&
        JSON.stringify(i.partialFilterExpression) === '{"phoneNumber":{"$type":"string"}}') ||
        indexes.some(i => JSON.stringify(i.key) === '{"phoneNumber":1}' && !i.partialFilterExpression)) {
      throw authError(503, 'APPLE_SETUP_REQUIRED', 'Apple account storage needs explicit backend setup.');
    }
    for (const Model of [Identity, Challenge]) {
      const actual = await Model.collection.listIndexes().toArray();
      if (!actual.some(i => i.name === '_id_' && JSON.stringify(i.key) === '{"_id":1}')) throw authError(503, 'APPLE_SETUP_REQUIRED', 'Apple storage requires explicit setup.');
      if (Model === Challenge && !actual.some(i => i.name === 'apple_challenge_expiry' && i.expireAfterSeconds === 0 && JSON.stringify(i.key) === '{"expiresAt":1}')) throw authError(503, 'APPLE_SETUP_REQUIRED', 'Apple nonce storage requires explicit setup.');
    }
  }, referral = ensureReferralCode,
} = {}) {
  function fingerprint(body) {
    if (typeof body.deviceFingerprint !== 'string') throw authError(400, 'INVALID_DEVICE_FINGERPRINT', 'A stable device identifier is required.');
    const value = normalizeFingerprint(body.deviceFingerprint);
    if (!value || value === 'unknown-device' || value.length > 512) throw authError(400, 'INVALID_DEVICE_FINGERPRINT', 'Unable to securely identify this device.');
    return crypto.createHash('sha256').update(value).digest('hex');
  }
  async function challenge(body) {
    if (!process.env.APPLE_CUSTOMER_CLIENT_ID?.trim()) throw authError(503, 'APPLE_NOT_CONFIGURED', 'Apple sign-in is not configured yet.');
    const fp = fingerprint(body); await ready();
    const id = crypto.randomBytes(32).toString('hex'), nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(now().getTime() + 300000);
    await Challenge.create({ _id: id, nonce, fingerprint: fp, expiresAt, usedAt: null });
    return { success: true, challengeId: id, nonce, expiresAt };
  }
  async function authenticate(body) {
    if (body.app !== 'customer' || typeof body.challengeId !== 'string' || !/^[a-f0-9]{64}$/.test(body.challengeId)) throw authError(400, 'APPLE_REQUEST_INVALID', 'Start Apple sign-in again.');
    const fp = fingerprint(body); await ready();
    const pending = await Challenge.findById(body.challengeId).lean();
    if (!pending || pending.usedAt || pending.expiresAt <= now() || pending.fingerprint !== fp) throw authError(401, 'APPLE_CHALLENGE_EXPIRED', 'Start Apple sign-in again.');
    const identity = await verify(body.idToken, pending.nonce);
    return transact(async session => {
      const mapping = await Identity.findById(identity.sub).session(session).lean();
      let user = mapping ? await User.findById(mapping.userId).session(session) : null;
      if (mapping) {
        assertCustomer(user);
        if (!user.isEmailVerified) throw authError(403, 'APPLE_ACCOUNT_RESTRICTED', 'This account requires verification before signing in.');
      }
      if (!mapping) {
        if (!identity.emailVerified || !identity.email || !/^.+@.+\..+$/.test(identity.email)) throw authError(401, 'APPLE_EMAIL_UNVERIFIED', 'Apple did not supply a verified email. Please authorize Apple sign-in again.');
        user = await User.findOne({ email: identity.email }).session(session);
        if (user) {
          assertCustomer(user);
          if (user.appleSubject && user.appleSubject !== identity.sub) throw authError(409, 'APPLE_ACCOUNT_CONFLICT', 'This account is linked to another Apple account.');
          if (typeof body.linkPassword !== 'string' || !body.linkPassword) return { status: 409, body: { code: 'APPLE_LINK_REQUIRED', message: 'Verify your existing NaijaGo password to link this Apple account.' } };
          if (!await bcrypt.compare(body.linkPassword, user.password)) throw authError(401, 'APPLE_LINK_FAILED', 'Your existing NaijaGo password could not be verified.');
        } else if (body.profile?.acceptedTerms !== true) {
          return { status: 202, body: { code: 'APPLE_PROFILE_REQUIRED', profile: { email: identity.email }, message: 'Review the terms to create your account. Name is optional; no phone number is needed to sign in.' } };
        }
      }
      // Consumption and identity association commit together. Nonces cannot be reused
      // across requests or instances; onboarding 202/409 responses do not consume them.
      const consumed = await Challenge.findOneAndUpdate({ _id: body.challengeId, fingerprint: fp, usedAt: null, expiresAt: { $gt: now() } },
        { $set: { usedAt: now() } }, { new: true, session }).lean();
      if (!consumed) throw authError(401, 'APPLE_CHALLENGE_EXPIRED', 'Start Apple sign-in again.');
      if (!user) {
        const name = key => {
          const value = body.profile?.[key];
          if (value != null && (typeof value !== 'string' || value.length > 100)) throw authError(400, 'APPLE_PROFILE_INVALID', 'Use a name of up to 100 characters.');
          return value?.trim() || undefined;
        };
        [user] = await User.create([{ appleSubject: identity.sub, email: identity.email,
          firstName: name('firstName'), lastName: name('lastName'), password: crypto.randomBytes(48).toString('hex'), isEmailVerified: true,
          notificationPreferences: { promotions: false },
          deviceFingerprint: normalizeFingerprint(body.deviceFingerprint), isDeviceVerified: true,
        }], { session });
      } else if (!mapping) {
        user.appleSubject = identity.sub; user.isEmailVerified = true;
      }
      assertCustomer(user);
      if (!mapping) await Identity.create([{ _id: identity.sub, userId: user._id }], { session });
      // Successful nonce-bound Apple authentication proves control of the identity
      // on this device. No email/device flag supplied by the client is trusted.
      addTrustedDevice(user, normalizeFingerprint(body.deviceFingerprint), { platform: 'ios', label: 'Apple-authenticated device' });
      user.deviceFingerprint = normalizeFingerprint(body.deviceFingerprint); user.isDeviceVerified = true;
      await user.save({ session });
      return { user };
    }).then(async result => { if (result.user && !result.user.referralCode) await referral(result.user); return result; });
  }
  return { challenge, authenticate };
}
module.exports = { createAppleAuthService, assertCustomer };
