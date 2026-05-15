const OneSignal = require('onesignal-node');

class NotificationService {
    constructor() {
        this.client = new OneSignal.Client(
            process.env.ONESIGNAL_APP_ID, // Your OneSignal App ID
            process.env.ONESIGNAL_REST_API_KEY // From OneSignal Dashboard > Settings > Keys & IDs
        );
    }

    /**
     * Send push notification to specific user by their OneSignal external ID
     */
    async sendToUser(userId, notificationData) {
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
                ...this.getPlatformOptions()
            };

            const response = await this.client.createNotification(notification);
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
    async sendToUsers(userIds, notificationData) {
        try {
            const notification = {
                contents: { en: notificationData.message },
                headings: { en: notificationData.title || 'Naijago Shopping' },
                include_external_user_ids: userIds,
                data: notificationData.data || {},
                ...this.getPlatformOptions()
            };

            const response = await this.client.createNotification(notification);
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
    async sendToSegment(segment, notificationData) {
        try {
            const notification = {
                contents: { en: notificationData.message },
                headings: { en: notificationData.title || 'Naijago Shopping' },
                included_segments: [segment],
                data: notificationData.data || {},
                ...this.getPlatformOptions()
            };

            const response = await this.client.createNotification(notification);
            console.log(`Sent to segment: ${segment}`);
            return response;
        } catch (error) {
            console.error('Error sending segment notification:', error);
            throw error;
        }
    }

    getPlatformOptions() {
        const channelId =
            process.env.ONESIGNAL_ANDROID_CHANNEL_ID ||
            'ea2ee9a7-0988-429d-9e86-412d1668055e';

        return {
            android_channel_id: channelId,
            priority: 10,
            ttl: 259200,
            ios_sound: 'default',
            android_sound: 'default',
            small_icon: 'ic_notification',
            large_icon: 'ic_launcher',
            android_accent_color: 'FF0B5FFF',
            ios_category: 'shopping'
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
