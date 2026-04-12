const AppSetting = require('../models/AppSetting');

const DELIVERY_FEE_SETTINGS_KEY = 'delivery_fee_program';
const ADMIN_IDENTITY_FIELDS = 'firstName lastName email';
const DEFAULT_FALLBACK_RATE_PER_KM = 200;
const DEFAULT_MINIMUM_DELIVERY_FEE = 1000;

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

const getDeliveryFeeSettings = async () => {
  const existingSettings = await AppSetting.findOne({ key: DELIVERY_FEE_SETTINGS_KEY })
    .select(
      'fallbackRatePerKm minimumDeliveryFee deliveryFeeZones updatedBy updatedAt createdAt deliveryFeeHistory',
    )
    .populate('updatedBy', ADMIN_IDENTITY_FIELDS)
    .populate('deliveryFeeHistory.changedBy', ADMIN_IDENTITY_FIELDS);

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
  getDeliveryFeeSettings,
  initializeDeliveryFeeSettings,
  normalizeDeliveryFeeZones,
  findMatchingDeliveryZone,
  buildDeliveryFeeQuote,
};
