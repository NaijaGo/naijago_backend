const mongoose = require('mongoose');

const AdminScheduledNotificationSchema = new mongoose.Schema(
  {
    segment: {
      type: String,
      required: true,
      index: true,
    },
    recipientIds: [{ type: String, trim: true }],
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
    scheduledFor: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['scheduled', 'sending', 'sent', 'cancelled', 'failed'],
      default: 'scheduled',
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    sentAt: Date,
    cancelledAt: Date,
    errorMessage: {
      type: String,
      trim: true,
    },
    preview: {
      customers: { type: Number, default: 0 },
      vendors: { type: Number, default: 0 },
      riders: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    sendResult: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  { timestamps: true },
);

AdminScheduledNotificationSchema.index({ status: 1, scheduledFor: 1 });
AdminScheduledNotificationSchema.index({ status: 1, updatedAt: 1 });
AdminScheduledNotificationSchema.index({ createdBy: 1, createdAt: -1 });

module.exports = mongoose.model(
  'AdminScheduledNotification',
  AdminScheduledNotificationSchema,
);
