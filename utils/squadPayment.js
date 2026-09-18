const crypto = require('crypto');

const normalizeSquadTransaction = (response) => {
  const data = response?.data?.data || response?.data || response || {};
  return {
    id: data.gateway_ref || data.transaction_ref,
    status: data.transaction_status || data.status,
    tx_ref: data.transaction_ref,
    gateway_ref: data.gateway_ref,
    amountKobo: Number(data.amount),
    currency: String(data.currency || '').toUpperCase(),
    email: data.email || data.customer?.email,
    raw: data,
  };
};

const squadPaymentMatchesOrder = (response, order, txRef) => {
  const payment = normalizeSquadTransaction(response);
  const expectedKobo = Math.round(Number(order?.totalPrice) * 100);
  return String(payment.status || '').toLowerCase() === 'success'
    && payment.tx_ref === txRef
    && payment.currency === 'NGN'
    && Number.isSafeInteger(expectedKobo)
    && payment.amountKobo >= expectedKobo;
};

const safeHexEqual = (left, right) => {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(String(left).trim().toLowerCase(), 'utf8');
  const rightBuffer = Buffer.from(String(right).trim().toLowerCase(), 'utf8');
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const verifySquadWebhookSignature = ({ rawBody, body, signature, secretKey }) => {
  if (!secretKey || !signature) return false;
  const payload = rawBody?.length ? rawBody : Buffer.from(JSON.stringify(body || {}), 'utf8');
  const expected = crypto.createHmac('sha512', secretKey).update(payload).digest('hex');
  return safeHexEqual(signature, expected);
};

const buildSquadPendingPaymentResult = (existingResult, response, txRef, checkedAt = new Date()) => {
  const payment = normalizeSquadTransaction(response);
  return {
    ...(existingResult || {}), provider: 'squad', tx_ref: txRef,
    status: String(payment.status || 'pending').toLowerCase(), lastCheckedAt: checkedAt,
  };
};

module.exports = { buildSquadPendingPaymentResult, normalizeSquadTransaction, squadPaymentMatchesOrder, verifySquadWebhookSignature };
