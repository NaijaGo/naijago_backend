const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const BackgroundJob = require('../models/BackgroundJob');
const { createBackgroundJobService } = require('../services/backgroundJobService');

const uuidV4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

test('job delivery-key default accepts the null scope used by Mongoose upserts', () => {
    // Match setDefaultsOnInsert, which calls getDefault(null, true).
    const field = BackgroundJob.schema.path('deliveryKey');
    const first = field.getDefault(null, true);
    const second = field.getDefault(null, true);
    assert.match(first, uuidV4);
    assert.match(second, uuidV4);
    assert.notEqual(first, second);
});

test('new job documents receive distinct delivery keys without replacing explicit keys', () => {
    const input = { type: 'explore.notify', dedupeKey: 'document', payload: {}, payloadHash: 'hash', runAt: new Date() };
    const first = new BackgroundJob(input), second = new BackgroundJob(input);
    assert.equal(first.validateSync(), undefined);
    assert.match(first.deliveryKey, uuidV4);
    assert.notEqual(first.deliveryKey, second.deliveryKey);
    const supplied = new BackgroundJob({ ...input, deliveryKey: first.deliveryKey });
    assert.equal(supplied.deliveryKey, first.deliveryKey);
});

function modelWithFakeCollection() {
    const isolated = new mongoose.Mongoose();
    const schema = BackgroundJob.schema.clone();
    schema.set('bufferCommands', false);
    const Job = isolated.model('JobDefaultRegression', schema);
    const rows = new Map(), writes = [];
    // Exercise real Mongoose query casting/defaults. Only the final driver write
    // is replaced: no server or production credentials are used in this test.
    Job.collection.findOneAndUpdate = async (filter, update, options) => {
        writes.push({ filter, update, options });
        const key = `${filter.type}:${filter.dedupeKey}`;
        if (!rows.has(key)) rows.set(key, { _id: new mongoose.Types.ObjectId(), ...update.$setOnInsert });
        const row = rows.get(key);
        Object.assign(row, update.$set || {});
        return { ...row };
    };
    return { Job, writes };
}

test('enqueue applies real Mongoose defaults on upsert and preserves the retry delivery key', async () => {
    const { Job, writes } = modelWithFakeCollection();
    const queue = createBackgroundJobService({ Job, allowedTypes: ['explore.notify'] });
    const input = { type: 'explore.notify', dedupeKey: 'first', payload: { event: 'test' } };
    const first = await queue.enqueue(input);
    const retry = await queue.enqueue(input);
    const second = await queue.enqueue({ ...input, dedupeKey: 'second' });
    assert.match(first.deliveryKey, uuidV4);
    assert.equal(retry.deliveryKey, first.deliveryKey);
    assert.equal(String(retry._id), String(first._id));
    assert.notEqual(second.deliveryKey, first.deliveryKey);
    for (const { update, options } of writes) {
        assert.equal(options.upsert, true);
        assert.match(update.$setOnInsert.deliveryKey, uuidV4);
        assert.equal(Object.hasOwn(update.$set || {}, 'deliveryKey'), false);
    }
});

test('transactional notification enqueue also applies defaults without passing the session to crypto', async () => {
    const { Job, writes } = modelWithFakeCollection();
    const queue = createBackgroundJobService({ Job, allowedTypes: ['explore.notify'] });
    // Driver sessions are class instances; Mongoose clones plain option objects.
    class TestSession { constructor() { this.marker = 'fake-transaction-session'; } }
    const session = new TestSession();
    const job = await queue.enqueue({ type: 'explore.notify', dedupeKey: 'transaction', payload: {} }, { session });
    assert.match(job.deliveryKey, uuidV4);
    assert.equal(writes[0].options.session, session);
});
