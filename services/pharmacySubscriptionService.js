const AppSetting = require('../models/AppSetting');
const User = require('../models/User');

const SETTINGS_KEY = 'pharmacy_subscription_program';
const ADMIN_IDENTITY_FIELDS = 'firstName lastName email';

const defaultPlans = () => [
  {
    planType: 'one_time',
    label: 'One-time pharmacist chat',
    price: Math.max(Number(process.env.PHARMACY_CHAT_ONE_TIME_PRICE || 500), 0),
    durationDays: 0,
    isActive: true,
  },
  {
    planType: 'weekly',
    label: 'Weekly pharmacist access',
    price: Math.max(Number(process.env.PHARMACY_CHAT_WEEKLY_PRICE || 1500), 0),
    durationDays: 7,
    isActive: true,
  },
  {
    planType: 'monthly',
    label: 'Monthly pharmacist access',
    price: Math.max(Number(process.env.PHARMACY_CHAT_MONTHLY_PRICE || 4500), 0),
    durationDays: 30,
    isActive: true,
  },
];

const mapAdminIdentity = (adminLike) => {
  if (!adminLike) return null;
  const firstName = String(adminLike.firstName || '').trim();
  const lastName = String(adminLike.lastName || '').trim();
  const name = `${firstName} ${lastName}`.trim();
  return {
    id: adminLike._id || null,
    name: name || adminLike.email || 'Admin',
    email: adminLike.email || '',
  };
};

const normalizePlan = (plan, fallback = {}) => {
  const planType = String(plan?.planType || fallback.planType || '').trim();
  const normalized = {
    planType,
    label: String(plan?.label || fallback.label || planType).trim(),
    price: Math.max(Number(plan?.price ?? fallback.price ?? 0), 0),
    durationDays: Math.max(Number(plan?.durationDays ?? fallback.durationDays ?? 0), 0),
    isActive: plan?.isActive === undefined ? fallback.isActive !== false : plan.isActive === true,
  };

  if (normalized.planType === 'one_time') {
    normalized.durationDays = 0;
  }

  return normalized;
};

const sanitizePlans = (plans = defaultPlans()) => {
  const fallbackByType = new Map(defaultPlans().map((plan) => [plan.planType, plan]));
  const inputByType = new Map(
    (Array.isArray(plans) ? plans : [])
      .filter((plan) => ['one_time', 'weekly', 'monthly'].includes(String(plan?.planType || '')))
      .map((plan) => [String(plan.planType), plan]),
  );

  return ['one_time', 'weekly', 'monthly'].map((planType) =>
    normalizePlan(inputByType.get(planType), fallbackByType.get(planType)),
  );
};

const getPharmacySubscriptionSettings = async () => {
  const settings = await AppSetting.findOne({ key: SETTINGS_KEY })
    .select('pharmacySubscriptionPlans pharmacySubscriptionHistory updatedBy updatedAt createdAt')
    .populate('updatedBy', ADMIN_IDENTITY_FIELDS)
    .populate('pharmacySubscriptionHistory.changedBy', ADMIN_IDENTITY_FIELDS);

  if (!settings) {
    return {
      plans: defaultPlans(),
      updatedBy: null,
      updatedAt: null,
      createdAt: null,
      source: 'env',
      history: [],
    };
  }

  return {
    plans: sanitizePlans(settings.pharmacySubscriptionPlans),
    updatedBy: mapAdminIdentity(settings.updatedBy),
    updatedAt: settings.updatedAt || null,
    createdAt: settings.createdAt || null,
    source: 'database',
    history: (settings.pharmacySubscriptionHistory || [])
      .map((entry) => ({
        plans: sanitizePlans(entry.plans),
        changedBy: mapAdminIdentity(entry.changedBy),
        changedAt: entry.changedAt || null,
        source: entry.source || 'admin_update',
      }))
      .sort((left, right) => new Date(right.changedAt || 0) - new Date(left.changedAt || 0)),
  };
};

