const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    targetType: { type: String, enum: ['product', 'campaign'], required: true },
    target: { type: mongoose.Schema.Types.ObjectId, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true },
    startedAt: { type: Date, required: true },
    countedAt: Date,
    watchedMilliseconds: { type: Number, min: 0, max: 3600000 },
    minimumMilliseconds: { type: Number, required: true, enum: [1000, 3000] },
}, { timestamps: true });
schema.index({ targetType: 1, target: 1, user: 1, day: 1 }, { unique: true });
schema.index({ targetType: 1, target: 1, countedAt: 1 });
module.exports = mongoose.model('FeedView', schema);
