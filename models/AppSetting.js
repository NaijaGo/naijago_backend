const mongoose = require('mongoose');
const { DEFAULTS: SCHEDULING_DEFAULTS } = require('../config/scheduledDelivery');

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

const DeliverySettingsHistorySchema = new mongoose.Schema({
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  changedAt: { type: Date, default: Date.now },
  oldValue: { type: mongoose.Schema.Types.Mixed, default: {} },
  newValue: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false });

const DeliveryPricingSchema = new mongoose.Schema({
  mode: { type: String, enum: ['zone', 'road_km'], default: 'zone' },
  baseFee: { type: Number, min: 0, default: 0 },
  pricePerKm: { type: Number, min: 0, default: 0 },
  minimumFee: { type: Number, min: 0, default: 0 },
  maximumFee: { type: Number, min: 0, default: null },
  maximumDistanceKm: { type: Number, min: 0, default: null },
  routeProfile: { type: String, enum: ['driving'], default: 'driving' },
}, { _id: false });

const RiderPayoutPricingSchema = new mongoose.Schema({
  basePayout: { type: Number, min: 0, default: 0 },
  pricePerKm: { type: Number, min: 0, default: 0 },
  minimumPayout: { type: Number, min: 0, default: 0 },
  maximumPayout: { type: Number, min: 0, default: null },
  multiVendorAdjustment: { type: Number, min: 0, default: 0 },
}, { _id: false });

const FreeDeliveryCampaignSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  minimumOrderAmount: { type: Number, min: 0, default: 0 },
  maximumDistanceKm: { type: Number, min: 0, default: null },
  customerEligibility: { type: String, enum: ['everyone', 'first_order'], default: 'everyone' },
  vendorIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  areas: [{ type: String, trim: true }],
  promoCode: { type: String, trim: true, uppercase: true, default: '' },
  startsAt: { type: Date, default: null },
  endsAt: { type: Date, default: null },
}, { _id: false });

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
    scheduledDelivery: {
      type: new mongoose.Schema({
        scheduledDeliveryEnabled: { type: Boolean, default: SCHEDULING_DEFAULTS.scheduledDeliveryEnabled },
        checkoutReservationMinutes: { type: Number, default: SCHEDULING_DEFAULTS.checkoutReservationMinutes,
          min: 1, max: 60, validate: Number.isSafeInteger },
        defaultTimeZone: { type: String, enum: [SCHEDULING_DEFAULTS.defaultTimeZone], default: SCHEDULING_DEFAULTS.defaultTimeZone },
      }, { _id: false }),
      default: undefined,
    },
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
    deliveryPricing: {
      type: DeliveryPricingSchema,
      default: () => ({}),
    },
    riderPayoutPricing: {
      type: RiderPayoutPricingSchema,
      default: () => ({}),
    },
    freeDeliveryCampaign: {
      type: FreeDeliveryCampaignSchema,
      default: () => ({}),
    },
    deliverySettingsHistory: {
      type: [DeliverySettingsHistorySchema],
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
    naijagoWarehouse: {
      formattedAddress: { type: String, trim: true, default: '' },
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
    },
    costLowStore: {
      vendorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
      },
      commissionKoboPerUnit: {
        type: Number,
        min: 0,
        default: 5700,
      },
    },
  },
  {
    timestamps: true,
  },
);

const AppSetting = mongoose.model('AppSetting', AppSettingSchema);

module.exports = AppSetting;
