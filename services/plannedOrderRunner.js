const { RecurringOccurrence, RecurringPlan } = require('../models/PlannedOrders');
const User = require('../models/User');
const service = require('./plannedOrderService');
const notifications = require('./notificationService');
let running = false;
let timer;
async function processPlannedOrders() {
    if (!service.enabled() || running) return;
    running = true;
    try {
        await service.advance();
        const now = new Date();
        const due = await RecurringOccurrence.find({ state: { $in: ['upcoming', 'awaiting_review'] }, reminderAt: { $lte: now }, expiresAt: { $gt: now }, reminderSentAt: null, $or: [{ reminderLeaseUntil: null }, { reminderLeaseUntil: { $lte: now } }] }).select('_id').limit(20).lean();
        for (const row of due) {
            const occurrence = await RecurringOccurrence.findOneAndUpdate({ _id: row._id, reminderSentAt: null, $or: [{ reminderLeaseUntil: null }, { reminderLeaseUntil: { $lte: now } }] }, { $set: { reminderLeaseUntil: new Date(Date.now() + 5 * 60000) } }, { new: true });
            if (!occurrence) continue;
            const plan = await RecurringPlan.findOne({ _id: occurrence.plan, state: 'active' }).lean();
            if (!plan) continue;
            const message = 'Your recurring purchase is coming up. Review current prices and availability when it is due. Nothing is charged automatically.';
            // In-app reminders have a stable ID, so retries never append duplicates.
            await User.updateOne({ _id: occurrence.owner, 'notifications._id': { $ne: occurrence._id } }, { $push: { notifications: { _id: occurrence._id, type: 'recurring_order_update', message, read: false, createdAt: now, relatedId: plan._id, relatedModel: 'RecurringPlan' } } });
            try {
                if (notifications.hasAudienceConfiguration('customer')) {
                    await notifications.sendToUser(String(occurrence.owner), { title: 'Recurring purchase reminder', message, data: { type: 'recurring_order_update', planId: String(plan._id), relatedId: String(occurrence._id), relatedModel: 'RecurringOccurrence' } });
                }
                await RecurringOccurrence.updateOne({ _id: occurrence._id }, { $set: { reminderSentAt: new Date() }, $unset: { reminderLeaseUntil: 1 } });
            } catch (_error) {
                // Retry after the lease. A provider acknowledgement lost in transit
                // can produce another push; the in-app reminder remains unique.
            }
        }
    } finally { running = false; }
}
function startPlannedOrderRunner() {
    if (!service.enabled() || timer) return;
    timer = setInterval(() => processPlannedOrders().catch(() => console.error('Planned-order reminder processing failed.')), 60000);
    timer.unref();
    processPlannedOrders().catch(() => console.error('Planned-order startup processing failed.'));
}
module.exports = { processPlannedOrders, startPlannedOrderRunner };
