const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectFeatureReadiness, createFeatureReadiness } = require('../services/adminFeatureReadiness');
const { diagnose } = require('../scripts/diagnoseImageRefinement');

function model(required, actual) {
  return { schema: { indexes: () => required }, collection: { collectionName: 'test_images',
    listIndexes: () => ({ toArray: async () => actual }) } };
}

test('readiness inspects matching indexes without creating anything', async () => {
  const fixture = model([[{ product: 1, sourceKey: 1 }, { unique: true }]], [{ key: { product: 1, sourceKey: 1 }, unique: true }]);
  assert.deepEqual(await inspectFeatureReadiness({ models: [fixture] }), {
    ready: true, checks: [{ collection: 'test_images', status: 'ready', missingIndexes: [] }],
  });
  assert.equal(await createFeatureReadiness({ models: [fixture] })(), true);
});

test('readiness explains missing/incompatible unique and TTL indexes', async () => {
  const fixture = model([[{ product: 1 }, { unique: true }], [{ expiresAt: 1 }, { expireAfterSeconds: 0 }]],
    [{ key: { product: 1 }, unique: true, partialFilterExpression: { active: true } },
      { key: { expiresAt: 1 }, expireAfterSeconds: 60 }]);
  const report = await inspectFeatureReadiness({ models: [fixture] });
  assert.equal(report.ready, false);
  assert.equal(report.checks[0].status, 'missing_indexes');
  assert.equal(report.checks[0].missingIndexes.length, 2);
});

test('collection/permission errors report safe codes without raw error details', async () => {
  for (const [code, status] of [[26, 'collection_missing'], [13, 'read_permission_missing'], [999, 'database_read_unavailable']]) {
    const fixture = model([], []);
    fixture.collection.listIndexes = () => { throw Object.assign(new Error('private connection details'), { code }); };
    const report = await inspectFeatureReadiness({ models: [fixture] });
    assert.equal(report.ready, false);
    assert.equal(report.checks[0].status, status);
    assert.doesNotMatch(JSON.stringify(report), /private connection details/);
  }
});

test('diagnostic does not call a provider or database by default', async () => {
  const report = await diagnose({ env: {}, http: { post: () => { throw new Error('must not call'); } } });
  assert.equal(report.configuration.ready, false);
  assert.ok(report.configuration.missingConfiguration.includes('PHOTOROOM_API_KEY'));
  assert.equal(report.database.status, 'NOT_RUN');
  assert.equal(report.photoroom.status, 'NOT_RUN');
  assert.equal(report.worker.status, 'NOT_VERIFIED');
});

test('diagnostic refuses live mode even with an API key', async () => {
  const report = await diagnose({ env: { PHOTOROOM_API_KEY: 'fixture-key', PHOTOROOM_SANDBOX: 'false' }, probe: true,
    http: { post: () => { throw new Error('must not call'); } } });
  assert.equal(report.photoroom.status, 'BLOCKED');
});

test('sandbox probe uses a synthetic PNG and fixed editing options; does not publish', async () => {
  let requests = 0;
  const report = await diagnose({ env: { PHOTOROOM_API_KEY: 'sandbox_fixture', PHOTOROOM_SANDBOX: 'true' }, probe: true,
    http: { post: async (url, form, options) => {
      requests++;
      assert.equal(url, 'https://image-api.photoroom.com/v2/edit');
      assert.equal(options.headers['x-api-key'], 'sandbox_fixture');
      assert.equal(form.get('background.color'), 'FFFFFF');
      assert.equal(form.get('shadow.mode'), 'ai.soft');
      assert.equal(form.get('outputSize'), '1000x1000');
      assert.equal(form.get('imageFile').name, 'diagnostic.png');
      return { status: 200, headers: { 'content-type': 'image/png' }, data: Buffer.from(await form.get('imageFile').arrayBuffer()) };
    } } });
  assert.equal(requests, 1);
  assert.equal(report.photoroom.status, 'PASS');
  assert.equal(report.database.status, 'NOT_RUN');
  assert.doesNotMatch(JSON.stringify(report), /sandbox_fixture/);
});

test('provider failure does not disclose credentials or raw provider errors', async () => {
  const report = await diagnose({ env: { PHOTOROOM_API_KEY: 'fixture-key', PHOTOROOM_SANDBOX: 'true' }, probe: true,
    http: { post: async (_url, _form, options) => {
      assert.equal(options.headers['x-api-key'], 'sandbox_fixture-key');
      throw Object.assign(new Error('fixture-key private error'), { response: { status: 401 } });
    } } });
  assert.equal(report.photoroom.status, 'FAIL');
  assert.equal(report.photoroom.httpStatus, 401);
  assert.doesNotMatch(JSON.stringify(report), /fixture-key|private error/);
});
