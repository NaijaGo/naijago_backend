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
const AdminScheduledNotification = require('../models/AdminScheduledNotification');
const AdminNotificationTemplate = require('../models/AdminNotificationTemplate');
const MarketingContactList = require('../models/MarketingContactList');
const AnalyticsEvent = require('../models/AnalyticsEvent');
const CompanyRider = require('../models/CompanyRider');
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
    getPharmacySubscribers,
    updatePharmacySubscriptionSettings,
} = require('../services/pharmacySubscriptionService');
const { sendVerificationEmail } = require('../utils/emailHelper');
const {
    findEligibleRiders,
    notifyAssignedRider,
} = require('../services/riderAssignmentService');
const { sendMarketingCampaign } = require('../services/marketingCampaignService');
const {
    ADMIN_NOTIFICATION_SEGMENTS: SERVICE_NOTIFICATION_SEGMENTS,
    exportRecipients,
    normalizeRecipientIds,
    recipientCounts,
    resolveNotificationSegment: resolveAdminNotificationSegment,
    sendAdminInAppNotification,
} = require('../services/adminNotificationService');

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
const CUSTOMER_CONTACT_FILTER = {
    isAdmin: { $ne: true },
    isVendor: { $ne: true },
    role: { $ne: 'admin' },
    $or: [
        { vendorStatus: { $exists: false } },
        { vendorStatus: null },
        { vendorStatus: 'none' },
    ],
};
const VENDOR_CONTACT_FILTER = {
    role: { $ne: 'admin' },
    $or: [
        { isVendor: true },
        { vendorStatus: { $nin: [null, 'none'] } },
        { businessName: { $exists: true, $ne: '' } },
    ],
};
const BUILT_IN_MARKETING_LISTS = [
    { id: 'segment:all_customers', name: 'All Customers', audience: 'customers', segment: 'all_customers' },
    { id: 'segment:customers_with_orders', name: 'Customers With Orders', audience: 'customers', segment: 'customers_with_orders' },
    { id: 'segment:customers_without_orders', name: 'Customers Without Orders', audience: 'customers', segment: 'customers_without_orders' },
    { id: 'segment:active_subscribers', name: 'Active Subscribers', audience: 'customers', segment: 'active_subscribers' },
    { id: 'segment:all_vendors', name: 'All Vendors', audience: 'vendors', segment: 'all_vendors' },
    { id: 'segment:approved_vendors', name: 'Approved Vendors', audience: 'vendors', segment: 'approved_vendors' },
    { id: 'segment:pending_vendors', name: 'Pending Vendors', audience: 'vendors', segment: 'pending_vendors' },
    { id: 'segment:suspended_vendors', name: 'Suspended Vendors', audience: 'vendors', segment: 'suspended_vendors' },
    { id: 'segment:all_riders', name: 'All Riders', audience: 'riders', segment: 'all_riders' },
    { id: 'segment:approved_riders', name: 'Approved Riders', audience: 'riders', segment: 'approved_riders' },
    { id: 'segment:pending_riders', name: 'Pending Riders', audience: 'riders', segment: 'pending_riders' },
    { id: 'segment:suspended_riders', name: 'Suspended Riders', audience: 'riders', segment: 'suspended_riders' },
    { id: 'segment:all', name: 'All Customers, Vendors, and Riders', audience: 'mixed', segment: 'all' },
];

