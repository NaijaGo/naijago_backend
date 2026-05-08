const User = require('../models/User');
const Rider = require('../models/Rider');
const MainOrder = require('../models/MainOrder');
const NotificationLog = require('../models/NotificationLog');
const notificationService = require('./notificationService');

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

const CONTACT_SELECT =
    '_id firstName lastName email phoneNumber role isVendor vendorStatus businessName businessWhatsAppNumber businessSupportPhone businessCategories createdAt updatedAt';
const RIDER_SELECT =
    '_id fullName email phoneNumber status plateNumber vehicleType createdAt updatedAt';

const normalizeNotificationType = (type, allowedTypes) => {
    const normalized = String(type || 'admin_message').trim().toLowerCase();
    return allowedTypes.has(normalized) ? normalized : 'admin_message';
};

const normalizeRecipientIds = (recipientIds = []) =>
    (Array.isArray(recipientIds) ? recipientIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean);

const applyExplicitIds = (query, explicitIds) => {
    if (!explicitIds.length) return query;
    return { $and: [query, { _id: { $in: explicitIds } }] };
};

const userQuery = (query, explicitIds) =>
    User.find(applyExplicitIds(query, explicitIds)).select(CONTACT_SELECT).lean();

const riderQuery = (query, explicitIds) =>
    Rider.find(applyExplicitIds(query, explicitIds)).select(RIDER_SELECT).lean();

const resolveNotificationSegment = async (segment, recipientIds = []) => {
    const normalizedSegment = ADMIN_NOTIFICATION_SEGMENTS.has(segment)
        ? segment
        : 'all_customers';
    const explicitIds = normalizeRecipientIds(recipientIds);
    const result = {
        segment: normalizedSegment,
        customers: [],
        vendors: [],
        riders: [],
    };

    if (normalizedSegment === 'all' || normalizedSegment === 'all_customers') {
        result.customers = await userQuery({ ...CUSTOMER_CONTACT_FILTER }, explicitIds);
    }

    if (normalizedSegment === 'customers_with_orders') {
        const purchasingCustomerIds = await MainOrder.distinct('user', { isPaid: true });
        result.customers = await userQuery(
            { ...CUSTOMER_CONTACT_FILTER, _id: { $in: purchasingCustomerIds } },
            explicitIds,
        );
    }

    if (normalizedSegment === 'customers_without_orders') {
        const purchasingCustomerIds = await MainOrder.distinct('user', { isPaid: true });
        result.customers = await userQuery(
            { ...CUSTOMER_CONTACT_FILTER, _id: { $nin: purchasingCustomerIds } },
            explicitIds,
        );
    }

    if (normalizedSegment === 'active_subscribers') {
        result.customers = await userQuery(
            {
                ...CUSTOMER_CONTACT_FILTER,
                'naijagoSubscription.status': 'active',
                'naijagoSubscription.expiresAt': { $gt: new Date() },
            },
            explicitIds,
        );
    }

    if (normalizedSegment === 'all' || normalizedSegment === 'all_vendors') {
        result.vendors = await userQuery({ ...VENDOR_CONTACT_FILTER }, explicitIds);
    }

    if (normalizedSegment === 'approved_vendors') {
        result.vendors = await userQuery(
            { ...VENDOR_CONTACT_FILTER, vendorStatus: 'approved' },
            explicitIds,
        );
    }

    if (normalizedSegment === 'pending_vendors') {
        result.vendors = await userQuery(
            { vendorStatus: { $in: ['sent', 'received', 'reviewing'] } },
            explicitIds,
        );
    }

    if (normalizedSegment === 'suspended_vendors') {
        result.vendors = await userQuery(
            { ...VENDOR_CONTACT_FILTER, vendorStatus: 'suspended' },
            explicitIds,
        );
    }

    if (normalizedSegment === 'all' || normalizedSegment === 'all_riders') {
        result.riders = await riderQuery({}, explicitIds);
    }

    if (normalizedSegment === 'approved_riders') {
        result.riders = await riderQuery({ status: 'approved' }, explicitIds);
    }

    if (normalizedSegment === 'pending_riders') {
        result.riders = await riderQuery({ status: 'pending' }, explicitIds);
    }

    if (normalizedSegment === 'suspended_riders') {
        result.riders = await riderQuery({ status: 'suspended' }, explicitIds);
    }

    return result;
};

const recipientCounts = (recipients) => ({
    customers: recipients.customers.length,
    vendors: recipients.vendors.length,
    riders: recipients.riders.length,
    total:
        recipients.customers.length +
        recipients.vendors.length +
        recipients.riders.length,
});

const normalizeContactExport = (contact, type) => ({
    id: contact._id,
    type,
    name:
        type === 'rider'
            ? contact.fullName || contact.email || 'Unnamed rider'
            : `${contact.firstName || ''} ${contact.lastName || ''}`.trim() ||
              contact.businessName ||
              contact.email ||
              'Unnamed contact',
    email: contact.email || '',
    phoneNumber: contact.phoneNumber || '',
    status: type === 'rider' ? contact.status || '' : contact.vendorStatus || contact.role || '',
    businessName: contact.businessName || '',
    businessWhatsAppNumber: contact.businessWhatsAppNumber || '',
    businessSupportPhone: contact.businessSupportPhone || '',
    createdAt: contact.createdAt,
});

