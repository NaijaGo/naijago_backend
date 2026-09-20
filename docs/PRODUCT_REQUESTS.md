# Product requests and private AI concepts

Part of REQUEST-01/REQUEST-02 in INTEGRATED_RELEASE_CHECKLIST.md. This is a
development checkpoint, not production/provider/device acceptance. Off by default.

## Customer and admin flow

1. A submitted search with no results offers Request This Product. Search errors
   must remain errors, not be treated as an empty catalog.
2. Continue saves an owner-private text draft with a retry identity. It neither
   submits to admin nor generates an image. Notes are optional and bounded.
3. An optional concept requires explicit consent to send the search description
   to Gemini. No account details or notes are sent. The server rechecks actual
   catalog matches, eligibility and stock before queueing a paid attempt.
4. The image is labelled AI-generated concept - not an actual product. Not for
   sale. It has no price, stock, offer or add-to-cart action. Text-only requests
   work without image generation. No Product or ProductOffer is invented.
5. Request This Product submits the draft to admin. My product requests in
   Account/search provides paginated history; notification taps open the request.
6. Product Moderation in admin contains the sourcing queue. Admin can source,
   explain unavailability or match an actual eligible catalog listing.
7. Customer sees the status/reason and can open the real listing. Its publication,
   vendor approval, offer and stock are revalidated, then the existing product
   details/cart/checkout flow applies. A concept never becomes an order.

## State, privacy and consistency

- States: draft -> requested -> sourcing -> matched or unavailable. Admin can
  reopen matched/unavailable requests for sourcing. Owners can cancel; cancelled
  requests cannot be reopened. There is no order/payment cancellation here.
- Unsubmitted drafts, including cancelled unsent drafts, are owner-only. Admin
  sees only submitted requests. Authentication is required; rider accounts cannot
  access customer request routes. Client-supplied owner/admin flags are ignored.
- Unique (owner, clientRequestId) plus input hash makes creation retries stable.
  Reusing a key with different content fails. Status updates require a current
  revision, allowed transition and, for admin, a customer-facing explanation.
- Status/history plus the deduplicated notification job commit in one Mongo
  transaction. statusRevision is separate from preview revisions. Old status
  jobs skip instead of sending stale updates. Inbox IDs and OneSignal delivery
  identities are stable across retries; push content excludes query and notes.
- Original request history is retained. No automatic deletion is implemented.
  Retention, account erasure and authenticated orphan-asset cleanup are explicit
  release gates, not a claim that assets already expire or are removed.

## Existing infrastructure reused

- Mongo replica-set transactions, BackgroundJob leases and AiUsageBucket quotas.
- Existing Gemini image model/adapter, Cloudinary account and customer OneSignal.
- Cloudinary authenticated, immutable per-request/per-generation media; API
  responses issue five-minute signed download links only after owner/admin auth.
  A copied link is usable until expiry: it is not permanently public storage.
- One paid generation call per queued attempt. A checkpoint is persisted before
  that call. After a crash, recover the exact stored asset or show uncertain;
  do not blindly call Gemini again. This is not exactly-once provider delivery.
- Explicit retries use a new generation (maximum three per request), consent,
  a finite UTC daily global budget and a finite per-account budget. Quota and
  enqueue are transactional. Failed paid attempts keep their reservation; no
  automatic refund of a possibly consumed generation allowance.
- Job queue retry does not mean paid generation retry. Admin can retry
  request.notify with existing audited/age/attempt limits, never request.preview.
- Cancellation blocks publication of an in-flight result but cannot guarantee
  cancellation/refund of a provider call already accepted. Original order,
  payment recovery and product publishing paths are unchanged.

## Configuration register: names only

Do not enable these until the remaining acceptance gates pass. Web backend and
the separately hosted durable worker need consistent configuration and Mongo.

| Name | Purpose |
|---|---|
| PRODUCT_REQUESTS_ENABLED | Enable requests and request worker handlers |
| BACKGROUND_JOBS_ENABLED | Required durable worker foundation |
| PRODUCT_REQUEST_PREVIEWS_ENABLED | Separate opt-in for paid optional previews |
| GEMINI_PREVIEW_DAILY_LIMIT | Required positive global daily generation limit; capped at 1000 |
| GEMINI_PREVIEW_USER_DAILY_LIMIT | Per-account daily limit; default 3, capped at 10 |
| GEMINI_API_KEY / GEMINI_IMAGE_MODEL | Existing backend-only Gemini configuration |
| CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET | Existing backend-only image storage configuration |

Reuse the existing audience-specific customer OneSignal settings; never copy
provider secrets into Dart defines, screenshots or Git. No new paid account/key
was created. Worker command remains node workers/backgroundWorker.js. Index
readiness fails closed. Requests have account-scoped read/write rate limits;
those HTTP limits are per process, while generation budgets are durable Mongo.

## API summary

All paths are below /api/product-requests. Private responses use no-store.

| Method / path | Access / action |
|---|---|
| GET /config | Public enabled/previewEnabled capability flags |
| POST / | Owner: private draft, query/criteria/notes/clientRequestId |
| GET / | Owner: cursor-paginated history |
| GET /:id | Owner: safe request and expiring preview link |
| PUT /:id | Owner: submit/cancel with revision |
| POST /:id/preview | Owner: aiConsent=true and revision; bounded generation |
| GET /:id/product | Owner: revalidated real matched catalog product |
| GET /admin | Admin: submitted requests; status/query/cursor filters |
| GET /admin/:id | Admin: submitted request detail |
| PUT /admin/:id | Admin: status/message/revision and optional real productId |

## Verification and remaining gates

Offline coverage includes owner isolation, idempotency, stale updates, outbox
rollback, catalog truth, budgets, private storage, crash recovery, notification
dedupe and consent UI. Counts/results are recorded in the master tracker.

The Requests Atlas suite uses only synthetic, uniquely owned test collections
and simulated provider calls. User-supplied output after backend checkpoint
c67194b verified run 82f2a8d915cd4ac0b4ee2d9d7ff8c109: 7 passed, 0 failed,
0 skipped, about 78.0 seconds overall; no cleanup error reported. This covers
draft ownership/retries, concurrent submission, outbox rollback, simultaneous
preview reservation, global quota bounds and inbox deduplication. It does not
verify real AI generation, storage or push delivery. Future regression command:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\runAtlasIntegrationTests.ps1 -RunTests -Suite Requests

Run in naijago_backend, enter only the dedicated test credentials in the hidden
prompt, and share the summary, not credentials. No production MONGO_URI change.

Remaining acceptance: browser admin flows and permissions,
Android/iOS history/consent/keyboard/offline/resume/push routing, approved real
Gemini/Cloudinary/OneSignal smoke tests, worker deployment/restart/health/alerts,
load and storage limits, retention/erasure/orphan cleanup and privacy copy.
Do not enable the feature, deploy or publish a release just because unit tests pass.

Provider references reviewed: https://ai.google.dev/gemini-api/docs/image-generation
and https://cloudinary.com/documentation/control_access_to_media .