const parsePagination = (query, defaults = {}) => {
    const maxLimit = defaults.maxLimit || 500;
    const defaultLimit = defaults.defaultLimit || 100;
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const requestedLimit = parseInt(query.limit, 10) || defaultLimit;
    const limit = Math.min(Math.max(requestedLimit, 1), maxLimit);
    return { page, limit, skip: (page - 1) * limit };
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

const normalizeUserContact = (user, type) => ({
    id: user._id,
    type,
    name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.businessName || user.email || 'Unnamed contact',
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    email: user.email || '',
    phoneNumber: user.phoneNumber || '',
    status: type === 'vendor' ? (user.vendorStatus || 'none') : (user.role || 'user'),
    businessName: user.businessName || '',
    businessCategories: user.businessCategories || [],
    businessWhatsAppNumber: user.businessWhatsAppNumber || '',
    businessSupportPhone: user.businessSupportPhone || '',
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
});

const normalizeRiderContact = (rider, source = 'individual') => ({
    id: rider._id,
    type: 'rider',
    source,
    name: rider.fullName || rider.email || 'Unnamed rider',
    email: rider.email || '',
    phoneNumber: rider.phoneNumber || '',
    status: rider.status || 'pending',
    plateNumber: rider.plateNumber || '',
    vehicleType: rider.vehicleType || '',
    isActive: rider.isActive === true,
    isAvailable: rider.isAvailable === true,
    walletBalance: rider.walletBalance || 0,
    totalEarnings: rider.totalEarnings || rider.stats?.totalEarnings || 0,
    totalWithdrawn: rider.totalWithdrawn || 0,
    activeDeliveries: rider.activeDeliveries || rider.stats?.activeDeliveries || 0,
    completedDeliveries: rider.completedDeliveries || rider.stats?.completedDeliveries || 0,
    rating: rider.rating || rider.stats?.averageRating || 0,
    cancellationRate: rider.cancellationRate || 0,
    companyName: rider.company?.companyName || rider.company?.name || '',
    createdAt: rider.createdAt || rider.joinedAt,
    updatedAt: rider.updatedAt || rider.lastActivity,
});

const buildVendorOperationPayload = ({
    vendor,
    productStats,
    salesStats,
    payoutDue,
}) => ({
    id: vendor._id,
    name: `${vendor.firstName || ''} ${vendor.lastName || ''}`.trim() || vendor.businessName || vendor.email || 'Unnamed vendor',
    firstName: vendor.firstName || '',
    lastName: vendor.lastName || '',
    email: vendor.email || '',
    phoneNumber: vendor.phoneNumber || '',
    role: vendor.role || 'user',
    pharmacistStatus: vendor.pharmacistStatus || 'none',
    status: vendor.vendorStatus || 'none',
    isVendor: vendor.isVendor === true,
    businessName: vendor.businessName || '',
    businessCategories: vendor.businessCategories || [],
    businessWhatsAppNumber: vendor.businessWhatsAppNumber || '',
    businessSupportPhone: vendor.businessSupportPhone || '',
    isTemporarilyClosed: vendor.isTemporarilyClosed === true,
    temporaryClosureReason: vendor.temporaryClosureReason || '',
    vendorWalletBalance: vendor.vendorWalletBalance || 0,
    appWalletBalance: vendor.appWalletBalance || 0,
    modelTotalProducts: vendor.totalProducts || 0,
    modelProductsSold: vendor.productsSold || 0,
    modelProductsUnsold: vendor.productsUnsold || 0,
    followersCount: vendor.followersCount || 0,
    totalProducts: productStats?.totalProducts || 0,
    activeProducts: productStats?.activeProducts || 0,
    totalSalesAmount: salesStats?.totalSalesAmount || 0,
    totalPlatformFees: salesStats?.totalPlatformFees || 0,
    paidShipments: salesStats?.paidShipments || 0,
    paidOrders: salesStats?.paidOrders || 0,
    payoutDueAmount: payoutDue?.amount || 0,
    payoutDueShipments: payoutDue?.shipmentCount || 0,
    lastSaleAt: salesStats?.lastSaleAt || null,
    lastProductActivityAt: productStats?.lastProductActivityAt || null,
    createdAt: vendor.createdAt,
    updatedAt: vendor.updatedAt,
});

const USER_NOTIFICATION_TYPES = new Set([
    'product_sold',
    'payment_received',
    'wallet_deposit',
    'wallet_withdrawal',
    'referral_reward',
    'vendor_status_update',
    'general',
    'admin_message',
    'order_update',
    'delivery_payout',
    'new_order',
    'order_shipped',
    'order_delivered',
]);

const RIDER_NOTIFICATION_TYPES = new Set([
    'product_sold',
    'payment_received',
    'wallet_deposit',
    'wallet_withdrawal',
    'vendor_status_update',
    'general',
    'admin_message',
    'order_update',
    'delivery_payout',
]);

const normalizeNotificationType = (type, allowedTypes) => {
    const normalized = String(type || 'admin_message').trim().toLowerCase();
    return allowedTypes.has(normalized) ? normalized : 'admin_message';
};

const ADMIN_NOTIFICATION_SEGMENTS = new Set([
    'all_customers',
    'customers_with_orders',
    'customers_without_orders',
    'active_subscribers',
    'all_vendors',
    'approved_vendors',
    'pending_vendors',
    'suspended_vendors',
    'all_riders',
    'approved_riders',
    'pending_riders',
    'suspended_riders',
    'all',
]);

const resolveNotificationSegment = async (segment, recipientIds = []) => {
    const normalizedSegment = ADMIN_NOTIFICATION_SEGMENTS.has(segment)
        ? segment
        : 'all_customers';
    const explicitIds = recipientIds.filter(Boolean);
    const result = {
        segment: normalizedSegment,
        customers: [],
        vendors: [],
        riders: [],
    };

    const applyIds = (query) => {
        if (!explicitIds.length) return query;
        return { ...query, _id: { $in: explicitIds } };
    };

    if (normalizedSegment === 'all' || normalizedSegment === 'all_customers') {
        result.customers = await User.find(applyIds({ ...CUSTOMER_CONTACT_FILTER }))
            .select('_id')
            .lean();
    }

    if (normalizedSegment === 'customers_with_orders') {
        const purchasingCustomerIds = await MainOrder.distinct('user', { isPaid: true });
        result.customers = await User.find(
            applyIds({ ...CUSTOMER_CONTACT_FILTER, _id: { $in: purchasingCustomerIds } }),
        ).select('_id').lean();
    }

    if (normalizedSegment === 'customers_without_orders') {
        const purchasingCustomerIds = await MainOrder.distinct('user', { isPaid: true });
        result.customers = await User.find(
            applyIds({ ...CUSTOMER_CONTACT_FILTER, _id: { $nin: purchasingCustomerIds } }),
        ).select('_id').lean();
    }

    if (normalizedSegment === 'active_subscribers') {
        result.customers = await User.find(
            applyIds({
                ...CUSTOMER_CONTACT_FILTER,
                'naijagoSubscription.status': 'active',
                'naijagoSubscription.expiresAt': { $gt: new Date() },
            }),
        ).select('_id').lean();
    }

    if (normalizedSegment === 'all' || normalizedSegment === 'all_vendors') {
        result.vendors = await User.find(applyIds({ ...VENDOR_CONTACT_FILTER }))
            .select('_id')
            .lean();
    }

    if (normalizedSegment === 'approved_vendors') {
        result.vendors = await User.find(
            applyIds({ ...VENDOR_CONTACT_FILTER, vendorStatus: 'approved' }),
        ).select('_id').lean();
    }

    if (normalizedSegment === 'pending_vendors') {
        result.vendors = await User.find(
            applyIds({ vendorStatus: { $in: ['sent', 'received', 'reviewing'] } }),
        ).select('_id').lean();
    }

    if (normalizedSegment === 'suspended_vendors') {
        result.vendors = await User.find(
            applyIds({ ...VENDOR_CONTACT_FILTER, vendorStatus: 'suspended' }),
        ).select('_id').lean();
    }

    if (normalizedSegment === 'all' || normalizedSegment === 'all_riders') {
        result.riders = await Rider.find(applyIds({})).select('_id').lean();
    }

    if (normalizedSegment === 'approved_riders') {
        result.riders = await Rider.find(applyIds({ status: 'approved' })).select('_id').lean();
    }

    if (normalizedSegment === 'pending_riders') {
        result.riders = await Rider.find(applyIds({ status: 'pending' })).select('_id').lean();
    }

    if (normalizedSegment === 'suspended_riders') {
        result.riders = await Rider.find(applyIds({ status: 'suspended' })).select('_id').lean();
    }

    return result;
};

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

const marketingListIdToSegment = (id) => {
    const value = String(id || '').trim();
    if (!value.startsWith('segment:')) return null;

    const segment = value.slice('segment:'.length);
    return SERVICE_NOTIFICATION_SEGMENTS.has(segment) ? segment : null;
};

const marketingContactFromExport = (contact) => ({
    name: contact.name || contact.businessName || contact.email || contact.phoneNumber || '',
    email: contact.email || '',
    phoneNumber:
        contact.type === 'vendor'
            ? contact.businessWhatsAppNumber || contact.businessSupportPhone || contact.phoneNumber || ''
            : contact.phoneNumber || '',
    type: ['customer', 'vendor', 'rider'].includes(contact.type) ? contact.type : 'other',
    source: `segment:${contact.type || 'contact'}`,
});

const buildMarketingListFromSegment = async (segment) => {
    const definition = BUILT_IN_MARKETING_LISTS.find((list) => list.segment === segment);
    if (!definition) return null;

    const recipients = await resolveAdminNotificationSegment(segment);
    const contacts = exportRecipients(recipients)
        .map(marketingContactFromExport)
        .filter((contact) => contact.email || contact.phoneNumber);

    return {
        _id: definition.id,
        id: definition.id,
        name: definition.name,
        audience: definition.audience,
        contacts,
        contactCount: contacts.length,
        source: 'built_in_segment',
        segment,
        createdAt: null,
        updatedAt: null,
    };
};

const summarizeBuiltInMarketingLists = async () => {
    const summaries = await Promise.all(
        BUILT_IN_MARKETING_LISTS.map(async (definition) => {
            const list = await buildMarketingListFromSegment(definition.segment);
            if (!list) return null;
            const { contacts, ...summary } = list;
            return summary;
        }),
    );

    return summaries.filter((list) => list && list.contactCount > 0);
};

// --- Admin Routes ---

router.get('/product-moderation', protect, authorizeAdmin, async (req, res) => {
    try {
        const { limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 300 });
        const status = req.query.status || 'pending';
        const products = await Product.find({ moderationStatus: status })
            .populate('vendor', 'businessName phoneNumber businessLocation')
            .sort({ updatedAt: -1, createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();
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

router.get('/contacts/customers', protect, authorizeAdmin, async (req, res) => {
    try {
        const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 500, maxLimit: 5000 });
        const search = String(req.query.search || '').trim();
        const query = { ...CUSTOMER_CONTACT_FILTER };
        if (search) {
            query.$and = [
                {
                    $or: [
                        { firstName: { $regex: search, $options: 'i' } },
                        { lastName: { $regex: search, $options: 'i' } },
                        { email: { $regex: search, $options: 'i' } },
                        { phoneNumber: { $regex: search, $options: 'i' } },
                    ],
                },
            ];
        }

        const [customers, total] = await Promise.all([
            User.find(query)
                .select('firstName lastName email phoneNumber role createdAt updatedAt')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            User.countDocuments(query),
        ]);

        res.status(200).json({
            type: 'customers',
            count: total,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
            contacts: customers.map((user) => normalizeUserContact(user, 'customer')),
        });
    } catch (error) {
        console.error('Error fetching customer contacts:', error);
        res.status(500).json({ message: 'Failed to fetch customer contacts.' });
    }
});

router.get('/contacts/vendors', protect, authorizeAdmin, async (req, res) => {
    try {
        const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 500, maxLimit: 5000 });
        const status = String(req.query.status || 'all').trim().toLowerCase();
        const search = String(req.query.search || '').trim();
        const query = { ...VENDOR_CONTACT_FILTER };

        if (status !== 'all') {
            query.vendorStatus = status;
        }

        if (search) {
            query.$and = [
                {
                    $or: [
                        { firstName: { $regex: search, $options: 'i' } },
                        { lastName: { $regex: search, $options: 'i' } },
                        { email: { $regex: search, $options: 'i' } },
                        { phoneNumber: { $regex: search, $options: 'i' } },
                        { businessName: { $regex: search, $options: 'i' } },
                    ],
                },
            ];
        }

        const [vendors, total] = await Promise.all([
            User.find(query)
                .select('firstName lastName email phoneNumber vendorStatus isVendor businessName businessCategories businessWhatsAppNumber businessSupportPhone createdAt updatedAt')
                .sort({ vendorStatus: 1, createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            User.countDocuments(query),
        ]);

        res.status(200).json({
            type: 'vendors',
            count: total,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
            contacts: vendors.map((user) => normalizeUserContact(user, 'vendor')),
        });
    } catch (error) {
        console.error('Error fetching vendor contacts:', error);
        res.status(500).json({ message: 'Failed to fetch vendor contacts.' });
    }
});

router.get('/vendors/operations', protect, authorizeAdmin, async (req, res) => {
    try {
        const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 200, maxLimit: 1000 });
        const status = String(req.query.status || 'all').trim().toLowerCase();
        const search = String(req.query.search || '').trim();
        const query = { ...VENDOR_CONTACT_FILTER };

        if (status !== 'all') {
            query.vendorStatus = status;
        }

        if (search) {
            query.$and = [
                {
                    $or: [
                        { firstName: { $regex: search, $options: 'i' } },
                        { lastName: { $regex: search, $options: 'i' } },
                        { email: { $regex: search, $options: 'i' } },
                        { phoneNumber: { $regex: search, $options: 'i' } },
                        { businessName: { $regex: search, $options: 'i' } },
                    ],
                },
            ];
        }

        const [
            vendors,
            total,
            productStats,
            salesStats,
            payoutDueStats,
        ] = await Promise.all([
            User.find(query)
                .select('firstName lastName email phoneNumber role pharmacistStatus vendorStatus isVendor businessName businessCategories businessWhatsAppNumber businessSupportPhone isTemporarilyClosed temporaryClosureReason vendorWalletBalance appWalletBalance totalProducts productsSold productsUnsold followersCount createdAt updatedAt')
                .sort({ vendorStatus: 1, createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            User.countDocuments(query),
            getVendorProductStats(),
            getVendorSalesSummary(buildAnalyticsRange('all')),
            Shipment.aggregate([
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
                        _id: '$vendor',
                        shipmentCount: { $sum: 1 },
                        amount: {
                            $sum: {
                                $cond: [
                                    {
                                        $gt: [
                                            {
                                                $subtract: [
                                                    { $ifNull: ['$subtotal', 0] },
                                                    { $ifNull: ['$platformFee', 0] },
                                                ],
                                            },
                                            0,
                                        ],
                                    },
                                    {
                                        $subtract: [
                                            { $ifNull: ['$subtotal', 0] },
                                            { $ifNull: ['$platformFee', 0] },
                                        ],
                                    },
                                    0,
                                ],
                            },
                        },
                    },
                },
            ]),
        ]);

        const productStatsByVendor = new Map(
            productStats.map((entry) => [entry.vendorId, entry]),
        );
        const salesStatsByVendor = new Map(
            salesStats.map((entry) => [entry.vendorId, entry]),
        );
        const payoutDueByVendor = new Map(
            payoutDueStats.map((entry) => [
                String(entry._id || ''),
                {
                    shipmentCount: Number(entry.shipmentCount || 0),
                    amount: toRoundedNumber(entry.amount || 0),
                },
            ]),
        );

        const operations = vendors.map((vendor) => {
            const vendorId = String(vendor._id || '');
            return buildVendorOperationPayload({
                vendor,
                productStats: productStatsByVendor.get(vendorId),
                salesStats: salesStatsByVendor.get(vendorId),
                payoutDue: payoutDueByVendor.get(vendorId),
            });
        });

        res.status(200).json({
            count: total,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
            vendors: operations,
            totals: {
                vendors: total,
                approved: operations.filter((vendor) => vendor.status === 'approved').length,
                suspended: operations.filter((vendor) => vendor.status === 'suspended').length,
                activeProducts: operations.reduce((sum, vendor) => sum + Number(vendor.activeProducts || 0), 0),
                totalSalesAmount: toRoundedNumber(
                    operations.reduce((sum, vendor) => sum + Number(vendor.totalSalesAmount || 0), 0),
                ),
                payoutDueAmount: toRoundedNumber(
                    operations.reduce((sum, vendor) => sum + Number(vendor.payoutDueAmount || 0), 0),
                ),
            },
        });
    } catch (error) {
        console.error('Error fetching vendor operations:', error);
        res.status(500).json({ message: 'Failed to fetch vendor operations.' });
    }
});

router.get('/contacts/riders', protect, authorizeAdmin, async (req, res) => {
    try {
        const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 500, maxLimit: 5000 });
        const status = String(req.query.status || 'all').trim().toLowerCase();
        const source = String(req.query.source || 'all').trim().toLowerCase();
        const search = String(req.query.search || '').trim();
        const riderQuery = {};
        const companyRiderQuery = {};

        if (status !== 'all') {
            riderQuery.status = status;
            companyRiderQuery.status = status;
        }

        if (search) {
            const searchClause = {
                $or: [
                    { fullName: { $regex: search, $options: 'i' } },
                    { email: { $regex: search, $options: 'i' } },
                    { phoneNumber: { $regex: search, $options: 'i' } },
                    { plateNumber: { $regex: search, $options: 'i' } },
                ],
            };
            riderQuery.$and = [searchClause];
            companyRiderQuery.$and = [searchClause];
        }

        const combinedSourceFetchLimit = source === 'all' ? skip + limit : limit;
        const [individualRiders, companyRiders, individualTotal, companyTotal] = await Promise.all([
            source === 'company'
                ? []
                : Rider.find(riderQuery)
                    .select('fullName email phoneNumber status plateNumber vehicleType isActive isAvailable walletBalance totalEarnings totalWithdrawn activeDeliveries completedDeliveries cancellationRate rating createdAt updatedAt')
                    .sort({ status: 1, createdAt: -1 })
                    .skip(source === 'all' ? 0 : skip)
                    .limit(combinedSourceFetchLimit)
                    .lean(),
            source === 'individual'
                ? []
                : CompanyRider.find(companyRiderQuery)
                    .populate('company', 'companyName name')
                    .select('fullName email phoneNumber status plateNumber vehicleType isActive isAvailable stats joinedAt lastActivity createdAt updatedAt company')
                    .sort({ status: 1, createdAt: -1 })
                    .skip(source === 'all' ? 0 : skip)
                    .limit(combinedSourceFetchLimit)
                    .lean(),
            source === 'company' ? Promise.resolve(0) : Rider.countDocuments(riderQuery),
            source === 'individual' ? Promise.resolve(0) : CompanyRider.countDocuments(companyRiderQuery),
        ]);

        const contacts = [
            ...individualRiders.map((rider) => normalizeRiderContact(rider, 'individual')),
            ...companyRiders.map((rider) => normalizeRiderContact(rider, 'company')),
        ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
            .slice(source === 'all' ? skip : 0, source === 'all' ? skip + limit : limit);
        const total = individualTotal + companyTotal;

        res.status(200).json({
            type: 'riders',
            count: total,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
            contacts,
        });
    } catch (error) {
        console.error('Error fetching rider contacts:', error);
        res.status(500).json({ message: 'Failed to fetch rider contacts.' });
    }
});

