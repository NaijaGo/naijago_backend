const AppSetting = require('../models/AppSetting');

const DELIVERY_FEE_SETTINGS_KEY = 'delivery_fee_program';
const ADMIN_IDENTITY_FIELDS = 'firstName lastName email';
const DEFAULT_FALLBACK_RATE_PER_KM = 200;
const DEFAULT_MINIMUM_DELIVERY_FEE = 1000;
const DEFAULT_DELIVERY_PRICING = {
  mode: 'zone',
  baseFee: 0,
  pricePerKm: 0,
  minimumFee: 0,
  maximumFee: null,
  maximumDistanceKm: null,
  routeProfile: 'driving',
};
const DEFAULT_RIDER_PAYOUT_PRICING = {
  basePayout: 0,
  pricePerKm: 0,
  minimumPayout: 0,
  maximumPayout: null,
  multiVendorAdjustment: 0,
};
const DEFAULT_FREE_DELIVERY_CAMPAIGN = {
  enabled: false,
  minimumOrderAmount: 0,
  maximumDistanceKm: null,
  customerEligibility: 'everyone',
  vendorIds: [],
  productIds: [],
  areas: [],
  promoCode: '',
  startsAt: null,
  endsAt: null,
};

// Generous sanity caps prevent accidental/malicious admin values without constraining normal pricing.
const DELIVERY_PRICING_LIMITS = Object.freeze({
  baseFee: 50000,
  pricePerKm: 10000,
  minimumFee: 50000,
  maximumFee: 500000,
  maximumDistanceKm: 500,
  basePayout: 100000,
  riderPricePerKm: 10000,
  minimumPayout: 100000,
  maximumPayout: 1000000,
  multiVendorAdjustment: 100000,
  campaignMinimumOrderAmount: 100000000,
  campaignMaximumDistanceKm: 500,
});

const validateDeliveryPricingBounds = ({ deliveryPricing, riderPayoutPricing, freeDeliveryCampaign } = {}) => {
  const groups = [
    [deliveryPricing, [
      ['baseFee', DELIVERY_PRICING_LIMITS.baseFee],
      ['pricePerKm', DELIVERY_PRICING_LIMITS.pricePerKm],
      ['minimumFee', DELIVERY_PRICING_LIMITS.minimumFee],
      ['maximumFee', DELIVERY_PRICING_LIMITS.maximumFee],
      ['maximumDistanceKm', DELIVERY_PRICING_LIMITS.maximumDistanceKm],
    ], 'Delivery pricing'],
    [riderPayoutPricing, [
      ['basePayout', DELIVERY_PRICING_LIMITS.basePayout],
      ['pricePerKm', DELIVERY_PRICING_LIMITS.riderPricePerKm],
      ['minimumPayout', DELIVERY_PRICING_LIMITS.minimumPayout],
      ['maximumPayout', DELIVERY_PRICING_LIMITS.maximumPayout],
      ['multiVendorAdjustment', DELIVERY_PRICING_LIMITS.multiVendorAdjustment],
    ], 'Rider payout'],
    [freeDeliveryCampaign, [
      ['minimumOrderAmount', DELIVERY_PRICING_LIMITS.campaignMinimumOrderAmount],
      ['maximumDistanceKm', DELIVERY_PRICING_LIMITS.campaignMaximumDistanceKm],
    ], 'Free delivery'],
  ];

  for (const [values, fields, label] of groups) {
    if (!values) continue;
    for (const [field, max] of fields) {
      if (!Object.prototype.hasOwnProperty.call(values, field)) continue;
      const value = values[field];
      if (value === null || value === '') {
        if (field === 'maximumFee' || field === 'maximumDistanceKm' || field === 'maximumPayout') continue;
        return `${label} ${field} must be a valid non-negative number.`;
      }
      if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) {
        return `${label} ${field} must be a valid non-negative number.`;
      }
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) return `${label} ${field} must be a valid non-negative number.`;
      if (number === 0 && ['maximumFee', 'maximumPayout', 'maximumDistanceKm'].includes(field)) {
        return `${label} ${field} must be greater than zero when set.`;
      }
      if (number > max) return `${label} ${field} cannot exceed ${max}.`;
    }
  }

  if (deliveryPricing?.mode != null && !['zone', 'road_km'].includes(deliveryPricing.mode)) {
    return 'Pricing method must be zone or road_km.';
  }
  if (deliveryPricing?.maximumFee != null && deliveryPricing?.minimumFee != null &&
      Number(deliveryPricing.maximumFee) < Number(deliveryPricing.minimumFee)) {
    return 'Maximum delivery fee must be greater than or equal to the minimum fee.';
  }
  if (riderPayoutPricing?.maximumPayout != null && riderPayoutPricing?.minimumPayout != null &&
      Number(riderPayoutPricing.maximumPayout) < Number(riderPayoutPricing.minimumPayout)) {
    return 'Maximum rider payout must be greater than or equal to the minimum payout.';
  }
  return null;
};

