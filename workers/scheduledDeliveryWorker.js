// Explicit opt-in worker; not imported by server.js and never launched at API startup.
require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { processSchedulingJobs } = require('../services/schedulingJobService');

async function run() {
  await connectDB();
  const workerId = `scheduled-delivery:${crypto.randomUUID()}`;
  let running = false;
  let stopping = false;
  const tick = async () => {
    if (running || stopping) return;
    running = true;
    try { await processSchedulingJobs({ workerId }); }
    catch { console.error('Scheduled delivery worker failed; inspect database job state.'); }
    finally { running = false; }
  };
  await tick();
  const timer = setInterval(tick, 60000);
  const shutdown = async () => {
    stopping = true;
    clearInterval(timer);
    while (running) await new Promise((resolve) => setTimeout(resolve, 100));
    await mongoose.disconnect();
    process.exitCode = 0;
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (require.main === module) run().catch(() => {
  console.error('Unable to start scheduled delivery worker.');
  process.exitCode = 1;
});
module.exports = { run };
