const mongoose = require('mongoose');

const MarketingContactSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phoneNumber: { type: String, trim: true },
    type: {
      type: String,
      enum: ['customer', 'vendor', 'rider', 'other'],
      default: 'other',
    },
    source: { type: String, trim: true },
  },
  { _id: false },
);

const MarketingContactListSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    audience: {
      type: String,
      enum: ['customers', 'vendors', 'riders', 'mixed'],
      default: 'mixed',
      index: true,
    },
    contacts: [MarketingContactSchema],
    contactCount: {
      type: Number,
      default: 0,
    },
    importedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

MarketingContactListSchema.index({ createdAt: -1 });
MarketingContactListSchema.index({ audience: 1, createdAt: -1 });
MarketingContactListSchema.index({ importedBy: 1, createdAt: -1 });

module.exports = mongoose.model('MarketingContactList', MarketingContactListSchema);