const DEFAULT_ABUJA_DELIVERY_ZONES = [
  {
    zoneKey: 'maitama',
    zoneName: 'Maitama',
    city: 'Abuja',
    group: 'Main Districts',
    aliases: ['maitama'],
    tags: [],
    amount: 1800,
    isActive: true,
  },
  {
    zoneKey: 'asokoro',
    zoneName: 'Asokoro',
    city: 'Abuja',
    group: 'Main Districts',
    aliases: ['asokoro'],
    tags: [],
    amount: 1800,
    isActive: true,
  },
  {
    zoneKey: 'wuse',
    zoneName: 'Wuse',
    city: 'Abuja',
    group: 'Main Districts',
    aliases: ['wuse', 'wuse 1', 'wuse 2', 'wuse i', 'wuse ii'],
    tags: [],
    amount: 1800,
    isActive: true,
  },
  {
    zoneKey: 'garki',
    zoneName: 'Garki',
    city: 'Abuja',
    group: 'Main Districts',
    aliases: ['garki', 'garki area 1', 'garki area 2', 'garki area 3', 'garki area 4', 'garki area 5'],
    tags: [],
    amount: 1800,
    isActive: true,
  },
  {
    zoneKey: 'cbd',
    zoneName: 'Central Business District',
    city: 'Abuja',
    group: 'Main Districts',
    aliases: ['central business district', 'cbd'],
    tags: [],
    amount: 1800,
    isActive: true,
  },
  {
    zoneKey: 'utako',
    zoneName: 'Utako',
    city: 'Abuja',
    group: 'Main Districts',
    aliases: ['utako'],
    tags: [],
    amount: 1800,
    isActive: true,
  },
  {
    zoneKey: 'jabi',
    zoneName: 'Jabi',
    city: 'Abuja',
    group: 'Main Districts',
    aliases: ['jabi'],
    tags: [],
    amount: 1800,
    isActive: true,
  },
  {
    zoneKey: 'gwarinpa',
    zoneName: 'Gwarinpa',
    city: 'Abuja',
    group: 'Residential Areas',
    aliases: ['gwarinpa'],
    tags: [],
    amount: 2200,
    isActive: true,
  },
  {
    zoneKey: 'lokogoma',
    zoneName: 'Lokogoma',
    city: 'Abuja',
    group: 'Residential Areas',
    aliases: ['lokogoma'],
    tags: [],
    amount: 2200,
    isActive: true,
  },
  {
    zoneKey: 'karmo',
    zoneName: 'Karmo',
    city: 'Abuja',
    group: 'Residential Areas',
    aliases: ['karmo'],
    tags: [],
    amount: 2200,
    isActive: true,
  },
  {
    zoneKey: 'lugbe',
    zoneName: 'Lugbe',
    city: 'Abuja',
    group: 'Residential Areas',
    aliases: ['lugbe'],
    tags: [],
    amount: 2200,
    isActive: true,
  },
  {
    zoneKey: 'kubwa',
    zoneName: 'Kubwa',
    city: 'Abuja',
    group: 'Residential Areas',
    aliases: ['kubwa'],
    tags: ['student_youth'],
    amount: 2200,
    isActive: true,
  },
  {
    zoneKey: 'dawaki',
    zoneName: 'Dawaki',
    city: 'Abuja',
    group: 'Residential Areas',
    aliases: ['dawaki'],
    tags: [],
    amount: 2200,
    isActive: true,
  },
  {
    zoneKey: 'life_camp',
    zoneName: 'Life Camp',
    city: 'Abuja',
    group: 'Residential Areas',
    aliases: ['life camp', 'lifecamp'],
    tags: [],
    amount: 2200,
    isActive: true,
  },
  {
    zoneKey: 'apo',
    zoneName: 'Apo',
    city: 'Abuja',
    group: 'Residential Areas',
    aliases: ['apo', 'apo resettlement'],
    tags: [],
    amount: 2200,
    isActive: true,
  },
  {
    zoneKey: 'durumi',
    zoneName: 'Durumi',
    city: 'Abuja',
    group: 'Residential Areas',
    aliases: ['durumi'],
    tags: [],
    amount: 2200,
    isActive: true,
  },
  {
    zoneKey: 'katampe',
    zoneName: 'Katampe',
    city: 'Abuja',
    group: 'Residential Areas',
    aliases: ['katampe'],
    tags: [],
    amount: 2200,
    isActive: true,
  },
  {
    zoneKey: 'jahi',
    zoneName: 'Jahi',
    city: 'Abuja',
    group: 'Residential Areas',
    aliases: ['jahi'],
    tags: [],
    amount: 2200,
    isActive: true,
  },
  {
    zoneKey: 'nyanya',
    zoneName: 'Nyanya',
    city: 'Abuja',
    group: 'Satellite Towns',
    aliases: ['nyanya'],
    tags: ['student_youth'],
    amount: 2800,
    isActive: true,
  },
  {
    zoneKey: 'karu',
    zoneName: 'Karu',
    city: 'Abuja',
    group: 'Satellite Towns',
    aliases: ['karu'],
    tags: [],
    amount: 2800,
    isActive: true,
  },
  {
    zoneKey: 'mararaba',
    zoneName: 'Mararaba',
    city: 'Abuja',
    group: 'Satellite Towns',
    aliases: ['mararaba'],
    tags: ['student_youth'],
    amount: 2800,
    isActive: true,
  },
  {
    zoneKey: 'mpape',
    zoneName: 'Mpape',
    city: 'Abuja',
    group: 'Satellite Towns',
    aliases: ['mpape'],
    tags: [],
    amount: 2800,
    isActive: true,
  },
  {
    zoneKey: 'gwagwalada',
    zoneName: 'Gwagwalada',
    city: 'Abuja',
    group: 'Satellite Towns',
    aliases: ['gwagwalada', 'university of abuja', 'uniabuja', 'uni abuja'],
    tags: ['student_youth'],
    amount: 2800,
    isActive: true,
  },
  {
    zoneKey: 'zuba',
    zoneName: 'Zuba',
    city: 'Abuja',
    group: 'Satellite Towns',
    aliases: ['zuba'],
    tags: [],
    amount: 2800,
    isActive: true,
  },
  {
    zoneKey: 'dei_dei',
    zoneName: 'Dei-Dei',
    city: 'Abuja',
    group: 'Satellite Towns',
    aliases: ['dei dei', 'deidei', 'dei-dei'],
    tags: [],
    amount: 2800,
    isActive: true,
  },
  {
    zoneKey: 'bwari',
    zoneName: 'Bwari',
    city: 'Abuja',
    group: 'Satellite Towns',
    aliases: ['bwari', 'veritas'],
    tags: ['student_youth'],
    amount: 2800,
    isActive: true,
  },
];

