// A scheduler failure must not starve jobs that are already queued.
async function runImageRefinementWorkerCycle({ schedule, runQueued, signal,
  isStopping = () => false, onScheduleError = () => {} }) {
  const stopped = () => signal?.aborted || isStopping();
  if (stopped()) return;
  try {
    await schedule({ signal });
  } catch (_) {
    if (stopped()) return;
    // Report no raw database/provider error or credentials.
    try { onScheduleError(); } catch (_) { /* Logging must not block the queue. */ }
  }
  if (!stopped()) return runQueued();
}

module.exports = { runImageRefinementWorkerCycle };
