const mongoose = require('mongoose');

const exploreVideoSchema = new mongoose.Schema({
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  creatorType: { type: String, enum: ['admin', 'vendor'], required: true },
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  videoUrl: { type: String, required: true, trim: true },
  thumbnailUrl: { type: String, trim: true, default: '' },
  cloudinaryPublicId: { type: String, required: true, trim: true },
  caption: { type: String, required: true, trim: true, maxlength: 500 },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  likesCount: { type: Number, min: 0, default: 0 },
  commentsCount: { type: Number, min: 0, default: 0 },
  viewsCount: { type: Number, min: 0, default: 0 },
  status: { type: String, enum: ['published', 'unpublished', 'deleted'], default: 'published' },
  visibility: { type: String, enum: ['public', 'unlisted'], default: 'public' },
  moderationStatus: { type: String, enum: ['approved', 'pending', 'rejected'], default: 'approved' },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

exploreVideoSchema.index({ status: 1, visibility: 1, moderationStatus: 1, deletedAt: 1, createdAt: -1, _id: -1 });
exploreVideoSchema.index({ creator: 1, createdAt: -1 });
exploreVideoSchema.index({ vendor: 1, createdAt: -1 });
exploreVideoSchema.index({ product: 1, createdAt: -1 });

module.exports = mongoose.models.ExploreVideo || mongoose.model('ExploreVideo', exploreVideoSchema);
