const mongoose = require('mongoose');

const AnalyticsEventSchema = new mongoose.Schema(
  {
    eventType: {
      type: String,
      enum: [
        'carousel_click',
        'restaurant_card_click',
        'food_order_created',
        'pharmacy_consultation_start',
      ],
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    sessionId: {
      type: String,
      trim: true,
      index: true,
    },
    source: {
      type: String,
      trim: true,
      maxlength: 80,
    },
    targetType: {
      type: String,
      trim: true,
      maxlength: 60,
    },
    targetId: {
      type: String,
      trim: true,
      index: true,
    },
    placement: {
      type: String,
      trim: true,
      maxlength: 40,
    },
    city: {
      type: String,
      trim: true,
      maxlength: 80,
      index: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model('AnalyticsEvent', AnalyticsEventSchema);
