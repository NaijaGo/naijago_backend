//models/Message.js
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  dispute: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DisputeRequest',
    required: true
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  text: { type: String, trim: true },
  attachments: [String], // Cloudinary URLs
}, { timestamps: true });

module.exports = mongoose.model('Message', messageSchema);
