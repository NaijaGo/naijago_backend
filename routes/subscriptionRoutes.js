const express = require('express');
const crypto = require('crypto');

const User = require('../models/User');
const Payment = require('../models/Payment');
const SubscriptionSettings = require('../models/SubscriptionSettings');
const MainOrder = require('../models/MainOrder');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

const router = express.Router();

const PLANS = [
  {
    id: 'student',
    name: 'Students',
    price: 10000,
    deliveries: 7,
    minimumOrderValue: 4000,
    deliveryScope: 'same_zone',
    deliveryScopeLabel: 'Same zone only',
    validHours: { start: '09:00', end: '18:00' },
    benefits: ['Free delivery within your zone', 'Built for weekly essentials'],
  },
  {
    id: 'standard',
    name: 'Standard',
    price: 20000,
    deliveries: 15,
    minimumOrderValue: 8000,
    deliveryScope: 'same_zone',
    deliveryScopeLabel: 'Same zone only',
    validHours: { start: '09:00', end: '18:00' },
    benefits: ['Priority delivery', 'More monthly free deliveries'],
  },
  {
    id: 'premium',
    name: 'Premium',
    price: 50000,
    deliveries: 20,
    minimumOrderValue: 15000,
    deliveryScope: 'city_errands',
    deliveryScopeLabel: 'Within city errands',
    validHours: { start: '09:00', end: '18:00' },
    benefits: [
      'Priority delivery and exclusive deals',
      'Errand requests within your city',
    ],
  },
];

const ALLOWED_PREFERENCES = new Set([
  'Fast Food',
  'Local Food',
  'Snacks',
  'Drinks',
  'Groceries',
  'Gadgets',
  'Fashion',
  'Health & Pharmacy',
  'Home Essentials',
  'Urgent Delivery',
  'Cheap Deals',
  'Premium Quality',
]);

async function getPlans({ includeInactive = false } = {}) {
  let settings = await SubscriptionSettings.findOne({ key: 'naijago' });
  if (!settings) {
    settings = await SubscriptionSettings.create({ key: 'naijago', plans: PLANS });
  }
  const plans = settings.plans?.length ? settings.plans.map((plan) => plan.toObject()) : PLANS;
  return includeInactive ? plans : plans.filter((plan) => plan.isActive !== false);
}

async function getPlan(planId, options) {
  const plans = await getPlans(options);
  return plans.find((plan) => plan.id === planId);
}

function sanitizePreferences(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => String(item || '').trim())
        .filter((item) => ALLOWED_PREFERENCES.has(item))
    )
  );
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isWithinHours(now, validHours) {
  const [startHour, startMinute] = validHours.start.split(':').map(Number);
  const [endHour, endMinute] = validHours.end.split(':').map(Number);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}

function normalizeSubscription(user) {
  const subscription = user.naijagoSubscription || {};
  const expiresAt = subscription.expiresAt ? new Date(subscription.expiresAt) : null;
  const isExpired =
    subscription.status === 'active' && expiresAt && expiresAt.getTime() <= Date.now();

  return {
    planId: isExpired ? 'none' : subscription.planId || 'none',
    planName: isExpired ? '' : subscription.planName || '',
    status: isExpired ? 'expired' : subscription.status || 'inactive',
    price: subscription.price || 0,
    monthlyDeliveryLimit: subscription.monthlyDeliveryLimit || 0,
    deliveriesRemaining: subscription.deliveriesRemaining || 0,
    minimumOrderValue: subscription.minimumOrderValue || 0,
    deliveryScope: subscription.deliveryScope || '',
    validHours: subscription.validHours || { start: '09:00', end: '18:00' },
    preferences: subscription.preferences || [],
    zone: subscription.zone || '',
    city: subscription.city || '',
    activatedAt: subscription.activatedAt || null,
    expiresAt: subscription.expiresAt || null,
    lastResetAt: subscription.lastResetAt || null,
    paymentReference: subscription.paymentReference || '',
  };
}

async function getUser(userId) {
  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('User not found.');
    error.statusCode = 404;
    throw error;
  }
  return user;
}

router.get('/plans', async (_req, res) => {
  const plans = await getPlans();
  res.json({ plans });
});

router.get('/me', protect, async (req, res) => {
  try {
    const user = await getUser(req.user._id);
    res.json({
      subscription: normalizeSubscription(user),
      userWalletBalance: user.userWalletBalance || 0,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      message: error.message || 'Failed to fetch subscription.',
    });
  }
});

