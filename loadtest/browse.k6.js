import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// No writes, logins, payments, external providers, images or Socket.IO traffic.
const base = String(__ENV.BASE_URL || '').replace(/\/$/, '');
if (!/^https:\/\/naijago-loadtest(?:-[a-z0-9-]+)?\.onrender\.com$/.test(base)
  && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) {
  throw new Error('BASE_URL must be the separate naijago-loadtest Render service or localhost with an explicit port.');
}
const token = __ENV.LOAD_TEST_ACCESS_TOKEN || '';
if (token.length < 32) throw new Error('Set the staging-only LOAD_TEST_ACCESS_TOKEN.');
const profile = __ENV.PROFILE || 'smoke';
const caps = { smoke: 10, baseline: 100, '500': 500, '1000': 1000, '2500': 2500, '5000': 5000 };
if (!caps[profile]) throw new Error('PROFILE must be smoke, baseline, 500, 1000, 2500 or 5000.');
if (profile === '5000' && __ENV.CONFIRM_5000 !== 'yes') throw new Error('Set CONFIRM_5000=yes only after smaller stages pass and metrics are monitored.');
const cap = caps[profile];
const stages = profile === 'smoke'
  ? [{ duration: '15s', target: 10 }, { duration: '45s', target: 10 }, { duration: '10s', target: 0 }]
  : [100, 500, 1000, 2500, 5000].filter(target => target <= cap).flatMap(target => [
    { duration: target >= 2500 ? '3m' : '1m', target },
    { duration: target === 5000 ? '15m' : '3m', target },
  ]).concat([{ duration: '1m', target: 0 }]);
const semanticFailures = new Rate('semantic_failures');
export const options = {
  stages,
  setupTimeout: '60s',
  gracefulRampDown: '15s',
  discardResponseBodies: true,
  thresholds: {
    http_req_failed: [
      'rate<0.01',
      { threshold: 'rate<0.10', abortOnFail: true, delayAbortEval: '1m' },
    ],
    http_req_duration: ['p(95)<2000', { threshold: 'p(95)<10000', abortOnFail: true, delayAbortEval: '1m' }],
    'http_req_duration{endpoint:catalog}': ['p(95)<2000'],
    'http_req_duration{endpoint:search}': ['p(95)<2000'],
    'http_req_duration{endpoint:detail}': ['p(95)<2000'],
    semantic_failures: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

function get(path, endpoint) {
  return http.get(`${base}${path}`, {
    headers: { 'X-NaijaGo-Loadtest-Token': token },
    timeout: '15s', redirects: 0, responseType: 'text',
    tags: { endpoint, name: endpoint },
  });
}
function json(response) { try { return response.json(); } catch (_) { return null; } }
function valid(response, shape) {
  const ok = check(response, {
    'HTTP 200': r => r.status === 200,
    'staging marker present': r => r.headers['X-Naijago-Loadtest-Mode'] === 'browse-only'
      || r.headers['X-NaijaGo-Loadtest-Mode'] === 'browse-only',
    'expected response shape': () => shape,
  });
  semanticFailures.add(!ok);
  return ok;
}
export function setup() {
  const root = get('/', 'preflight');
  if (!valid(root, Boolean(json(root)?.message))) throw new Error('Target is not a ready browsing load-test deployment.');
  const catalog = get('/api/products?page=1&limit=50', 'preflight');
  const products = json(catalog);
  if (!valid(catalog, Array.isArray(products) && products.length > 0)) {
    throw new Error('Preflight failed: seed synthetic active products in the isolated database before testing.');
  }
  const ids = products.map(p => String(p._id || '')).filter(id => /^[a-f\d]{24}$/i.test(id));
  if (!ids.length) throw new Error('Catalog contains no valid product IDs.');
  const total = Number(catalog.headers['X-Total-Count']);
  if (!Number.isSafeInteger(total) || total < products.length) throw new Error('Catalog total is missing or invalid.');
  const terms = products.map(p => String(p.name || '').split(/\s+/).find(word => word.length >= 3)).filter(Boolean);
  if (!terms.length) throw new Error('Synthetic product names must contain searchable words.');
  return { ids, terms, pages: Math.max(1, Math.ceil(total / 20)), total };
}
const pick = values => values[Math.floor(Math.random() * values.length)];
export default function (data) {
  // Deliberate think time: VUs represent browsing sessions, not requests/second.
  if (Math.random() < 0.25) {
    const categories = get('/api/categories', 'categories');
    const body = json(categories);
    valid(categories, Boolean(body && typeof body === 'object'));
    sleep(1 + Math.random() * 2);
  }
  const page = 1 + Math.floor(Math.random() * data.pages);
  const catalog = get(`/api/products?page=${page}&limit=20`, 'catalog');
  const products = json(catalog);
  valid(catalog, Array.isArray(products) && products.length > 0);
  sleep(2 + Math.random() * 3);
  const product = Array.isArray(products) && products.length ? pick(products) : null;
  const id = product && /^[a-f\d]{24}$/i.test(String(product._id)) ? String(product._id) : pick(data.ids);
  const detail = get(`/api/products/${id}`, 'detail');
  valid(detail, String(json(detail)?._id) === id);
  sleep(2 + Math.random() * 3);
  if (Math.random() < 0.5) {
    const term = pick(data.terms);
    const search = get(`/api/products/search?q=${encodeURIComponent(term)}&ai=false&page=1&limit=20`, 'search');
    valid(search, Array.isArray(json(search)?.products));
    sleep(2 + Math.random() * 3);
  }
}
