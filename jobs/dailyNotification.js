// backend/jobs/dailyNotifications.js
const cron = require('node-cron');
const notificationService = require('../services/notificationService');
const User = require('../models/User');

// Daily at 6 PM
cron.schedule('0 18 * * *', async () => {
    console.log('Running daily reminder job...');
    
    try {
        // Find users who haven't purchased in 7 days
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        
        const inactiveUsers = await User.find({
            lastPurchaseDate: { $lt: weekAgo },
            notificationPreferences: { dailyReminders: true }
        });
        
        const userIds = inactiveUsers.map(user => user._id.toString());
        
        if (userIds.length > 0) {
            await notificationService.sendToUsers(userIds, {
                title: 'Missing You at Naijago!',
                message: 'We haven\'t seen you in a while. Check out new products!',
                data: { type: 'reengagement' }
            });
        }
    } catch (error) {
        console.error('Error in daily notification job:', error);
    }
});

module.exports = cron;