router.post('/setup', protect, async (req, res) => {
  const { planId, preferences, zone, city } = req.body;
  const plan = await getPlan(planId);

  if (!plan) {
    return res.status(400).json({ message: 'Invalid subscription plan.' });
  }

  const sanitizedPreferences = sanitizePreferences(preferences);
  if (sanitizedPreferences.length === 0) {
    return res.status(400).json({ message: 'Select at least one preference.' });
  }

  try {
    const user = await getUser(req.user._id);
    user.naijagoSubscription = {
      ...(user.naijagoSubscription?.toObject?.() || user.naijagoSubscription || {}),
      planId: plan.id,
      planName: plan.name,
      status: 'payment_pending',
      price: plan.price,
      monthlyDeliveryLimit: plan.deliveries,
      deliveriesRemaining: 0,
      minimumOrderValue: plan.minimumOrderValue,
      deliveryScope: plan.deliveryScope,
      validHours: plan.validHours,
      preferences: sanitizedPreferences,
      zone: typeof zone === 'string' ? zone.trim() : '',
      city: typeof city === 'string' ? city.trim() : '',
    };

    await user.save();

    res.json({
      message: 'Subscription setup saved. Payment activation is pending.',
      subscription: normalizeSubscription(user),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      message: error.message || 'Failed to save subscription setup.',
    });
  }
});

router.post('/activate-wallet', protect, async (req, res) => {
  const { planId, preferences, zone, city } = req.body;
  const plan = await getPlan(planId);

  if (!plan) {
    return res.status(400).json({ message: 'Invalid subscription plan.' });
  }

  const sanitizedPreferences = sanitizePreferences(preferences);
  if (sanitizedPreferences.length === 0) {
    return res.status(400).json({ message: 'Select at least one preference.' });
  }

  try {
    const user = await getUser(req.user._id);

    if ((user.userWalletBalance || 0) < plan.price) {
      return res.status(400).json({
        message: 'Insufficient wallet balance. Please top up your wallet.',
        requiredAmount: plan.price,
        userWalletBalance: user.userWalletBalance || 0,
      });
    }

    const now = new Date();
    const reference = `SUB-${plan.id.toUpperCase()}-${crypto.randomUUID()}`;

    user.userWalletBalance = Number(((user.userWalletBalance || 0) - plan.price).toFixed(2));
    user.naijagoSubscription = {
      planId: plan.id,
      planName: plan.name,
      status: 'active',
      price: plan.price,
      monthlyDeliveryLimit: plan.deliveries,
      deliveriesRemaining: plan.deliveries,
      minimumOrderValue: plan.minimumOrderValue,
      deliveryScope: plan.deliveryScope,
      validHours: plan.validHours,
      preferences: sanitizedPreferences,
      zone: typeof zone === 'string' ? zone.trim() : '',
      city: typeof city === 'string' ? city.trim() : '',
      activatedAt: now,
      expiresAt: addDays(now, 30),
      lastResetAt: now,
      paymentReference: reference,
    };

    await user.save();

    await Payment.create({
      userId: user._id,
      transactionRef: reference,
      amount: plan.price,
      currency: 'NGN',
      status: 'successful',
      gateway: 'Wallet',
    });

    res.json({
      message: `${plan.name} subscription activated.`,
      subscription: normalizeSubscription(user),
      userWalletBalance: user.userWalletBalance || 0,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      message: error.message || 'Failed to activate subscription.',
    });
  }
});

router.post('/validate-delivery', protect, async (req, res) => {
  const { orderTotal, pickupZone, deliveryZone, city } = req.body;

  try {
    const user = await getUser(req.user._id);
    const subscription = normalizeSubscription(user);

    if (subscription.status !== 'active') {
      return res.json({ eligible: false, reason: 'No active subscription.' });
    }

    const plan = await getPlan(subscription.planId, { includeInactive: true });
    if (!plan) {
      return res.json({ eligible: false, reason: 'Invalid subscription plan.' });
    }

    if (subscription.deliveriesRemaining <= 0) {
      return res.json({ eligible: false, reason: 'Monthly free deliveries exhausted.' });
    }

    if (Number(orderTotal || 0) < subscription.minimumOrderValue) {
      return res.json({ eligible: false, reason: 'Minimum order value not met.' });
    }

    if (!isWithinHours(new Date(), subscription.validHours)) {
      return res.json({ eligible: false, reason: 'Outside subscription delivery hours.' });
    }

    const sameZone = pickupZone && deliveryZone && String(pickupZone) === String(deliveryZone);
    if (plan.deliveryScope === 'same_zone' && !sameZone) {
      return res.json({ eligible: false, reason: 'Delivery is outside the same zone.' });
    }

    if (
      plan.deliveryScope === 'city_errands' &&
      subscription.city &&
      city &&
      String(subscription.city).toLowerCase() !== String(city).toLowerCase()
    ) {
      return res.json({ eligible: false, reason: 'Delivery is outside your subscription city.' });
    }

    res.json({
      eligible: true,
      freeDeliveryRemaining: subscription.deliveriesRemaining,
      subscription,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      message: error.message || 'Failed to validate subscription delivery.',
    });
  }
});

