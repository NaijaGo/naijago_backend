const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: String, nonce: { type: String, required: true }, fingerprint: { type: String, required: true },
  expiresAt: { type: Date, required: true }, usedAt: { type: Date, default: null },
}, { autoCreate: false, autoIndex: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'apple_challenge_expiry' });
module.exports = mongoose.model('AppleAuthChallenge', schema);
