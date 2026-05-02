// adminRoutes.js
const express = require('express');
const AppSetting = require('../models/AppSetting');
const User = require('../models/User'); // Import the User model
const Dispute = require('../models/DisputeRequest'); // Import the Dispute model
const Rider = require('../models/Rider');
const Product = require('../models/Product');
const MainOrder = require('../models/MainOrder');
const Shipment = require('../models/Shipment');
const NotificationLog = require('../models/NotificationLog');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const { protect } = require('../middleware/authMiddleware'); // Import the protect middleware
const {
    getReferralProgramSettings,
} = require('../services/referralService');
const {
    getDeliveryFeeSettings,
    normalizeDeliveryFeeZones,
    DELIVERY_FEE_SETTINGS_KEY,
} = require('../services/deliveryFeeService');
const {
    getPharmacySubscriptionSettings,
    updatePharmacySubscriptionSettings,
} = require('../services/pharmacySubscriptionService');

const router = express.Router();
const REFERRAL_SETTINGS_KEY = 'referral_program';
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const APPROVED_VENDOR_FILTER = {
    isVendor: true,
    vendorStatus: 'approved',
};
const CUSTOMER_FILTER = {
    isAdmin: { $ne: true },
    isVendor: { $ne: true },
    role: { $ne: 'admin' },
};
const CUSTOMER_LOOKUP_MATCH = {
    'userDoc.isAdmin': { $ne: true },
    'userDoc.isVendor': { $ne: true },
    'userDoc.role': { $ne: 'admin' },
};

const buildReferralSettingsPayload = (settings, message) => ({
    message,
    referralRewardAmount: settings.referralRewardAmount,
    source: settings.source,
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
    createdAt: settings.createdAt,
    history: settings.history,
});

const buildDeliveryFeeSettingsPayload = (settings, message) => ({
    message,
    fallbackRatePerKm: settings.fallbackRatePerKm,
    minimumDeliveryFee: settings.minimumDeliveryFee,
    zoneCount: Array.isArray(settings.zones) ? settings.zones.length : 0,
    zones: settings.zones,
    source: settings.source,
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
    createdAt: settings.createdAt,
    history: settings.history,
});

const buildPharmacySubscriptionSettingsPayload = (settings, message) => ({
    message,
    plans: settings.plans,
    source: settings.source,
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
    createdAt: settings.createdAt,
    history: settings.history,
});

const toRoundedNumber = (value, digits = 2) => {
    const numericValue = Number(value || 0);

    if (!Number.isFinite(numericValue)) {
        return 0;
    }

    return Number(numericValue.toFixed(digits));
};

const calculateChangePercent = (currentValue, previousValue) => {
    const current = Number(currentValue || 0);
    const previous = Number(previousValue || 0);

    if (!Number.isFinite(current) || !Number.isFinite(previous)) {
        return 0;
    }

    if (previous === 0) {
        return current === 0 ? 0 : 100;
    }

    return toRoundedNumber(((current - previous) / previous) * 100, 1);
};

const buildAnalyticsRange = (requestedRange = 'all') => {
    const normalizedRange = String(requestedRange || 'all').toLowerCase();
    const now = new Date();
    let startDate = null;
    let label = 'All Time';
    let key = 'all';

    switch (normalizedRange) {
    case 'today':
        key = 'today';
        label = 'Today';
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
    case '7d':
        key = '7d';
        label = 'Last 7 Days';
        startDate = new Date(now.getTime() - (6 * DAY_IN_MS));
        startDate.setHours(0, 0, 0, 0);
        break;
    case '30d':
        key = '30d';
        label = 'Last 30 Days';
        startDate = new Date(now.getTime() - (29 * DAY_IN_MS));
        startDate.setHours(0, 0, 0, 0);
        break;
    case 'month':
        key = 'month';
        label = 'Month to Date';
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
    default:
        return {
            key,
            label,
            isAllTime: true,
            startDate: null,
            endDate: null,
            previousStartDate: null,
            previousEndDate: null,
        };
    }

    const endDate = now;
    const durationInMs = Math.max(endDate.getTime() - startDate.getTime(), 1);

    return {
        key,
        label,
        isAllTime: false,
        startDate,
        endDate,
        previousStartDate: new Date(startDate.getTime() - durationInMs),
        previousEndDate: new Date(startDate.getTime()),
    };
};

const serializeAnalyticsRange = (rangeWindow) => ({
    key: rangeWindow.key,
    label: rangeWindow.label,
    isAllTime: rangeWindow.isAllTime,
    startDate: rangeWindow.startDate ? rangeWindow.startDate.toISOString() : null,
    endDate: rangeWindow.endDate ? rangeWindow.endDate.toISOString() : null,
    previousStartDate: rangeWindow.previousStartDate
        ? rangeWindow.previousStartDate.toISOString()
        : null,
    previousEndDate: rangeWindow.previousEndDate
        ? rangeWindow.previousEndDate.toISOString()
        : null,
});

const buildDocumentDateQuery = (rangeWindow, fieldName = 'createdAt') => {
    if (!rangeWindow || rangeWindow.isAllTime) {
        return {};
    }

    return {
        [fieldName]: {
            $gte: rangeWindow.startDate,
            $lt: rangeWindow.endDate,
        },
    };
};

const buildRangeExpression = (dateExpression, rangeWindow) => {
    if (!rangeWindow || rangeWindow.isAllTime) {
        return null;
    }

    return {
        $and: [
            { $gte: [dateExpression, rangeWindow.startDate] },
            { $lt: [dateExpression, rangeWindow.endDate] },
        ],
    };
};

const buildComparisonRange = (rangeWindow) => {
    if (!rangeWindow || rangeWindow.isAllTime) {
        return null;
    }

    return {
        key: `${rangeWindow.key}_previous`,
        label: `Previous ${rangeWindow.label}`,
        isAllTime: false,
        startDate: rangeWindow.previousStartDate,
        endDate: rangeWindow.previousEndDate,
        previousStartDate: null,
        previousEndDate: null,
    };
};

const getPaidOrderSummary = async (rangeWindow) => {
    if (!rangeWindow) {
        return {
            paidOrders: 0,
            grossMerchandiseValue: 0,
            platformRevenue: 0,
            averageOrderValue: 0,
        };
    }

    const effectivePaidAtExpression = { $ifNull: ['$paidAt', '$createdAt'] };
    const rangeExpression = buildRangeExpression(effectivePaidAtExpression, rangeWindow);
    const aggregationPipeline = [
        { $match: { isPaid: true } },
    ];

    if (rangeExpression) {
        aggregationPipeline.push({ $match: { $expr: rangeExpression } });
    }

    aggregationPipeline.push({
        $group: {
            _id: null,
            paidOrders: { $sum: 1 },
            grossMerchandiseValue: { $sum: { $ifNull: ['$totalPrice', 0] } },
            platformRevenue: { $sum: { $ifNull: ['$totalPlatformFees', 0] } },
        },
    });

    const [summary] = await MainOrder.aggregate(aggregationPipeline);
    const paidOrders = Number(summary?.paidOrders || 0);
    const grossMerchandiseValue = Number(summary?.grossMerchandiseValue || 0);
    const platformRevenue = Number(summary?.platformRevenue || 0);

    return {
        paidOrders,
        grossMerchandiseValue: toRoundedNumber(grossMerchandiseValue),
        platformRevenue: toRoundedNumber(platformRevenue),
        averageOrderValue: paidOrders > 0
            ? toRoundedNumber(grossMerchandiseValue / paidOrders)
            : 0,
    };
};

