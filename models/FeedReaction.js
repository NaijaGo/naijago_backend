const mongoose = require('mongoose');
const { REACTIONS } = require('../utils/explorePolicy');
const schema = new mongoose.Schema({
    targetType: { type: String, enum: ['product', 'campaign'], required: true },
    target: { type: mongoose.Schema.Types.ObjectId, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reaction: { type: String, enum: REACTIONS, required: true },
}, { timestamps: true });
schema.index({ targetType: 1, target: 1, user: 1 }, { unique: true });
schema.index({ targetType: 1, target: 1, reaction: 1 });
module.exports = mongoose.model('FeedReaction', schema);
