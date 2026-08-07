const OneSignal = require('onesignal-node');

class NotificationService {
    constructor() {
        this.clients = new Map();
    }

    audienceConfig(audience = 'customer') {
        const prefix = String(audience || 'customer').toUpperCase();
        const appId = process.env[`${prefix}_ONESIGNAL_APP_ID`] ||
            (audience === 'customer' ? process.env.ONESIGNAL_APP_ID : '');
        const apiKey = process.env[`${prefix}_ONESIGNAL_REST_API_KEY`] ||
            (audience === 'customer' ? process.env.ONESIGNAL_REST_API_KEY : '');
        return { appId, apiKey };
    }

    hasAudienceConfiguration(audience = 'customer') {
        const { appId, apiKey } = this.audienceConfig(audience);
        return Boolean(appId && apiKey);
    }

    clientFor(audience = 'customer') {
        const normalized = String(audience || 'customer').toLowerCase();
        if (this.clients.has(normalized)) return this.clients.get(normalized);
        const { appId, apiKey } = this.audienceConfig(normalized);
        if (!appId || !apiKey) {
            throw new Error(`OneSignal is not configured for audience: ${normalized}`);
        }
        const client = new OneSignal.Client(appId, apiKey);
        this.clients.set(normalized, client);
        return client;
    }

    /**
     * Send push notification to specific user by their OneSignal external ID
     */
    async sendToUser(userId, notificationData, options = {}) {
        try {
            const notification = {
                contents: {
                    en: notificationData.message
                },
                headings: {
                    en: notificationData.title || 'Naijago Shopping'
                },
                include_external_user_ids: [userId],
                data: notificationData.data || {},
                ios_badgeType: 'Increase',
                ios_badgeCount: 1,
                ...this.getPlatformOptions(options.audience)
            };

            const response = await this.clientFor(options.audience).createNotification(notification);
            console.log('Notification sent:', response.body);
            return response;
        } catch (error) {
            console.error('Error sending notification:', error);
            throw error;
        }
    }

    /**
     * Send to multiple users
     */
    async sendToUsers(userIds, notificationData, options = {}) {
        try {
            const notification = {
                contents: { en: notificationData.message },
                headings: { en: notificationData.title || 'Naijago Shopping' },
                include_external_user_ids: userIds,
                data: notificationData.data || {},
                ...this.getPlatformOptions(options.audience)
            };

            const response = await this.clientFor(options.audience).createNotification(notification);
            console.log(`Sent to ${userIds.length} users`);
            return response;
        } catch (error) {
            console.error('Error sending bulk notifications:', error);
            throw error;
        }
    }

    /**
     * Send to user segment (e.g., all users, inactive users)
     */
    async sendToSegment(segment, notificationData, options = {}) {
        try {
            const notification = {
                contents: { en: notificationData.message },
                headings: { en: notificationData.title || 'Naijago Shopping' },
                included_segments: [segment],
                data: notificationData.data || {},
                ...this.getPlatformOptions(options.audience)
            };

            const response = await this.clientFor(options.audience).createNotification(notification);
            console.log(`Sent to segment: ${segment}`);
            return response;
        } catch (error) {
            console.error('Error sending segment notification:', error);
            throw error;
        }
    }

    getPlatformOptions(audience = 'customer') {
        const normalizedAudience = String(audience || 'customer').toLowerCase();
        const channelId =
            process.env[`${normalizedAudience.toUpperCase()}_ONESIGNAL_ANDROID_CHANNEL_ID`] ||
            process.env.ONESIGNAL_ANDROID_CHANNEL_ID ||
            'ea2ee9a7-0988-429d-9e86-412d1668055e';
        const sound = normalizedAudience === 'rider'
            ? (process.env.RIDER_NOTIFICATION_SOUND || 'rider_job_alert')
            : 'default';

        return {
            ...(normalizedAudience === 'rider'
                ? { existing_android_channel_id: 'naijago_rider_jobs_v1' }
                : { android_channel_id: channelId }),
            priority: 10,
            ttl: 259200,
            ios_sound: sound === 'default' ? 'default' : `${sound}.wav`,
            android_sound: sound,
            small_icon: 'ic_notification',
            large_icon: 'ic_launcher',
            android_accent_color: 'FF0B5FFF',
            ios_category: normalizedAudience === 'rider' ? 'rider_delivery' : 'shopping'
        };
    }

    /**
     * Get OneSignal user ID from your user data
     */
    async getOneSignalUserIdFromDatabase(userId) {
        // This depends on your User model structure
        // You might need to store OneSignal user ID when they login
        const user = await User.findById(userId).select('oneSignalUserId');
        return user?.oneSignalUserId;
    }
}

module.exports = new NotificationService();
