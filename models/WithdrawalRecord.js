const mongoose = require('mongoose');
// Keep legacy provider fields while adding durable Kora dispatch state.
module.exports = new mongoose.Schema({
  amount: {type: Number, required: true, min: 100},
  reference: String,
  status: {type: String, enum: ['pending', 'completed', 'failed', 'cancelled'], default: 'pending'},
  createdAt: {type: Date, default: Date.now}, completedAt: Date,
  paymentMethod: {type: String, default: 'bank_transfer'},
  provider: String, mode: String, providerStatus: String,
  dispatchState: {type: String, enum: ['awaiting_approval', 'reserved', 'submitted', 'unknown']},
  submittedAt: Date, lastCheckedAt: Date, failureReason: String,
  accountDetails: {bankCode: String, bankName: String, accountNumber: String, accountName: String},
  processedBy: {type: mongoose.Schema.Types.ObjectId, ref: 'User'},
}, {strict: false});
