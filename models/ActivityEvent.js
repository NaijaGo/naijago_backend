const mongoose = require('mongoose');

const ActivityEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    eventType: { type: String, required: true, index: true, trim: true },
    category: {
      type: String,
      enum: [
        'customer',
        'vendor',
        'pharmacist',
        'product',
        'order',
        'payment',
        'rider',
        'delivery',
        'wallet',
        'withdrawal',
        'dispute',
        'return',
        'subscription',
        'referral',
        'chat',
        'company',
        'system',
      ],
      default: 'system',
      index: true,
    },
    severity: {
      type: String,
      enum: ['info', 'success', 'warning', 'critical'],
      default: 'info',
      index: true,
    },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    actor: {
      type: { type: String, trim: true },
      id: { type: mongoose.Schema.Types.ObjectId, index: true },
      name: { type: String, trim: true },
    },
    target: {
      type: { type: String, trim: true },
      id: { type: mongoose.Schema.Types.ObjectId, index: true },
      name: { type: String, trim: true },
    },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'MainOrder', index: true },
    shipment: { type: mongoose.Schema.Types.ObjectId, ref: 'Shipment', index: true },
    session: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatSession', index: true },
    destination: {
      page: { type: String, trim: true },
      params: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    push: {
      status: {
        type: String,
        enum: ['pending', 'sent', 'skipped', 'failed'],
        default: 'pending',
      },
      sentAt: Date,
      errorMessage: String,
      providerResponse: mongoose.Schema.Types.Mixed,
    },
  },
  { timestamps: true },
);

ActivityEventSchema.index({ createdAt: -1 });
ActivityEventSchema.index({ category: 1, createdAt: -1 });
ActivityEventSchema.index({ severity: 1, createdAt: -1 });
ActivityEventSchema.index({ eventType: 1, createdAt: -1 });

module.exports = mongoose.model('ActivityEvent', ActivityEventSchema);
