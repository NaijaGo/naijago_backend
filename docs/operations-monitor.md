# Operations and anonymous visitor monitoring

This addition is local and disabled by default. It does not enable planned orders,
change inventory, alter checkout amounts, or replace the existing activity alerts.

## Admin controls

Open `operations-monitor.html` in the Admin Panel. The server requires the existing
authenticated `isAdmin` authorization for every monitoring read and settings write.
Settings are stored in `AppSetting`, key `operations_monitor`, under `operationsMonitor`:

- `visitorTrackingEnabled`: consent-based app/website page statistics, default false.
- `updatesEnabled`: scheduled database summaries, default false.
- `pushEnabled`: existing Admin push for scheduled summaries, default false.
- `intervalMinutes`: whole number 15–1440, default 60.

Instant operational alerts reuse the existing ActivityEvent/socket/notification bell.
Scheduled summaries also use that feed; optional push requires the existing Admin
push provider and a subscribed admin device. No new provider or secret is added.

## API

- `GET /api/analytics/visitor-config`: public enablement flag.
- `POST /api/analytics/visitor`: consent-required, rate-limited, allowlisted page event.
- `GET /api/admin/operations-monitor/settings`: settings and push configuration status.
- `PUT /api/admin/operations-monitor/settings`: validated Admin-only settings.
- `GET /api/admin/operations-monitor/overview`: last-24-hour figures and latest 10 digests.
- `GET /api/admin/operations-monitor/visitors?days=1&page=1`: guest statistics and
  30 recent events per page; days 1–30, page 1–1000.

Visitor payload: `sessionId` (32 hex characters), `source` (`customer_app` or `website`),
`page` (allowlisted name), `deviceClass` (coarse category), `consent` (true).
User identity, when present, comes only from a verified JWT. The raw random session
is SHA-256 hashed server-side. Clients rotate it daily. No IP, raw user agent,
contact details, GPS, search terms, query strings or form values are persisted by
this endpoint. Clients offer withdrawal of consent. Anonymous statistics measure
sessions, not identified people, and exclude unconsented visits. Client analytics
are self-reported and are not fraud-proof business/accounting evidence.

Customer app coverage is the main Home/Cart/Categories/Explore/Account tabs.
Website coverage is Home/About/Contact/Download/Policies/Privacy/Delete Account.
Detailed product and nested app screens are not instrumented in this version.

## Summaries and availability

Summaries currently use verified counts and deterministic rules, not AI. Gemini
egress is not implemented pending explicit approval for the aggregate payload.
No customer or order records leave the backend through this addition.

The runner checks once per minute and processes the latest completed reporting
window while updates are enabled and this backend process is running. It does not
backfill missed windows after downtime. An always-running backend is required for
continuous operation; a sleeping/stopped hosting instance cannot produce alerts.
MongoDB `_id` uniqueness and leases coordinate interval processing. Existing push
delivery is best effort; a crash between sending and recording push state can
still produce a duplicate notification on retry. This is not exactly-once push.

Counts of paid orders mean orders created in the reporting window that are paid
at snapshot time, not a payment ledger. Open disputes and pending fulfilment are
current backlogs at generation time. Failed notifications count existing recorded
failures; unlogged failures and delayed webhook events are not inferred.

## Database prerequisites before enabling

No production database operations have been performed during development.
Verify declared indexes exist in the deployment database before enabling:

- AnalyticsEvent `{ dedupeKey: 1 }`: unique, sparse (existing events unaffected).
- AnalyticsEvent `{ expiresAt: 1 }`: TTL, `expireAfterSeconds: 0`.
- AnalyticsEvent `{ eventType: 1, createdAt: -1 }`.
- OperationsDigest implicit unique string `_id`.
- OperationsDigest `{ expiresAt: 1 }`: TTL, `expireAfterSeconds: 0`.

New visitor events and digests receive expiry dates 30 days after creation.
TTL deletion is asynchronous and requires the indexes above. Existing analytics
events do not receive expiry dates. Business/order records are never deleted by
this feature. Database integration, index presence and push delivery require
dedicated verification before deployment and activation.
