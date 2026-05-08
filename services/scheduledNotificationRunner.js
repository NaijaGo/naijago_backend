const AdminScheduledNotification = require('../models/AdminScheduledNotification');
const { sendAdminInAppNotification } = require('./adminNotificationService');

let isProcessing = false;
let intervalHandle = null;
const STALE_SENDING_MINUTES = Number(process.env.SCHEDULED_NOTIFICATION_STALE_MINUTES || 15);

const recoverStaleSendingNotifications = async () => {
  const staleBefore = new Date(Date.now() - STALE_SENDING_MINUTES * 60 * 1000);
  await AdminScheduledNotification.updateMany(
    {
      status: 'sending',
      updatedAt: { $lt: staleBefore },
    },
    {
      status: 'scheduled',
      errorMessage: 'Recovered from stale sending state.',
    },
  );
};

const processDueScheduledNotifications = async (app) => {
  if (isProcessing) return;
  isProcessing = true;

  try {
    await recoverStaleSendingNotifications();
    const dueItems = await AdminScheduledNotification.find({
      status: 'scheduled',
      scheduledFor: { $lte: new Date() },
    })
      .sort({ scheduledFor: 1 })
      .limit(20);

    for (const item of dueItems) {
      const locked = await AdminScheduledNotification.findOneAndUpdate(
        { _id: item._id, status: 'scheduled' },
        { status: 'sending' },
        { new: true },
      );

      if (!locked) continue;

      try {
        const result = await sendAdminInAppNotification({
          app,
          adminUserId: locked.createdBy,
          segment: locked.segment,
          title: locked.title,
          message: locked.message,
          type: locked.type,
          recipientIds: locked.recipientIds,
          scheduledNotificationId: locked._id,
        });

        locked.status = 'sent';
        locked.sentAt = new Date();
        locked.sendResult = result;
        await locked.save();
      } catch (error) {
        locked.status = 'failed';
        locked.errorMessage = error.message || 'Scheduled send failed.';
        await locked.save();
      }
    }
  } finally {
    isProcessing = false;
  }
};

const startScheduledNotificationRunner = (app) => {
  if (intervalHandle) return intervalHandle;

  intervalHandle = setInterval(() => {
    processDueScheduledNotifications(app).catch((error) => {
      console.error('Scheduled notification runner error:', error);
    });
  }, 60 * 1000);

  processDueScheduledNotifications(app).catch((error) => {
    console.error('Scheduled notification startup check failed:', error);
  });

  return intervalHandle;
};

module.exports = {
  processDueScheduledNotifications,
  recoverStaleSendingNotifications,
  startScheduledNotificationRunner,
};
