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

const PharmacySubscriptionPlanSchema = new mongoose.Schema(
  {
    planType: {
      type: String,
      enum: ['one_time', 'weekly', 'monthly'],
      required: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    price: {
      type: Number,
      min: 0,
      required: true,
      default: 0,
    },
    durationDays: {
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

const PharmacySubscriptionHistorySchema = new mongoose.Schema(
  {
    plans: {
      type: [PharmacySubscriptionPlanSchema],
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
    pharmacySubscriptionPlans: {
      type: [PharmacySubscriptionPlanSchema],
      default: [],
    },
    pharmacySubscriptionHistory: {
      type: [PharmacySubscriptionHistorySchema],
      default: [],
    },
    foodReadinessCampaigns: {
      type: [
        {
          mealType: {
            type: String,
            enum: ['breakfast', 'lunch', 'dinner'],
            required: true,
          },
          title: { type: String, trim: true, required: true },
          message: { type: String, trim: true, required: true },
          imageUrl: { type: String, trim: true },
          city: { type: String, trim: true, default: 'Abuja' },
          startTime: { type: String, default: '06:00' },
          endTime: { type: String, default: '11:00' },
          isActive: { type: Boolean, default: true },
          updatedAt: { type: Date, default: Date.now },
          _id: false,
        },
      ],
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
