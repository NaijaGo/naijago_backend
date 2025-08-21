// models/DisputeRequest.js

const mongoose = require('mongoose');

const disputeRequestSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true
  },
  reason: {
    type: String,
    required: true,
    trim: true
  },
  status: {
    type: String,
    // 🚨 THIS IS THE UPDATED LINE 🚨
    enum: ['pending', 'reviewing', 'processed', 'settled', 'resolved'],
    default: 'pending'
  },
  attachments: [String], // Cloudinary URLs
  messages: [
    {
      sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      text: String,
      attachments: [String],
      createdAt: { type: Date, default: Date.now }
    }
  ],
}, { timestamps: true });

module.exports = mongoose.model('DisputeRequest', disputeRequestSchema);