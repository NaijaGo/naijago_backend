# Reviewed product photo cleanup

The Admin **Product moderation → Product image studio** processes existing
catalog photos. Customer apps reuse the existing product image fields; no new
checkout, price or inventory fields are introduced.

## Admin workflow

1. Search the existing catalog. Select up to 20 products across catalog pages.
2. Choose the standard white-background, centered, soft-shadow style. Relighting
   is optional; review colours carefully.
3. Click **Preview selected photos**. This calls authenticated
   `POST /api/image-refinements/preview` with `{ "productIds": ["..."] }`.
   The endpoint only reads products and existing reviews. It does not reserve
   budget, call Photoroom, enqueue work or change products.
4. Inspect the original photos and number of new images. A product can have
   several photos. Previously recorded sources are not automatically processed
   again. Unsupported/legacy URLs need a fresh upload through normal product
   management. Products with more than 40 sources require individual review.
5. Confirm permission to send the photos to Photoroom; queue the selected batch.
   Selection changes invalidate the preview. The worker checks products and
   daily image limits again. The preview is not a guaranteed budget reservation.
6. Refresh reviews when processing completes. Compare the preserved original
   with the private candidate. Check exact labels, packaging, colours, quantity
   and product identity. Reject distorted results; retake blurry/incomplete photos.
7. Approve with an accuracy confirmation and review reason. Approval queues
   publication; wait for **approved**, not merely **publishing**. Sandbox
   candidates cannot be published.
8. Approved publication replaces matching existing product/variant image URLs
   atomically. The original is retained. The customer app receives the new,
   versioned URL when it next fetches the product; stale cached catalog data may
   need a refresh. Ordinary vendor uploads are not processed automatically.

Start with a representative batch of 10–20 products before processing the full
catalog. Continue in reviewed batches; there is no automatic bulk approval.

## Configuration and release prerequisites

Configure provider credentials through the hosting environment's secret settings,
never source files or chat. Required variable names for the backend and worker:

- `BACKGROUND_JOBS_ENABLED=true`, `IMAGE_REFINEMENT_ENABLED=true`.
- `PHOTOROOM_API_KEY`, `PHOTOROOM_SANDBOX=true` for initial sandbox verification.
- Finite `PHOTOROOM_DAILY_LIMIT` and `PHOTOROOM_VENDOR_DAILY_LIMIT` image budgets.
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
- The worker uses the existing `MONGO_URI` database configuration. Test using a
  dedicated replica set, never a production connection for integration tests.

Run a separate Image Studio worker with `npm run worker:image-refinements`.
It handles only `image.refine` and `image.publish` jobs. Deploying the web server
does not start the worker. Other Admin features are not dependencies of this worker.

An operator must separately review/provision the declared collection indexes:

- BackgroundJob: unique `(type,dedupeKey)`; `(state,type,runAt,priority)`;
  `(state,leaseUntil)`; `(owner,createdAt)`; `(state,_id)`.
- ImageRefinement: unique `(product,sourceKey)`; `(state,_id)`.
- AiUsageBucket: TTL `expiresAt` with `expireAfterSeconds: 0`.

Inspect each model's exact index directions/options during rollout. Uniqueness
indexes must not be sparse or partial. The API and worker only inspect readiness;
they do not create these collections/indexes. No production database rollout is
performed as part of committing this code.

`GET /api/image-refinements/config` is Admin-only and returns `enabled`,
`processingEnabled` and `databaseReady` booleans without credentials. Processing
is disabled until provider/storage configuration, budgets and required indexes
are ready. This endpoint does not establish that a worker is running or prove
provider connectivity. No collections/indexes are automatically provisioned.
It also reports missing environment-variable names, sandbox mode, incompatible
key/mode configuration and the worker command, never secret values.

## Diagnosing a batch that is not processing

Run this from Render Shell on the backend after the diagnostic commit is deployed:

```sh
npm run diagnose:image-refinements -- --database-read-only --probe
```

This only reads collection/index metadata and topology; it does not create indexes,
write records, run transactions, queue work or publish images. The provider probe
requires `PHOTOROOM_SANDBOX=true`, forces a sandbox key, and processes one synthetic
test image. It uses sandbox allowance but never a real product photo or live credits.
The JSON output contains missing variable names and safe status codes, not keys,
connection strings, raw provider errors or image bytes. It is safe to share that
output. A provider PASS does not verify Cloudinary, product quality, worker liveness
or publication; those still need separate verification.

- HTTP 404: the running backend does not expose the Image Studio route.
- HTTP 401: the route requires an authenticated Admin session; it does not show
  that processing is configured or that a worker is running.
- Disabled: use the missing-setting names shown by Image Studio. The web service
  and dedicated worker each need the relevant configuration.
- Indexes not ready: request a reviewed index rollout; restarting the web service
  does not create the indexes.
- Stays queued: inspect the dedicated Render worker logs and confirm it runs
  `npm run worker:image-refinements`. Do not repeatedly queue the same batch.
- Uncertain: an interrupted provider attempt might have consumed allowance. Use
  explicit review/regeneration controls; do not assume a free retry.
- Pending review: processing succeeded but the original customer image remains
  unchanged until a permitted live candidate is approved and published. Sandbox
  candidates remain private and cannot be published.

Before production activation, verify against a dedicated transaction-capable
test database and provider sandbox: preservation, queue deduplication, daily
budgets, worker recovery, expired private links, moderation revision conflicts,
and rejection without product changes. Then verify a reviewed live candidate and
publication using authorized non-production products. Sandbox success alone
does not verify live publication. Backend and Admin must be released together
because the UI requires the new preview endpoint. This document does not
authorize production mutations or deployment.