const initializePharmacySubscriptionSettings = async () => {
  const existingSettings = await AppSetting.findOne({ key: SETTINGS_KEY }).select(
    'pharmacySubscriptionPlans',
  );

  if (existingSettings) {
    return { seeded: false, plans: sanitizePlans(existingSettings.pharmacySubscriptionPlans) };
  }

  const plans = defaultPlans();
  try {
    await AppSetting.create({
      key: SETTINGS_KEY,
      pharmacySubscriptionPlans: plans,
      pharmacySubscriptionHistory: [{ plans, changedBy: null, source: 'startup_seed' }],
      updatedBy: null,
    });
    return { seeded: true, plans };
  } catch (error) {
    if (error?.code === 11000) {
      const persisted = await AppSetting.findOne({ key: SETTINGS_KEY }).select(
        'pharmacySubscriptionPlans',
      );
      return { seeded: false, plans: sanitizePlans(persisted?.pharmacySubscriptionPlans) };
    }
    throw error;
  }
};

const updatePharmacySubscriptionSettings = async ({ plans, adminId }) => {
  const sanitizedPlans = sanitizePlans(plans);
  const settings = await AppSetting.findOneAndUpdate(
    { key: SETTINGS_KEY },
    {
      $set: {
        pharmacySubscriptionPlans: sanitizedPlans,
        updatedBy: adminId || null,
      },
      $push: {
        pharmacySubscriptionHistory: {
          $each: [{ plans: sanitizedPlans, changedBy: adminId || null, source: 'admin_update' }],
          $slice: -20,
        },
      },
    },
    { new: true, upsert: true, runValidators: true },
  );

  return getPharmacySubscriptionSettings(settings);
};

const getUserPharmacyAccess = (user) => {
  const subscription = user?.pharmacySubscription || {};
  const now = new Date();
  const expiresAt = subscription.expiresAt ? new Date(subscription.expiresAt) : null;
  const hasTimedAccess =
    subscription.status === 'active' && expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt > now;
  const oneTimeCredits = Math.max(Number(subscription.oneTimeCredits || 0), 0);
  const source = hasTimedAccess ? 'subscription' : oneTimeCredits > 0 ? 'one_time' : null;

  return {
    hasAccess: hasTimedAccess || oneTimeCredits > 0,
    entitlement: 'pharmacy_chat',
    source,
    planType: hasTimedAccess ? subscription.planType : oneTimeCredits > 0 ? 'one_time' : 'none',
    status: hasTimedAccess ? 'active' : oneTimeCredits > 0 ? 'credit_available' : 'inactive',
    expiresAt: hasTimedAccess ? expiresAt : null,
    oneTimeCredits,
  };
};

const purchasePharmacySubscription = async ({ userId, planType }) => {
  const settings = await getPharmacySubscriptionSettings();
  const plan = settings.plans.find((item) => item.planType === planType && item.isActive);
  if (!plan) {
    const error = new Error('Selected pharmacist subscription plan is not available.');
    error.statusCode = 400;
    throw error;
  }

  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('User not found.');
    error.statusCode = 404;
    throw error;
  }

  if (Number(user.userWalletBalance || 0) < plan.price) {
    const error = new Error('Insufficient wallet balance for this pharmacist subscription.');
    error.statusCode = 402;
    error.details = { price: plan.price, walletBalance: user.userWalletBalance || 0 };
    throw error;
  }

  user.userWalletBalance = Number(user.userWalletBalance || 0) - plan.price;
  const now = new Date();

  if (plan.planType === 'one_time') {
    user.pharmacySubscription = {
      ...(user.pharmacySubscription || {}),
      planType: 'one_time',
      status: 'inactive',
      oneTimeCredits: Math.max(Number(user.pharmacySubscription?.oneTimeCredits || 0), 0) + 1,
      purchasedAt: now,
      expiresAt: user.pharmacySubscription?.expiresAt || null,
    };
  } else {
    const currentExpiresAt = user.pharmacySubscription?.expiresAt
      ? new Date(user.pharmacySubscription.expiresAt)
      : null;
    const startsAt = currentExpiresAt && currentExpiresAt > now ? currentExpiresAt : now;
    const expiresAt = new Date(startsAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
    user.pharmacySubscription = {
      ...(user.pharmacySubscription || {}),
      planType: plan.planType,
      status: 'active',
      expiresAt,
      purchasedAt: now,
      oneTimeCredits: Math.max(Number(user.pharmacySubscription?.oneTimeCredits || 0), 0),
    };
  }

  await user.save();

  return {
    plan,
    walletBalance: user.userWalletBalance,
    access: getUserPharmacyAccess(user),
  };
};

