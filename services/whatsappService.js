const axios = require('axios');

const DEFAULT_WAPISENDER_BASE_URL = 'https://api.wapisender.com';

const isEnabled = () =>
  process.env.WAPISENDER_ENABLED === 'true' &&
  Boolean(process.env.WAPISENDER_API_KEY) &&
  Boolean(process.env.WAPISENDER_INSTANCE);

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

  if (process.env.WAPISENDER_NUMBER_FORMAT === 'jid') {
    return `${digits}@s.whatsapp.net`;
  }

  return digits;
};

const sendText = async ({ to, text }) => {
  if (!isEnabled()) {
    return { skipped: true, reason: 'WapiSender is not configured.' };
  }

  const number = normalizeNigeriaPhone(to);
  if (!number) {
    return { skipped: true, reason: 'Missing WhatsApp number.' };
  }

  const baseUrl = process.env.WAPISENDER_BASE_URL || DEFAULT_WAPISENDER_BASE_URL;
  const instance = encodeURIComponent(process.env.WAPISENDER_INSTANCE);
  const endpoint = (process.env.WAPISENDER_SEND_TEXT_URL || `${baseUrl.replace(/\/$/, '')}/message/sendText/${instance}`)
    .replace('{instance}', instance);
  const payloadMode = process.env.WAPISENDER_PAYLOAD_MODE || 'evolution';
  const body = payloadMode === 'simple'
    ? { number, text }
    : {
        number,
        options: {
          delay: Number(process.env.WAPISENDER_MESSAGE_DELAY_MS || 1200),
          presence: 'composing',
        },
        textMessage: { text },
      };

  const response = await axios.post(
    endpoint,
    body,
    {
      headers: {
        apikey: process.env.WAPISENDER_API_KEY,
        Authorization: `Bearer ${process.env.WAPISENDER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: Number(process.env.WAPISENDER_TIMEOUT_MS || 10000),
    },
  );

  return response.data;
};

module.exports = {
  isEnabled,
  normalizeNigeriaPhone,
  sendText,
};