const getCustomerPurchaseSummary = async (rangeWindow) => {
    if (!rangeWindow) {
        return {
            customersWithPurchases: 0,
            purchasingCustomersInRange: 0,
            firstTimeCustomersInRange: 0,
            repeatCustomersInRange: 0,
        };
    }

    const effectivePaidAtExpression = { $ifNull: ['$paidAt', '$createdAt'] };
    const paidOrdersInWindowAccumulator = rangeWindow.isAllTime
        ? { $sum: 1 }
        : {
            $sum: {
                $cond: [buildRangeExpression(effectivePaidAtExpression, rangeWindow), 1, 0],
            },
        };

    const purchasingCustomerCondition = rangeWindow.isAllTime
        ? { $gt: ['$totalPaidOrders', 0] }
        : { $gt: ['$paidOrdersInWindow', 0] };

    const firstTimeCustomerCondition = rangeWindow.isAllTime
        ? { $eq: ['$totalPaidOrders', 1] }
        : {
            $and: [
                { $gt: ['$paidOrdersInWindow', 0] },
                buildRangeExpression('$firstPaidAt', rangeWindow),
            ],
        };

    const repeatCustomerCondition = rangeWindow.isAllTime
        ? { $gte: ['$totalPaidOrders', 2] }
        : {
            $and: [
                { $gt: ['$paidOrdersInWindow', 0] },
                { $lt: ['$firstPaidAt', rangeWindow.startDate] },
            ],
        };

    const aggregationPipeline = [
        { $match: { isPaid: true } },
        {
            $group: {
                _id: '$user',
                firstPaidAt: { $min: effectivePaidAtExpression },
                totalPaidOrders: { $sum: 1 },
                paidOrdersInWindow: paidOrdersInWindowAccumulator,
            },
        },
        {
            $lookup: {
                from: User.collection.name,
                localField: '_id',
                foreignField: '_id',
                as: 'userDoc',
            },
        },
        { $unwind: '$userDoc' },
        { $match: CUSTOMER_LOOKUP_MATCH },
        {
            $group: {
                _id: null,
                customersWithPurchases: { $sum: 1 },
                purchasingCustomersInRange: {
                    $sum: { $cond: [purchasingCustomerCondition, 1, 0] },
                },
                firstTimeCustomersInRange: {
                    $sum: { $cond: [firstTimeCustomerCondition, 1, 0] },
                },
                repeatCustomersInRange: {
                    $sum: { $cond: [repeatCustomerCondition, 1, 0] },
                },
            },
        },
    ];

    const [summary] = await MainOrder.aggregate(aggregationPipeline);

    return {
        customersWithPurchases: Number(summary?.customersWithPurchases || 0),
        purchasingCustomersInRange: Number(summary?.purchasingCustomersInRange || 0),
        firstTimeCustomersInRange: Number(summary?.firstTimeCustomersInRange || 0),
        repeatCustomersInRange: Number(summary?.repeatCustomersInRange || 0),
    };
};

const getVendorPayoutsCompletedSummary = async (rangeWindow) => {
    if (!rangeWindow) {
        return {
            shipmentCount: 0,
            amount: 0,
        };
    }

    const payoutAmountExpression = {
        $subtract: [
            { $ifNull: ['$subtotal', 0] },
            { $ifNull: ['$platformFee', 0] },
        ],
    };

    const vendorPaidMatch = rangeWindow.isAllTime
        ? { vendorPaidAt: { $exists: true, $ne: null } }
        : buildDocumentDateQuery(rangeWindow, 'vendorPaidAt');

    const [summary] = await Shipment.aggregate([
        { $match: vendorPaidMatch },
        {
            $lookup: {
                from: MainOrder.collection.name,
                localField: 'mainOrder',
                foreignField: '_id',
                as: 'mainOrder',
            },
        },
        { $unwind: '$mainOrder' },
        { $match: { 'mainOrder.isPaid': true } },
        {
            $group: {
                _id: null,
                shipmentCount: { $sum: 1 },
                amount: {
                    $sum: {
                        $cond: [
                            { $gt: [payoutAmountExpression, 0] },
                            payoutAmountExpression,
                            0,
                        ],
                    },
                },
            },
        },
    ]);

    return {
        shipmentCount: Number(summary?.shipmentCount || 0),
        amount: toRoundedNumber(summary?.amount || 0),
    };
};

const getCurrentVendorPayoutDueSummary = async () => {
    const payoutAmountExpression = {
        $subtract: [
            { $ifNull: ['$subtotal', 0] },
            { $ifNull: ['$platformFee', 0] },
        ],
    };

    const [summary] = await Shipment.aggregate([
        {
            $match: {
                $or: [
                    { vendorPaidAt: { $exists: false } },
                    { vendorPaidAt: null },
                ],
            },
        },
        {
            $lookup: {
                from: MainOrder.collection.name,
                localField: 'mainOrder',
                foreignField: '_id',
                as: 'mainOrder',
            },
        },
        { $unwind: '$mainOrder' },
        {
            $match: {
                'mainOrder.isPaid': true,
                'mainOrder.mainOrderStatus': { $in: ['delivered', 'completed'] },
            },
        },
        {
            $group: {
                _id: null,
                shipmentCount: { $sum: 1 },
                amount: {
                    $sum: {
                        $cond: [
                            { $gt: [payoutAmountExpression, 0] },
                            payoutAmountExpression,
                            0,
                        ],
                    },
                },
            },
        },
    ]);

    return {
        shipmentCount: Number(summary?.shipmentCount || 0),
        amount: toRoundedNumber(summary?.amount || 0),
    };
};

const getVendorProductStats = async () => {
    const productStats = await Product.aggregate([
        {
            $group: {
                _id: '$vendor',
                totalProducts: { $sum: 1 },
                activeProducts: {
                    $sum: {
                        $cond: [{ $eq: ['$isActive', true] }, 1, 0],
                    },
                },
                lastProductActivityAt: {
                    $max: {
                        $ifNull: ['$updatedAt', '$createdAt'],
                    },
                },
            },
        },
    ]);

    return productStats.map((entry) => ({
        vendorId: String(entry?._id || ''),
        totalProducts: Number(entry?.totalProducts || 0),
        activeProducts: Number(entry?.activeProducts || 0),
        lastProductActivityAt: entry?.lastProductActivityAt || null,
    })).filter((entry) => entry.vendorId);
};

const getVendorSalesSummary = async (rangeWindow) => {
    if (!rangeWindow) {
        return [];
    }

    const effectivePaidAtExpression = { $ifNull: ['$mainOrder.paidAt', '$mainOrder.createdAt'] };
    const rangeExpression = buildRangeExpression(effectivePaidAtExpression, rangeWindow);
    const aggregationPipeline = [
        {
            $lookup: {
                from: MainOrder.collection.name,
                localField: 'mainOrder',
                foreignField: '_id',
                as: 'mainOrder',
            },
        },
        { $unwind: '$mainOrder' },
        { $match: { 'mainOrder.isPaid': true } },
    ];

    if (rangeExpression) {
        aggregationPipeline.push({ $match: { $expr: rangeExpression } });
    }

    aggregationPipeline.push(
        {
            $group: {
                _id: '$vendor',
                totalSalesAmount: { $sum: { $ifNull: ['$subtotal', 0] } },
                totalPlatformFees: { $sum: { $ifNull: ['$platformFee', 0] } },
                paidShipments: { $sum: 1 },
                paidOrderIds: { $addToSet: '$mainOrder._id' },
                lastSaleAt: { $max: effectivePaidAtExpression },
            },
        },
        {
            $project: {
                vendorId: '$_id',
                totalSalesAmount: 1,
                totalPlatformFees: 1,
                paidShipments: 1,
                paidOrders: { $size: '$paidOrderIds' },
                lastSaleAt: 1,
            },
        },
    );

    const salesSummary = await Shipment.aggregate(aggregationPipeline);

    return salesSummary.map((entry) => ({
        vendorId: String(entry?.vendorId || ''),
        totalSalesAmount: toRoundedNumber(entry?.totalSalesAmount || 0),
        totalPlatformFees: toRoundedNumber(entry?.totalPlatformFees || 0),
        paidShipments: Number(entry?.paidShipments || 0),
        paidOrders: Number(entry?.paidOrders || 0),
        lastSaleAt: entry?.lastSaleAt || null,
    })).filter((entry) => entry.vendorId);
};

