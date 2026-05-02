const mongoose = require('mongoose');

const NotificationLogSchema = new mongoose.Schema(
  {
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    channel: {
      type: String,
      enum: ['app_socket', 'push', 'whatsapp'],
      required: true,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['sent', 'skipped', 'failed'],
      required: true,
      index: true,
    },
    recipient: {
      type: String,
      trim: true,
    },
    title: {
      type: String,
      trim: true,
    },
    message: {
      type: String,
      trim: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MainOrder',
      index: true,
    },
    shipment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Shipment',
      index: true,
    },
    errorMessage: {
      type: String,
      trim: true,
    },
    providerResponse: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model('NotificationLog', NotificationLogSchema);