const exportRecipients = (recipients) => [
    ...recipients.customers.map((contact) => normalizeContactExport(contact, 'customer')),
    ...recipients.vendors.map((contact) => normalizeContactExport(contact, 'vendor')),
    ...recipients.riders.map((contact) => normalizeContactExport(contact, 'rider')),
];

const sendAdminInAppNotification = async ({
    app,
    adminUserId,
    segment,
    title,
    message,
    type = 'admin_message',
    recipientIds = [],
    scheduledNotificationId = null,
}) => {
    const normalizedSegment = String(segment || '').trim().toLowerCase();
    if (!ADMIN_NOTIFICATION_SEGMENTS.has(normalizedSegment)) {
        const error = new Error('Invalid notification segment.');
        error.statusCode = 400;
        throw error;
    }

    const cleanTitle = String(title || '').trim();
    const cleanMessage = String(message || '').trim();
    if (!cleanTitle || !cleanMessage) {
        const error = new Error('Notification title and message are required.');
        error.statusCode = 400;
        throw error;
    }

    const recipients = await resolveNotificationSegment(
        normalizedSegment,
        normalizeRecipientIds(recipientIds),
    );
    const userType = normalizeNotificationType(type, USER_NOTIFICATION_TYPES);
    const riderType = normalizeNotificationType(type, RIDER_NOTIFICATION_TYPES);
    const storedMessage = `${cleanTitle}: ${cleanMessage}`;
    const notificationBase = {
        message: storedMessage,
        relatedModel: 'User',
        relatedId: adminUserId,
    };
    const io = app?.get('io');
    const customerIds = recipients.customers.map((customer) => customer._id);
    const vendorIds = recipients.vendors.map((vendor) => vendor._id);
    const riderIds = recipients.riders.map((rider) => rider._id);

    if (customerIds.length) {
        await User.updateMany(
            { _id: { $in: customerIds } },
            { $push: { notifications: { ...notificationBase, type: userType } } },
        );
        customerIds.forEach((id) => {
            io?.emit(`user_${id}`, {
                type: userType,
                title: cleanTitle,
                message: storedMessage,
                createdAt: new Date().toISOString(),
            });
        });
    }

    if (vendorIds.length) {
        await User.updateMany(
            { _id: { $in: vendorIds } },
            { $push: { notifications: { ...notificationBase, type: userType } } },
        );
        vendorIds.forEach((id) => {
            app?.get('notifyVendor')?.(id.toString(), {
                type: userType,
                title: cleanTitle,
                message: storedMessage,
                data: { type: userType, title: cleanTitle, message: storedMessage },
            });
        });

        notificationService
            .sendToUsers(
                vendorIds.map((id) => id.toString()),
                {
                    title: cleanTitle,
                    message: cleanMessage,
                    data: {
                        type: userType,
                        audience: 'vendor',
                        segment: normalizedSegment,
                    },
                },
            )
            .catch((error) => {
                console.error('Vendor OneSignal push failed:', error.message);
            });
    }

    if (riderIds.length) {
        await Rider.updateMany(
            { _id: { $in: riderIds } },
            {
                $push: {
                    notifications: {
                        type: riderType,
                        message: storedMessage,
                        relatedModel: 'User',
                        relatedId: adminUserId,
                    },
                },
            },
        );
        riderIds.forEach((id) => {
            app?.get('notifyRider')?.(id.toString(), {
                title: cleanTitle,
                message: storedMessage,
                data: { type: riderType, title: cleanTitle, message: storedMessage },
            });
        });

        notificationService
            .sendToUsers(
                riderIds.map((id) => id.toString()),
                {
                    title: cleanTitle,
                    message: cleanMessage,
                    data: {
                        type: riderType,
                        audience: 'rider',
                        segment: normalizedSegment,
                    },
                },
            )
            .catch((error) => {
                console.error('Rider OneSignal push failed:', error.message);
            });
    }

    const results = recipientCounts(recipients);
    await NotificationLog.create({
        channel: 'app_socket',
        eventType: scheduledNotificationId
            ? 'admin_scheduled_in_app_notification'
            : 'admin_in_app_notification',
        status: 'sent',
        recipient: normalizedSegment,
        title: cleanTitle,
        message: cleanMessage,
        providerResponse: {
            ...results,
            sentBy: adminUserId,
            segment: normalizedSegment,
            recipientIds: normalizeRecipientIds(recipientIds),
            scheduledNotificationId,
        },
    });

    return {
        message: 'Notification sent successfully.',
        segment: normalizedSegment,
        results,
        total: results.total,
    };
};

module.exports = {
    ADMIN_NOTIFICATION_SEGMENTS,
    exportRecipients,
    normalizeRecipientIds,
    recipientCounts,
    resolveNotificationSegment,
    sendAdminInAppNotification,
};
