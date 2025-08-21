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
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt timestamps
  }
);

const Review = mongoose.model('Review', reviewSchema);

module.exports = Review;
