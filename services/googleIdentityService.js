const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client({ transporterOptions: { timeout: 10000, retry: false } });
const APPS = new Set(['customer', 'vendor', 'rider']);
function authError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
async function verifyGoogleIdentity(idToken, app) {
  if (!APPS.has(app)) throw authError(400, 'INVALID_APP', 'Choose a supported NaijaGo app.');
  const audience = process.env['GOOGLE_' + app.toUpperCase() + '_CLIENT_ID']?.trim();
  if (!audience) throw authError(503, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not available yet. Please use email and password.');
  if (typeof idToken !== 'string' || !idToken || idToken.length > 10000) {
    throw authError(400, 'GOOGLE_TOKEN_REQUIRED', 'Please sign in with Google again.');
  }
  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience });
    payload = ticket.getPayload();
  } catch (_) {
    throw authError(401, 'GOOGLE_TOKEN_INVALID', 'Google sign-in could not be verified. Please try again.');
  }
  if (typeof payload?.sub !== 'string' || !payload.sub || payload.sub.length > 255 ||
      typeof payload.email !== 'string' || !payload.email || payload.email_verified !== true ||
      !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) {
    throw authError(401, 'GOOGLE_EMAIL_UNVERIFIED', 'Please verify your Google email address first.');
  }
  const email = payload.email.trim().toLowerCase();
  return { sub: payload.sub, email,
    firstName: payload.given_name || '', lastName: payload.family_name || '', fullName: payload.name || '',
    authoritativeEmail: email.endsWith('@gmail.com') || Boolean(payload.hd),
  };
}
function sendGoogleError(res, error) {
  const known = Number.isInteger(error.status);
  return res.status(known ? error.status : error.code === 11000 ? 409 : 500).json({
    code: known ? error.code : error.code === 11000 ? 'ACCOUNT_EXISTS' : 'GOOGLE_SIGN_IN_FAILED',
    message: known ? error.message : error.code === 11000
      ? 'An account already exists. Please sign in again or use your existing account.'
      : 'Unable to complete Google sign-in right now. Please try again.',
  });
}
module.exports = { verifyGoogleIdentity, authError, sendGoogleError };