router.get('/notification-logs', protect, authorizeAdmin, async (req, res) => {
    try {
        const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 200 });
        const filter = {};
        if (req.query.channel) filter.channel = req.query.channel;
        if (req.query.status) filter.status = req.query.status;
        if (req.query.eventType) filter.eventType = req.query.eventType;
        if (req.query.vendorId) filter.vendor = req.query.vendorId;
        if (req.query.shipmentId) filter.shipment = req.query.shipmentId;
        if (req.query.orderId) filter.order = req.query.orderId;

        const [logs, total] = await Promise.all([
            NotificationLog.find(filter)
                .populate('vendor', 'businessName firstName lastName phoneNumber')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            NotificationLog.countDocuments(filter),
        ]);

        res.status(200).json({
            count: total,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
            logs,
        });
    } catch (error) {
        console.error('Error fetching notification logs:', error);
        res.status(500).json({ message: 'Failed to fetch notification logs.' });
    }
});

router.get('/notification-stats', protect, authorizeAdmin, async (req, res) => {
    try {
        const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
        const since = new Date(Date.now() - days * DAY_IN_MS);
        const logMatch = { createdAt: { $gte: since } };
        const [logStats, scheduledStats, customerReadStats, riderReadStats] = await Promise.all([
            NotificationLog.aggregate([
                { $match: logMatch },
                {
                    $group: {
                        _id: {
                            channel: '$channel',
                            status: '$status',
                            eventType: '$eventType',
                        },
                        count: { $sum: 1 },
                    },
                },
            ]),
            AdminScheduledNotification.aggregate([
                {
                    $group: {
                        _id: '$status',
                        count: { $sum: 1 },
                    },
                },
            ]),
            User.aggregate([
                { $unwind: '$notifications' },
                { $match: { 'notifications.createdAt': { $gte: since } } },
                {
                    $group: {
                        _id: {
                            read: '$notifications.read',
                            type: {
                                $cond: [
                                    { $eq: ['$isVendor', true] },
                                    'vendor',
                                    'customer',
                                ],
                            },
                        },
                        count: { $sum: 1 },
                    },
                },
            ]),
            Rider.aggregate([
                { $unwind: '$notifications' },
                { $match: { 'notifications.createdAt': { $gte: since } } },
                {
                    $group: {
                        _id: { read: '$notifications.read', type: 'rider' },
                        count: { $sum: 1 },
                    },
                },
            ]),
        ]);

        const delivery = {
            sent: 0,
            failed: 0,
            skipped: 0,
            byChannel: {},
            byEventType: {},
        };

        logStats.forEach((entry) => {
            const status = entry._id.status || 'unknown';
            const channel = entry._id.channel || 'unknown';
            const eventType = entry._id.eventType || 'unknown';
            delivery[status] = (delivery[status] || 0) + entry.count;
            delivery.byChannel[channel] = delivery.byChannel[channel] || {
                sent: 0,
                failed: 0,
                skipped: 0,
            };
            delivery.byChannel[channel][status] =
                (delivery.byChannel[channel][status] || 0) + entry.count;
            delivery.byEventType[eventType] =
                (delivery.byEventType[eventType] || 0) + entry.count;
        });

        const scheduled = {
            scheduled: 0,
            sending: 0,
            sent: 0,
            cancelled: 0,
            failed: 0,
        };
        scheduledStats.forEach((entry) => {
            scheduled[entry._id || 'scheduled'] = entry.count;
        });

        const readStats = {
            customers: { read: 0, unread: 0 },
            vendors: { read: 0, unread: 0 },
            riders: { read: 0, unread: 0 },
        };
        [...customerReadStats, ...riderReadStats].forEach((entry) => {
            const type = `${entry._id.type}s`;
            const bucket = entry._id.read === true ? 'read' : 'unread';
            if (readStats[type]) readStats[type][bucket] += entry.count;
        });

        res.status(200).json({
            days,
            since,
            delivery,
            scheduled,
            readStats,
        });
    } catch (error) {
        console.error('Error loading notification stats:', error);
        res.status(500).json({ message: 'Failed to load notification stats.' });
    }
});