const toNonNegativeNumber = (value, fallback = 0) => {
  const numericValue = Number.parseFloat(String(value ?? fallback));
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return fallback;
  }

  return Number(numericValue.toFixed(2));
};

const normalizeText = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const mapAdminIdentity = (adminLike) => {
  if (!adminLike) {
    return null;
  }

  const firstName = String(adminLike.firstName || '').trim();
  const lastName = String(adminLike.lastName || '').trim();
  const fullName = `${firstName} ${lastName}`.trim();

  return {
    id: adminLike._id || null,
    name: fullName || adminLike.email || 'Admin',
    email: adminLike.email || '',
  };
};

const normalizeDeliveryFeeZones = (zones = DEFAULT_ABUJA_DELIVERY_ZONES) =>
  zones
    .map((zone) => {
      const zoneName = String(zone.zoneName || zone.name || zone.zoneKey || '').trim();
      const zoneKey = String(zone.zoneKey || zoneName)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

      const aliases = Array.from(
        new Set(
          [zoneName, ...(Array.isArray(zone.aliases) ? zone.aliases : [])]
            .map((entry) => String(entry || '').trim())
            .filter(Boolean),
        ),
      );

      return {
        zoneKey,
        zoneName,
        city: String(zone.city || 'Abuja').trim(),
        group: String(zone.group || 'Abuja Zones').trim(),
        aliases,
        tags: Array.from(
          new Set(
            (Array.isArray(zone.tags) ? zone.tags : [])
              .map((entry) => String(entry || '').trim())
              .filter(Boolean),
          ),
        ),
        amount: toNonNegativeNumber(zone.amount, 0),
        isActive: zone.isActive !== false,
      };
    })
    .filter((zone) => zone.zoneKey && zone.zoneName);

