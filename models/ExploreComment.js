const mongoose = require('mongoose');

const exploreCommentSchema = new mongoose.Schema({
  video: { type: mongoose.Schema.Types.ObjectId, ref: 'ExploreVideo', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  text: { type: String, required: true, trim: true, maxlength: 1000 },
}, { timestamps: true });

exploreCommentSchema.index({ video: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.models.ExploreComment || mongoose.model('ExploreComment', exploreCommentSchema);
