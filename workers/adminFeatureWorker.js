// Opt-in worker for sourcing notifications and reviewed image processing only.
// No checkout, payment, scheduled-delivery or inventory handlers are registered.
async function main() {
  require('dotenv').config();
  if (process.env.BACKGROUND_JOBS_ENABLED !== 'true') throw new Error('Background jobs are disabled.');
  const mongoose = require('mongoose');
  const { createBackgroundJobService, createJobRunner } = require('../services/backgroundJobService');
  const Job = require('../models/BackgroundJob');
  const runtimes = [];
  if (process.env.PRODUCT_REQUESTS_ENABLED === 'true') runtimes.push(require('../services/productRequestRuntime'));
  if (process.env.IMAGE_REFINEMENT_ENABLED === 'true') runtimes.push(require('../services/imageRefinementRuntime'));
  if (!runtimes.length || !process.env.MONGO_URI) throw new Error('Configure a supported feature and database before starting this worker.');
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  try {
    const topology = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!topology.setName && topology.msg !== 'isdbgrid') throw new Error('A transaction-capable database is required.');
    for (const runtime of runtimes) if (!await runtime.ready()) throw new Error('Required feature indexes are missing or incompatible.');
    const handlers = Object.assign({}, ...runtimes.map(runtime => runtime.handlers()));
    const queue = createBackgroundJobService({ Job, allowedTypes: Object.keys(handlers), leaseMs: 360000 });
    const runner = createJobRunner({ queue, handlers, onError: () => console.warn('Admin feature job was not completed. Inspect the safe job status in Admin.') });
    let active = null, stopping = false;
    const tick = () => {
      if (stopping || active) return;
      active = (async () => {
        for (const runtime of runtimes) if (runtime.service.schedule) await runtime.service.schedule({ signal: controller.signal });
        if (!stopping) await runner.tick();
      })().catch(() => console.warn('Admin feature worker is temporarily unavailable.'))
        .finally(() => { active = null; });
    };
    const controller = new AbortController();
    const interval = setInterval(tick, 5000);
    let shutdown;
    const stop = () => {
      if (shutdown) return shutdown;
      stopping = true; clearInterval(interval); controller.abort(); runner.stop();
      shutdown = (async () => {
        await active;
        await mongoose.disconnect();
      })();
      return shutdown;
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(); });
    tick();
    return { stop };
  } catch (error) { await mongoose.disconnect(); throw error; }
}
if (require.main === module) main().catch(() => {
  console.error('Admin feature worker did not start. Check feature configuration, database topology and required indexes.');
  process.exitCode = 1;
});
module.exports = { main };