router.get('/admin/overview', protect, authorizeRoles('admin'), async (_req, res) => {
  try {
    const [plans, subscribers, subscriptionPayments, discountedOrders] = await Promise.all([
      getPlans({ includeInactive: true }),
      User.find({ 'naijagoSubscription.status': { $in: ['payment_pending', 'active', 'expired', 'cancelled'] } })
        .select('firstName lastName email phoneNumber userWalletBalance naijagoSubscription createdAt')
        .sort({ 'naijagoSubscription.activatedAt': -1, updatedAt: -1 })
        .lean(),
      Payment.find({ transactionRef: /^SUB-/ })
        .select('amount status gateway createdAt transactionRef userId')
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
      MainOrder.find({ subscriptionFreeDeliveryApplied: true })
        .select('user totalPrice subscriptionDeliveryDiscount subscriptionPlanId createdAt')
        .populate('user', 'firstName lastName email phoneNumber')
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ]);

    const summary = subscribers.reduce((acc, user) => {
      const sub = user.naijagoSubscription || {};
      const status = sub.status || 'inactive';
      const planId = sub.planId || 'none';
      acc.total += 1;
      acc.byStatus[status] = (acc.byStatus[status] || 0) + 1;
      acc.byPlan[planId] = (acc.byPlan[planId] || 0) + 1;
      if (status === 'active') {
        acc.active += 1;
        acc.activeMonthlyValue += Number(sub.price || 0);
        acc.remainingDeliveries += Number(sub.deliveriesRemaining || 0);
      }
      return acc;
    }, {
      total: 0,
      active: 0,
      activeMonthlyValue: 0,
      remainingDeliveries: 0,
      byStatus: {},
      byPlan: {},
    });

    const revenue = subscriptionPayments
      .filter((payment) => payment.status === 'successful')
      .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    const deliveryDiscounts = discountedOrders
      .reduce((sum, order) => sum + Number(order.subscriptionDeliveryDiscount || 0), 0);

    res.json({
      plans,
      summary: {
        ...summary,
        revenue,
        deliveryDiscounts,
        subscriptionPayments: subscriptionPayments.length,
        discountedOrders: discountedOrders.length,
      },
      subscribers,
      subscriptionPayments,
      discountedOrders,
    });
  } catch (error) {
    console.error('Admin subscription overview error:', error);
    res.status(500).json({ message: 'Failed to fetch subscription overview.' });
  }
});

router.put('/admin/plans', protect, authorizeRoles('admin'), async (req, res) => {
  try {
    const incomingPlans = Array.isArray(req.body.plans) ? req.body.plans : [];
    if (!incomingPlans.length) {
      return res.status(400).json({ message: 'Plans are required.' });
    }

    const existingPlans = await getPlans({ includeInactive: true });
    const nextPlans = existingPlans.map((existing) => {
      const incoming = incomingPlans.find((plan) => plan.id === existing.id);
      if (!incoming) return existing;
      return {
        ...existing,
        name: String(incoming.name || existing.name).trim(),
        price: Math.max(0, Number(incoming.price ?? existing.price)),
        deliveries: Math.max(0, Number(incoming.deliveries ?? existing.deliveries)),
        minimumOrderValue: Math.max(0, Number(incoming.minimumOrderValue ?? existing.minimumOrderValue)),
        deliveryScope: ['same_zone', 'city_errands'].includes(incoming.deliveryScope)
          ? incoming.deliveryScope
          : existing.deliveryScope,
        deliveryScopeLabel: String(incoming.deliveryScopeLabel || existing.deliveryScopeLabel).trim(),
        validHours: {
          start: String(incoming.validHours?.start || existing.validHours?.start || '09:00'),
          end: String(incoming.validHours?.end || existing.validHours?.end || '18:00'),
        },
        benefits: Array.isArray(incoming.benefits)
          ? incoming.benefits.map((benefit) => String(benefit).trim()).filter(Boolean)
          : existing.benefits,
        isActive: incoming.isActive !== false,
      };
    });

    const settings = await SubscriptionSettings.findOneAndUpdate(
      { key: 'naijago' },
      { plans: nextPlans, updatedBy: req.user._id },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).populate('updatedBy', 'firstName lastName email');

    res.json({
      message: 'Subscription plans updated.',
      plans: settings.plans,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedBy,
    });
  } catch (error) {
    console.error('Admin subscription plan update error:', error);
    res.status(500).json({ message: 'Failed to update subscription plans.' });
  }
});

module.exports = router;
