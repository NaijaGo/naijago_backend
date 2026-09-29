'use strict';

const MESSAGES = {
    group_created: 'Your group order is ready to invite participants.',
    participant_joined: 'A participant joined your group order.',
    items_submitted: 'A group-order basket was updated.',
    participant_removed: 'A participant was removed from the group order.',
    group_extended: 'The group-order cutoff was updated.',
    group_closed: 'The group order is closed and ready for owner review.',
    group_cancelled: 'The group order was cancelled.',
    checkout_started: 'Checkout has started for this planned order.',
    occurrence_generated: 'Your next recurring order is ready for review and payment.',
    future_order_updated: 'An upcoming recurring order changed and needs review.',
    occurrence_skip: 'The upcoming recurring order was skipped.',
    occurrence_edit: 'The upcoming recurring order was updated.',
    occurrence_cancelled: 'The upcoming recurring order was cancelled.',
};

function createPlanningNotificationService({
    Group,
    Occurrence,
    User,
    notifications,
    now = () => new Date(),
}) {
    return async function notify(payload, { job, signal }) {
        signal.throwIfAborted();
        const isGroup = job.type === 'group.notify';
        const recordId = isGroup ? payload.groupId : payload.occurrenceId;
        const row = isGroup
            ? await Group.findById(recordId).select('owner members state revision').lean()
            : await Occurrence.findById(recordId).select('owner plan state revision').lean();
        if (!row) return { skipped: 'record_unavailable' };
        if (!isGroup && !row.plan) return { skipped: 'plan_unavailable' };
        const recipients = isGroup
            ? [...new Set((row.members || []).filter((member) => member.state === 'active').map((member) => String(member.user)))]
            : [String(row.owner)];
        if (!recipients.length) return { skipped: 'no_recipients' };
        const message = MESSAGES[payload.event] || 'Your planned order has an update.';
        const relatedModel = isGroup ? 'GroupOrder' : 'RecurringOccurrence';
        const update = {
            _id: job._id,
            type: 'order_update',
            message,
            read: false,
            createdAt: now(),
            relatedId: recordId,
            relatedModel,
            plannedOrder: {
                kind: isGroup ? 'group' : 'recurring',
                id: isGroup ? recordId : row.plan,
            },
        };
        await User.updateMany(
            { _id: { $in: recipients }, 'notifications._id': { $ne: job._id } },
            { $push: { notifications: update } },
        );
        signal.throwIfAborted();
        if (!notifications.hasAudienceConfiguration('customer')) {
            return { inApp: true, pushSkipped: 'not_configured', recipients: recipients.length };
        }
        if (!job.deliveryKey) {
            throw Object.assign(new Error('Missing delivery identity.'), {
                jobCode: 'missing_delivery_key',
                retryable: false,
            });
        }
        const response = await notifications.createNotification('customer', {
            headings: { en: 'NaijaGo planned order' },
            contents: { en: message },
            include_aliases: { external_id: recipients },
            target_channel: 'push',
            idempotency_key: job.deliveryKey,
            data: {
                type: isGroup ? 'group_order_update' : 'recurring_order_update',
                recordId: String(recordId),
                ...(isGroup ? {} : { planId: String(row.plan) }),
            },
            ...notifications.getPlatformOptions('customer'),
        });
        if (!response.body?.id || response.body?.errors) {
            throw Object.assign(new Error('No confirmed push recipient.'), {
                jobCode: 'push_recipient_unavailable',
                retryable: false,
            });
        }
        return {
            inApp: true,
            pushAccepted: true,
            recipients: recipients.length,
            providerId: response.body.id,
        };
    };
}

module.exports = { createPlanningNotificationService, MESSAGES };
