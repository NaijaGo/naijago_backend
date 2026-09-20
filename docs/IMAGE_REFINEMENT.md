# Product image refinement

Local implementation for REFINE-01 / REFINE-02. Disabled by default. The isolated
Atlas gate passed with simulated providers. Real Photoroom/Cloudinary, admin
browser and device acceptance remain pending.
This document does not authorize production activation or a paid provider call.

## Existing architecture, not a second catalog

- Product IDs, offers, prices, stock, moderation/publication status, checkout and
  order history stay unchanged. The customer app reads its existing image fields.
- With IMAGE_REFINEMENT_ENABLED, a new/changed vendor image saves a durable pending
  marker on the same product write. Restarting the web server cannot lose it.
- The existing Mongo worker scans at most five marked products per minute. Admin
  bulk selection marks up to 20 existing products per request without waiting for
  the image provider. Each product can contain up to 40 distinct image sources.
- One ImageRefinement record per product/source/seller, with deduplicated jobs,
  records the original, candidate generations, review reasons and publication.
  Reassignment prevents old-seller work from publishing and permits a new review.
- Only versioned HTTPS URLs in this installation's Cloudinary product folders
  are accepted: naijago_products, naijago_product_views, naijago_ai_catalog_drafts.
  Legacy external/unsupported images require re-upload. No arbitrary URL fetches,
  redirects, SVG, other tenants or onboarding/private-document folders.

## Processing and publication

    Product upload / admin batch
      -> durable marker -> transactional quota + image.refine job
      -> authenticated immutable original copy
      -> paid-call checkpoint -> authenticated candidate
      -> admin compares Original / Refined
      -> reject OR explicitly approve -> image.publish job
      -> public versioned copy -> transactional image-only replacement

Originals and candidates use authenticated Cloudinary storage with five-minute
review links. Originals are never overwritten or deleted by this feature.
Published copies have separate versioned paths, so existing caches do not conceal
an approved change. ImageUrls, structured main/front/back/rear/others and variant
image mirrors are updated together without changing variant stock or prices.

New candidates never become customer images automatically. Existing product
images remain in place during processing or failure. Existing product moderation
rules still apply; approving an image does NOT activate a draft/disabled listing.
The product/seller/source is checked again before publication. A vendor image
edit loaded before approval fails its stale-save guard rather than overwriting it.

Standard style: remove background, white background, centered square 1000x1000,
15% padding, soft shadow. Relight is an explicit review/regeneration option using
Photoroom's hue/saturation-preserving lighting mode. It can still change appearance;
review colours, logos, text, material, quantity and identifying details. We do not
use a beautifier, invented replacement object, text removal, expansion or upscaling.
Reject unsuitable results; do not promise pixel-perfect identity preservation.

Images are bounded to JPEG/PNG/WebP, 10 MiB and 20 megapixels for storage metadata.
Provider responses are checked for allowed MIME/magic bytes and size. Photoroom
has additional feature-specific limits; real large-image/relight acceptance is a
provider gate. Uploading originals directly remains the fallback for unsupported
images, not silently inventing a product or disabling its purchase.

## Costs, retries and failure states

- Transactional global and per-seller UTC-day reservations use existing
  AiUsageBucket records. Defaults fail closed without an explicit global limit.
- Repeated batch requests reuse existing image records/jobs without paying again.
- A generating checkpoint is persisted before Photoroom. After a crash or timeout,
  recover the exact candidate path or mark uncertain. No automatic paid re-call.
- Admin Regenerate is explicit, reserves another quota slot and is capped at
  three generations per image/seller identity. Previous candidates remain in
  audit history. Reservations are conservative limits, not a billing receipt;
  failed attempts are not refunded into the retry budget.
- Queued work whose reservation day expired cannot call Photoroom using that old
  budget. It reports budget_window_expired; an explicit fresh attempt is needed.
- Original preservation and approved publication may retry at immutable storage
  paths. Publication swaps product references only after confirmed storage.
- Sandbox candidates cannot be approved. Configure live mode and explicitly
  regenerate if a reviewed sandbox sample should become a publishable candidate.
- Failed publication can be retried through its image review, at most three manual
  retries; it does not rerun Photoroom. Generic job administration does not expose
  paid image-refinement retries.

## Configuration register (backend AND worker, never Flutter or Git)

