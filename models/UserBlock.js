const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    blockedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ user: 1, blockedUser: 1 }, { unique: true });
schema.index({ blockedUser: 1, user: 1 });
module.exports = mongoose.model('UserBlock', schema);