router.post('/notifications/preview', protect, authorizeAdmin, async (req, res) => {
    try {
        const segment = String(req.body.segment || req.body.audience || '').trim().toLowerCase();
        const recipientIds = normalizeRecipientIds(req.body.recipientIds);

        if (!SERVICE_NOTIFICATION_SEGMENTS.has(segment)) {
            return res.status(400).json({ message: 'Invalid notification segment.' });
        }

        const recipients = await resolveAdminNotificationSegment(segment, recipientIds);
        const results = recipientCounts(recipients);

        res.status(200).json({
            segment,
            results,
            total: results.total,
            message: `This will send to ${results.customers} customers / ${results.vendors} vendors / ${results.riders} riders.`,
        });
    } catch (error) {
        console.error('Error previewing admin notification:', error);
        res.status(500).json({ message: 'Failed to preview recipients.' });
    }
});

router.post('/notifications/send', protect, authorizeAdmin, async (req, res) => {
    try {
        const segment = String(req.body.segment || req.body.audience || '').trim().toLowerCase();
        const title = String(req.body.title || '').trim();
        const message = String(req.body.message || '').trim();
        const recipientIds = normalizeRecipientIds(req.body.recipientIds);

        if (!SERVICE_NOTIFICATION_SEGMENTS.has(segment)) {
            return res.status(400).json({
                message: 'Invalid notification segment.',
            });
        }

        if (!title || !message) {
            return res.status(400).json({
                message: 'Notification title and message are required.',
            });
        }

        const result = await sendAdminInAppNotification({
            app: req.app,
            adminUserId: req.user._id,
            segment,
            title,
            message,
            type: req.body.type,
            recipientIds,
        });

        res.status(200).json(result);
    } catch (error) {
        console.error('Error sending admin notification:', error);
        res.status(error.statusCode || 500).json({
            message: error.statusCode ? error.message : 'Failed to send notification.',
        });
    }
});

