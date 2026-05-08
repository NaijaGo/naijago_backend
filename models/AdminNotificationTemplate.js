const mongoose = require('mongoose');

const AdminNotificationTemplateSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
      index: true,
    },
    category: {
      type: String,
      enum: [
        'promo',
        'rider_reminder',
        'vendor_notice',
        'delivery_alert',
        'customer_update',
        'general',
      ],
      default: 'general',
      index: true,
    },
    segment: {
      type: String,
      required: true,
      trim: true,
      default: 'all_customers',
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    type: {
      type: String,
      default: 'admin_message',
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    lastUsedAt: Date,
  },
  { timestamps: true },
);

module.exports = mongoose.model(
  'AdminNotificationTemplate',
  AdminNotificationTemplateSchema,
);
