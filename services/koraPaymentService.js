const axios = require('axios');
const crypto = require('node:crypto');
const {nairaToKobo} = require('../utils/koraPayment');
const API = 'https://api.korapay.com/merchant/api/v1';
const fail = (message, code = 'KORAPAY_NOT_CONFIGURED', statusCode = 503) => {
  throw Object.assign(new Error(message), {code, statusCode});
};
const httpsUrl = (value, required = false) => {
  if (!value && !required) return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.hash) return url.href;
  } catch { /* fail closed */ }
  fail('A valid HTTPS Kora notification or redirect URL is required.');
};
const getKoraConfig = () => {
  const secretKey = String(process.env.KORAPAY_SECRET_KEY || '').trim();
  const mode = String(process.env.KORAPAY_MODE || 'test').trim().toLowerCase();
  if (!['test', 'live'].includes(mode) || !secretKey.startsWith(`sk_${mode}_`)) fail('Kora secret key and mode must match.');
  if (process.env.NODE_ENV === 'production' && mode !== 'live') fail('Production Kora payments require live mode.');
  return {secretKey, mode, publicKey: String(process.env.KORAPAY_PUBLIC_KEY || '').trim()};
};
const getKoraCheckoutConfig = () => {
  const config = getKoraConfig();
  const channels = String(process.env.KORAPAY_CHANNELS || 'bank_transfer,card').split(',').map(v => v.trim()).filter(Boolean);
  if (!channels.length || channels.some(channel => !['bank_transfer', 'card', 'pay_with_bank'].includes(channel))) fail('Kora payment channels are invalid.');
  return {...config, channels: [...new Set(channels)],
    notificationUrl: httpsUrl(process.env.KORAPAY_NOTIFICATION_URL, true),
    redirectUrl: httpsUrl(process.env.KORAPAY_REDIRECT_URL)};
};
const referenceRequired = reference => {
  if (typeof reference !== 'string' || !/^[a-z\d_-]{8,100}$/i.test(reference)) fail('Invalid Kora reference.', 'KORAPAY_INVALID_REFERENCE', 400);
};
const auth = key => ({headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'}, timeout: 30000, maxRedirects: 0});
// Restrict redirects at both API and checkout boundaries; never forward secrets.
const validCheckoutUrl = value => {
  try {
    const url = new URL(value);
    return typeof value === 'string' && value.trim() === value && url.protocol === 'https:'
      && url.hostname === 'checkout.korapay.com' && (!url.port || url.port === '443')
      && !url.username && !url.password;
  } catch {return false;}
};
const scopes = new WeakMap();
const verify = async (kind, reference, httpClient = axios) => {
  referenceRequired(reference);
  const config = getKoraConfig();
  let clients = scopes.get(httpClient);
  if (!clients) {clients = new Map(); scopes.set(httpClient, clients);}
  const key = crypto.createHash('sha256').update(config.secretKey).digest('hex');
  if (!clients.has(key)) clients.set(key, {until: 0, inFlight: new Map()});
  const scope = clients.get(key), item = `${kind}:${reference}`;
  const delayed = () => Object.assign(new Error('Payment verification is delayed. Please wait and do not pay again.'),
    {statusCode: 503, code: 'KORAPAY_RATE_LIMITED', retryAfterSeconds: Math.max(1, Math.ceil((scope.until - Date.now()) / 1000))});
  if (scope.until > Date.now()) throw delayed();
  if (scope.inFlight.has(item)) return scope.inFlight.get(item);
  const work = (async () => {
    try {return (await httpClient.get(`${API}/${kind}/${encodeURIComponent(reference)}`, auth(config.secretKey))).data;}
    catch (error) {
      if (error.response?.status === 404) return {status: false, data: null};
      if (error.response?.status === 429) {
        const retry = Number(error.response.headers?.['retry-after']);
        scope.until = Date.now() + (Number.isFinite(retry) && retry > 0 ? Math.max(60, retry) : 60) * 1000;
        throw delayed();
      }
      fail('Kora verification is temporarily unavailable. Do not pay again.', 'KORAPAY_VERIFY_UNAVAILABLE');
    }
  })();
  scope.inFlight.set(item, work);
  try {return await work;} finally {scope.inFlight.delete(item);}
};
const initiateKoraPayment = async ({amountNaira, email, customerName, transactionRef, orderId, httpClient = axios}) => {
  const config = getKoraCheckoutConfig(); referenceRequired(transactionRef);
  const kobo = nairaToKobo(amountNaira);
  if (kobo === null || typeof email !== 'string' || !email.includes('@')) fail('Valid payment details are required.', 'KORAPAY_INVALID_PAYMENT', 400);
  const payload = {amount: kobo / 100, currency: 'NGN', reference: transactionRef,
    customer: {email, name: customerName || email}, merchant_bears_cost: true,
    channels: config.channels, notification_url: config.notificationUrl,
    metadata: {'order-id': String(orderId), source: 'naijago-customer-app'}};
  if (config.redirectUrl) payload.redirect_url = config.redirectUrl;
  let response;
  try {response = (await httpClient.post(`${API}/charges/initialize`, payload, auth(config.secretKey))).data;}
  catch {fail('Checkout could not be opened. Your payment reference is saved; do not pay through another gateway.', 'KORAPAY_INITIALIZE_UNAVAILABLE');}
  if (response?.status !== true || response.data?.reference !== transactionRef || !validCheckoutUrl(response.data?.checkout_url)) fail('Kora returned invalid checkout details.', 'KORAPAY_INVALID_CHECKOUT');
  return {data: response.data, mode: config.mode};
};
const listKoraBanks = async (httpClient = axios) => {
  const config = getKoraConfig();
  if (!config.publicKey.startsWith(`pk_${config.mode}_`)) fail('Kora public key and mode must match.');
  const response = await httpClient.get(`${API}/misc/banks`, {...auth(config.publicKey), params: {countryCode: 'NG'}});
  if (response.data?.status !== true || !Array.isArray(response.data.data)) fail('Kora bank list is unavailable.');
  return response.data.data.map(bank => ({name: bank.name, code: bank.code, id: bank.code}));
};
const initiateKoraTransfer = async ({reference, amount, bank, account, name, email, httpClient = axios}) => {
  const config = getKoraConfig(); referenceRequired(reference);
  if (process.env.KORAPAY_PAYOUTS_ENABLED !== 'true') fail('Kora bank transfers are not enabled.');
  if (nairaToKobo(amount) === null || !/^\d{10}$/.test(account) || !/^\d{3,12}$/.test(bank) || !email) fail('Valid bank transfer details are required.', 'KORAPAY_INVALID_PAYOUT', 400);
  return (await httpClient.post(`${API}/transactions/disburse`, {
    reference, destination: {type: 'bank_account', amount, currency: 'NGN',
      narration: `NaijaGo withdrawal ${reference}`, bank_account: {bank, account}, customer: {name, email}},
    notification_url: httpsUrl(process.env.KORAPAY_NOTIFICATION_URL, true),
  }, auth(config.secretKey))).data;
};
module.exports = {getKoraConfig, getKoraCheckoutConfig, validCheckoutUrl, initiateKoraPayment, listKoraBanks,
  initiateKoraTransfer, verifyKoraPayment: args => verify('charges', args.transactionRef, args.httpClient),
  verifyKoraTransfer: args => verify('transactions', args.transactionRef, args.httpClient)};
