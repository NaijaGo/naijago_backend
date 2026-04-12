const mongoose = require('mongoose');

const ReferralRewardHistorySchema = new mongoose.Schema(
  {
    previousAmount: {
      type: Number,
      min: 0,
      default: null,
    },
    newAmount: {
      type: Number,
      min: 0,
      required: true,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
    source: {
      type: String,
      enum: ['admin_update', 'startup_seed'],
      default: 'admin_update',
    },
  },
  {
    _id: false,
  },
);

const DeliveryFeeZoneSchema = new mongoose.Schema(
  {
    zoneKey: {
      type: String,
      required: true,
      trim: true,
    },
    zoneName: {
      type: String,
      required: true,
      trim: true,
    },
    city: {
      type: String,
      default: 'Abuja',
      trim: true,
    },
    group: {
      type: String,
      default: 'Abuja Zones',
      trim: true,
    },
    aliases: {
      type: [String],
      default: [],
    },
    tags: {
      type: [String],
      default: [],
    },
    amount: {
      type: Number,
      min: 0,
      required: true,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    _id: false,
  },
);

const DeliveryFeeHistorySchema = new mongoose.Schema(
  {
    fallbackRatePerKm: {
      type: Number,
      min: 0,
      default: 200,
    },
    minimumDeliveryFee: {
      type: Number,
      min: 0,
      default: 1000,
    },
    zones: {
      type: [DeliveryFeeZoneSchema],
      default: [],
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
    source: {
      type: String,
      enum: ['admin_update', 'startup_seed'],
      default: 'admin_update',
    },
  },
  {
    _id: false,
  },
);

const AppSettingSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    referralRewardAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    referralRewardHistory: {
      type: [ReferralRewardHistorySchema],
      default: [],
    },
    fallbackRatePerKm: {
      type: Number,
      min: 0,
      default: 200,
    },
    minimumDeliveryFee: {
      type: Number,
      min: 0,
      default: 1000,
    },
    deliveryFeeZones: {
      type: [DeliveryFeeZoneSchema],
      default: [],
    },
    deliveryFeeHistory: {
      type: [DeliveryFeeHistorySchema],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

AppSettingSchema.index({ key: 1 }, { unique: true });

const AppSetting = mongoose.model('AppSetting', AppSettingSchema);

module.exports = AppSetting;
