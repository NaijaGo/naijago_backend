// models/ChatMessage.js
const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema({
  session: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatSession',
    required: true,
  },
  senderType: {
    type: String,
    enum: ['user', 'ai', 'pharmacist', 'system'], // ADDED 'system'
    required: true,
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  message: {
    type: String,
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('ChatMessage', chatMessageSchema);


// // models/ChatMessage.js
// const mongoose = require('mongoose');

// const chatMessageSchema = new mongoose.Schema({
//   session: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'ChatSession',
//     required: true,
//   },
//   senderType: {
//     type: String,
//     enum: ['user', 'ai', 'pharmacist'],
//     required: true,
//   },
//   sender: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: 'User',
//   },
//   message: {
//     type: String,
//     required: true,
//   },
//   createdAt: { type: Date, default: Date.now },
// });

// module.exports = mongoose.model('ChatMessage', chatMessageSchema);