const consumeOneTimeCreditIfNeeded = async (user) => {
  const access = getUserPharmacyAccess(user);
  if (!access.hasAccess) return { allowed: false, access };
  if (access.status === 'active') return { allowed: true, access, consumed: false };

  user.pharmacySubscription.oneTimeCredits = Math.max(
    Number(user.pharmacySubscription.oneTimeCredits || 0) - 1,
    0,
  );
  await user.save();
  return { allowed: true, access: getUserPharmacyAccess(user), consumed: true };
};

const getPharmacySubscribers = async ({ status = 'all', limit = 100, skip = 0 } = {}) => {
  const now = new Date();
  const baseQuery = {
    $or: [
      { 'pharmacySubscription.status': 'active' },
      { 'pharmacySubscription.oneTimeCredits': { $gt: 0 } },
      { 'pharmacySubscription.purchasedAt': { $ne: null } },
      { 'pharmacySubscription.expiresAt': { $ne: null } },
    ],
  };

  const query =
    status === 'active'
      ? {
          $or: [
            {
              'pharmacySubscription.status': 'active',
              'pharmacySubscription.expiresAt': { $gt: now },
            },
            { 'pharmacySubscription.oneTimeCredits': { $gt: 0 } },
          ],
        }
      : baseQuery;

  const activeQuery = {
    $or: [
      {
        'pharmacySubscription.status': 'active',
        'pharmacySubscription.expiresAt': { $gt: now },
      },
      { 'pharmacySubscription.oneTimeCredits': { $gt: 0 } },
    ],
  };

  const [users, total, activeTotal] = await Promise.all([
    User.find(query)
      .select('firstName lastName email phoneNumber userWalletBalance pharmacySubscription createdAt updatedAt')
      .sort({ 'pharmacySubscription.purchasedAt': -1, updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(query),
    User.countDocuments(activeQuery),
  ]);

  const subscribers = users.map((user) => ({
    id: String(user._id),
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    name:
      [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      user.email ||
      'Customer',
    email: user.email || '',
    phoneNumber: user.phoneNumber || '',
    walletBalance: Number(user.userWalletBalance || 0),
    pharmacySubscription: user.pharmacySubscription || {},
    access: getUserPharmacyAccess(user),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }));

  const summary = subscribers.reduce(
    (acc, subscriber) => {
      const access = subscriber.access;
      if (access.hasAccess) acc.pageActive += 1;
      if (access.source === 'subscription') acc.timed += 1;
      if (access.oneTimeCredits > 0) acc.oneTimeCredits += access.oneTimeCredits;
      return acc;
    },
    { total, active: activeTotal, pageActive: 0, timed: 0, oneTimeCredits: 0 },
  );

  return { subscribers, total, summary };
};

module.exports = {
  getPharmacySubscriptionSettings,
  initializePharmacySubscriptionSettings,
  updatePharmacySubscriptionSettings,
  getUserPharmacyAccess,
  purchasePharmacySubscription,
  consumeOneTimeCreditIfNeeded,
  getPharmacySubscribers,
};