const cloneDefaultDeliveryFeeZones = () =>
  normalizeDeliveryFeeZones(DEFAULT_ABUJA_DELIVERY_ZONES).map((zone) => ({ ...zone }));

const mapDeliveryFeeHistoryEntry = (entry) => ({
  fallbackRatePerKm: toNonNegativeNumber(entry?.fallbackRatePerKm, DEFAULT_FALLBACK_RATE_PER_KM),
  minimumDeliveryFee: toNonNegativeNumber(
    entry?.minimumDeliveryFee,
    DEFAULT_MINIMUM_DELIVERY_FEE,
  ),
  changedAt: entry?.changedAt || null,
  source: entry?.source || 'admin_update',
  changedBy: mapAdminIdentity(entry?.changedBy || null),
  zones: normalizeDeliveryFeeZones(entry?.zones || []),
});

const normalizeOptionalNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : null;
};

const normalizeDeliveryPricing = (pricing = {}) => ({
  mode: pricing?.mode === 'road_km' ? 'road_km' : 'zone',
  baseFee: toNonNegativeNumber(pricing?.baseFee, DEFAULT_DELIVERY_PRICING.baseFee),
  pricePerKm: toNonNegativeNumber(pricing?.pricePerKm, DEFAULT_DELIVERY_PRICING.pricePerKm),
  minimumFee: toNonNegativeNumber(pricing?.minimumFee, DEFAULT_DELIVERY_PRICING.minimumFee),
  maximumFee: normalizeOptionalNumber(pricing?.maximumFee),
  maximumDistanceKm: normalizeOptionalNumber(pricing?.maximumDistanceKm),
  routeProfile: 'driving',
});

const normalizeRiderPayoutPricing = (pricing = {}) => ({
  basePayout: toNonNegativeNumber(pricing?.basePayout, 0),
  pricePerKm: toNonNegativeNumber(pricing?.pricePerKm, 0),
  minimumPayout: toNonNegativeNumber(pricing?.minimumPayout, 0),
  maximumPayout: normalizeOptionalNumber(pricing?.maximumPayout),
  multiVendorAdjustment: toNonNegativeNumber(pricing?.multiVendorAdjustment, 0),
});

const normalizeFreeDeliveryCampaign = (campaign = {}) => ({
  enabled: campaign?.enabled === true,
  minimumOrderAmount: toNonNegativeNumber(campaign?.minimumOrderAmount, 0),
  maximumDistanceKm: normalizeOptionalNumber(campaign?.maximumDistanceKm),
  customerEligibility: campaign?.customerEligibility === 'first_order' ? 'first_order' : 'everyone',
  vendorIds: Array.isArray(campaign?.vendorIds) ? campaign.vendorIds.map(String) : [],
  productIds: Array.isArray(campaign?.productIds) ? campaign.productIds.map(String) : [],
  areas: Array.isArray(campaign?.areas)
    ? campaign.areas.map((area) => String(area || '').trim()).filter(Boolean)
    : [],
  promoCode: String(campaign?.promoCode || '').trim().toUpperCase(),
  startsAt: campaign?.startsAt || null,
  endsAt: campaign?.endsAt || null,
});

const mapDeliverySettingsHistoryEntry = (entry) => ({
  oldValue: entry?.oldValue || {},
  newValue: entry?.newValue || {},
  changedAt: entry?.changedAt || null,
  changedBy: mapAdminIdentity(entry?.changedBy || null),
});

