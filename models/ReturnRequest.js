const mongoose = require('mongoose');

const ReturnRequestSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  orderId: { type: String, required: true, index: true },
  status: {
    type: String,
    enum: ['pending', 'underReview', 'approved', 'rejected', 'resolved'],
    default: 'pending',
    index: true
  },
  thumbnailUrl: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('ReturnRequest', ReturnRequestSchema);
