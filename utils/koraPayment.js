const crypto = require('node:crypto');

// Kora accepts NGN amounts in naira. Convert only for integer comparisons.
const nairaToKobo = (value) => {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const amount = Number(value), kobo = Math.round(amount * 100);
  return Number.isFinite(amount) && amount > 0 && Number.isSafeInteger(kobo) && kobo > 0
    && Math.abs(amount * 100 - kobo) < 0.00001 ? kobo : null;
};
const normalizeKoraTransaction = (response) => {
  const data = response?.data || {};
  return { id: data.transaction_reference || data.reference, tx_ref: data.reference,
    status: String(data.status || 'pending').toLowerCase(), currency: String(data.currency || '').toUpperCase(),
    amountKobo: nairaToKobo(data.amount_paid ?? data.amount), email: data.customer?.email, raw: data };
};
const koraPaymentMatchesOrder = (response, order, reference) => {
  const payment = normalizeKoraTransaction(response), expected = nairaToKobo(order?.totalPrice);
  const stored = order?.paymentResult;
  return response?.status === true && payment.status === 'success'
    && payment.tx_ref === reference && stored?.provider === 'korapay' && stored.tx_ref === reference
    && payment.currency === 'NGN' && expected !== null && payment.amountKobo === expected
    && (stored.expectedAmountKobo == null || stored.expectedAmountKobo === expected)
    && (!payment.raw.metadata?.['order-id'] || String(payment.raw.metadata['order-id']) === String(order._id))
    && (!payment.email || !stored.expectedCustomerEmail || payment.email.toLowerCase() === stored.expectedCustomerEmail.toLowerCase());
};
const verifyKoraWebhookSignature = ({body, signature, secretKey}) => {
  if (!secretKey || typeof signature !== 'string' || !/^[a-f\d]{64}$/i.test(signature)
    || !body?.data || typeof body.data !== 'object' || Array.isArray(body.data)) return false;
  const expected = crypto.createHmac('sha256', secretKey).update(JSON.stringify(body.data)).digest();
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), expected);
};
const buildKoraPendingPaymentResult = (existing, response, reference) => {
  const payment = normalizeKoraTransaction(response);
  // A provider's success with a mismatched amount/reference is not our success.
  const status = payment.status === 'success' ? 'pending' : payment.status;
  return {...existing, provider: 'korapay', tx_ref: reference,
    status: ['failed', 'cancelled'].includes(status) ? status : 'pending', lastCheckedAt: new Date()};
};
const koraVerifiedTransaction = response => {
  const payment = normalizeKoraTransaction(response);
  return {id: payment.id, status: 'successful', tx_ref: payment.tx_ref,
    gateway_ref: payment.raw.transaction_reference, amount: payment.amountKobo / 100,
    currency: payment.currency, email: payment.email};
};
module.exports = {nairaToKobo, normalizeKoraTransaction, koraPaymentMatchesOrder,
  verifyKoraWebhookSignature, buildKoraPendingPaymentResult, koraVerifiedTransaction};
