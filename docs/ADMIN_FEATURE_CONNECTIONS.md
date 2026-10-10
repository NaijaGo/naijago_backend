# Admin feature connections

These routes connect the existing Admin panels; they do not activate a production
provider, change checkout, or start a worker inside the web process.

## Endpoints

- GET `/api/explore/admin/reports`; PUT `/api/explore/admin/reports/:id`.
- POST `/api/explore/reports` submits a report against an existing public
  product, Explore campaign or current Explore video comment.
- GET `/api/admin/background-jobs`; POST `/:id/retry` within this route.
  Only `request.notify` jobs can be manually retried, at most three times within
  seven days. Existing Explore/media job records are visible but read-only.
- GET `/api/product-requests/admin`; GET/PUT `/api/product-requests/admin/:id`.
  Only submitted sourcing requests are visible to Admin. Customer draft,
  submission, cancellation, detail and matched-product routes reuse the original
  implementation under `/api/product-requests`.
- GET `/api/image-refinements/config`; GET `/api/image-refinements`;
  POST `/api/image-refinements/preview` (read-only selected-photo inspection);
  POST `/api/image-refinements/batch`; GET/PUT `/api/image-refinements/:id`.

All Admin routes enforce backend Admin authentication. Moderation needs a reason;
mutations use revisions and MongoDB transactions where required. Old comments
without a moderation state remain visible. Hiding is not deleting criticism.

## Configuration and worker

- `BACKGROUND_JOBS_ENABLED=true` gates feature mutations and worker startup.
- `PRODUCT_REQUESTS_ENABLED=true` enables sourcing submission/updates.
- `PRODUCT_REQUEST_PREVIEWS_ENABLED=true` additionally enables optional concepts.
- Concepts require `GEMINI_API_KEY`, the existing Cloudinary configuration,
  `GEMINI_PREVIEW_DAILY_LIMIT`, and optional `GEMINI_PREVIEW_USER_DAILY_LIMIT`.
- `IMAGE_REFINEMENT_ENABLED=true` enables reviewed image processing.
- Processing additionally requires `PHOTOROOM_API_KEY`, `PHOTOROOM_DAILY_LIMIT`,
  optional `PHOTOROOM_VENDOR_DAILY_LIMIT`, and `CLOUDINARY_CLOUD_NAME`,
  `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
- `PHOTOROOM_SANDBOX` defaults to sandbox. Sandbox images cannot be published.
- A separate worker runs `npm run worker:admin-features` using the deployment's
  existing database configuration. Do not run it against production for testing.

No automatic image-processing hooks are attached to ordinary product edits.
Admin must explicitly queue a batch; originals remain preserved and private
candidates require human review before publication. Existing Gemini image calls
keep their default behavior; concepts request a single provider attempt.
See `PRODUCT_PHOTO_CLEANUP.md` for the existing-product batch workflow.

## Database rollout prerequisites (not executed by this change)

Use a dedicated transaction-capable replica set for integration verification.
Transactions are required for coordinated request/job and refinement/job changes.
New models disable automatic collection/index creation. API readiness inspects
indexes only; missing/incompatible indexes reject writes. A separately reviewed
operator rollout must create and verify the declared indexes before activation:

- BackgroundJob: unique `(type, dedupeKey)`; `(state,type,runAt,priority)`;
  `(state,leaseUntil)`; `(owner,createdAt)`; `(state,_id)`.
- ProductRequest: unique `(owner,clientRequestId)`; `(owner,_id)`; `(state,_id)`.
- ImageRefinement: unique `(product,sourceKey)`; `(state,_id)`.
- FeedReport: unique `(reporter,targetType,target)`; `(state,createdAt)`.
- AiUsageBucket: `expiresAt` with TTL 0.

Uniqueness indexes must be non-sparse and not partial. Do not normalize stock,
migrate historical orders, delete existing records, or replace existing indexes
without separate review. Public catalog prices still use the current Deal resolver.
Matching requires approved active products, remaining unreserved stock and an
available approved vendor. Unsupported search criteria are rejected explicitly.

## Release verification still required

Syntax/module loading and unauthenticated route checks do not prove persistence,
transactions, concurrent moderation, provider spending or successful publication.
Verify those against a dedicated test replica set, then perform an authenticated
Admin browser check against the test backend. Production database changes, configuration and deployment require separate runtime verification.