router.post('/notifications/schedule', protect, authorizeAdmin, async (req, res) => {
    try {
        const segment = String(req.body.segment || req.body.audience || '').trim().toLowerCase();
        const title = String(req.body.title || '').trim();
        const message = String(req.body.message || '').trim();
        const recipientIds = normalizeRecipientIds(req.body.recipientIds);
        const scheduledFor = new Date(req.body.scheduledFor);

        if (!SERVICE_NOTIFICATION_SEGMENTS.has(segment)) {
            return res.status(400).json({ message: 'Invalid notification segment.' });
        }

        if (!title || !message) {
            return res.status(400).json({
                message: 'Notification title and message are required.',
            });
        }

        if (Number.isNaN(scheduledFor.getTime()) || scheduledFor <= new Date()) {
            return res.status(400).json({
                message: 'Choose a valid future date and time.',
            });
        }

        const recipients = await resolveAdminNotificationSegment(segment, recipientIds);
        const preview = recipientCounts(recipients);
        const scheduled = await AdminScheduledNotification.create({
            segment,
            recipientIds,
            title,
            message,
            type: req.body.type || 'admin_message',
            scheduledFor,
            createdBy: req.user._id,
            preview,
        });

        res.status(201).json({
            message: 'Notification scheduled successfully.',
            scheduled,
            preview,
        });
    } catch (error) {
        console.error('Error scheduling admin notification:', error);
        res.status(500).json({ message: 'Failed to schedule notification.' });
    }
});

router.get('/notifications/scheduled', protect, authorizeAdmin, async (req, res) => {
    try {
        const status = String(req.query.status || '').trim();
        const filter = status ? { status } : {};
        const scheduled = await AdminScheduledNotification.find(filter)
            .populate('createdBy', 'firstName lastName email')
            .sort({ scheduledFor: -1 })
            .limit(100)
            .lean();

        res.status(200).json({ count: scheduled.length, scheduled });
    } catch (error) {
        console.error('Error loading scheduled notifications:', error);
        res.status(500).json({ message: 'Failed to load scheduled notifications.' });
    }
});

router.put('/notifications/scheduled/:id/cancel', protect, authorizeAdmin, async (req, res) => {
    try {
        const scheduled = await AdminScheduledNotification.findOneAndUpdate(
            { _id: req.params.id, status: 'scheduled' },
            { status: 'cancelled', cancelledAt: new Date() },
            { new: true },
        );

        if (!scheduled) {
            return res.status(404).json({
                message: 'Scheduled notification not found or cannot be cancelled.',
            });
        }

        res.status(200).json({ message: 'Scheduled notification cancelled.', scheduled });
    } catch (error) {
        console.error('Error cancelling scheduled notification:', error);
        res.status(500).json({ message: 'Failed to cancel scheduled notification.' });
    }
});

router.get('/notifications/templates', protect, authorizeAdmin, async (req, res) => {
    try {
        const filter = {};
        const category = String(req.query.category || '').trim();
        const search = String(req.query.search || '').trim();

        if (category && category !== 'all') filter.category = category;
        if (search) {
            filter.$or = [
                { name: { $regex: search, $options: 'i' } },
                { title: { $regex: search, $options: 'i' } },
                { message: { $regex: search, $options: 'i' } },
            ];
        }

        const templates = await AdminNotificationTemplate.find(filter)
            .populate('createdBy', 'firstName lastName email')
            .populate('updatedBy', 'firstName lastName email')
            .sort({ updatedAt: -1 })
            .limit(200)
            .lean();

        res.status(200).json({ count: templates.length, templates });
    } catch (error) {
        console.error('Error loading notification templates:', error);
        res.status(500).json({ message: 'Failed to load notification templates.' });
    }
});