const getReferralPerformanceSummary = async (rangeWindow) => {
    if (!rangeWindow) {
        return {
            referralsSent: 0,
            referralsConverted: 0,
            rewardCostTotal: 0,
            totalReferralSignups: 0,
            totalRewardedReferrals: 0,
            totalRewardCost: 0,
            pendingReferrals: 0,
        };
    }

    const referredAtExpression = { $ifNull: ['$referredAt', '$createdAt'] };
    const referralRangeExpression = buildRangeExpression(referredAtExpression, rangeWindow);
    const rewardRangeExpression = buildRangeExpression('$referralRewardGrantedAt', rangeWindow);
    const rewardedCondition = { $ne: ['$referralRewardGrantedAt', null] };
    const referralsSentCondition = rangeWindow.isAllTime
        ? true
        : referralRangeExpression;
    const referralsConvertedCondition = rangeWindow.isAllTime
        ? rewardedCondition
        : {
            $and: [
                rewardedCondition,
                rewardRangeExpression,
            ],
        };

    const [summary] = await User.aggregate([
        {
            $match: {
                referredBy: { $exists: true, $ne: null },
            },
        },
        {
            $group: {
                _id: null,
                referralsSent: {
                    $sum: {
                        $cond: [referralsSentCondition, 1, 0],
                    },
                },
                referralsConverted: {
                    $sum: {
                        $cond: [referralsConvertedCondition, 1, 0],
                    },
                },
                rewardCostTotal: {
                    $sum: {
                        $cond: [
                            referralsConvertedCondition,
                            { $ifNull: ['$referralRewardAmount', 0] },
                            0,
                        ],
                    },
                },
                totalReferralSignups: { $sum: 1 },
                totalRewardedReferrals: {
                    $sum: {
                        $cond: [rewardedCondition, 1, 0],
                    },
                },
                totalRewardCost: {
                    $sum: { $ifNull: ['$referralRewardAmount', 0] },
                },
            },
        },
    ]);

    const totalReferralSignups = Number(summary?.totalReferralSignups || 0);
    const totalRewardedReferrals = Number(summary?.totalRewardedReferrals || 0);

    return {
        referralsSent: Number(summary?.referralsSent || 0),
        referralsConverted: Number(summary?.referralsConverted || 0),
        rewardCostTotal: toRoundedNumber(summary?.rewardCostTotal || 0),
        totalReferralSignups,
        totalRewardedReferrals,
        totalRewardCost: toRoundedNumber(summary?.totalRewardCost || 0),
        pendingReferrals: Math.max(totalReferralSignups - totalRewardedReferrals, 0),
    };
};

// --- Middleware for Admin Authorization ---
// This middleware checks if the authenticated user is an administrator.
const authorizeAdmin = (req, res, next) => {
    // The 'protect' middleware should have already attached req.user
    if (req.user && req.user.isAdmin) {
        next(); // User is an admin, proceed to the next middleware/route handler
    } else {
        // If not an admin, return a forbidden error
        res.status(403).json({ message: 'Not authorized as an admin' });
    }
};

// --- Admin Routes ---

router.get('/product-moderation', protect, authorizeAdmin, async (req, res) => {
    try {
        const status = req.query.status || 'pending';
        const products = await Product.find({ moderationStatus: status })
            .populate('vendor', 'businessName phoneNumber businessLocation')
            .sort({ updatedAt: -1, createdAt: -1 })
            .limit(100);
        res.status(200).json(products);
    } catch (error) {
        console.error('Error fetching product moderation queue:', error);
        res.status(500).json({ message: 'Failed to fetch product moderation queue.' });
    }
});

router.put('/product-moderation/:productId', protect, authorizeAdmin, async (req, res) => {
    try {
        const status = String(req.body.status || '').trim().toLowerCase();
        if (!['approved', 'rejected', 'pending'].includes(status)) {
            return res.status(400).json({ message: 'Invalid moderation status.' });
        }

        const product = await Product.findById(req.params.productId);
        if (!product) {
            return res.status(404).json({ message: 'Product not found.' });
        }

        product.moderationStatus = status;
        product.isActive = status === 'approved';
        product.moderationNote = String(req.body.note || '').trim();
        product.reviewedAt = new Date();
        product.reviewedBy = req.user._id;
        await product.save();
        await product.populate('vendor', 'businessName phoneNumber businessLocation');

        res.status(200).json({
            message: `Product ${status}.`,
            product,
        });
    } catch (error) {
        console.error('Error updating product moderation status:', error);
        res.status(500).json({ message: 'Failed to update product moderation status.' });
    }
});

router.get('/notification-logs', protect, authorizeAdmin, async (req, res) => {
    try {
        const filter = {};
        if (req.query.channel) filter.channel = req.query.channel;
        if (req.query.status) filter.status = req.query.status;
        if (req.query.vendorId) filter.vendor = req.query.vendorId;
        if (req.query.shipmentId) filter.shipment = req.query.shipmentId;
        if (req.query.orderId) filter.order = req.query.orderId;

        const limit = Math.min(Number(req.query.limit) || 100, 200);
        const logs = await NotificationLog.find(filter)
            .populate('vendor', 'businessName firstName lastName phoneNumber')
            .sort({ createdAt: -1 })
            .limit(limit);

        res.status(200).json(logs);
    } catch (error) {
        console.error('Error fetching notification logs:', error);
        res.status(500).json({ message: 'Failed to fetch notification logs.' });
    }
});

