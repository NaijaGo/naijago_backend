const axios = require('axios');

const DEFAULT_WAPISENDER_BASE_URL = 'https://api.wapisender.com';

const getApiKey = () => String(process.env.WAPISENDER_API_KEY || '').trim();

const getInstanceName = () =>
  String(
    process.env.WAPISENDER_INSTANCE_NAME ||
    process.env.WAPISENDER_INSTANCE ||
    'NaijaGo',
  ).trim();

const isTruthy = (value) => ['true', '1', 'yes'].includes(String(value || '').trim().toLowerCase());

const isEnabled = () =>
  isTruthy(process.env.WAPISENDER_ENABLED) &&
  Boolean(getApiKey());

const stripTrailingSlash = (value) => String(value || '').trim().replace(/\/+$/, '');

const buildSendTextEndpoint = (instance) => {
  const baseUrl = stripTrailingSlash(process.env.WAPISENDER_BASE_URL || DEFAULT_WAPISENDER_BASE_URL);
  const configuredUrl = String(process.env.WAPISENDER_SEND_TEXT_URL || '').trim();
  let endpoint = configuredUrl || `${baseUrl}/message/sendText/{instance}`;

  endpoint = endpoint
    .replace(/\{instance\}/g, instance)
    .replace(/INSTANCE_NAME/g, instance)
    .replace(/your-instance/g, instance);

  if (!/\/message\/sendText(?:\/|$)/i.test(endpoint)) {
    return `${stripTrailingSlash(endpoint)}/message/sendText/${instance}`;
  }

  if (/\/message\/sendText\/?$/i.test(endpoint)) {
    return `${stripTrailingSlash(endpoint)}/${instance}`;
  }

  return endpoint;
};

const extractProviderMessage = (data) => {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return data.filter(Boolean).join('; ');
  return extractProviderMessage(data.message || data.error || data.response);
};

const normalizeNigeriaPhone = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw;

  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('0')) {
    digits = `234${digits.slice(1)}`;
  } else if (digits.length === 10 && /^[789]/.test(digits)) {
    digits = `234${digits}`;
  }

  if (process.env.WAPISENDER_NUMBER_FORMAT !== 'digits') {
    return `${digits}@s.whatsapp.net`;
  }

  return digits;
};

const buildSendTextBody = ({ number, text }) => {
  const payloadMode = process.env.WAPISENDER_PAYLOAD_MODE || 'evolution';

  if (payloadMode === 'simple') {
    return { number, text };
  }

  return {
    number,
    options: {
      delay: Number(process.env.WAPISENDER_MESSAGE_DELAY_MS || 1200),
      presence: 'composing',
    },
    textMessage: { text },
  };
};

const sendText = async ({ to, text }) => {
  if (!isEnabled()) {
    return { skipped: true, reason: 'WapiSender is not configured.' };
  }

  const number = normalizeNigeriaPhone(to);
  if (!number) {
    return { skipped: true, reason: 'Missing WhatsApp number.' };
  }

  const apiKey = getApiKey();
  const instance = encodeURIComponent(getInstanceName());
  if (!instance) {
    return { skipped: true, reason: 'Missing WapiSender instance key.' };
  }

  const endpoint = buildSendTextEndpoint(instance);
  const body = buildSendTextBody({ number, text });

  try {
    const response = await axios.post(
      endpoint,
      body,
      {
        headers: {
          apikey: apiKey,
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: Number(process.env.WAPISENDER_TIMEOUT_MS || 10000),
      },
    );

    return response.data;
  } catch (error) {
    const providerMessage = extractProviderMessage(error.response?.data);
    if (providerMessage) {
      error.message = `WapiSender error: ${providerMessage}`;
    }
    throw error;
  }
};

module.exports = {
  buildSendTextBody,
  buildSendTextEndpoint,
  isEnabled,
  normalizeNigeriaPhone,
  sendText,
};