| Name | Meaning |
|---|---|
| IMAGE_REFINEMENT_ENABLED | Explicit true enables API/workflow; default off |
| BACKGROUND_JOBS_ENABLED | Existing worker feature flag; required |
| PHOTOROOM_API_KEY | New secret, from the Photoroom API dashboard; not confirmed configured |
| PHOTOROOM_SANDBOX | Defaults to sandbox unless exactly false; watermarked tests cannot publish |
| PHOTOROOM_DAILY_LIMIT | Required integer 1..1000; choose a low approved test budget first |
| PHOTOROOM_VENDOR_DAILY_LIMIT | Integer 1..500, default 20; NaijaGo direct products share a platform bucket |
| CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET | Reuse existing server-side storage configuration |

Obtain a Photoroom Image Editing API key through the official API dashboard linked
from https://docs.photoroom.com/. A consumer/mobile subscription alone is not proof
of API access. Do not sign up for a paid plan or activate billing implicitly.
When authorized for provider testing, set the key only in the staging backend and
worker's private environment. Use sandbox first and the same configuration on both
processes. Do not print keys or raw Axios errors, paste secrets into chat, or put
them in mobile Dart defines. No new customer-app key is needed.

Verified API contract references:

- https://docs.photoroom.com/getting-started/api-reference-openapi
- https://docs.photoroom.com/image-editing-api-plus-plan/quickstart-guide
- https://docs.photoroom.com/image-editing-api-plus-plan/ai-relight
- https://docs.photoroom.com/image-editing-api-plus-plan/sandbox-mode
- https://cloudinary.com/documentation/control_access_to_media

The adapter uses GET https://image-api.photoroom.com/v2/edit with x-api-key,
an expiring original image URL and fixed edit parameters. There are no provider
calls during unit or Atlas integration tests.

## Admin and vendor UI

Existing Product Moderation page -> Product image studio. Search the existing
admin catalog, select up to 20 products across pages, choose style, acknowledge
image-processing permission and queue. The worker creates review cards. Statuses
show queued/preserving/generating/pending review/publishing/completed or problems.
Unfiltered first-page pending cards refresh on a bounded timer; filtered or older
pages have Refresh reviews. Compare original/candidate, enter a reason, confirm
identity/rights to approve, or reject/regenerate. Expired private links need refresh.
The vendor upload screen includes an image-processing/review notice.

Admin-only endpoints: GET /api/image-refinements/config, GET /api/image-refinements,
POST /api/image-refinements/batch, GET/PUT /api/image-refinements/:id. Authenticated
actor is server-owned. Reads and writes are rate-limited; responses are no-store
and do not expose raw provider exceptions or credentials.

## Validation and remaining release gates

Final local checkpoint: 214 backend tests passed, 0 failed, 5 database suites
deliberately skipped (219 total, about 55.7 seconds). Twenty refinement/API tests
are included. Admin JavaScript and PowerShell syntax checks passed; the vendor
notice passed Dart parse-checking without a build. These are not browser/device
or real-provider results.

Offline tests cover URL boundaries, storage privacy, byte validation, immutable
recovery, quotas, duplicate staging, asynchronous bulk marking, approval rollback,
stale sellers/images, generation caps, expired budgets and admin authorization.
The Atlas suite uses actual schemas/transactions with synthetic products and
mocked providers. Run it from the backend repository:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\runAtlasIntegrationTests.ps1 -RunTests -Suite Refinement

It checks seven subtests plus their parent: concurrent dedupe, outbox rollback,
original preservation, concurrent publication/stale vendor saves, reassignment,
global budgets and durable upload scheduling. Test records stay in this run's
isolated collections on the already-approved test cluster. Never use MONGO_URI.

User-supplied Atlas result (2026-09-20), after checkpoint e2afcfe: run
14f152de66ce4493b7257c05ee47223b, 8 passed, 0 failed, 0 skipped, about 71.8 seconds
overall. All seven subtests plus the parent passed; no cleanup error was reported.
Photoroom and Cloudinary were simulated, so this is database/workflow evidence,
not actual image-quality, paid-provider or storage-access acceptance. Retain the
command above for relevant regressions; no repeat is needed to record this pass.

Still required: actual sandbox processing and private-link
expiry/access checks; approved small live provider test; budget visibility and
alerts; admin browser/a11y/error/permission tests; vendor/customer device regression;
worker hosting/restart rehearsal; updated processing/privacy copy. Original and
candidate retention, account erasure, approved-image takedown/revert and unreferenced
public-copy cleanup share the REQUEST-03/media lifecycle release gate. No automatic
media deletion is introduced here. No push/deployment/build has been performed.