router.post('/notifications/templates', protect, authorizeAdmin, async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        const category = String(req.body.category || 'general').trim();
        const segment = String(req.body.segment || 'all_customers').trim().toLowerCase();
        const title = String(req.body.title || '').trim();
        const message = String(req.body.message || '').trim();

        if (!name || !title || !message) {
            return res.status(400).json({
                message: 'Template name, title, and message are required.',
            });
        }

        if (!SERVICE_NOTIFICATION_SEGMENTS.has(segment)) {
            return res.status(400).json({ message: 'Invalid notification segment.' });
        }

        const template = await AdminNotificationTemplate.create({
            name,
            category,
            segment,
            title,
            message,
            type: req.body.type || 'admin_message',
            createdBy: req.user._id,
            updatedBy: req.user._id,
        });

        res.status(201).json({
            message: 'Notification template saved.',
            template,
        });
    } catch (error) {
        console.error('Error creating notification template:', error);
        res.status(500).json({ message: 'Failed to save notification template.' });
    }
});

router.put('/notifications/templates/:id', protect, authorizeAdmin, async (req, res) => {
    try {
        const updates = {};
        const allowedFields = ['name', 'category', 'segment', 'title', 'message', 'type'];

        allowedFields.forEach((field) => {
            if (req.body[field] !== undefined) {
                updates[field] = String(req.body[field] || '').trim();
            }
        });

        if (updates.segment) {
            updates.segment = updates.segment.toLowerCase();
            if (!SERVICE_NOTIFICATION_SEGMENTS.has(updates.segment)) {
                return res.status(400).json({ message: 'Invalid notification segment.' });
            }
        }

        if (updates.name === '' || updates.title === '' || updates.message === '') {
            return res.status(400).json({
                message: 'Template name, title, and message cannot be empty.',
            });
        }

        updates.updatedBy = req.user._id;

        const template = await AdminNotificationTemplate.findByIdAndUpdate(
            req.params.id,
            updates,
            { new: true, runValidators: true },
        );

        if (!template) {
            return res.status(404).json({ message: 'Notification template not found.' });
        }

        res.status(200).json({
            message: 'Notification template updated.',
            template,
        });
    } catch (error) {
        console.error('Error updating notification template:', error);
        res.status(500).json({ message: 'Failed to update notification template.' });
    }
});

router.put('/notifications/templates/:id/use', protect, authorizeAdmin, async (req, res) => {
    try {
        const template = await AdminNotificationTemplate.findByIdAndUpdate(
            req.params.id,
            { lastUsedAt: new Date(), updatedBy: req.user._id },
            { new: true },
        );

        if (!template) {
            return res.status(404).json({ message: 'Notification template not found.' });
        }

        res.status(200).json({ message: 'Template marked as used.', template });
    } catch (error) {
        console.error('Error marking notification template used:', error);
        res.status(500).json({ message: 'Failed to update template usage.' });
    }
});

router.delete('/notifications/templates/:id', protect, authorizeAdmin, async (req, res) => {
    try {
        const template = await AdminNotificationTemplate.findByIdAndDelete(req.params.id);

        if (!template) {
            return res.status(404).json({ message: 'Notification template not found.' });
        }

        res.status(200).json({ message: 'Notification template deleted.' });
    } catch (error) {
        console.error('Error deleting notification template:', error);
        res.status(500).json({ message: 'Failed to delete notification template.' });
    }
});

router.post('/notifications/export-segment', protect, authorizeAdmin, async (req, res) => {
    try {
        const segment = String(req.body.segment || req.body.audience || '').trim().toLowerCase();
        const recipientIds = normalizeRecipientIds(req.body.recipientIds);

        if (!SERVICE_NOTIFICATION_SEGMENTS.has(segment)) {
            return res.status(400).json({ message: 'Invalid notification segment.' });
        }

        const recipients = await resolveAdminNotificationSegment(segment, recipientIds);
        const contacts = exportRecipients(recipients);

        res.status(200).json({
            segment,
            contacts,
            count: contacts.length,
            results: recipientCounts(recipients),
        });
    } catch (error) {
        console.error('Error exporting notification segment:', error);
        res.status(500).json({ message: 'Failed to export segment.' });
    }
});

router.get('/marketing-lists', protect, authorizeAdmin, async (req, res) => {
    try {
        const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 500 });
        const [importedLists, builtInLists] = await Promise.all([
            MarketingContactList.find({})
                .populate('importedBy', 'firstName lastName email')
                .sort({ createdAt: -1 })
                .lean(),
            summarizeBuiltInMarketingLists(),
        ]);
        const allLists = [...builtInLists, ...importedLists];
        const total = allLists.length;
        const lists = allLists.slice(skip, skip + limit);

        res.status(200).json({
            count: total,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
            lists,
        });
    } catch (error) {
        console.error('Error loading marketing lists:', error);
        res.status(500).json({ message: 'Failed to load marketing lists.' });
    }
});

router.get('/marketing-lists/:id', protect, authorizeAdmin, async (req, res) => {
    try {
        const segment = marketingListIdToSegment(req.params.id);
        if (segment) {
            const list = await buildMarketingListFromSegment(segment);
            if (!list) {
                return res.status(404).json({ message: 'Marketing list not found.' });
            }

            return res.status(200).json({ list });
        }
        if (String(req.params.id || '').startsWith('segment:')) {
            return res.status(404).json({ message: 'Marketing list not found.' });
        }

        const list = await MarketingContactList.findById(req.params.id)
            .populate('importedBy', 'firstName lastName email')
            .lean();

        if (!list) {
            return res.status(404).json({ message: 'Marketing list not found.' });
        }

        res.status(200).json({ list });
    } catch (error) {
        console.error('Error loading marketing list:', error);
        res.status(500).json({ message: 'Failed to load marketing list.' });
    }
});

