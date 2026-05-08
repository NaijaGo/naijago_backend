const dotenv = require('dotenv');
const colors = require('colors');

dotenv.config();

const connectDB = require('../config/db');
const { processDueScheduledNotifications } = require('../services/scheduledNotificationRunner');

const intervalMs = Number(process.env.SCHEDULED_NOTIFICATION_WORKER_INTERVAL_MS || 60000);

const appShim = {
  get() {
    return undefined;
  },
};

const run = async () => {
  await connectDB();
  console.log(colors.green('Scheduled notification worker started.'));

  const tick = async () => {
    try {
      await processDueScheduledNotifications(appShim);
    } catch (error) {
      console.error('Scheduled notification worker tick failed:', error);
    }
  };

  await tick();
  setInterval(tick, intervalMs);
};

run().catch((error) => {
  console.error('Scheduled notification worker startup failed:', error);
  process.exit(1);
});
