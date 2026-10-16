// Opt-in protection for a separate browsing load-test deployment only.
// No environment is changed and no connection is opened by this module.
const crypto = require('node:crypto');

const DATABASE = 'naijago_loadtest';
const MARKER = 'browse-only';
const allowedPath = path => path === '/' || path === '/api/categories'
  || path === '/api/products' || path === '/api/products/search'
  || /^\/api\/products\/[a-f\d]{24}$/i.test(path);
const fail = message => { throw new Error(`Load-test configuration: ${message}`); };

function configureLoadTestMode(env) {
  const mode = env.LOAD_TEST_MODE;
  if (mode === undefined || mode === '' || mode === 'off') return { enabled: false };
  if (mode !== MARKER) fail('LOAD_TEST_MODE must be browse-only or off.');
  if (env.NODE_ENV !== 'production') fail('use NODE_ENV=production for comparable runtime behavior.');
  if (env.KORAPAY_PAYOUTS_ENABLED !== 'false') fail('KORAPAY_PAYOUTS_ENABLED must be false.');
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || /REPLACE|PASTE_/i.test(env.JWT_SECRET)) fail('provide a new staging-only JWT_SECRET of at least 32 characters.');
  const token = String(env.LOAD_TEST_ACCESS_TOKEN || '');
  if (!/^[\x21-\x7e]{32,256}$/.test(token) || /REPLACE|PASTE_/i.test(token)) fail('provide a staging-only LOAD_TEST_ACCESS_TOKEN of 32-256 printable characters.');
  // A staging service must not inherit the production integration environment group.
  const externalCredential = /^(KORAPAY|FLUTTERWAVE|SQUAD|RESEND|ONESIGNAL|CLOUDINARY|AWS|PHOTOROOM|OPENROUTER|GEMINI|GOOGLE|MAPBOX|FIREBASE|SMTP|EMAIL|MAIL|TERMII|TWILIO)(?:_|$)/;
  for (const [name, value] of Object.entries(env)) {
    if (value && externalCredential.test(name) && /KEY|TOKEN|SECRET|PASS|CREDENTIAL|CLOUDINARY_URL/.test(name)) {
      fail(`remove ${name} from this deployment; no external service credentials are needed.`);
    }
  }
  let uri;
  try { uri = new URL(env.MONGO_URI); } catch (_) { fail('provide the separate database URI.'); }
  if (!['mongodb:', 'mongodb+srv:'].includes(uri.protocol)
    || decodeURIComponent(uri.pathname) !== `/${DATABASE}`
    || [...uri.searchParams.keys()].some(key => key.toLowerCase() === 'dbname')) {
    fail(`MONGO_URI must explicitly select /${DATABASE}.`);
  }
  if (env.RENDER_EXTERNAL_HOSTNAME && !/^naijago-loadtest(?:-[a-z0-9-]+)?\.onrender\.com$/.test(env.RENDER_EXTERNAL_HOSTNAME)) {
    fail('use a separate Render web service named naijago-loadtest, never the production service.');
  }
  const expected = Buffer.from(token);
  return {
    enabled: true,
    // Mounted before body parsing, routes and static assets. Socket.IO is gated separately.
    middleware(req, res, next) {
      res.set('X-NaijaGo-Loadtest-Mode', MARKER);
      res.set('Cache-Control', 'no-store');
      if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).json({ message: 'Browsing load test: writes are disabled.' });
      const path = req.path.replace(/\/$/, '') || '/';
      // Render health checks cannot supply a secret header.
      if (path === '/') return next();
      const supplied = Buffer.from(String(req.get('X-NaijaGo-Loadtest-Token') || ''));
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        return res.status(401).json({ message: 'Load-test access token required.' });
      }
      if (!allowedPath(path)) return res.status(403).json({ message: 'This route is outside the browsing load test.' });
      if (path === '/api/products/search' && String(req.query.ai || '').toLowerCase() === 'true') {
        return res.status(403).json({ message: 'External AI search is outside this test.' });
      }
      return next();
    },
    async verifyDatabase(connection) {
      if (connection.name !== DATABASE) fail('unexpected connected database.');
      const status = await connection.db.command({ connectionStatus: 1 });
      const roles = status.authInfo?.authenticatedUserRoles;
      if (!Array.isArray(roles) || !roles.length
        || roles.some(role => role.role !== 'read' || role.db !== DATABASE)) {
        fail(`database account must have only the built-in read role on ${DATABASE}.`);
      }
    },
  };
}

module.exports = { configureLoadTestMode };
