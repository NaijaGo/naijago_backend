const mongoose = require('mongoose');

const exploreLikeSchema = new mongoose.Schema({
  video: { type: mongoose.Schema.Types.ObjectId, ref: 'ExploreVideo', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

exploreLikeSchema.index({ video: 1, user: 1 }, { unique: true, name: 'uniq_explore_video_user_like' });
exploreLikeSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.models.ExploreLike || mongoose.model('ExploreLike', exploreLikeSchema);
