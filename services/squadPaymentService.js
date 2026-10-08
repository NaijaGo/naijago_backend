const axios = require('axios');
const crypto = require('node:crypto');

// Direct verification, webhook and recovery share one in-process provider gate.
// Never cache a payment as successful or initiate a new charge here.
const verificationScopes = new WeakMap();
function scopeFor(httpClient, baseUrl, secretKey) {
  let scopes = verificationScopes.get(httpClient);
  if (!scopes) { scopes = new Map(); verificationScopes.set(httpClient, scopes); }
  const account = crypto.createHash('sha256').update(`${baseUrl}\n${secretKey}`).digest('hex');
  if (!scopes.has(account)) scopes.set(account, { cooldownUntil: 0, inFlight: new Map() });
  return scopes.get(account);
}
function rateLimitError(until) {
  const error = new Error('Payment verification is temporarily delayed by Squad. Please wait before verifying again. Do not pay again.');
  Object.assign(error, { code: 'SQUAD_RATE_LIMITED', statusCode: 503,
    retryAfterSeconds: Math.max(1, Math.ceil((until - Date.now()) / 1000)) });
  return error;
}
function cooldownMilliseconds(value) {
  const seconds = Number(value);
  if (typeof value === 'string' && value.trim() && seconds >= 0 && Number.isSafeInteger(Math.ceil(seconds * 1000))) return Math.max(60000, Math.ceil(seconds * 1000));
  const deadline = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(deadline) ? Math.max(60000, deadline - Date.now()) : 60000;
}

const getSquadConfig = () => {
  const secretKey = String(process.env.SQUAD_SECRET_KEY || '').trim();
  const baseUrl = String(
    process.env.SQUAD_BASE_URL || 'https://sandbox-api-d.squadco.com',
  ).replace(/\/$/, '');
  if (!secretKey) {
    const error = new Error('Squad payment is not configured.');
    error.code = 'SQUAD_NOT_CONFIGURED';
    throw error;
  }
  return {
    secretKey,
    baseUrl,
    callbackUrl: String(process.env.SQUAD_REDIRECT_URL || '').trim(),
  };
};

const initiateSquadPayment = async ({
  amountNaira,
  email,
  customerName,
  transactionRef,
  orderId,
  httpClient = axios,
}) => {
  const { secretKey, baseUrl, callbackUrl } = getSquadConfig();
  const amount = Math.round(Number(amountNaira) * 100);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Error('A valid payment amount is required.');
  }
  const payload = {
    amount,
    email,
    currency: 'NGN',
    initiate_type: 'inline',
    transaction_ref: transactionRef,
    customer_name: customerName,
    payment_channels: ['card', 'bank', 'ussd', 'transfer'],
    metadata: { order_id: String(orderId), source: 'naijago_customer_app' },
    pass_charge: false,
  };
  if (callbackUrl) payload.callback_url = callbackUrl;

  const response = await httpClient.post(`${baseUrl}/transaction/initiate`, payload, {
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  const data = response?.data?.data;
  if (!data?.checkout_url || !data?.transaction_ref) {
    throw new Error('Squad did not return a checkout URL.');
  }
  return { raw: response.data, data };
};

const verifySquadPayment = async ({ transactionRef, initiatedAt, httpClient = axios }) => {
  const { secretKey, baseUrl } = getSquadConfig();
  if (typeof transactionRef !== 'string' || !transactionRef.trim() || transactionRef.length > 200) {
    throw new Error('A valid transaction reference is required.');
  }
  const scope = scopeFor(httpClient, baseUrl, secretKey);
  if (scope.cooldownUntil > Date.now()) throw rateLimitError(scope.cooldownUntil);
  if (scope.inFlight.has(transactionRef)) return scope.inFlight.get(transactionRef);
  const work = (async () => {
    const end = new Date();
    const start = initiatedAt ? new Date(initiatedAt) : new Date(end);
    if (Number.isNaN(start.getTime())) start.setTime(end.getTime());
    start.setUTCDate(start.getUTCDate() - 1);
    const earliest = new Date(end);
    earliest.setUTCDate(earliest.getUTCDate() - 29);
    if (start < earliest) start.setTime(earliest.getTime());
    const formatDate = (value) => value.toISOString().slice(0, 10);
    let response;
    try { response = await httpClient.get(`${baseUrl}/transaction`, {
      params: {
        start_date: formatDate(start),
        end_date: formatDate(end),
        reference: transactionRef,
      },
      headers: { Authorization: `Bearer ${secretKey}` },
      timeout: 30000,
    }); } catch (error) {
      if (error.response?.status === 429) {
        const headers = error.response.headers;
        const retryAfter = headers?.get?.('retry-after') ?? headers?.['retry-after'];
        scope.cooldownUntil = Date.now() + cooldownMilliseconds(retryAfter);
        throw rateLimitError(scope.cooldownUntil);
      }
      throw error;
    }
    const payload = response?.data;
    const records = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.data?.rows)
        ? payload.data.rows
        : payload?.data
          ? [payload.data]
          : [];
    const transaction = records.find((item) => item?.transaction_ref === transactionRef);
    return transaction
      ? { status: 200, success: true, data: transaction }
      : { status: 404, success: false, data: null };
  })();
  scope.inFlight.set(transactionRef, work);
  try { return await work; }
  finally { if (scope.inFlight.get(transactionRef) === work) scope.inFlight.delete(transactionRef); }
};

module.exports = { getSquadConfig, initiateSquadPayment, verifySquadPayment };
