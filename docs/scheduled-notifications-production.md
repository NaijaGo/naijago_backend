# Scheduled Notifications Production Runbook

The backend can run scheduled admin notifications in-process for local development, but production should run the scheduler as a separate worker so scheduled messages survive web server restarts and scale cleanly.

## Web Process

Set this environment variable on the normal API/web process:

```bash
DISABLE_IN_PROCESS_SCHEDULED_NOTIFICATIONS=true
```

Start the API as usual.

## Worker Process

Run one worker process:

```bash
npm run worker:scheduled-notifications
```

Recommended environment variables:

```bash
SCHEDULED_NOTIFICATION_WORKER_INTERVAL_MS=60000
SCHEDULED_NOTIFICATION_STALE_MINUTES=10
```

The worker checks due scheduled messages, recovers stale `sending` jobs back to `scheduled`, sends the notification, and updates the scheduled record to `sent` or `failed`.

## Deployment Notes

- Run exactly one scheduler worker per environment unless you add a distributed lock.
- Keep the worker connected to the same MongoDB database as the API.
- Monitor worker logs for `Scheduled notification worker tick failed`.
- If a deploy restarts the API, queued scheduled messages remain in MongoDB and the worker continues processing them.
