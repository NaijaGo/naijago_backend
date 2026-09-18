const axios = require('axios');

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
  const end = new Date();
  const start = initiatedAt ? new Date(initiatedAt) : new Date(end);
  if (Number.isNaN(start.getTime())) start.setTime(end.getTime());
  start.setUTCDate(start.getUTCDate() - 1);
  const earliest = new Date(end);
  earliest.setUTCDate(earliest.getUTCDate() - 29);
  if (start < earliest) start.setTime(earliest.getTime());
  const formatDate = (value) => value.toISOString().slice(0, 10);
  const response = await httpClient.get(`${baseUrl}/transaction`, {
    params: {
      start_date: formatDate(start),
      end_date: formatDate(end),
      reference: transactionRef,
      page: 1,
      perpage: 20,
    },
    headers: { Authorization: `Bearer ${secretKey}` },
    timeout: 30000,
  });
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
};

module.exports = { getSquadConfig, initiateSquadPayment, verifySquadPayment };
