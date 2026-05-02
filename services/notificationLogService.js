const NotificationLog = require('../models/NotificationLog');

async function recordNotificationLog(payload, options = {}) {
  try {
    await NotificationLog.create([payload], options);
  } catch (error) {
    console.error('Notification log write failed:', error.message);
  }
}

module.exports = {
  recordNotificationLog,
};
