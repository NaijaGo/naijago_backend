const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Rider = require('../models/Rider');
const { normalizeFingerprint } = require('../services/deviceTrustService');
const { ensureReferralCode } = require('../services/referralService');
const { verifyGoogleIdentity, authError, sendGoogleError } = require('../services/googleIdentityService');
// Link only after proving ownership of the existing NaijaGo account.
// Google subjects, never client-supplied email addresses or roles, identify logins.
async function findGoogleAccount(Model, identity, body) {
  let account = await Model.findOne({ googleSubject: identity.sub }).select('+password');
  if (account) return account;
  account = await Model.findOne({ email: identity.email }).select('+password');
  if (!account) return null;
  if (account.isAdmin) throw authError(403, 'GOOGLE_ADMIN_NOT_SUPPORTED', 'Please use your existing Admin login.');
  if (account.googleSubject && account.googleSubject !== identity.sub) {
    throw authError(409, 'GOOGLE_ACCOUNT_CONFLICT', 'This account is linked to another Google account.');
  }
  if (typeof body.linkPassword !== 'string' || !body.linkPassword) {
    throw authError(409, 'GOOGLE_LINK_REQUIRED', 'Enter your existing NaijaGo password to link this Google account.');
  }
  if (!await bcrypt.compare(body.linkPassword, account.password)) {
    throw authError(401, 'GOOGLE_LINK_FAILED', 'Your existing NaijaGo password could not be verified.');
  }
  const linked = await Model.findOneAndUpdate({ _id: account._id,
    $or: [{ googleSubject: { $exists: false } }, { googleSubject: null }, { googleSubject: identity.sub }],
  }, { $set: { googleSubject: identity.sub,
    ...(identity.authoritativeEmail ? { isEmailVerified: true } : {}),
  } }, { new: true, runValidators: true }).select('+password');
  if (!linked) throw authError(409, 'GOOGLE_ACCOUNT_CONFLICT', 'This account is linked to another Google account.');
  return linked;
}
function googleUserAuth(sendVerificationEmail) {
  return async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!['customer', 'vendor'].includes(body.app)) throw authError(400, 'INVALID_APP', 'Choose the customer or vendor app.');
      const fingerprint = normalizeFingerprint(body.deviceFingerprint);
      if (!fingerprint || fingerprint === 'unknown-device') throw authError(400, 'INVALID_DEVICE_FINGERPRINT', 'Unable to identify this device securely. Please restart the app.');
      const identity = await verifyGoogleIdentity(body.idToken, body.app);
      let user = await findGoogleAccount(User, identity, body);
      if (!user) {
        if (!body.profile) return res.status(202).json({ code: 'GOOGLE_PROFILE_REQUIRED', profile: {
          email: identity.email, firstName: identity.firstName, lastName: identity.lastName,
        }, message: 'Complete your account details to continue.' });
        const { firstName, lastName, phoneNumber, acceptedTerms } = body.profile;
        if (typeof firstName !== 'string' || !firstName.trim() || firstName.trim().length > 100 ||
            typeof lastName !== 'string' || !lastName.trim() || lastName.trim().length > 100 ||
            typeof phoneNumber !== 'string' || !/^(?:\+?234|0)[789]\d{9}$/.test(phoneNumber.trim()) || acceptedTerms !== true) {
          throw authError(400, 'GOOGLE_PROFILE_INVALID', 'Enter your first name, last name, Nigerian phone number and accept the terms.');
        }
        const verificationToken = identity.authoritativeEmail ? undefined : crypto.randomBytes(32).toString('hex');
        user = await User.create({ firstName: firstName.trim(), lastName: lastName.trim(),
          phoneNumber: phoneNumber.trim(), email: identity.email, googleSubject: identity.sub,
          password: crypto.randomBytes(48).toString('hex'), isEmailVerified: identity.authoritativeEmail,
          emailVerificationToken: verificationToken,
          emailVerificationExpires: verificationToken ? new Date(Date.now() + 86400000) : undefined,
        });
        await ensureReferralCode(user);
        if (verificationToken) await sendVerificationEmail(user.email, verificationToken, 'email');
      }
      if (user.isAdmin) throw authError(403, 'GOOGLE_ADMIN_NOT_SUPPORTED', 'Please use your existing Admin login.');
      req.googleAuthenticatedUser = user;
      return next();
    } catch (error) { return sendGoogleError(res, error); }
  };
}
async function googleRiderAuth(req, res, next) {
  try {
    const identity = await verifyGoogleIdentity(req.body?.idToken, 'rider');
    const rider = await findGoogleAccount(Rider, identity, req.body || {});
    if (!rider) return res.status(202).json({ code: 'GOOGLE_RIDER_ONBOARDING_REQUIRED',
      profile: { email: identity.email, fullName: identity.fullName },
      message: 'Complete your rider profile and submit your verification documents for approval.' });
    req.googleAuthenticatedRider = rider;
    return next();
  } catch (error) { return sendGoogleError(res, error); }
}
module.exports = { googleUserAuth, googleRiderAuth };
