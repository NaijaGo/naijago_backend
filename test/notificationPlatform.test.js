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

test('OneSignal transport uses current authentication and alias targeting', async () => {
    const previousAppId = process.env.RIDER_ONESIGNAL_APP_ID;
    const previousApiKey = process.env.RIDER_ONESIGNAL_REST_API_KEY;
    const previousHttpClient = notificationService.httpClient;
    let request;

    process.env.RIDER_ONESIGNAL_APP_ID = '00000000-0000-4000-8000-000000000000';
    process.env.RIDER_ONESIGNAL_REST_API_KEY = 'Key test-key';
    notificationService.httpClient = {
        post: async (...args) => {
            request = args;
            return { data: { id: 'message-id' }, status: 200 };
        },
    };

    try {
        const response = await notificationService.sendToUser(
            'rider-id',
            { title: 'Job', message: 'New job', data: { type: 'order_assigned' } },
            { audience: 'rider' },
        );

        assert.equal(request[0], 'https://api.onesignal.com/notifications');
        assert.equal(request[1].app_id, process.env.RIDER_ONESIGNAL_APP_ID);
        assert.deepEqual(request[1].include_aliases, { external_id: ['rider-id'] });
        assert.equal(request[1].target_channel, 'push');
        assert.equal(request[1].existing_android_channel_id, 'naijago_rider_jobs_v1');
        assert.equal(request[2].headers.Authorization, 'Key test-key');
        assert.equal(response.body.id, 'message-id');
    } finally {
        notificationService.httpClient = previousHttpClient;
        if (previousAppId === undefined) delete process.env.RIDER_ONESIGNAL_APP_ID;
        else process.env.RIDER_ONESIGNAL_APP_ID = previousAppId;
        if (previousApiKey === undefined) delete process.env.RIDER_ONESIGNAL_REST_API_KEY;
        else process.env.RIDER_ONESIGNAL_REST_API_KEY = previousApiKey;
    }
});
