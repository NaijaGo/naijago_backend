const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { authError } = require('./googleIdentityService');
const KEYS_URL = 'https://appleid.apple.com/auth/keys';
function createAppleVerifier({ fetchKeys = async () => {
  const response = await fetch(KEYS_URL, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw new Error('Apple keys unavailable');
  return response.json();
}, audience = () => process.env.APPLE_CUSTOMER_CLIENT_ID?.trim(), now = () => Date.now() } = {}) {
  let cache = null, expires = 0, pending = null, lastRefresh = 0;
  async function keys(force = false) {
    if (cache && expires > now() && (!force || now() - lastRefresh < 60000)) return cache;
    if (!pending) pending = (async () => {
      const result = await fetchKeys();
      if (!Array.isArray(result.keys) || !result.keys.length || result.keys.length > 20) throw new Error('Invalid Apple key set');
      cache = result.keys; lastRefresh = now(); expires = now() + 3600000; return cache;
    })().finally(() => { pending = null; });
    return pending;
  }
  return async function verify(idToken, nonce) {
    const clientId = audience();
    if (!clientId) throw authError(503, 'APPLE_NOT_CONFIGURED', 'Apple sign-in is not configured yet.');
    if (typeof idToken !== 'string' || !idToken || idToken.length > 10000 || !/^[a-f0-9]{64}$/.test(nonce || '')) {
      throw authError(400, 'APPLE_TOKEN_REQUIRED', 'Please sign in with Apple again.');
    }
    const decoded = jwt.decode(idToken, { complete: true });
    if (!decoded || decoded.header.alg !== 'RS256' || typeof decoded.header.kid !== 'string' || decoded.header.kid.length > 255) {
      throw authError(401, 'APPLE_TOKEN_INVALID', 'Apple identity could not be verified.');
    }
    let key;
    try {
      key = (await keys()).find(k => k.kid === decoded.header.kid && k.kty === 'RSA' && k.alg === 'RS256' && k.use === 'sig');
      if (!key) key = (await keys(true)).find(k => k.kid === decoded.header.kid && k.kty === 'RSA' && k.alg === 'RS256' && k.use === 'sig');
    } catch (_) { throw authError(503, 'APPLE_UNAVAILABLE', 'Apple verification is temporarily unavailable. Please retry.'); }
    if (!key) throw authError(401, 'APPLE_TOKEN_INVALID', 'Apple identity could not be verified.');
    let payload;
    try {
      payload = jwt.verify(idToken, crypto.createPublicKey({ key, format: 'jwk' }), {
        algorithms: ['RS256'], issuer: 'https://appleid.apple.com', audience: clientId,
        clockTimestamp: Math.floor(now() / 1000),
      });
      if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255 ||
          payload.aud !== clientId || !Number.isFinite(payload.exp) || !Number.isFinite(payload.iat) ||
          payload.iat > now() / 1000 + 60 || payload.nonce !== nonce) throw new Error('Invalid Apple claims');
    } catch (_) { throw authError(401, 'APPLE_TOKEN_INVALID', 'Apple identity expired or could not be verified. Please sign in again.'); }
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null;
    return { sub: payload.sub, email, emailVerified: payload.email_verified === true || payload.email_verified === 'true' };
  };
}
module.exports = { createAppleVerifier, verifyAppleIdentity: createAppleVerifier() };
