// Dedicated Image Studio entry point. Other Admin features are not loaded.
async function main() {
  require('dotenv').config();
  if (process.env.BACKGROUND_JOBS_ENABLED !== 'true' || process.env.IMAGE_REFINEMENT_ENABLED !== 'true' || !process.env.MONGO_URI) {
    throw new Error('Configure Image Studio, background jobs and its database before starting the worker.');
  }
  const mongoose = require('mongoose');
  const { createBackgroundJobService, createJobRunner } = require('../services/backgroundJobService');
  const Job = require('../models/BackgroundJob');
  const runtime = require('../services/imageRefinementRuntime');
  if (!runtime.service.processingEnabled()) {
    const config = runtime.service.configuration();
    console.error('Image Studio configuration is incomplete:', config.missingConfiguration.join(', '),
      config.keyModeMismatch ? 'Sandbox key requires sandbox mode.' : '');
    throw new Error('Image provider/storage configuration or a finite budget is missing.');
  }
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  try {
    const topology = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!topology.setName && topology.msg !== 'isdbgrid') throw new Error('A transaction-capable database is required.');
    if (!await runtime.ready()) throw new Error('Required Image Studio indexes are missing or incompatible.');
    const handlers = runtime.handlers();
    const queue = createBackgroundJobService({ Job, allowedTypes: Object.keys(handlers), leaseMs: 360000 });
    const runner = createJobRunner({ queue, handlers, onError: () => console.warn('Image job was not completed. Inspect its safe status in Admin Image Studio.') });
    const controller = new AbortController();
    let active = null, stopping = false, shutdown;
    const tick = () => {
      if (stopping || active) return;
      active = (async () => {
        await runtime.service.schedule({ signal: controller.signal });
        if (!stopping) await runner.tick();
      })().catch(() => console.warn('Image Studio worker is temporarily unavailable.'))
        .finally(() => { active = null; });
    };
    const interval = setInterval(tick, 5000);
    const stop = () => {
      if (shutdown) return shutdown;
      stopping = true; clearInterval(interval); controller.abort(); runner.stop();
      shutdown = (async () => { await active; await mongoose.disconnect(); })();
      return shutdown;
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(); });
    tick();
    return { stop };
  } catch (error) { await mongoose.disconnect(); throw error; }
}
if (require.main === module) main().catch(() => {
  console.error('Image Studio worker did not start. Check configuration, database topology and required indexes.');
  process.exitCode = 1;
});
module.exports = { main };
