# Durable background jobs

This shared Mongo-backed queue is a release foundation. It does not replace the
existing payment recovery or scheduled-notification runners. New task types are
registered explicitly; arbitrary client-supplied code/type names are not executed.

## Guarantees and limits

- Unique `(type, dedupeKey)` plus canonical payload hash prevents accidental duplicate enqueue; a reused key with different input/owner is rejected.
- Atomic claims use expiring leases and random fencing tokens. A stale worker cannot acknowledge another worker's job.
- Three-minute leases are renewed every minute. Expired work can be reclaimed; exhausted jobs are marked failed.
- Retry delays grow from five seconds to at most fifteen minutes; a valid provider Retry-After can delay longer. Four attempts default, maximum eight. Most provider 4xx failures do not retry.
- Raw exceptions/request headers/API keys are never stored in job errors. Payloads must be plain JSON under 32 KiB; results under 128 KiB. Store file IDs/URLs, not file bytes.
- A stopped worker aborts the handler; unacknowledged work recovers after lease expiry.
- Delivery is **at least once**, not exactly once. Every handler must make its own external side effects idempotent, use the supplied AbortSignal and provider timeouts. A provider may have completed a request before a connection failed.
- Completed deduplication records do not automatically expire. Retention/archive policy must preserve paid-operation idempotency.

## Worker (not deployed or started by this implementation)

`node workers/backgroundWorker.js`

Required configuration: existing `MONGO_URI`, `BACKGROUND_JOBS_ENABLED=true`.
At least one task flag below must be enabled; an empty worker fails startup
before connecting instead of appearing healthy without any active handlers.
Registered tasks: `media.cleanup` (MEDIA_CLEANUP_ENABLED=true),
`media.revoke` (PRODUCT_VIDEO_ENABLED=true) and `explore.notify` (EXPLORE_ENABLED=true).
Media tasks reuse existing Cloudinary credentials. Explore uses the existing
audience-specific OneSignal credentials, including the vendor audience.
Do not enable cleanup until the dry-run/rehearsal/provider acceptance checks have
been performed. Deployment/hosting choice remains part of the release checklist;
no paid worker service has been created here. An always-running process is needed
for time-sensitive jobs; sleeping web services cannot promise on-time execution.

The production entrypoint now uses the locally tested managed lifecycle. It
connects, ensures queue/Explore indexes, then starts one non-overlapping polling
loop. Startup failures attempt database close within five seconds and emit only
sanitized diagnostics. SIGTERM/SIGINT stops polling, aborts the scheduler/handler,
and waits up to thirty seconds for the active tick before attempting database
close within five seconds. If either drain or close fails/times out, the process
exits unsuccessfully; otherwise it exits naturally once handles close. Set the
host shutdown grace period above this 35-second total, with operational margin,
and verify its actual behavior in staging before release. No Render worker has
been provisioned or restarted by these tests.

Media scans check cancellation before querying and between each enqueue/marker
operation. A shutdown after enqueue but before the scheduling marker is safe to
retry: the next scan reuses the existing queue identity. The worker never starts
another scan or claim after stop begins. In-flight provider effects still need
idempotency; cancellation cannot undo a request already accepted by a provider.

Cleanup scans at most fifty assets/hour. It only targets invalid, abandoned or
never-completed uploads whose ticket expired more than seven days ago. It skips
every product-referenced video and every approved/pending-review video, validates
the owner-scoped Cloudinary path, and records a deletion receipt only after provider
confirmation. Product images and other existing Cloudinary assets are not targets.
After confirmed deletion these temporary files cannot be recovered from Cloudinary
through this feature; original source files should remain with their uploader.

Rejected videos are hidden from public APIs immediately. Every new rejection of a
verified upload stores a pending revocation in the same asset save. The worker scans
these records every fifteen seconds, queues a high-priority rename and requests
Cloudinary CDN invalidation. The original is preserved under another authenticated
identifier. Retries first check whether the rename already completed. Approval is
blocked while revocation is pending. Previously downloaded/browser-cached copies
cannot be recalled; provider/CDN propagation is not instantaneous. Real-provider
rename/derived-playback/invalidation acceptance remains a release gate.

Admin background-work panels are on Product moderation and Carousel slides.
GET /api/admin/background-jobs returns only safe metadata, never payloads,
results, credentials or provider deduplication keys. Failed allowlisted jobs
younger than seven days can be retried at most three times with a required reason
and matching revision. Original provider keys are retained. Payment jobs cannot
be retried here. There is no automatic retry after configuration failures.

Explore notification outbox records are written in the same database transaction
as reactions/comments. Workers save one in-app notification per job and use a
stable OneSignal idempotency key. Self, blocked, removed and stale activity is
skipped. Push acceptance is not proof that a device displayed a notification.

## Before release

- Verified 2026-09-20 from user-supplied isolated Atlas run 265adef2f39e42df98611b23ba1191ba: concurrent enqueue/claim identity, simulated lease expiry and stale completion rejection, transactionally deduplicated reaction/comment notifications, and rollback on injected outbox failure. Four subtests plus parent passed, with no failures or skips. This confirms database behavior under parallel calls, not actual delivery to a device.
- Verified 2026-09-20 from user-supplied isolated Atlas run 112424a7e8be4f40a4dc8e8fc1d6bac6: Workers passed 5/5 with no failures/skips or reported cleanup error. Separate Node processes/connections used the actual queue/runner with synthetic jobs, a simulated provider and controlled lease clocks. Competing claims, crash after provider acceptance before acknowledgment, graceful stop and exhausted attempts passed. See ISOLATED_DATABASE_TESTS.md.
- Production lifecycle offline tests passed 17/17: startup/index-failure cleanup, enabled-handler validation, single-flight scheduling, bounded drain/close, cancellation between scans/queue writes, repeat-stop behavior and secret-safe diagnostics. The Atlas process suite does not start the production worker entrypoint or validate Render hosting. Still rehearse host SIGTERM/restart timing, health/alerts and actual provider idempotency; do not equate a simulated provider receipt with device delivery.
- Verify Cloudinary deletion on a deliberately abandoned test upload only.
- Verify admin visibility/retry/audit against a real isolated Mongo database and browser. Cancellation UI and worker-health alerts remain pending.
- Complete image refinement/preview jobs, media takedown/revocation and scheduled workflow handlers.
- Configure monitoring for failed/exhausted jobs, oldest queued age and worker heartbeat.