router.get('/engagement-analytics', protect, authorizeAdmin, async (req, res) => {
    try {
        const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
        const since = new Date(Date.now() - (days * DAY_IN_MS));
        const eventMatch = { createdAt: { $gte: since } };
        const notificationMatch = { createdAt: { $gte: since }, channel: 'whatsapp' };

        const [
            eventTotals,
            carouselByPlacement,
            restaurantByCity,
            pharmacyBySource,
            recentEvents,
            whatsappTotals,
            recentWhatsappLogs,
        ] = await Promise.all([
            AnalyticsEvent.aggregate([
                { $match: eventMatch },
                { $group: { _id: '$eventType', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
            ]),
            AnalyticsEvent.aggregate([
                { $match: { ...eventMatch, eventType: 'carousel_click' } },
                { $group: { _id: { placement: '$placement', targetType: '$targetType' }, count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 20 },
            ]),
            AnalyticsEvent.aggregate([
                { $match: { ...eventMatch, eventType: 'restaurant_card_click' } },
                { $group: { _id: { city: '$city', source: '$source' }, count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 20 },
            ]),
            AnalyticsEvent.aggregate([
                { $match: { ...eventMatch, eventType: 'pharmacy_consultation_start' } },
                { $group: { _id: '$source', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 20 },
            ]),
            AnalyticsEvent.find(eventMatch)
                .sort({ createdAt: -1 })
                .limit(25)
                .populate('user', 'firstName lastName email phoneNumber'),
            NotificationLog.aggregate([
                { $match: notificationMatch },
                { $group: { _id: '$status', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
            ]),
            NotificationLog.find(notificationMatch)
                .sort({ createdAt: -1 })
                .limit(25)
                .populate('vendor', 'businessName firstName lastName phoneNumber'),
        ]);

        const totals = Object.fromEntries(eventTotals.map((entry) => [entry._id, entry.count]));
        const whatsapp = Object.fromEntries(whatsappTotals.map((entry) => [entry._id, entry.count]));

        res.status(200).json({
            range: { days, since },
            totals: {
                carouselClicks: totals.carousel_click || 0,
                restaurantCardClicks: totals.restaurant_card_click || 0,
                foodOrders: totals.food_order_created || 0,
                pharmacyConsultationStarts: totals.pharmacy_consultation_start || 0,
            },
            breakdowns: {
                carouselByPlacement,
                restaurantByCity,
                pharmacyBySource,
                whatsapp,
            },
            recentEvents,
            recentWhatsappLogs,
        });
    } catch (error) {
        console.error('Error fetching engagement analytics:', error);
        res.status(500).json({ message: 'Failed to fetch engagement analytics.' });
    }
});

// @desc    Get customer and vendor commerce metrics
// @route   GET /api/admin/customer-vendor-metrics
// @access  Private (Admin only)
router.get('/customer-vendor-metrics', protect, authorizeAdmin, async (req, res) => {
    const analyticsRange = buildAnalyticsRange(req.query.range);
    const comparisonRange = buildComparisonRange(analyticsRange);

    try {
        const [
            approvedVendorDocs,
            registeredVendors,
            registeredCustomers,
            activeVendorIds,
            purchasingCustomerIds,
            vendorsWithSalesAggregation,
            currentRangeOrderCount,
            previousRangeOrderCount,
            currentPaidOrderSummary,
            previousPaidOrderSummary,
            currentCustomerPurchaseSummary,
            previousCustomerPurchaseSummary,
            newCustomersInRange,
            newCustomersInPreviousRange,
            vendorPayoutsCompletedInRange,
            vendorPayoutsCompletedInPreviousRange,
            vendorPayoutDueSummary,
            vendorProductStats,
            vendorSalesLifetimeSummary,
            vendorSalesRangeSummary,
            currentReferralPerformance,
            previousReferralPerformance,
            lifetimeReferralPerformance,
        ] = await Promise.all([
            User.find(APPROVED_VENDOR_FILTER)
                .select('firstName lastName email businessName createdAt')
                .lean(),
            User.countDocuments(APPROVED_VENDOR_FILTER),
            User.countDocuments(CUSTOMER_FILTER),
            Product.distinct('vendor', { isActive: true }),
            MainOrder.distinct('user', { isPaid: true }),
            Shipment.aggregate([
                {
                    $lookup: {
                        from: MainOrder.collection.name,
                        localField: 'mainOrder',
                        foreignField: '_id',
                        as: 'mainOrder',
                    },
                },
                { $unwind: '$mainOrder' },
                { $match: { 'mainOrder.isPaid': true } },
                { $group: { _id: '$vendor' } },
            ]),
            MainOrder.countDocuments(buildDocumentDateQuery(analyticsRange)),
            comparisonRange
                ? MainOrder.countDocuments(buildDocumentDateQuery(comparisonRange))
                : Promise.resolve(0),
            getPaidOrderSummary(analyticsRange),
            getPaidOrderSummary(comparisonRange),
            getCustomerPurchaseSummary(analyticsRange),
            getCustomerPurchaseSummary(comparisonRange),
            User.countDocuments({
                ...CUSTOMER_FILTER,
                ...buildDocumentDateQuery(analyticsRange),
            }),
            comparisonRange
                ? User.countDocuments({
                    ...CUSTOMER_FILTER,
                    ...buildDocumentDateQuery(comparisonRange),
                })
                : Promise.resolve(0),
            getVendorPayoutsCompletedSummary(analyticsRange),
            getVendorPayoutsCompletedSummary(comparisonRange),
            getCurrentVendorPayoutDueSummary(),
            getVendorProductStats(),
            getVendorSalesSummary(buildAnalyticsRange('all')),
            getVendorSalesSummary(analyticsRange),
            getReferralPerformanceSummary(analyticsRange),
            getReferralPerformanceSummary(comparisonRange),
            getReferralPerformanceSummary(buildAnalyticsRange('all')),
        ]);

        const approvedVendorIds = new Set(
            approvedVendorDocs.map((vendorDoc) => String(vendorDoc?._id || '')).filter(Boolean),
        );
        const activeVendorIdSet = new Set(
            activeVendorIds.map((vendorId) => String(vendorId || '')).filter(
                (vendorId) => approvedVendorIds.has(vendorId),
            ),
        );
        const vendorProductStatsById = new Map(
            vendorProductStats
                .filter((entry) => approvedVendorIds.has(entry.vendorId))
                .map((entry) => [entry.vendorId, entry]),
        );
        const vendorSalesLifetimeById = new Map(
            vendorSalesLifetimeSummary
                .filter((entry) => approvedVendorIds.has(entry.vendorId))
                .map((entry) => [entry.vendorId, entry]),
        );
        const vendorSalesRangeById = new Map(
            vendorSalesRangeSummary
                .filter((entry) => approvedVendorIds.has(entry.vendorId))
                .map((entry) => [entry.vendorId, entry]),
        );

        const activeVendors = activeVendorIds.length
            ? await User.countDocuments({
                ...APPROVED_VENDOR_FILTER,
                _id: { $in: activeVendorIds },
            })
            : 0;

        const customersWithPurchases = purchasingCustomerIds.length
            ? await User.countDocuments({
                ...CUSTOMER_FILTER,
                _id: { $in: purchasingCustomerIds },
            })
            : 0;

        const vendorSaleIds = vendorsWithSalesAggregation
            .map((entry) => entry?._id)
            .filter(Boolean);

        const vendorsWithSales = vendorSaleIds.length
            ? await User.countDocuments({
                ...APPROVED_VENDOR_FILTER,
                _id: { $in: vendorSaleIds },
            })
            : 0;

        const customersWithoutPurchases = Math.max(
            registeredCustomers - customersWithPurchases,
            0,
        );

        const customerPurchaseConversionRate = registeredCustomers > 0
            ? Number(((customersWithPurchases / registeredCustomers) * 100).toFixed(1))
            : 0;

        const vendorActivationRate = registeredVendors > 0
            ? Number(((activeVendors / registeredVendors) * 100).toFixed(1))
            : 0;

        const vendorSalesParticipationRate = registeredVendors > 0
            ? Number(((vendorsWithSales / registeredVendors) * 100).toFixed(1))
            : 0;

        const vendorsWithProducts = vendorProductStatsById.size;
        const vendorsWithZeroProducts = Math.max(registeredVendors - vendorsWithProducts, 0);
        const vendorsWithProductsButNoSales = Array.from(vendorProductStatsById.keys()).filter(
            (vendorId) => !vendorSalesLifetimeById.has(vendorId),
        ).length;
        const activeVendorsWithNoSales = Array.from(activeVendorIdSet).filter(
            (vendorId) => !vendorSalesLifetimeById.has(vendorId),
        ).length;
        const inactivityThreshold = new Date(Date.now() - (30 * DAY_IN_MS));
        const vendorsInactive30Days = approvedVendorDocs.filter((vendorDoc) => {
            const vendorId = String(vendorDoc?._id || '');
            const productStats = vendorProductStatsById.get(vendorId);
            const salesStats = vendorSalesLifetimeById.get(vendorId);
            const lastProductActivityAt = productStats?.lastProductActivityAt
                ? new Date(productStats.lastProductActivityAt)
                : null;
            const lastSaleAt = salesStats?.lastSaleAt ? new Date(salesStats.lastSaleAt) : null;
            const hasRecentProductActivity = Boolean(
                lastProductActivityAt && lastProductActivityAt >= inactivityThreshold,
            );
            const hasRecentSalesActivity = Boolean(
                lastSaleAt && lastSaleAt >= inactivityThreshold,
            );

            return !hasRecentProductActivity && !hasRecentSalesActivity;
        }).length;
        const topPerformingVendors = approvedVendorDocs
            .map((vendorDoc) => {
                const vendorId = String(vendorDoc?._id || '');
                const rangeSales = vendorSalesRangeById.get(vendorId);

                if (!rangeSales || rangeSales.totalSalesAmount <= 0) {
                    return null;
                }

                const productStats = vendorProductStatsById.get(vendorId);
                const displayName = String(vendorDoc.businessName || '').trim()
                    || `${vendorDoc.firstName || ''} ${vendorDoc.lastName || ''}`.trim()
                    || vendorDoc.email
                    || 'Vendor';

                return {
                    vendorId,
                    vendorName: displayName,
                    businessName: vendorDoc.businessName || displayName,
                    email: vendorDoc.email || '',
                    totalSalesAmount: rangeSales.totalSalesAmount,
                    totalPlatformFees: rangeSales.totalPlatformFees,
                    paidOrders: rangeSales.paidOrders,
                    paidShipments: rangeSales.paidShipments,
                    totalProducts: Number(productStats?.totalProducts || 0),
                    activeProducts: Number(productStats?.activeProducts || 0),
                    lastSaleAt: rangeSales.lastSaleAt || null,
                };
            })
            .filter(Boolean)
            .sort((left, right) => {
                if (right.totalSalesAmount !== left.totalSalesAmount) {
                    return right.totalSalesAmount - left.totalSalesAmount;
                }

                return right.paidOrders - left.paidOrders;
            })
            .slice(0, 5);

        const purchasingCustomersInRange = Number(
            currentCustomerPurchaseSummary.purchasingCustomersInRange || 0,
        );
        const firstTimeCustomersInRange = Number(
            currentCustomerPurchaseSummary.firstTimeCustomersInRange || 0,
        );
        const repeatCustomersInRange = Number(
            currentCustomerPurchaseSummary.repeatCustomersInRange || 0,
        );
        const repeatCustomerRateInRange = purchasingCustomersInRange > 0
            ? toRoundedNumber((repeatCustomersInRange / purchasingCustomersInRange) * 100, 1)
            : 0;
        const firstPurchaseShareInRange = purchasingCustomersInRange > 0
            ? toRoundedNumber((firstTimeCustomersInRange / purchasingCustomersInRange) * 100, 1)
            : 0;

        const trends = {
            orderCountChangePercent: calculateChangePercent(
                currentRangeOrderCount,
                previousRangeOrderCount,
            ),
            paidOrdersChangePercent: calculateChangePercent(
                currentPaidOrderSummary.paidOrders,
                previousPaidOrderSummary.paidOrders,
            ),
            gmvChangePercent: calculateChangePercent(
                currentPaidOrderSummary.grossMerchandiseValue,
                previousPaidOrderSummary.grossMerchandiseValue,
            ),
            platformRevenueChangePercent: calculateChangePercent(
                currentPaidOrderSummary.platformRevenue,
                previousPaidOrderSummary.platformRevenue,
            ),
            averageOrderValueChangePercent: calculateChangePercent(
                currentPaidOrderSummary.averageOrderValue,
                previousPaidOrderSummary.averageOrderValue,
            ),
            newCustomersChangePercent: calculateChangePercent(
                newCustomersInRange,
                newCustomersInPreviousRange,
            ),
            purchasingCustomersChangePercent: calculateChangePercent(
                purchasingCustomersInRange,
                previousCustomerPurchaseSummary.purchasingCustomersInRange,
            ),
            firstTimeCustomersChangePercent: calculateChangePercent(
                firstTimeCustomersInRange,
                previousCustomerPurchaseSummary.firstTimeCustomersInRange,
            ),
            repeatCustomersChangePercent: calculateChangePercent(
                repeatCustomersInRange,
                previousCustomerPurchaseSummary.repeatCustomersInRange,
            ),
            vendorPayoutsCompletedChangePercent: calculateChangePercent(
                vendorPayoutsCompletedInRange.amount,
                vendorPayoutsCompletedInPreviousRange.amount,
            ),
            referralsSentChangePercent: calculateChangePercent(
                currentReferralPerformance.referralsSent,
                previousReferralPerformance.referralsSent,
            ),
            referralsConvertedChangePercent: calculateChangePercent(
                currentReferralPerformance.referralsConverted,
                previousReferralPerformance.referralsConverted,
            ),
            rewardCostTotalChangePercent: calculateChangePercent(
                currentReferralPerformance.rewardCostTotal,
                previousReferralPerformance.rewardCostTotal,
            ),
        };

        res.status(200).json({
            range: serializeAnalyticsRange(analyticsRange),
            lifetime: {
                registeredVendors,
                activeVendors,
                registeredCustomers,
                customersWithoutPurchases,
                customersWithPurchases,
                vendorsWithSales,
                customerPurchaseConversionRate,
                vendorActivationRate,
                vendorSalesParticipationRate,
                vendorQuality: {
                    vendorsWithZeroProducts,
                    vendorsWithProductsButNoSales,
                    activeVendorsWithNoSales,
                    vendorsInactive30Days,
                },
                referralPerformance: {
                    referralsSent: lifetimeReferralPerformance.totalReferralSignups,
                    referralsConverted: lifetimeReferralPerformance.totalRewardedReferrals,
                    rewardCostTotal: lifetimeReferralPerformance.totalRewardCost,
                    pendingReferrals: lifetimeReferralPerformance.pendingReferrals,
                },
            },
            period: {
                totalOrders: currentRangeOrderCount,
                paidOrders: currentPaidOrderSummary.paidOrders,
                grossMerchandiseValue: currentPaidOrderSummary.grossMerchandiseValue,
                platformRevenue: currentPaidOrderSummary.platformRevenue,
                averageOrderValue: currentPaidOrderSummary.averageOrderValue,
                newCustomers: newCustomersInRange,
                purchasingCustomers: purchasingCustomersInRange,
                firstTimeCustomers: firstTimeCustomersInRange,
                repeatCustomers: repeatCustomersInRange,
                repeatCustomerRate: repeatCustomerRateInRange,
                firstPurchaseShare: firstPurchaseShareInRange,
                vendorPayoutDueAmount: vendorPayoutDueSummary.amount,
                vendorPayoutDueShipments: vendorPayoutDueSummary.shipmentCount,
                vendorPayoutsCompleted: vendorPayoutsCompletedInRange.amount,
                vendorPayoutsCompletedShipments: vendorPayoutsCompletedInRange.shipmentCount,
                referralPerformance: {
                    referralsSent: currentReferralPerformance.referralsSent,
                    referralsConverted: currentReferralPerformance.referralsConverted,
                    rewardCostTotal: currentReferralPerformance.rewardCostTotal,
                },
            },
            previousPeriod: comparisonRange
                ? {
                    totalOrders: previousRangeOrderCount,
                    paidOrders: previousPaidOrderSummary.paidOrders,
                    grossMerchandiseValue: previousPaidOrderSummary.grossMerchandiseValue,
                    platformRevenue: previousPaidOrderSummary.platformRevenue,
                    averageOrderValue: previousPaidOrderSummary.averageOrderValue,
                    newCustomers: newCustomersInPreviousRange,
                    purchasingCustomers:
                        previousCustomerPurchaseSummary.purchasingCustomersInRange,
                    firstTimeCustomers:
                        previousCustomerPurchaseSummary.firstTimeCustomersInRange,
                    repeatCustomers: previousCustomerPurchaseSummary.repeatCustomersInRange,
                    vendorPayoutsCompleted: vendorPayoutsCompletedInPreviousRange.amount,
                    referralPerformance: {
                        referralsSent: previousReferralPerformance.referralsSent,
                        referralsConverted: previousReferralPerformance.referralsConverted,
                        rewardCostTotal: previousReferralPerformance.rewardCostTotal,
                    },
                }
                : null,
            vendorQuality: {
                vendorsWithZeroProducts,
                vendorsWithProductsButNoSales,
                activeVendorsWithNoSales,
                vendorsInactive30Days,
            },
            referralPerformance: {
                lifetime: {
                    referralsSent: lifetimeReferralPerformance.totalReferralSignups,
                    referralsConverted: lifetimeReferralPerformance.totalRewardedReferrals,
                    rewardCostTotal: lifetimeReferralPerformance.totalRewardCost,
                    pendingReferrals: lifetimeReferralPerformance.pendingReferrals,
                },
                current: {
                    referralsSent: currentReferralPerformance.referralsSent,
                    referralsConverted: currentReferralPerformance.referralsConverted,
                    rewardCostTotal: currentReferralPerformance.rewardCostTotal,
                },
                previous: comparisonRange
                    ? {
                        referralsSent: previousReferralPerformance.referralsSent,
                        referralsConverted: previousReferralPerformance.referralsConverted,
                        rewardCostTotal: previousReferralPerformance.rewardCostTotal,
                    }
                    : null,
            },
            trends,
            registeredVendors,
            activeVendors,
            registeredCustomers,
            customersWithoutPurchases,
            firstTimeCustomersWithoutPurchase: customersWithoutPurchases,
            customersWithPurchases,
            vendorsWithSales,
            customerPurchaseConversionRate,
            vendorActivationRate,
            vendorSalesParticipationRate,
            totalOrdersInRange: currentRangeOrderCount,
            paidOrdersInRange: currentPaidOrderSummary.paidOrders,
            grossMerchandiseValue: currentPaidOrderSummary.grossMerchandiseValue,
            platformRevenue: currentPaidOrderSummary.platformRevenue,
            averageOrderValue: currentPaidOrderSummary.averageOrderValue,
            newCustomersInRange,
            purchasingCustomersInRange,
            firstTimeCustomersInRange,
            repeatCustomersInRange,
            repeatCustomerRateInRange,
            firstPurchaseShareInRange,
            vendorPayoutDueAmount: vendorPayoutDueSummary.amount,
            vendorPayoutDueShipments: vendorPayoutDueSummary.shipmentCount,
            vendorPayoutsCompletedInRange: vendorPayoutsCompletedInRange.amount,
            vendorPayoutsCompletedShipmentsInRange: vendorPayoutsCompletedInRange.shipmentCount,
            previousTotalOrdersInRange: previousRangeOrderCount,
            previousPaidOrdersInRange: previousPaidOrderSummary.paidOrders,
            previousGrossMerchandiseValue: previousPaidOrderSummary.grossMerchandiseValue,
            previousPlatformRevenue: previousPaidOrderSummary.platformRevenue,
            previousAverageOrderValue: previousPaidOrderSummary.averageOrderValue,
            previousNewCustomersInRange: newCustomersInPreviousRange,
            previousPurchasingCustomersInRange:
                previousCustomerPurchaseSummary.purchasingCustomersInRange,
            previousFirstTimeCustomersInRange:
                previousCustomerPurchaseSummary.firstTimeCustomersInRange,
            previousRepeatCustomersInRange:
                previousCustomerPurchaseSummary.repeatCustomersInRange,
            vendorsWithZeroProducts,
            vendorsWithProductsButNoSales,
            activeVendorsWithNoSales,
            vendorsInactive30Days,
            referralsSentInRange: currentReferralPerformance.referralsSent,
            referralsConvertedInRange: currentReferralPerformance.referralsConverted,
            referralRewardCostTotalInRange: currentReferralPerformance.rewardCostTotal,
            totalReferralSignups: lifetimeReferralPerformance.totalReferralSignups,
            totalRewardedReferrals: lifetimeReferralPerformance.totalRewardedReferrals,
            totalReferralRewardCost: lifetimeReferralPerformance.totalRewardCost,
            pendingReferralConversions: lifetimeReferralPerformance.pendingReferrals,
            previousReferralsSentInRange: previousReferralPerformance.referralsSent,
            previousReferralsConvertedInRange: previousReferralPerformance.referralsConverted,
            previousReferralRewardCostTotalInRange:
                previousReferralPerformance.rewardCostTotal,
            topPerformingVendors,
        });
    } catch (error) {
        console.error('Error fetching customer/vendor metrics:', error);
        res.status(500).json({ message: 'Server error fetching customer/vendor metrics.' });
    }
});

// @desc    Get referral reward settings
// @route   GET /api/admin/referral-settings
// @access  Private (Admin only)
router.get('/referral-settings', protect, authorizeAdmin, async (req, res) => {
    try {
        const settings = await getReferralProgramSettings();

        res.status(200).json(buildReferralSettingsPayload(settings));
    } catch (error) {
        console.error('Error fetching referral settings:', error);
        res.status(500).json({ message: 'Server error fetching referral settings.' });
    }
});

// @desc    Update referral reward settings
// @route   PUT /api/admin/referral-settings
// @access  Private (Admin only)
router.put('/referral-settings', protect, authorizeAdmin, async (req, res) => {
    const parsedRewardAmount = Number.parseFloat(req.body?.referralRewardAmount);

    if (!Number.isFinite(parsedRewardAmount) || parsedRewardAmount < 0) {
        return res.status(400).json({
            message: 'referralRewardAmount must be a valid non-negative number.',
        });
    }

    try {
        const existingSettings = await AppSetting.findOne({ key: REFERRAL_SETTINGS_KEY }).select(
            'referralRewardAmount',
        );
        const currentAmount = existingSettings
            ? Number(existingSettings.referralRewardAmount || 0)
            : null;

        if (currentAmount !== null && currentAmount === parsedRewardAmount) {
            const settings = await getReferralProgramSettings();
            return res.status(200).json(
                buildReferralSettingsPayload(settings, 'Referral reward amount is unchanged.'),
            );
        }

        await AppSetting.findOneAndUpdate(
            { key: REFERRAL_SETTINGS_KEY },
            {
                $set: {
                    referralRewardAmount: parsedRewardAmount,
                    updatedBy: req.user._id,
                },
                $push: {
                    referralRewardHistory: {
                        previousAmount: currentAmount,
                        newAmount: parsedRewardAmount,
                        changedBy: req.user._id,
                        changedAt: new Date(),
                        source: 'admin_update',
                    },
                },
            },
            {
                upsert: true,
                setDefaultsOnInsert: true,
            },
        );

        const settings = await getReferralProgramSettings();

        res.status(200).json(
            buildReferralSettingsPayload(settings, 'Referral reward amount updated successfully.'),
        );
    } catch (error) {
        console.error('Error updating referral settings:', error);
        res.status(500).json({ message: 'Server error updating referral settings.' });
    }
});

// @desc    Get delivery fee settings
// @route   GET /api/admin/delivery-fee-settings
// @access  Private (Admin only)
router.get('/delivery-fee-settings', protect, authorizeAdmin, async (req, res) => {
    try {
        const settings = await getDeliveryFeeSettings();

        res.status(200).json(buildDeliveryFeeSettingsPayload(settings));
    } catch (error) {
        console.error('Error fetching delivery fee settings:', error);
        res.status(500).json({ message: 'Server error fetching delivery fee settings.' });
    }
});

// @desc    Update delivery fee settings
// @route   PUT /api/admin/delivery-fee-settings
// @access  Private (Admin only)
router.put('/delivery-fee-settings', protect, authorizeAdmin, async (req, res) => {
    const parsedFallbackRatePerKm = Number.parseFloat(req.body?.fallbackRatePerKm);
    const parsedMinimumDeliveryFee = Number.parseFloat(req.body?.minimumDeliveryFee);
    const providedZones = Array.isArray(req.body?.zones) ? req.body.zones : null;

    if (!Number.isFinite(parsedFallbackRatePerKm) || parsedFallbackRatePerKm < 0) {
        return res.status(400).json({
            message: 'fallbackRatePerKm must be a valid non-negative number.',
        });
    }

    if (!Number.isFinite(parsedMinimumDeliveryFee) || parsedMinimumDeliveryFee < 0) {
        return res.status(400).json({
            message: 'minimumDeliveryFee must be a valid non-negative number.',
        });
    }

    if (!providedZones || providedZones.length === 0) {
        return res.status(400).json({
            message: 'zones must be a non-empty array of delivery zone settings.',
        });
    }

    const normalizedZones = normalizeDeliveryFeeZones(providedZones);
    const uniqueZoneKeys = new Set(normalizedZones.map((zone) => zone.zoneKey));

    if (normalizedZones.length === 0 || uniqueZoneKeys.size !== normalizedZones.length) {
        return res.status(400).json({
            message: 'Each delivery zone must have a unique zoneKey and valid configuration.',
        });
    }

    try {
        const existingSettings = await AppSetting.findOne({ key: DELIVERY_FEE_SETTINGS_KEY }).select(
            'fallbackRatePerKm minimumDeliveryFee deliveryFeeZones',
        );

        const currentFallbackRatePerKm = existingSettings
            ? Number(existingSettings.fallbackRatePerKm || 0)
            : null;
        const currentMinimumDeliveryFee = existingSettings
            ? Number(existingSettings.minimumDeliveryFee || 0)
            : null;
        const currentZones = normalizeDeliveryFeeZones(existingSettings?.deliveryFeeZones || []);

        const isUnchanged =
            currentFallbackRatePerKm === parsedFallbackRatePerKm &&
            currentMinimumDeliveryFee === parsedMinimumDeliveryFee &&
            JSON.stringify(currentZones) === JSON.stringify(normalizedZones);

        if (isUnchanged) {
            const settings = await getDeliveryFeeSettings();
            return res.status(200).json(
                buildDeliveryFeeSettingsPayload(settings, 'Delivery fee settings are unchanged.'),
            );
        }

        await AppSetting.findOneAndUpdate(
            { key: DELIVERY_FEE_SETTINGS_KEY },
            {
                $set: {
                    fallbackRatePerKm: parsedFallbackRatePerKm,
                    minimumDeliveryFee: parsedMinimumDeliveryFee,
                    deliveryFeeZones: normalizedZones,
                    updatedBy: req.user._id,
                },
                $push: {
                    deliveryFeeHistory: {
                        fallbackRatePerKm: parsedFallbackRatePerKm,
                        minimumDeliveryFee: parsedMinimumDeliveryFee,
                        zones: normalizedZones,
                        changedBy: req.user._id,
                        changedAt: new Date(),
                        source: 'admin_update',
                    },
                },
            },
            {
                upsert: true,
                setDefaultsOnInsert: true,
            },
        );

        const settings = await getDeliveryFeeSettings();

        res.status(200).json(
            buildDeliveryFeeSettingsPayload(
                settings,
                'Delivery fee settings updated successfully.',
            ),
        );
    } catch (error) {
        console.error('Error updating delivery fee settings:', error);
        res.status(500).json({ message: 'Server error updating delivery fee settings.' });
    }
});

// @desc    Get pharmacist chat subscription settings
// @route   GET /api/admin/pharmacist-subscription-settings
// @access  Private (Admin only)
router.get('/pharmacist-subscription-settings', protect, authorizeAdmin, async (req, res) => {
    try {
        const settings = await getPharmacySubscriptionSettings();
        res.status(200).json(buildPharmacySubscriptionSettingsPayload(settings));
    } catch (error) {
        console.error('Error fetching pharmacist subscription settings:', error);
        res.status(500).json({ message: 'Server error fetching pharmacist subscription settings.' });
    }
});

// @desc    Update pharmacist chat subscription prices
// @route   PUT /api/admin/pharmacist-subscription-settings
// @access  Private (Admin only)
router.put('/pharmacist-subscription-settings', protect, authorizeAdmin, async (req, res) => {
    try {
        const { plans } = req.body;

        if (!Array.isArray(plans)) {
            return res.status(400).json({ message: 'Plans must be an array.' });
        }

        const settings = await updatePharmacySubscriptionSettings({
            plans,
            adminId: req.user._id,
        });

        res.status(200).json(
            buildPharmacySubscriptionSettingsPayload(
                settings,
                'Pharmacist subscription settings updated successfully.',
            ),
        );
    } catch (error) {
        console.error('Error updating pharmacist subscription settings:', error);
        res.status(500).json({ message: 'Server error updating pharmacist subscription settings.' });
    }
});

// @desc    Get all vendor requests (users with vendorStatus 'sent', 'received', 'reviewing')
// @route   GET /api/admin/vendor-requests
// @access  Private (Admin only)
router.get('/vendor-requests', protect, authorizeAdmin, async (req, res) => {
    try {
        // Find users who have submitted a vendor request and are not yet approved/rejected
        const vendorRequests = await User.find({
            vendorStatus: { $in: ['sent', 'received', 'reviewing'] }
        }).select('-password -emailVerificationToken -deviceVerificationToken -passwordResetToken'); // Exclude sensitive fields

        res.status(200).json(vendorRequests);
    } catch (error) {
        console.error('Error fetching vendor requests:', error);
        res.status(500).json({ message: 'Server error fetching vendor requests.' });
    }
});

// @desc    Update a user's vendor status (approve/reject)
// @route   PUT /api/admin/vendor-status/:userId
// @access  Private (Admin only)
router.put('/vendor-status/:userId', protect, authorizeAdmin, async (req, res) => {
    const { userId } = req.params;
    const { status } = req.body; // Expected status: 'approved' or 'rejected'

    // Validate the status input
    if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status provided. Must be "approved" or "rejected".' });
    }

    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Update the vendor status
        user.vendorStatus = status;

        if (status === 'approved') {
            user.isVendor = true; // Mark as a vendor
            user.vendorRejectionDate = undefined; // Clear any previous rejection date
        } else if (status === 'rejected') {
            user.isVendor = false; // Ensure not marked as a vendor
            user.vendorRejectionDate = Date.now(); // Record rejection date for cooldown
        }

        await user.save();

        res.status(200).json({
            message: `Vendor status for ${user.email} updated to ${status}.`,
            userId: user._id,
            vendorStatus: user.vendorStatus,
            isVendor: user.isVendor,
            vendorRejectionDate: user.vendorRejectionDate,
        });

    } catch (error) {
        console.error('Error updating vendor status:', error);
        res.status(500).json({ message: 'Server error updating vendor status.' });
    }
});

// @desc    Get all pharmacist approval requests
// @route   GET /api/admin/pharmacist-requests
// @access  Private (Admin only)
router.get('/pharmacist-requests', protect, authorizeAdmin, async (req, res) => {
    try {
        const pharmacistRequests = await User.find({
            pharmacistStatus: { $in: ['sent', 'received', 'reviewing'] }
        }).select('-password -emailVerificationToken -deviceVerificationToken -passwordResetToken');

        res.status(200).json(pharmacistRequests);
    } catch (error) {
        console.error('Error fetching pharmacist requests:', error);
        res.status(500).json({ message: 'Server error fetching pharmacist requests.' });
    }
});

// @desc    Update pharmacist approval status
// @route   PUT /api/admin/pharmacist-status/:userId
// @access  Private (Admin only)
router.put('/pharmacist-status/:userId', protect, authorizeAdmin, async (req, res) => {
    const { userId } = req.params;
    const { status } = req.body;

    if (!['approved', 'rejected', 'received', 'reviewing'].includes(status)) {
        return res.status(400).json({
            message: 'Invalid status provided. Must be approved, rejected, received, or reviewing.'
        });
    }

    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        if (!user.isVendor || user.vendorStatus !== 'approved') {
            return res.status(400).json({
                message: 'User must be an approved vendor before pharmacist approval.'
            });
        }

        user.pharmacistStatus = status;

        if (status === 'approved') {
            user.role = 'pharmacist';
            user.pharmacistRejectionDate = undefined;
        } else if (status === 'rejected') {
            user.role = 'user';
            user.pharmacistRejectionDate = Date.now();
        }

        user.notifications.push({
            type: 'vendor_status_update',
            message: status === 'approved'
                ? 'Your pharmacist vendor approval is complete. Pharmacy tools are now available.'
                : status === 'rejected'
                ? 'Your pharmacist vendor approval request was not approved.'
                : `Your pharmacist approval status is now ${status}.`,
            relatedModel: 'User',
            relatedId: user._id,
        });

        await user.save();

        res.status(200).json({
            message: `Pharmacist status for ${user.email} updated to ${status}.`,
            userId: user._id,
            pharmacistStatus: user.pharmacistStatus,
            isPharmacist: user.role === 'pharmacist',
        });
    } catch (error) {
        console.error('Error updating pharmacist status:', error);
        res.status(500).json({ message: 'Server error updating pharmacist status.' });
    }
});

// @desc    Get all disputes
// @route   GET /api/admin/disputes
// @access  Private (Admin only)
router.get('/disputes', protect, authorizeAdmin, async (req, res) => {
    try {
        const disputes = await Dispute.find({})
            .populate('user', 'firstName lastName email')
            .populate('order', 'totalPrice _id');
        res.status(200).json(disputes);
    } catch (error) {
        console.error('Error fetching disputes:', error);
        res.status(500).json({ message: 'Server error fetching disputes.' });
    }
});

// @desc    Send a message to a dispute chat
// @route   POST /api/admin/disputes/:disputeId/message
// @access  Private (Admin only)
router.post('/disputes/:disputeId/message', protect, authorizeAdmin, async (req, res) => {
    const { disputeId } = req.params;
    const { text } = req.body;

    if (!text) {
        return res.status(400).json({ message: 'Message text is required.' });
    }

    try {
        const dispute = await Dispute.findById(disputeId);
        if (!dispute) {
            return res.status(404).json({ message: 'Dispute not found.' });
        }

        const newMessage = {
            sender: req.user._id,
            senderType: 'Admin',
            text,
        };

        dispute.messages.push(newMessage);
        await dispute.save();

        res.status(200).json({ message: 'Message sent successfully.', newMessage });
    } catch (error) {
        console.error('Error sending message to dispute:', error);
        res.status(500).json({ message: 'Server error sending message.' });
    }
});

// @desc    Update dispute status
// @route   PUT /api/admin/disputes/:disputeId/status
// @access  Private (Admin only)
router.put('/disputes/:disputeId/status', protect, authorizeAdmin, async (req, res) => {
    const { disputeId } = req.params;
    const { status } = req.body;

    if (!['pending', 'resolved'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status provided. Must be "pending" or "resolved".' });
    }

    try {
        const dispute = await Dispute.findById(disputeId);
        if (!dispute) {
            return res.status(404).json({ message: 'Dispute not found.' });
        }
        
        dispute.status = status;
        await dispute.save();

        res.status(200).json({ message: `Dispute status updated to ${status}.` });
    } catch (error) {
        console.error('Error updating dispute status:', error);
        res.status(500).json({ message: 'Server error updating dispute status.' });
    }
});



// --- New Rider Management Routes ---

// @desc    Get all pending rider applications
// @route   GET /api/admin/riders/pending
// @access  Private (Admin only)
router.get('/riders/pending', protect, authorizeAdmin, async (req, res) => {
    try {
        // Find riders where status is 'pending'
        const pendingRiders = await Rider.find({ status: 'pending' }).select('-password');
        res.status(200).json(pendingRiders);
    } catch (error) {
        console.error('Error fetching rider requests:', error);
        res.status(500).json({ message: 'Server error fetching rider requests.' });
    }
});

// @desc    Update rider status (approve/reject)
// @route   PUT /api/admin/riders/:riderId/status
// @access  Private (Admin only)
router.put('/riders/:riderId/status', protect, authorizeAdmin, async (req, res) => {
    const { riderId } = req.params;
    const { status } = req.body; 

    if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status. Use "approved" or "rejected".' });
    }

    try {
        const rider = await Rider.findById(riderId);
        if (!rider) return res.status(404).json({ message: 'Rider not found.' });

        rider.status = status;
        
        if (status === 'approved') {
            rider.isVerified = true;
            rider.rejectionReason = undefined; 
        } else if (status === 'rejected') {
            rider.isVerified = false;
            // SETTING YOUR DEFAULT REASON HERE
            rider.rejectionReason = "Photo was blurry or the documents are invalid. Please re-upload clear documents.";
        }

        await rider.save();

        // Trigger the email notification
        await sendVerificationEmail(rider.email, null, 'rider_status', { 
            status: status, 
            reason: rider.rejectionReason 
        });

        res.status(200).json({ 
            message: `Rider ${rider.fullName} has been ${status} and notified.`,
            status: rider.status 
        });
    } catch (error) {
        console.error('Admin status update error:', error);
        res.status(500).json({ message: 'Server error updating rider status.' });
    }
});
module.exports = router;