const getDeliveryFeeSettings = async () => {
  const existingSettings = await AppSetting.findOne({ key: DELIVERY_FEE_SETTINGS_KEY })
    .select(
      'fallbackRatePerKm minimumDeliveryFee deliveryFeeZones updatedBy updatedAt createdAt deliveryFeeHistory deliveryPricing riderPayoutPricing freeDeliveryCampaign deliverySettingsHistory',
    )
    .populate('updatedBy', ADMIN_IDENTITY_FIELDS)
    .populate('deliveryFeeHistory.changedBy', ADMIN_IDENTITY_FIELDS)
    .populate('deliverySettingsHistory.changedBy', ADMIN_IDENTITY_FIELDS);

  if (existingSettings) {
    const zones = normalizeDeliveryFeeZones(existingSettings.deliveryFeeZones || []);
    const history = Array.isArray(existingSettings.deliveryFeeHistory)
      ? existingSettings.deliveryFeeHistory
          .map(mapDeliveryFeeHistoryEntry)
          .sort(
            (left, right) =>
              new Date(right.changedAt || 0).getTime() -
              new Date(left.changedAt || 0).getTime(),
          )
      : [];

    return {
      fallbackRatePerKm: toNonNegativeNumber(
        existingSettings.fallbackRatePerKm,
        DEFAULT_FALLBACK_RATE_PER_KM,
      ),
      minimumDeliveryFee: toNonNegativeNumber(
        existingSettings.minimumDeliveryFee,
        DEFAULT_MINIMUM_DELIVERY_FEE,
      ),
      zones,
      updatedBy: mapAdminIdentity(existingSettings.updatedBy),
      updatedAt: existingSettings.updatedAt || null,
      createdAt: existingSettings.createdAt || null,
      source: 'database',
      history,
      deliveryPricing: normalizeDeliveryPricing(existingSettings.deliveryPricing),
      riderPayoutPricing: normalizeRiderPayoutPricing(existingSettings.riderPayoutPricing),
      freeDeliveryCampaign: normalizeFreeDeliveryCampaign(existingSettings.freeDeliveryCampaign),
      deliverySettingsHistory: (existingSettings.deliverySettingsHistory || [])
        .map(mapDeliverySettingsHistoryEntry)
        .sort((left, right) => new Date(right.changedAt || 0) - new Date(left.changedAt || 0)),
    };
  }

  return {
    fallbackRatePerKm: DEFAULT_FALLBACK_RATE_PER_KM,
    minimumDeliveryFee: DEFAULT_MINIMUM_DELIVERY_FEE,
    zones: cloneDefaultDeliveryFeeZones(),
    updatedBy: null,
    updatedAt: null,
    createdAt: null,
    source: 'defaults',
    history: [],
    deliveryPricing: { ...DEFAULT_DELIVERY_PRICING },
    riderPayoutPricing: { ...DEFAULT_RIDER_PAYOUT_PRICING },
    freeDeliveryCampaign: { ...DEFAULT_FREE_DELIVERY_CAMPAIGN },
    deliverySettingsHistory: [],
  };
};

const initializeDeliveryFeeSettings = async () => {
  const existingSettings = await AppSetting.findOne({ key: DELIVERY_FEE_SETTINGS_KEY }).select(
    'deliveryFeeZones fallbackRatePerKm minimumDeliveryFee',
  );

  if (existingSettings) {
    return {
      seeded: false,
      zoneCount: Array.isArray(existingSettings.deliveryFeeZones)
        ? existingSettings.deliveryFeeZones.length
        : 0,
      fallbackRatePerKm: toNonNegativeNumber(
        existingSettings.fallbackRatePerKm,
        DEFAULT_FALLBACK_RATE_PER_KM,
      ),
      minimumDeliveryFee: toNonNegativeNumber(
        existingSettings.minimumDeliveryFee,
        DEFAULT_MINIMUM_DELIVERY_FEE,
      ),
    };
  }

  const defaultZones = cloneDefaultDeliveryFeeZones();

  try {
    await AppSetting.create({
      key: DELIVERY_FEE_SETTINGS_KEY,
      fallbackRatePerKm: DEFAULT_FALLBACK_RATE_PER_KM,
      minimumDeliveryFee: DEFAULT_MINIMUM_DELIVERY_FEE,
      deliveryFeeZones: defaultZones,
      updatedBy: null,
      deliveryFeeHistory: [
        {
          fallbackRatePerKm: DEFAULT_FALLBACK_RATE_PER_KM,
          minimumDeliveryFee: DEFAULT_MINIMUM_DELIVERY_FEE,
          zones: defaultZones,
          changedBy: null,
          source: 'startup_seed',
        },
      ],
    });

    return {
      seeded: true,
      zoneCount: defaultZones.length,
      fallbackRatePerKm: DEFAULT_FALLBACK_RATE_PER_KM,
      minimumDeliveryFee: DEFAULT_MINIMUM_DELIVERY_FEE,
    };
  } catch (error) {
    if (error?.code === 11000) {
      const persistedSettings = await AppSetting.findOne({ key: DELIVERY_FEE_SETTINGS_KEY }).select(
        'deliveryFeeZones fallbackRatePerKm minimumDeliveryFee',
      );

      return {
        seeded: false,
        zoneCount: Array.isArray(persistedSettings?.deliveryFeeZones)
          ? persistedSettings.deliveryFeeZones.length
          : defaultZones.length,
        fallbackRatePerKm: toNonNegativeNumber(
          persistedSettings?.fallbackRatePerKm,
          DEFAULT_FALLBACK_RATE_PER_KM,
        ),
        minimumDeliveryFee: toNonNegativeNumber(
          persistedSettings?.minimumDeliveryFee,
          DEFAULT_MINIMUM_DELIVERY_FEE,
        ),
      };
    }

    throw error;
  }
};

