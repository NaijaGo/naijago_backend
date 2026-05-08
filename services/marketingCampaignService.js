const { Resend } = require('resend');
const NotificationLog = require('../models/NotificationLog');
const whatsappService = require('./whatsappService');

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const htmlFromMessage = ({ title, message }) => `
  <div style="font-family:Arial,sans-serif;background:#f5f7fb;padding:32px 16px;color:#111827;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e5e7eb;">
      <img src="https://naijago-backend.onrender.com/naijago-app.jpg" alt="NaijaGo" style="width:72px;height:72px;border-radius:50%;object-fit:cover;margin-bottom:20px;" />
      <h1 style="font-size:24px;line-height:1.25;color:#102b5c;margin:0 0 16px;">${escapeHtml(title)}</h1>
      <div style="font-size:16px;line-height:1.6;color:#374151;white-space:pre-line;">${escapeHtml(message)}</div>
      <p style="font-size:12px;color:#6b7280;margin-top:28px;">You are receiving this message from NaijaGo.</p>
    </div>
  </div>
`;

const sendCampaignEmail = async ({ to, title, message }) => {
  if (!process.env.RESEND_API_KEY) {
    return { skipped: true, reason: 'Resend is not configured.' };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: process.env.MARKETING_EMAIL_FROM || 'NaijaGo <noreply@naijagoapp.com>',
    to,
    subject: title,
    html: htmlFromMessage({ title, message }),
    text: message,
  });

  if (error) {
    throw new Error(error.message || 'Resend email failed.');
  }

  return data;
};

const buildRecipientName = (contact) => contact.name || contact.email || contact.phoneNumber || 'contact';

const sendMarketingCampaign = async ({
  list,
  title,
  message,
  channels = [],
  sentBy,
}) => {
  const enabledChannels = channels.filter((channel) =>
    ['email', 'whatsapp'].includes(channel),
  );

  if (!enabledChannels.length) {
    const error = new Error('Choose at least one campaign channel.');
    error.statusCode = 400;
    throw error;
  }

  const cleanTitle = String(title || '').trim();
  const cleanMessage = String(message || '').trim();
  if (!cleanTitle || !cleanMessage) {
    const error = new Error('Campaign title and message are required.');
    error.statusCode = 400;
    throw error;
  }

  const contacts = Array.isArray(list.contacts) ? list.contacts : [];
  const results = {
    email: { sent: 0, skipped: 0, failed: 0 },
    whatsapp: { sent: 0, skipped: 0, failed: 0 },
    totalContacts: contacts.length,
  };
  const campaignId = `${list._id}-${Date.now()}`;

  for (const contact of contacts) {
    const recipientName = buildRecipientName(contact);

    if (enabledChannels.includes('email')) {
      if (!contact.email) {
        results.email.skipped += 1;
        await NotificationLog.create({
          channel: 'email',
          eventType: 'admin_marketing_campaign',
          status: 'skipped',
          recipient: recipientName,
          title: cleanTitle,
          message: cleanMessage,
          errorMessage: 'Contact has no email address.',
          providerResponse: { campaignId, listId: list._id, sentBy },
        });
      } else {
        try {
          const providerResponse = await sendCampaignEmail({
            to: contact.email,
            title: cleanTitle,
            message: cleanMessage,
          });
          const skipped = providerResponse?.skipped === true;
          results.email[skipped ? 'skipped' : 'sent'] += 1;
          await NotificationLog.create({
            channel: 'email',
            eventType: 'admin_marketing_campaign',
            status: skipped ? 'skipped' : 'sent',
            recipient: contact.email,
            title: cleanTitle,
            message: cleanMessage,
            errorMessage: providerResponse?.reason,
            providerResponse: { campaignId, listId: list._id, sentBy, providerResponse },
          });
        } catch (error) {
          results.email.failed += 1;
          await NotificationLog.create({
            channel: 'email',
            eventType: 'admin_marketing_campaign',
            status: 'failed',
            recipient: contact.email,
            title: cleanTitle,
            message: cleanMessage,
            errorMessage: error.message,
            providerResponse: { campaignId, listId: list._id, sentBy },
          });
        }
      }
    }

    if (enabledChannels.includes('whatsapp')) {
      if (!contact.phoneNumber) {
        results.whatsapp.skipped += 1;
        await NotificationLog.create({
          channel: 'whatsapp',
          eventType: 'admin_marketing_campaign',
          status: 'skipped',
          recipient: recipientName,
          title: cleanTitle,
          message: cleanMessage,
          errorMessage: 'Contact has no phone number.',
          providerResponse: { campaignId, listId: list._id, sentBy },
        });
      } else {
        try {
          const providerResponse = await whatsappService.sendText({
            to: contact.phoneNumber,
            text: `${cleanTitle}\n\n${cleanMessage}`,
          });
          const skipped = providerResponse?.skipped === true;
          results.whatsapp[skipped ? 'skipped' : 'sent'] += 1;
          await NotificationLog.create({
            channel: 'whatsapp',
            eventType: 'admin_marketing_campaign',
            status: skipped ? 'skipped' : 'sent',
            recipient: contact.phoneNumber,
            title: cleanTitle,
            message: cleanMessage,
            errorMessage: providerResponse?.reason,
            providerResponse: { campaignId, listId: list._id, sentBy, providerResponse },
          });
        } catch (error) {
          results.whatsapp.failed += 1;
          await NotificationLog.create({
            channel: 'whatsapp',
            eventType: 'admin_marketing_campaign',
            status: 'failed',
            recipient: contact.phoneNumber,
            title: cleanTitle,
            message: cleanMessage,
            errorMessage: error.message,
            providerResponse: error.response?.data || { campaignId, listId: list._id, sentBy },
          });
        }
      }
    }
  }

  return {
    campaignId,
    listId: list._id,
    listName: list.name,
    channels: enabledChannels,
    results,
  };
};

module.exports = {
  sendMarketingCampaign,
};
