const mongoose = require('mongoose');

const VALID_CAROUSEL_PLACEMENTS = ['main', 'promo', 'explore'];

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
    advertiserName: { type: String, trim: true, maxlength: 140 },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    mediaKind: { type: String, enum: ['image', 'video'], default: 'image' },
    videoAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'MediaAsset', default: null },
    startsAt: Date,
    endsAt: Date,
    imageRightsConfirmed: { type: Boolean, default: false },
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
      enum: ['none', 'restaurant', 'pharmacy', 'category', 'product', 'vendor', 'external'],
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
CarouselSlideSchema.index({ placement: 1, isActive: 1, endsAt: 1, startsAt: 1 });

const CarouselSlide = mongoose.model('CarouselSlide', CarouselSlideSchema);

module.exports = {
  CarouselSlide,
  VALID_CAROUSEL_PLACEMENTS,
};