const findMatchingDeliveryZone = (zones = [], shippingAddress = {}) => {
  const normalizedAddress = normalizeText(
    [
      shippingAddress?.address,
      shippingAddress?.city,
      shippingAddress?.postalCode,
      shippingAddress?.country,
    ]
      .filter(Boolean)
      .join(' '),
  );

  if (!normalizedAddress) {
    return null;
  }

  const candidates = normalizeDeliveryFeeZones(zones)
    .filter((zone) => zone.isActive !== false)
    .sort((left, right) => {
      const leftLength = Math.max(
        ...left.aliases.map((alias) => normalizeText(alias).length),
        normalizeText(left.zoneName).length,
      );
      const rightLength = Math.max(
        ...right.aliases.map((alias) => normalizeText(alias).length),
        normalizeText(right.zoneName).length,
      );

      return rightLength - leftLength;
    });

  for (const zone of candidates) {
    const searchTerms = Array.from(
      new Set([zone.zoneName, ...(zone.aliases || [])].map(normalizeText).filter(Boolean)),
    );

    if (
      searchTerms.some((term) =>
        new RegExp(`(^|\\s)${escapeRegex(term)}(?=$|\\s)`, 'i').test(normalizedAddress),
      )
    ) {
      return zone;
    }
  }

  return null;
};

const buildDeliveryFeeQuote = ({ shippingAddress, distanceKm = 0, settings }) => {
  const activeSettings = settings || {
    fallbackRatePerKm: DEFAULT_FALLBACK_RATE_PER_KM,
    minimumDeliveryFee: DEFAULT_MINIMUM_DELIVERY_FEE,
    zones: cloneDefaultDeliveryFeeZones(),
  };

  const matchedZone = findMatchingDeliveryZone(activeSettings.zones, shippingAddress);
  if (matchedZone) {
    return {
      amount: toNonNegativeNumber(matchedZone.amount, DEFAULT_MINIMUM_DELIVERY_FEE),
      source: 'zone',
      zone: matchedZone,
      fallbackRatePerKm: toNonNegativeNumber(
        activeSettings.fallbackRatePerKm,
        DEFAULT_FALLBACK_RATE_PER_KM,
      ),
      minimumDeliveryFee: toNonNegativeNumber(
        activeSettings.minimumDeliveryFee,
        DEFAULT_MINIMUM_DELIVERY_FEE,
      ),
    };
  }

  const fallbackRatePerKm = toNonNegativeNumber(
    activeSettings.fallbackRatePerKm,
    DEFAULT_FALLBACK_RATE_PER_KM,
  );
  const minimumDeliveryFee = toNonNegativeNumber(
    activeSettings.minimumDeliveryFee,
    DEFAULT_MINIMUM_DELIVERY_FEE,
  );

  let shippingPrice = Number(distanceKm || 0) * fallbackRatePerKm;
  if (!Number.isFinite(shippingPrice) || shippingPrice < minimumDeliveryFee) {
    shippingPrice = minimumDeliveryFee;
  }

  return {
    amount: Number(shippingPrice.toFixed(2)),
    source: 'distance_fallback',
    zone: null,
    fallbackRatePerKm,
    minimumDeliveryFee,
  };
};

module.exports = {
  DELIVERY_FEE_SETTINGS_KEY,
  DEFAULT_ABUJA_DELIVERY_ZONES,
  DEFAULT_DELIVERY_PRICING,
  DEFAULT_RIDER_PAYOUT_PRICING,
  DEFAULT_FREE_DELIVERY_CAMPAIGN,
  DELIVERY_PRICING_LIMITS,
  validateDeliveryPricingBounds,
  getDeliveryFeeSettings,
  initializeDeliveryFeeSettings,
  normalizeDeliveryFeeZones,
  normalizeDeliveryPricing,
  normalizeRiderPayoutPricing,
  normalizeFreeDeliveryCampaign,
  findMatchingDeliveryZone,
  buildDeliveryFeeQuote,
};
