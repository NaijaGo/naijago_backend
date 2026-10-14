const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: String, userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
}, { autoCreate: false, autoIndex: false });
module.exports = mongoose.model('AppleIdentity', schema);
