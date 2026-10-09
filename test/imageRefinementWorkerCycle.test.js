const test = require('node:test');
const assert = require('node:assert/strict');
const { runImageRefinementWorkerCycle } = require('../services/imageRefinementWorkerCycle');

test('worker schedules before processing the queue exactly once', async () => {
  const calls = [], controller = new AbortController();
  const result = await runImageRefinementWorkerCycle({ signal: controller.signal,
    schedule: async ({ signal }) => { assert.equal(signal, controller.signal); calls.push('schedule'); },
    runQueued: async () => { calls.push('queue'); return true; } });
  assert.deepEqual(calls, ['schedule', 'queue']);
  assert.equal(result, true);
});

test('scheduler failure is safely reported and queued jobs still run', async () => {
  const calls = [];
  await runImageRefinementWorkerCycle({
    schedule: async () => { throw new Error('private database connection details'); },
    onScheduleError: (...args) => { assert.deepEqual(args, []); calls.push('report'); },
    runQueued: async () => calls.push('queue') });
  assert.deepEqual(calls, ['report', 'queue']);
});

test('logging failure does not block queued jobs after scheduler failure', async () => {
  let queued = 0;
  await runImageRefinementWorkerCycle({ schedule: async () => { throw new Error('scheduler'); },
    onScheduleError: () => { throw new Error('logger'); }, runQueued: async () => queued++ });
  assert.equal(queued, 1);
});

test('already aborted or stopping workers perform no scheduling or queue work', async () => {
  const controller = new AbortController();
  controller.abort();
  for (const options of [{ signal: controller.signal }, { isStopping: () => true }]) {
    await runImageRefinementWorkerCycle({ ...options,
      schedule: () => assert.fail('must not schedule'), runQueued: () => assert.fail('must not run') });
  }
});

test('shutdown during successful or failed scheduling prevents queue processing', async () => {
  for (const fails of [false, true]) {
    const controller = new AbortController();
    let reports = 0;
    await runImageRefinementWorkerCycle({ signal: controller.signal,
      schedule: async () => { controller.abort(); if (fails) throw new Error('aborted'); },
      onScheduleError: () => reports++,
      runQueued: () => assert.fail('must not run after shutdown') });
    assert.equal(reports, 0, 'shutdown is not a scheduling error');
  }
});

test('stopping after scheduling prevents queue processing', async () => {
  let stopping = false;
  await runImageRefinementWorkerCycle({ isStopping: () => stopping,
    schedule: async () => { stopping = true; }, runQueued: () => assert.fail('must not run') });
});

test('queue errors reach the existing worker error handler without retrying in the cycle', async () => {
  let queued = 0;
  const error = new Error('queue unavailable');
  await assert.rejects(runImageRefinementWorkerCycle({ schedule: async () => {},
    runQueued: async () => { queued++; throw error; } }), candidate => candidate === error);
  assert.equal(queued, 1);
});
