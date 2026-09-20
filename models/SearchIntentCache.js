const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    _id: String,
    state: { type: String, enum: ['working', 'ready'], required: true },
    result: mongoose.Schema.Types.Mixed,
    leaseToken: String,
    leaseUntil: Date,
    expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('SearchIntentCache', schema);
