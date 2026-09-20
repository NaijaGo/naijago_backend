const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');

const schema = new mongoose.Schema({
    type: { type: String, required: true, maxlength: 80 },
    dedupeKey: { type: String, required: true, maxlength: 200 },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    payloadHash: { type: String, required: true },
    // Mongoose supplies a scope argument (null on upsert) to default callbacks.
    // crypto.randomUUID accepts an options object, never that scope argument.
    deliveryKey: { type: String, default: () => randomUUID() },
    state: { type: String, enum: ['queued', 'running', 'completed', 'failed', 'cancelled'], default: 'queued' },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 4, min: 1, max: 8 },
    priority: { type: Number, default: 0, min: 0, max: 10 },
    runAt: { type: Date, required: true },
    leaseUntil: Date,
    lockToken: String,
    startedAt: Date,
    finishedAt: Date,
    errorCode: { type: String, maxlength: 80 },
    manualRetries: { type: Number, default: 0, min: 0, max: 3 },
    reviewHistory: [{ _id: false, actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        action: { type: String, enum: ['retry'] }, reason: { type: String, maxlength: 500 }, at: Date }],
    result: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

schema.index({ type: 1, dedupeKey: 1 }, { unique: true });
schema.index({ state: 1, type: 1, runAt: 1, priority: -1 });
schema.index({ state: 1, leaseUntil: 1 });
schema.index({ owner: 1, createdAt: -1 });
schema.index({ state: 1, _id: -1 });
// No automatic TTL: deleting a dedupe record could repeat a paid operation.
module.exports = mongoose.model('BackgroundJob', schema);
