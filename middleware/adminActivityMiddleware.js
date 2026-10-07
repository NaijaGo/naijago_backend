const { publishAdminActivity } = require('../services/adminActivityService');

const CATEGORY_RULES = [
  ['/orders', 'order', 'orders.html'],
  ['/riders', 'rider', 'riders.html'],
  ['/vendor', 'vendor', 'vendors.html'],
  ['/pharmacist', 'pharmacist', 'pharmacist-requests.html'],
  ['/products', 'product', 'product-moderation.html'],
  ['/wallet', 'wallet', 'withdrawals.html'],
  ['/withdraw', 'withdrawal', 'withdrawals.html'],
  ['/disputes', 'dispute', 'disputes.html'],
  ['/returns', 'return', 'orders.html'],
  ['/subscriptions', 'subscription', 'subscriptions.html'],
  ['/referral', 'referral', 'referral-settings.html'],
  ['/chat', 'chat', 'pharmacy-chat-prices.html'],
  ['/companies', 'company', 'companies.html'],
  ['/companyadmin', 'company', 'companies.html'],
  ['/auth', 'customer', 'people.html'],
  ['/admin', 'system', 'index.html'],
];

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const EXCLUDED_PATHS = [
  '/api/analytics/',
  '/api/riders/location',
  '/api/riders/notifications/mark-read',
  '/api/auth/notifications/mark-read',
];
const SILENT_PATHS = [
  '/api/chat/send',
  '/api/admin/activity/',
  '/api/auth/notification-preferences',
];

const labelFromPath = (path) => path
  .replace(/^\/api\//, '')
  .replace(/[?#].*$/, '')
  .split('/')
  .filter((part) => part && !/^[a-f\d]{24}$/i.test(part))
  .map((part) => part.replace(/[-_]/g, ' '))
  .join(' · ');

const actorFromRequest = (req) => {
  const account = req.user || req.rider;
  if (!account) return undefined;
  const name = account.businessName || account.fullName ||
    [account.firstName, account.lastName].filter(Boolean).join(' ') || account.email || '';
  const type = account.isAdmin ? 'admin' : account.plateNumber ? 'rider' :
    account.isVendor ? 'vendor' : account.role || 'customer';
  return { type, id: account._id, name };
};

function adminActivityMiddleware(req, res, next) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (!MUTATION_METHODS.has(req.method) || !path.startsWith('/api/') ||
      EXCLUDED_PATHS.some((excluded) => path.startsWith(excluded))) {
    return next();
  }

  const startedAt = Date.now();
  res.once('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 400) return;
    const [, category = 'system', page = 'index.html'] =
      CATEGORY_RULES.find(([fragment]) => path.includes(fragment)) || [];
    const label = labelFromPath(path) || 'platform activity';
    const isDelete = req.method === 'DELETE';
    const isApproval = /approve|reject|status|moderation|verify/i.test(path);

    setImmediate(() => {
      publishAdminActivity(req.app, {
        eventType: `${req.method.toLowerCase()}_${path.replace(/^\/api\//, '').replace(/[^a-z0-9]+/gi, '_')}`,
        category,
        severity: isDelete ? 'warning' : isApproval ? 'success' : 'info',
        title: isDelete ? `Deleted: ${label}` : `Activity: ${label}`,
        message: `${actorFromRequest(req)?.name || 'A platform user'} completed ${label}.`,
        actor: actorFromRequest(req),
        target: req.params?.id ? { type: category, id: req.params.id } : undefined,
        orderId: req.params?.orderId,
        shipmentId: req.params?.shipmentId,
        sessionId: req.params?.sessionId,
        destination: { page, params: { id: req.params?.id || null } },
        metadata: {
          method: req.method,
          path,
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt,
          pushToAdmin: !SILENT_PATHS.some((silent) => path.startsWith(silent)),
        },
      }).catch((error) => console.error('Request activity publishing failed:', error.message));
    });
  });

  next();
}

module.exports = adminActivityMiddleware;
