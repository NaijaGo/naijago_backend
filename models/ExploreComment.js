const mongoose = require('mongoose');

const exploreCommentSchema = new mongoose.Schema({
  video: { type: mongoose.Schema.Types.ObjectId, ref: 'ExploreVideo', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  text: { type: String, required: true, trim: true, maxlength: 1000 },
  state: { type: String, enum: ['visible', 'hidden'], default: 'visible' },
  moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  moderationReason: { type: String, maxlength: 1000 },
  moderatedAt: Date,
}, { timestamps: true });

exploreCommentSchema.index({ video: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.models.ExploreComment || mongoose.model('ExploreComment', exploreCommentSchema);
