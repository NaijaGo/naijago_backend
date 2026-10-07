const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  _id: { type: String },
  status: { type: String, enum: ['processing', 'ready', 'completed'], required: true },
  leaseOwner: String,
  leaseUntil: Date,
  windowStart: Date,
  windowEnd: Date,
  snapshot: mongoose.Schema.Types.Mixed,
  priorities: [String],
  generator: { type: String, enum: ['rules'], default: 'rules' },
  expiresAt: Date,
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('OperationsDigest', schema);
