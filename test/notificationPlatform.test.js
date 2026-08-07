const test = require('node:test');
const assert = require('node:assert/strict');

const notificationService = require('../services/notificationService');

test('rider pushes use the native urgent channel and custom sound', () => {
    const previousSound = process.env.RIDER_NOTIFICATION_SOUND;
    delete process.env.RIDER_NOTIFICATION_SOUND;

    try {
        const options = notificationService.getPlatformOptions('rider');

        assert.equal(options.existing_android_channel_id, 'naijago_rider_jobs_v1');
        assert.equal(options.android_channel_id, undefined);
        assert.equal(options.android_sound, 'rider_job_alert');
        assert.equal(options.priority, 10);
    } finally {
        if (previousSound === undefined) {
            delete process.env.RIDER_NOTIFICATION_SOUND;
        } else {
            process.env.RIDER_NOTIFICATION_SOUND = previousSound;
        }
    }
});

test('customer pushes continue using a OneSignal channel', () => {
    const options = notificationService.getPlatformOptions('customer');

    assert.ok(options.android_channel_id);
    assert.equal(options.existing_android_channel_id, undefined);
    assert.equal(options.android_sound, 'default');
});
