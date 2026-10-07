// models/Review.js

const mongoose = require('mongoose');

const reviewSchema = mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: 'Product', // Reference to the Product model
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: 'User', // Reference to the User model
    },
    rating: {
      type: Number,
      required: true,
      min: 1, // Minimum rating of 1 star
      max: 5, // Maximum rating of 5 stars
    },
    comment: {
      type: String,
      required: true,
      maxlength: 3000,
    },
    photos: [{ url: { type: String, required: true }, publicId: { type: String, required: true } }],
    verifiedPurchase: { type: Boolean, default: false },
    moderationStatus: { type: String, enum: ['approved', 'pending', 'rejected'], default: 'approved' },
    moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    moderationReason: { type: String, maxlength: 500 },
    deletedAt: { type: Date, default: null },
    reviewKey: { type: String },
    reports: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, reason: { type: String, maxlength: 500 }, createdAt: { type: Date, default: Date.now } }],
  },
  {
    timestamps: true, // Adds createdAt and updatedAt timestamps
  }
);

reviewSchema.index({ reviewKey: 1 }, { unique: true, sparse: true });
reviewSchema.index({ product: 1, moderationStatus: 1, createdAt: -1 });
const Review = mongoose.model('Review', reviewSchema);

module.exports = Review;
