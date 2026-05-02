// models/ChatSession.js
const mongoose = require('mongoose');

const chatSessionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  pharmacist: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // pharmacist joins later
  },
  status: {
    type: String,
    enum: ['open', 'assigned', 'closed'],
    default: 'open',
  },
  pharmacyAccessType: {
    type: String,
    enum: ['one_time', 'weekly', 'monthly', 'admin'],
    default: 'one_time',
  },
  pharmacyAccessGrantedAt: {
    type: Date,
    default: Date.now,
  },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('ChatSession', chatSessionSchema);
