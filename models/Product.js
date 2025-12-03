// models/Product.js

const mongoose = require('mongoose');

const productSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
    },
    price: {
      type: Number,
      required: true,
      default: 0,
    },
    category: {
      type: String,
      required: true,
    },
    stockQuantity: {
      type: Number,
      required: true,
      default: 0,
    },

    // ------------------------------
    // OLD FIELD (kept for backward compatibility)
    // ------------------------------
    imageUrls: [
      {
        type: String,
        required: true,
      },
    ],

    // ------------------------------
    // NEW STRUCTURED IMAGE OBJECT
    // ------------------------------
    images: {
      main: { type: String, required: false }, // Main image
      front: { type: String, required: false },
      back: { type: String, required: false },
      rear: { type: String, required: false },

      // A flexible array for any other images (side view, top view, etc.)
      others: [
        {
          type: String,
        },
      ],
    },
    // ------------------------------

    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: 'User',
    },

    averageRating: {
      type: Number,
      default: 0,
    },
    numReviews: {
      type: Number,
      default: 0,
    },

    salesCount: {
      type: Number,
      default: 0,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    // Flashsale support
    is_flashsale: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

const Product = mongoose.model('Product', productSchema);

module.exports = Product;