router.post('/marketing-lists/import', protect, authorizeAdmin, async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        const audience = ['customers', 'vendors', 'riders', 'mixed'].includes(req.body.audience)
            ? req.body.audience
            : 'mixed';
        const contacts = Array.isArray(req.body.contacts) ? req.body.contacts : [];

        if (!name) {
            return res.status(400).json({ message: 'List name is required.' });
        }

        const seen = new Set();
        const normalizedContacts = contacts
            .map((contact) => ({
                name: String(contact.name || '').trim(),
                email: String(contact.email || '').trim().toLowerCase(),
                phoneNumber: String(contact.phoneNumber || contact.phone || '').trim(),
                type: ['customer', 'vendor', 'rider', 'other'].includes(contact.type)
                    ? contact.type
                    : 'other',
                source: String(contact.source || 'admin_import').trim(),
            }))
            .filter((contact) => contact.email || contact.phoneNumber)
            .filter((contact) => {
                const key = `${contact.email}|${contact.phoneNumber}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

        if (!normalizedContacts.length) {
            return res.status(400).json({
                message: 'Import at least one contact with an email or phone number.',
            });
        }

        const list = await MarketingContactList.create({
            name,
            audience,
            contacts: normalizedContacts,
            contactCount: normalizedContacts.length,
            importedBy: req.user._id,
        });

        res.status(201).json({
            message: 'Marketing contact list imported.',
            list,
        });
    } catch (error) {
        console.error('Error importing marketing list:', error);
        res.status(500).json({ message: 'Failed to import marketing list.' });
    }
});

router.delete('/marketing-lists/:id', protect, authorizeAdmin, async (req, res) => {
    try {
        if (marketingListIdToSegment(req.params.id)) {
            return res.status(400).json({ message: 'Built-in marketing lists cannot be deleted.' });
        }
        if (String(req.params.id || '').startsWith('segment:')) {
            return res.status(404).json({ message: 'Marketing list not found.' });
        }

        const list = await MarketingContactList.findByIdAndDelete(req.params.id);

        if (!list) {
            return res.status(404).json({ message: 'Marketing list not found.' });
        }

        res.status(200).json({ message: 'Marketing list deleted.' });
    } catch (error) {
        console.error('Error deleting marketing list:', error);
        res.status(500).json({ message: 'Failed to delete marketing list.' });
    }
});

router.post('/marketing-campaigns/send', protect, authorizeAdmin, async (req, res) => {
    try {
        const listId = String(req.body.listId || '').trim();
        const title = String(req.body.title || '').trim();
        const message = String(req.body.message || '').trim();
        const channels = Array.isArray(req.body.channels) ? req.body.channels : [];

        if (!listId) {
            return res.status(400).json({ message: 'Marketing list is required.' });
        }

        const segment = marketingListIdToSegment(listId);
        const list = segment
            ? await buildMarketingListFromSegment(segment)
            : String(listId).startsWith('segment:')
                ? null
                : await MarketingContactList.findById(listId).lean();
        if (!list) {
            return res.status(404).json({ message: 'Marketing list not found.' });
        }

        const result = await sendMarketingCampaign({
            list,
            title,
            message,
            channels,
            sentBy: req.user._id,
        });

        res.status(200).json({
            message: 'Marketing campaign processed.',
            campaign: result,
        });
    } catch (error) {
        console.error('Error sending marketing campaign:', error);
        res.status(error.statusCode || 500).json({
            message: error.statusCode ? error.message : 'Failed to send marketing campaign.',
        });
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

// @desc    Get pharmacist chat subscribers
// @route   GET /api/admin/pharmacist-subscribers
// @access  Private (Admin only)
router.get('/pharmacist-subscribers', protect, authorizeAdmin, async (req, res) => {
    try {
        const { limit, skip, page } = parsePagination(req.query, {
            defaultLimit: 100,
            maxLimit: 500,
        });
        const status = String(req.query.status || 'all').toLowerCase() === 'active'
            ? 'active'
            : 'all';
        const result = await getPharmacySubscribers({ status, limit, skip });

        res.status(200).json({
            ...result,
            page,
            limit,
            status,
        });
    } catch (error) {
        console.error('Error fetching pharmacist subscribers:', error);
        res.status(500).json({ message: 'Server error fetching pharmacist subscribers.' });
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
        const { limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 300 });
        // Find users who have submitted a vendor request and are not yet approved/rejected
        const vendorRequests = await User.find({
            vendorStatus: { $in: ['sent', 'received', 'reviewing'] }
        })
            .select('-password -emailVerificationToken -deviceVerificationToken -passwordResetToken')
            .sort({ vendorRequestDate: -1, createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(); // Exclude sensitive fields

        res.status(200).json(vendorRequests);
    } catch (error) {
        console.error('Error fetching vendor requests:', error);
        res.status(500).json({ message: 'Server error fetching vendor requests.' });
    }
});

// @desc    Update a user's vendor status
// @route   PUT /api/admin/vendor-status/:userId
// @access  Private (Admin only)
router.put('/vendor-status/:userId', protect, authorizeAdmin, async (req, res) => {
    const { userId } = req.params;
    const { status } = req.body;

    if (!['received', 'reviewing', 'approved', 'rejected', 'suspended'].includes(status)) {
        return res.status(400).json({
            message: 'Invalid status provided. Must be received, reviewing, approved, rejected, or suspended.',
        });
    }

    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        user.vendorStatus = status;

        if (status === 'approved') {
            user.isVendor = true;
            user.vendorRejectionDate = undefined;
            user.isTemporarilyClosed = false;
            user.temporaryClosureReason = undefined;
        } else if (status === 'rejected') {
            user.isVendor = false;
            user.vendorRejectionDate = Date.now();
        } else if (status === 'suspended') {
            user.isVendor = false;
            user.isTemporarilyClosed = true;
            user.temporaryClosureReason = String(req.body.reason || '').trim()
                || 'Vendor account suspended by admin.';
        } else {
            user.isVendor = false;
        }

        user.notifications.push({
            type: 'vendor_status_update',
            message: status === 'approved'
                ? 'Your vendor registration has been approved. Vendor tools are now available.'
                : status === 'suspended'
                ? 'Your vendor account has been suspended by admin.'
                : status === 'rejected'
                ? 'Your vendor registration was not approved.'
                : `Your vendor registration status is now ${status}.`,
            relatedModel: 'User',
            relatedId: user._id,
        });

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
        const { limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 300 });
        const pharmacistRequests = await User.find({
            pharmacistStatus: { $in: ['sent', 'received', 'reviewing'] }
        })
            .select('-password -emailVerificationToken -deviceVerificationToken -passwordResetToken')
            .sort({ pharmacistRequestDate: -1, createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

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
        const { limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 300 });
        const disputes = await Dispute.find({})
            .populate('user', 'firstName lastName email')
            .populate('order', 'totalPrice _id')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();
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

// @desc    Get eligible riders near a pickup point for manual assignment
// @route   GET /api/admin/riders/eligible?lat=...&lng=...
// @access  Private (Admin only)
router.get('/riders/eligible', protect, authorizeAdmin, async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radiusKm = Number(req.query.radiusKm || 25);
    const limit = Number(req.query.limit || 20);

    try {
        const riders = await findEligibleRiders({
            pickupLocation: Number.isFinite(lat) && Number.isFinite(lng)
                ? { latitude: lat, longitude: lng }
                : null,
            radiusKm,
            limit,
        });

        res.json({
            count: riders.length,
            riders,
        });
    } catch (error) {
        console.error('Eligible riders error:', error);
        res.status(500).json({ message: 'Server error fetching eligible riders.' });
    }
});

// @desc    Update individual rider status
// @route   PUT /api/admin/riders/:riderId/status
// @access  Private (Admin only)
router.put('/riders/:riderId/status', protect, authorizeAdmin, async (req, res) => {
    const { riderId } = req.params;
    const { status, reason } = req.body;

    if (!['pending', 'approved', 'rejected', 'suspended'].includes(status)) {
        return res.status(400).json({
            message: 'Invalid status. Use pending, approved, rejected, or suspended.',
        });
    }

    try {
        const rider = await Rider.findById(riderId);
        if (!rider) return res.status(404).json({ message: 'Rider not found.' });

        rider.status = status;
        
        if (status === 'approved') {
            rider.isVerified = true;
            rider.isActive = true;
            rider.rejectionReason = undefined; 
        } else if (status === 'rejected') {
            rider.isVerified = false;
            rider.isActive = false;
            rider.rejectionReason =
                String(reason || '').trim()
                || "Photo was blurry or the documents are invalid. Please re-upload clear documents.";
            rider.rejectionDate = Date.now();
        } else if (status === 'suspended') {
            rider.isActive = false;
            rider.isAvailable = false;
            rider.rejectionReason =
                String(reason || '').trim()
                || 'Rider account suspended by admin.';
        } else if (status === 'pending') {
            rider.isVerified = false;
            rider.isActive = false;
            rider.isAvailable = false;
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

// @desc    Manually assign a ready order to an approved rider
// @route   PUT /api/admin/riders/assign-order
// @access  Private (Admin only)
router.put('/riders/assign-order', protect, authorizeAdmin, async (req, res) => {
    const { orderId, riderId } = req.body;

    if (!orderId || !riderId) {
        return res.status(400).json({ message: 'orderId and riderId are required.' });
    }

    const session = await MainOrder.startSession();
    session.startTransaction();

    try {
        const rider = await Rider.findOne({
            _id: riderId,
            status: 'approved',
            isActive: true,
        }).session(session);

        if (!rider) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ message: 'Approved active rider not found.' });
        }

        if ((rider.activeDeliveries || 0) >= 5) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'Rider already has the maximum active deliveries.' });
        }

        const readyShipments = await Shipment.find({
            mainOrder: orderId,
            shipmentStatus: 'ready_for_pickup',
            isClaimed: false,
        }).session(session);

        if (readyShipments.length === 0) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ message: 'No unclaimed ready shipments found for this order.' });
        }

        const pickupOTP = Math.floor(1000 + Math.random() * 9000).toString();
        const deliveryOTP = Math.floor(1000 + Math.random() * 9000).toString();

        const mainOrder = await MainOrder.findOneAndUpdate(
            {
                _id: orderId,
                isPaid: true,
                isClaimed: false,
                mainOrderStatus: { $nin: ['delivered', 'completed', 'cancelled'] },
                $or: [{ rider: null }, { rider: { $exists: false } }],
            },
            {
                $set: {
                    rider: riderId,
                    isClaimed: true,
                    claimedAt: Date.now(),
                    pickupOTP,
                    deliveryOTP,
                    shipmentStatus: 'ready_for_pickup',
                },
            },
            { new: true, session },
        );

        if (!mainOrder) {
            await session.abortTransaction();
            session.endSession();
            return res.status(409).json({ message: 'Order has already been claimed or is not available.' });
        }

        await Shipment.updateMany(
            {
                _id: { $in: readyShipments.map((shipment) => shipment._id) },
                isClaimed: false,
                shipmentStatus: 'ready_for_pickup',
            },
            {
                $set: {
                    rider: riderId,
                    isClaimed: true,
                    claimedAt: Date.now(),
                    pickupOTP,
                    deliveryOTP,
                },
            },
            { session },
        );

        rider.activeDeliveries = (rider.activeDeliveries || 0) + 1;
        await rider.save({ session });

        await session.commitTransaction();
        session.endSession();

        await notifyAssignedRider({
            app: req.app,
            riderId,
            mainOrder,
            pickupOTP,
            deliveryOTP,
        });

        req.app.get('notifyAdmin')?.({
            type: 'manual_rider_assignment',
            message: `Order ${orderId} manually assigned to rider ${rider.fullName}.`,
            orderId,
            riderId,
        });

        res.json({
            message: 'Rider assigned successfully.',
            orderId,
            riderId,
            pickupOTP,
            deliveryOTP,
        });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error('Manual rider assignment error:', error);
        res.status(500).json({ message: 'Server error assigning rider.', error: error.message });
    }
});

// @desc    Update company rider operational status
// @route   PUT /api/admin/company-riders/:riderId/status
// @access  Private (Admin only)
router.put('/company-riders/:riderId/status', protect, authorizeAdmin, async (req, res) => {
    const { riderId } = req.params;
    const { status } = req.body;

    if (!['active', 'inactive', 'suspended', 'pending_verification'].includes(status)) {
        return res.status(400).json({
            message: 'Invalid status. Use active, inactive, suspended, or pending_verification.',
        });
    }

    try {
        const rider = await CompanyRider.findById(riderId);
        if (!rider) {
            return res.status(404).json({ message: 'Company rider not found.' });
        }

        rider.status = status;
        rider.isActive = status === 'active';
        if (status !== 'active') {
            rider.isAvailable = false;
        }
        rider.notes.push({
            content: `Admin changed rider status to ${status}.`,
            addedBy: 'admin',
        });

        await rider.save();

        res.status(200).json({
            message: `Company rider ${rider.fullName} status updated to ${status}.`,
            status: rider.status,
        });
    } catch (error) {
        console.error('Admin company rider status update error:', error);
        res.status(500).json({ message: 'Server error updating company rider status.' });
    }
});
module.exports = router;
