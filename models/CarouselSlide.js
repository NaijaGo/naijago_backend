const mongoose = require('mongoose');

const VALID_CAROUSEL_PLACEMENTS = ['main', 'promo'];

const CarouselSlideSchema = new mongoose.Schema(
  {
    placement: {
      type: String,
      enum: VALID_CAROUSEL_PLACEMENTS,
      required: true,
      index: true,
    },
    title: {
      type: String,
      trim: true,
      default: '',
    },
    subtitle: {
      type: String,
      trim: true,
      default: '',
    },
    imageUrl: {
      type: String,
      trim: true,
      required: true,
    },
    linkUrl: {
      type: String,
      trim: true,
      default: '',
    },
    actionType: {
      type: String,
      enum: ['none', 'restaurant', 'pharmacy', 'category', 'product', 'external'],
      default: 'none',
    },
    actionValue: {
      type: String,
      trim: true,
      default: '',
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

CarouselSlideSchema.index({ placement: 1, isActive: 1, sortOrder: 1 });

const CarouselSlide = mongoose.model('CarouselSlide', CarouselSlideSchema);

module.exports = {
  CarouselSlide,
  VALID_CAROUSEL_PLACEMENTS,
};
