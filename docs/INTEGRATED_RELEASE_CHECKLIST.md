# NaijaGo integrated release tracker

Started 2026-09-20. User authorized implementation of the integrated release across backend, customer, vendor, rider, admin and website. Scope: conversation requirements plus `naijagomainapp/new_feature_to_add_docs.pdf` (10 pages).

## How to use this tracker

States: Pending -> Working -> Implemented -> Tested -> Deployed -> Device verified. Record evidence, blockers and remaining tasks. No unsupported completion percentages. Local tests do not imply a production deployment or device verification. Work in verified vertical slices within one release programme. Do not run paid provider calls, transactions or production migrations as automated tests.

## Baseline

Local remote-tracking refs have not been freshly fetched.

| Repository | Branch | Starting commit | Existing changes |
|---|---|---|---|
| naijago_backend | main | f6b85c4 | Clean |
| naijagomainapp | main | 390718f | Untracked requirements PDF; preserve |
| go-vendor | main | 5442a13 | Clean |
| Go-Rider | main | 7f0394b | Clean |
| naijago.com_admin_panel | master | 1cf8204 | Clean |
| naijagoapp.com- | main | ff8650a | Clean |

Workspace root has no usable Git repository. Cross-repository tracker lives here; app changes/tests live in their own repositories. Never commit environment files, keystores or credentials.

## Requirements matrix

| ID | Requirement / acceptance criteria | Components | State |
|---|---|---|---|
| BASE-01 | Regression tests for payments, stock, sellers, pickup, addresses, notifications; document existing failures | Backend/apps | Working: shared authoritative checkout and transaction-only variant stock connected locally; 21 new service/HTTP regressions and Checkout Atlas 6/6 passed; payment freshness/reconciliation and cross-app acceptance pending |
| BASE-02 | Retain/version PDF, tracker, configuration/deployment/test evidence | All | Working |
| BASE-03 | Backup, dry run, repeatable migrations and rollback before backfills | Backend | Pending |
| BASE-04 | Review vulnerabilities, startup, credentials/log hygiene; no blind forced upgrades | All | Pending |
| ADDR-01 | Exactly one address mode; manual remains selected; coordinates match address; cancelling saved selection preserves previous details | Customer | Tested locally; device pending |
| ADDR-02 | Complete suggestion triggers quote; incomplete selection explains missing fields; Apply resolves then calculates; stale responses discarded | Customer/backend | Tested locally; device pending |
| ADDR-03 | Preserve autocomplete, 3-4 visible results, scroll/keyboard handling, neutral scrollbar, delivery/pickup/payment | Customer | Pending |
| HOME-01 | Remove homepage category section/cards while preserving category navigation elsewhere | Customer | Implemented; device pending |
| MEDIA-01 | Optional vendor video picker/preview/remove; maximum 60 seconds; size/format validation; five-point acknowledgement | Vendor/backend | Implemented; provider/device pending |
| MEDIA-02 | Compatible media model; original/processed asset/poster/duration/dimensions/uploader/moderation; signed uploads with ownership/expiry | Backend | Mock/API tests passed; provider pending |
| MEDIA-03 | Product video player/gallery, fullscreen/mute/replay, loading/error/data saver; no autoplay with sound | Customer | Implemented; device pending |
| MEDIA-04 | Video moderation/admin reason/approval, publish gates, processing retries, abandoned upload cleanup | Admin/backend | Implemented with mock tests; actual provider cleanup/revocation and browser checks pending |
| EXP-01 | Explore tab, paginated mixed feed, pinned active admin campaigns, Sponsored labels and vendor/product links | Customer/backend | Implemented; service/widget tests passed; Mongo/device/performance pending |
| EXP-02 | Admin banner/video form; advertiser/vendor/destination, preview, WAT scheduling/expiry, pause/reject | Admin/backend | Implemented; policy/syntax tests passed; browser/provider pending |
| EXP-03 | Like/Love/Wow/Thumbs Down; one current reaction/user, comments/replies, reporting/blocking and moderation | Apps/backend/admin | Implemented; mock/API tests and Atlas reaction/comment retry uniqueness + outbox rollback passed; browser/device/moderation acceptance pending |
| EXP-04 | Defined views/watch time/impressions; deduplicated server counters, concurrency/idempotency | Backend/customer | Qualified video watches implemented/tested with mocks; banner impressions, real races/device checks pending |
| EXP-05 | Vendor engagement notices and replies; aggregation/preferences and deep links | Vendor/backend | Outbox, preferences, dedupe, replies/deep links implemented; provider delivery and aggregation acceptance pending |
| EXP-06 | Visible-only video playback, caching, data usage, performance/accessibility | Customer | Manual muted playback and lifecycle/expiry guards implemented; device/data/performance/accessibility pending |
| SEARCH-01 | Central taxonomy; category path/audience/gender/type/brand/tags/vendor fields; legacy backfill/create/edit | Backend/admin/vendor | Working: attributes/forms/dry-run migration added; data audit pending |
| SEARCH-02 | Structured intent/synonyms, broad/specific searches and combined filters; true availability; relevance tests | Backend | Unit and real Atlas search/filter/offer/pagination tests passed; representative data audit/performance/device acceptance pending |
| SEARCH-03 | Collection heading/View All/subcategory chips/products across vendors, filters and pagination | Customer | Implemented; contract/device checks in progress |
| SEARCH-04 | Gemini strict-schema ambiguous-query classification; fast deterministic path, cache/timeouts/fallback/rate-cost limits | Backend | Unit and real Atlas cache/quota/lease tests passed with simulated AI; real model and latency acceptance pending |
| REQUEST-01 | Explicit zero-result AI preview; AI concept/not for sale label; no fake price/cart; async generation | Customer/backend | Implemented behind flags; offline customer/backend tests and isolated Atlas preview reservation/global budget tests passed; real provider/device acceptance pending |
| REQUEST-02 | Request This Product; admin sourcing queue/status/vendor match, customer history/notifications | Customer/admin/backend | Offline tests and isolated Atlas request privacy, concurrent submission, outbox rollback and inbox dedupe passed; browser/device/provider acceptance pending |
| REQUEST-03 | Request/media retention, account erasure and authenticated orphan cleanup; storage/rate limits and privacy copy | Backend/apps/admin | Release gate pending; no automatic deletion or erasure coverage claimed |
| REFINE-01 | Preserve original; automatic derivative refinement, background/light/centering/shadow; product identity preserved | Backend | Implemented locally with Photoroom adapter and durable upload marker; real provider/identity acceptance pending. See IMAGE_REFINEMENT.md |
| REFINE-02 | Original/refined compare, approve/reject/regenerate, versioned publication; bulk/retries/rate-cost controls | Admin/backend | Offline tests and isolated Atlas dedupe/quota/rollback/publication/stale-save/reassignment checks passed; real provider/browser/device acceptance and shared retention/takedown gate still open |
| SCHED-01 | Now/scheduled, WAT windows/lead time/cutoffs/advance bounds/capacity; expiring payment holds and booking races | Backend/customer | Working: reservation/calendar foundations tested offline; Planning Atlas capacity/retry/expiry/rollback cases passed. Actual checkout/slot integration pending. See ORDER_FEATURES.md |
| SCHED-02 | Multi-vendor split rules, reminders/reschedule/cancel, due-only dispatch and ops visibility | All relevant | Working: due-only dispatch policy tested; actual dispatch guards, rescheduling, notifications and all-app views not connected |
| REVIEW-01 | Delivered verified purchase; stars/text/max 5 JPEG-PNG-HEIC images, max 10MB originals, conversion/thumbnails/EXIF stripping | Backend/customer | Working: eligibility/byte rules and private Cloudinary conversion adapter tested with mocks; existing review route, UI and real decoder/metadata acceptance pending |
| REVIEW-02 | Reports/admin moderation/audit/customer notice; vendor replies without deleting criticism; photo filter/lazy load | Apps/admin/backend | Pending |
| GROUP-01 | Single vendor; owner pays; one destination/fee; invite/code, configurable limit (default 10), cutoff/realtime cart | Backend/customer | Working: actual existing MainOrder/Shipment creator now composed with owner-approved immediate group checkout in one transaction, tested offline; PlannedCheckout Atlas gate pending. Public API/screens, notifications and payment completion linkage pending |
| GROUP-02 | Member permissions/privacy, stock-price-availability rechecks, failure/cancel/expiry, analytics/order linkage | All relevant | Working: real catalog/aggregate-stock adapter, retained legacy sizes, expiring signed approval and retry/rollback tests passed offline; updated Mongo integration, abandonment, notification delivery and payment linkage pending |
| RECUR-01 | Weekly/biweekly/monthly/custom; reminder-to-pay, next/all edits, pause/resume/skip/cancel, occurrence linkage | Backend/customer | Working: calendar/service and earlier Atlas controls verified; pending future baskets/addresses now update transactionally, leaving paid/checkout-linked occurrences untouched. Future schedule edits, real checkout races, API/screens/payment integration pending |
| RECUR-02 | Current price-stock-vendor-address-slot checks, substitution preference/approval threshold, reminders/failure/admin oversight | Apps/backend/admin | Working: real catalog/shared quote composition, explicit approval and price-change metadata tested offline. Scheduled quotes fail closed without real slot validation; future-time pricing, substitution approval/UI, actual payment and notifications pending |
| RECUR-03 | PDF initial scope is reminder-to-pay; automatic charges require provider support/consent verification before inclusion | Backend | Pending decision |
| OPS-01 | Durable jobs, leases/retries/idempotency, feature flags, audit/analytics/permissions | Backend/admin | Atlas claim/lease/outbox and independent-process crash/restart tests passed; production startup cleanup, bounded shutdown and scheduler cancellation locally tested; hosting rehearsal, health/alerts, provider acceptance and remaining handlers pending |
| WEB-01 | Needed product/vendor/campaign/group deep links/fallback pages, privacy/UGC/advertising terms | Website/apps | Pending |
| RELEASE-01 | Compatibility with existing apps, migrations rehearsed, backup/rollback | All | Pending |
| RELEASE-02 | Unit/API/concurrency/E2E/performance; payment/webhook/notification/media failures, slow networks and device matrix | All | Pending |
| RELEASE-03 | Versions/signing/API36/iOS configuration, clean commits/push/deployment manifest, AAB/iOS internal testing | All | Pending |

## Previous radar: verify rather than assume complete

| ID | Item | Evidence / remaining work |
|---|---|---|
| OLD-01 | Squad checkout/recovery without duplicate settlement or stock changes | User reports end-to-end success; regression tests required |
| OLD-02 | Wallet deposits still use Flutterwave | Audit intended provider coverage before release |
| OLD-03 | Vendor OneSignal config | Missing vendor audience in latest live logs |
| OLD-04 | Vendor WhatsApp | Latest logs: Connection Closed |
| OLD-05 | Admin activity/browser push, rider sound/deep links | Previous implementation; verify complete event/device coverage |
| OLD-06 | Device verification, pharmacy role/presence/session, vendor locks, sidebar/combined filters | Previous work; regression/device tests |
| OLD-07 | NaijaGo seller/catalog/history/reassignment, Gemini drafts and reviewed images | Previous work; regression tests |
| OLD-08 | Low Cost store, fixed 57 naira commission, restaurant notes, branding/categories, authentic ratings/sales | Audit/protect existing implementation |
| OLD-09 | Pickup per seller, QR/code verification, hours/capacity/fees/analytics | Acceptance/concurrency tests |
| OLD-10 | API36, approved upload-key resets, rider iOS/Codemagic | Verify signing and deployment without exposing credentials |
| OLD-11 | Restaurant delivery coverage | Existing formatRadius helper forces a temporary 1000-km minimum despite vendor configuration. Review/remove this test override with coverage regressions before release; do not reuse it as scheduled-delivery coverage validation. |

## Configuration register (names only)

| Service | Known state | Required work |
|---|---|---|
| Gemini | Existing catalog integration | Verify supported APIs; reuse backend key/models; classify/preview limits |
| Product requests | Implemented, disabled by default | PRODUCT_REQUESTS_ENABLED, BACKGROUND_JOBS_ENABLED; separate PRODUCT_REQUEST_PREVIEWS_ENABLED and GEMINI_PREVIEW_DAILY_LIMIT / GEMINI_PREVIEW_USER_DAILY_LIMIT; reuse existing backend Gemini/Cloudinary/customer OneSignal; see PRODUCT_REQUESTS.md |
| Cloudinary | Existing images/carousels | Signed video uploads/transcoding/storage capacity |
| Geoapify | Existing autocomplete | Preserve config and test resolution |
| Squad | Hosted checkout/recovery live | Preserve rotated secret/webhook/recovery; wallet coverage audit |
| OneSignal | Existing audience services | Vendor config missing in latest logs; verify each audience |
| Photoroom | Adapter implemented; no confirmed key or real provider call | PHOTOROOM_API_KEY, PHOTOROOM_SANDBOX, PHOTOROOM_DAILY_LIMIT, PHOTOROOM_VENDOR_DAILY_LIMIT; IMAGE_REFINEMENT_ENABLED + existing background jobs/Cloudinary, configured privately on backend AND worker; see IMAGE_REFINEMENT.md |
| Video moderation | No confirmed provider | Inspect existing moderation before selecting service |
| Jobs | In-process runners exist | Audit durable Mongo queue vs external queue; avoid unnecessary paid infrastructure |
| WhatsApp | Provider connection error | Operational connection/configuration check |

## Execution evidence

- 2026-09-20: Quote-ID-fix final offline regression: 316 passed, zero failed, eight credential-gated database suites deliberately skipped (324 total, 37322.4985ms). Order-route parsing and Git whitespace checks passed. Local checkpoint only; corrected PlannedCheckout Atlas acceptance is still pending.

- 2026-09-20: PlannedCheckout rerun after b88e8fd, 066239891d744956b46d7ce2f703e225: user fixtures now succeed; two subtests passed and three failed plus parent (2 pass/4 fail, six total, 142165.7497ms). All failing scenarios stop at offer-ID validation, so concurrency/outbox/source-index acceptance remains pending. Reproduced the same INVALID_ITEM stack offline using real BSON IDs: summary overwrote canonical string offer ID with Mongo ObjectId, hidden by HTTP JSON but broken for direct group creation. Removed that override, keeping catalog input validation strict. Route fixture IDs now use real BSON values; added direct/HTTP variant parity, no-offer compatibility and hostile ID regressions. Focused checks 48/48 passed after the reproduced failures. No production data/index/credential change, paid call, push, deployment or build. Rerun the same PlannedCheckout Atlas gate; do not change database settings.

- 2026-09-20: Fixture-fix final offline regression: 313 passed, zero failed, eight credential-gated suites deliberately skipped (321 total, 36185.8851ms). JavaScript parsing and Git whitespace checks passed. No authenticated database/provider call or runtime change by the agent; corrected PlannedCheckout Atlas acceptance still pending.

- 2026-09-20: First PlannedCheckout Atlas attempt after f3ad920, run 36c0adf4516d4a3bad95d25346cc01f6, reached the test database but failed before checkout subtests: raw buyer/seller inserts omitted unique email/phone values (E11000 email_1, one inserted test user). No cleanup error reported. Corrected test fixtures with distinct synthetic identities and required fields; sequential User.create now applies validation/hashing. Three new offline regressions share the exact fixtures and check schema validity, actual unique-index fields and missing email/phone rejection; focused fixture/loader/harness tests passed 15/15. Production models, indexes, accounts and settings unchanged. PlannedCheckout remains unverified until the corrected suite passes; no push/deploy/build. See ISOLATED_DATABASE_TESTS.md.

- 2026-09-20: Actual immediate group checkout now composes the existing MainOrder/Shipment creator inside the source/order/outbox transaction. Source claiming plus a partial unique receipt index protects retry identity; individual items, seller/location and fee components are rechecked against the approved quote. HTTP private-context spoofing is rejected/ignored, and the creator never charges, decrements inventory or owns transaction commit. Added twelve offline regressions, including real schemas and isolated-loader guards. Final backend regression: 310 passed, zero failed, eight credential-gated Mongo suites skipped (318 total, 48377.2536ms); PowerShell parsing and diff checks passed. New PlannedCheckout Atlas suite prepared, NOT passed. Scheduled/recurring creation remains blocked; public planning APIs/screens, payment freshness/settlement and dispatch remain pending. New index needs backup/rehearsal before deployment. Existing restaurant radius override recorded as OLD-11. No new key, provider call, production write, push, deployment or build. See ORDER_FEATURES.md and ISOLATED_DATABASE_TESTS.md.

- 2026-09-20: Planned-checkout adapter checkpoint: real catalog/shared quote composition for groups and recurring templates, legacy selection preservation, expiring owner-bound HMAC approval, unpaid-order link checks and future pending-occurrence edit propagation. Recurring checkout writes the plan to conflict with controls; real race acceptance still pending. Added 21 local regressions; full backend suite 298 passed, zero failed, seven credential-gated Atlas suites skipped (305 total, 35199.8806ms). Existing delivery/pickup/subscription/Low Cost and HTTP quote contracts passed. Planning test fixtures now implement the new validator contract; prior Atlas passes do not validate these new changes. Scheduled validation fails closed; actual order/payment/dispatch adapters, public routes/workers and screens still pending. No new key, paid call, production database change, push, deploy or build. See ORDER_FEATURES.md.

- 2026-09-20: User ran Checkout against isolated Atlas after checkpoint 9c1cd18. Run 509083010de949d8b4f8f2d912e8a4ce passed six tests (five subtests plus parent), zero failed, zero skipped, 43191.5829ms overall; no cleanup error reported. Real Mongo verified catalog/offer/variant resolution, aggregate quantities, competing variant settlement stock updates, primary mirrors, secondary-seller isolation, seller/variant mismatch rejection, rollback and legacy no-offer protection. Seven prepared Atlas suites are now verified. This supersedes Checkout-pending notes below, not remaining payment/provider/dispatch or app acceptance gates. Evidence-recording checkpoint only: no runtime changes, test rerun, production database access, push, deployment or build.

- 2026-09-20: Final shared-checkout regression passed 277 tests, zero failed, seven deliberately skipped credential-gated Mongo suites (284 total, 63803.3936ms), including all 21 new service/HTTP cases. JavaScript/PowerShell syntax and diff checks passed. This supersedes the preliminary 275-test run below; Checkout Atlas remains unverified until the user runs it with hidden test credentials. No deployment or build.

- 2026-09-20: Shared checkout checkpoint: actual summary/creation use one Product/ProductOffer/seller resolver, validate legacy sizes and structured variants, aggregate quantities across shipments, reject ineligible offers without stale fallback, and ignore forged seller/location/item-price/tax values. Existing tax remains server-owned zero until a real server tax policy is configured. Wallet/provider inventory hook now atomically checks variant stock and updates primary mirrors without consuming another seller's inventory. Short errors and per-item restaurant notes are retained. Focused tests: 21 passed (12 service, 9 HTTP); delivery, pickup, subscription and 57-naira Low Cost commission covered. First full regression before the last two compatibility cases: 275 passed, zero failed, seven skipped. New Checkout Atlas suite prepared (five subtests + parent), NOT yet passed. Six prior gates remain verified. No push/deployment/build, database access or paid provider call. Fresh quote acceptance, paid-but-unfulfillable/historical-order reconciliation and scheduling/group/recurring wiring still required. See ORDER_FEATURES.md.

- 2026-09-20: Authorized by user. All source repositories clean; requirements PDF preserved. Sandbox fails with Windows deny-read ACL errors; direct apply_patch executable works through approved escalation.
- 2026-09-20: Confirmed manual Apply calls quote while address readiness is false; quote exits. Current-location card marks ready manual addresses selected. Saved-address switch may reuse older coordinates. Fix/tests in progress.
- 2026-09-20: Checkout state and widget tests passed (11): manual selection/automatic quote, required postcode/Apply, stale geocode/quote rejection, saved-address coordinate change, invalid coordinates. Homepage category block removed, main Categories tab retained.
- 2026-09-20: Pinned Flutter 3.35.6 / Dart 3.9.2 used. Local generated package config initially pointed to another SDK; refreshed with pinned SDK. No Flutter upgrade. Added video_player 2.10.0; lockfiles retain compatible resolution.
- 2026-09-20: Backend baseline 35 tests passed; after video additions 46 passed; after structured search 53 passed. Video tests include real HTTP routes with mocked database/provider, owner isolation, moderation authorization/revision/audit, feature flag and signed-upload validation. No paid API call or live database test performed.
- 2026-09-20: Customer and vendor targeted analyzer checks report no compile errors. Remaining findings are informational style/deprecation lints; device/build validation remains outstanding.
- 2026-09-20: Media API, vendor upload warning/preview/retry, admin video review and customer playback implemented behind PRODUCT_VIDEO_ENABLED (off by default). See PRODUCT_VIDEO.md for configuration and remaining cleanup/revocation/provider checks.
- 2026-09-20: Catalog search attributes, editable vendor/admin fields, deterministic intent/type/audience matching, offer-aware budget sorting, collection chips/pagination and dry-run metadata migration added. See SMART_SEARCH.md. Gemini/preview/request work not yet implemented.
- 2026-09-20: Combined customer test run passed all 13 tests (11 checkout + 2 search HTTP contract/error tests). Admin JavaScript syntax and Git whitespace checks passed. No production migration, provider call, release build or deployment performed.
- 2026-09-20: Local checkpoints: backend 39e4915, customer fdb41f9, vendor ff04a16, admin ff3bf88. Not pushed to avoid automatic deployment of an incomplete release. Rider/website unchanged.
- 2026-09-20: Durable Mongo job queue and disabled-by-default expired invalid-upload cleanup worker added. Queue unit tests: 7 passed. Cleanup/provider and multi-worker Mongo acceptance still need completing; no actual media deletion has been performed.
- 2026-09-20: Explore customer tab/feed, scheduled sponsored campaigns, reviewed video playback, reactions/comments/replies, reporting/blocking, vendor activity and push/inbox thread navigation implemented. Existing product/offers, carousel and User notification architecture reused. Admin campaign/report/job panels added. See EXPLORE.md.
- 2026-09-20: Media rejection now records durable access revocation; worker preserves original via authenticated rename and requests CDN invalidation. Cleanup/revocation handlers and admin retries tested with mocked providers only. No real media was deleted or renamed.
- 2026-09-20: Gemini strict-schema fallback wired only after zero catalog matches, with opt-out, six-second timeout, cached interpretations, Mongo-backed global/network quotas and model/numeric-token preservation. UI labels Smart matches. No paid AI call performed. See SMART_SEARCH.md.
- 2026-09-20: Full backend suite: 122 passed, 0 failed, 1 intentionally skipped isolated-Mongo suite. New tests cover queue/retry/fencing, notification outbox/preferences, feed eligibility, media review/revocation, AI budgets/cache/fallback, seller-price presentation and scoped temporary-file cleanup. These do not establish real database/provider behavior.
- 2026-09-20: Customer sequential regression run: 24 passed (11 checkout, 2 original search, 7 Explore service/widget, 4 notification navigation). Updated search suite then passed 3/3, adding AI opt-out/label coverage. Vendor notification-navigation suite: 4 passed. Earlier parallel Flutter loading timeout was replaced by successful sequential reruns; no timeout counted as a pass.
- 2026-09-20: Latest targeted customer/vendor analyzers exit 0 with informational style/deprecation lints only (customer 26, vendor 4 in the respective checked file sets). Admin/backend JavaScript syntax and Git whitespace checks passed. Release builds and devices are still pending.
- 2026-09-20: Added opt-in loopback-only replica-set race/rollback suite. Docker Desktop engine was unavailable; test deliberately skipped. Never reuse production MONGO_URI for it. See ISOLATED_DATABASE_TESTS.md.

## Current release boundary

- 2026-09-20: User ran Planning on isolated Atlas after checkpoint 9f64da3. Run e66534eddf03421eb7f0934a13ac8bcd passed 10 tests (nine subtests plus parent), zero failed, zero skipped, 43644.541ms overall; no cleanup error reported. Real Mongo verified capacity contention, reservation retry/expiry/settlement rollback, group limits/privacy/outbox rollback and recurring uniqueness/rollback/owner controls. Providers and commercial/order adapters were simulated. All six prepared Atlas gates have passed. Earlier connection blockers below are historical; their cause is still unknown, and no network/credential fix is claimed. Actual checkout/payment/dispatch, review/media moderation, API/worker and cross-app integration remain unfinished. This is a documentation-only local checkpoint; no push/deploy/build or new authenticated database call.

- 2026-09-20: Diagnostic-only follow-up validated by a full offline regression: 256 passed, 0 failed, 6 credential-gated Mongo suites skipped (262 total, 68189.5904ms); focused harness/diagnostic/safety suite 29 passed. Diff checks passed. Save this as a local test-harness checkpoint only, with no push/deploy. Actual Planning Atlas acceptance is still blocked on the next safe connection diagnostic, not marked passed by these mocked tests.

- 2026-09-20: After checkpoint 5eea634, the user reported TEST_DATABASE_CONNECTION_OK followed by another Planning connection-setup failure (13.2 seconds, zero subtests/fixtures reached). The cause remains unknown. Fixed the test harness's loss of safe diagnostics and taught the existing classifier to recognize MongooseServerSelectionError. No credential, IP, timeout/pool, production or application behavior was changed. Focused diagnostic/harness/safety regression: 29 passed, zero failed. Planning Atlas remains unverified; the next run will expose a safe code/stage/guidance if connection fails. See ISOLATED_DATABASE_TESTS.md.

- 2026-09-20: Final local foundation regression completed: 248 passed, 0 failed, 6 credential-gated Mongo suites skipped, 254 total, 179541.7217ms. Includes all 34 new planning/review policy and service tests and final legacy-variant/input guards. Atlas runner PowerShell syntax and tracked whitespace checks passed. The dedicated test cluster SRV records resolved in a read-only DNS check; that does not establish database authentication, IP access or transaction acceptance. No production configuration, payment route, public API, runtime worker, app build, push or deployment changed in this checkpoint.

- 2026-09-20: The first user-run Planning Atlas attempt failed during openIsolatedTestDatabase connection setup (one failed parent, zero subtests reached). No test fixtures/collections were created by this attempt, and it does not establish a planning-logic regression. The underlying cause is not yet known: use the existing connection-only runner to obtain a credential-safe diagnostic before changing passwords or retrying the full suite. Planning remains unverified; the original five passed gates remain separate evidence. Save the local foundation checkpoint without pushing/deploying the incomplete release.

- 2026-09-20: User authorized scheduled orders, photo reviews, groups and recurring reminders as one coordinated phase. All ten PDF pages reviewed. Shared domain rules/models/services and a combined Planning Atlas gate added locally; services are not mounted in public APIs or the runtime worker. Existing live payment/order/review behavior is unchanged. Focused offline tests passed (17 policy/schema, six photo adapter, eleven service tests). Planning Atlas, actual catalog/checkout/payment/dispatch integration and all-app UI remain pending. See ORDER_FEATURES.md; do not treat foundations as completed features.

- 2026-09-20: User ran Refinement against the isolated Atlas cluster after backend checkpoint e2afcfe. Run 14f152de66ce4493b7257c05ee47223b passed 8 tests (seven subtests plus parent), 0 failed, 0 skipped, about 71.8 seconds overall; no cleanup error reported. Real Mongo verified concurrent image/job/quota identity, transaction rollback, private original preservation, approval/publication and stale-save protection, seller reassignment isolation, bounded global reservations and durable vendor-upload recovery. Photoroom and Cloudinary were simulated. All five prepared Atlas gates have passed; real-provider, browser/device and release acceptance remain outstanding.

- 2026-09-20: User ran Requests against the isolated Atlas cluster after backend checkpoint c67194b. Run 82f2a8d915cd4ac0b4ee2d9d7ff8c109 passed 7 tests (six subtests plus parent), 0 failed, 0 skipped, about 78.0 seconds overall; no cleanup error reported. Real Mongo verified owner-isolated draft retry identity, concurrent submission with one notification job, rollback after injected outbox failure, simultaneous preview reservations, bounded concurrent global quota with rollback and unique inbox delivery despite preview revision changes. External providers were simulated; no paid AI/storage/push acceptance was established. This supersedes earlier Requests-Atlas-pending notes below. All four prepared database gates have now passed; the integrated release is not complete.

- 2026-09-20: Final request-checkpoint backend rerun: 194 passed, 0 failed, 4 deliberately skipped database suites (198 total), approximately 156.0 seconds, including audited request notification retries that exclude paid preview jobs. Customer request/search rerun: 9 passed, 0 failed; the consent finder and API-field assertions are corrected. These successful runs supersede the intermediate Flutter failures below. Changed JavaScript, PowerShell runner syntax and Git whitespace checks passed. No provider/database call, deployment or build was performed.
- 2026-09-20: Admin sourcing queue saved locally as fdbedd4; customer request workflow saved as 2d1ade4. Final targeted customer analyzer exited 0 with no errors/warnings and three pre-existing home-screen informational notices (680.2 seconds). Backend implementation and this evidence are saved in the corresponding local feature checkpoint. No push/deployment/build. The existing untracked customer screenshots folder is preserved and excluded, as are secrets/signing files.

- 2026-09-20: AI concepts and sourcing requests implemented as a separate non-purchasable, owner-private request model with explicit submission/consent, authenticated expiring image links, transactional quotas/status outbox, bounded recovery, customer history/deep links and admin matching to revalidated real products. No invented Product/ProductOffer, price, stock or payment path. See PRODUCT_REQUESTS.md. Retention/erasure/orphan cleanup remain release gates.
- 2026-09-20: Request-checkpoint full offline backend regression: 194 passed, 0 failed, 4 deliberately skipped isolated database suites (198 total), approximately 235.3 seconds. Twenty new offline request/API tests are included. No database URI or paid provider calls supplied. The new Requests Atlas suite is prepared, not yet passed; earlier Explore/Search/Workers evidence remains valid. Flutter initial run passed 8/9: consent-button test used an exact widget-type finder that excludes the icon-button subclass; correcting and rerunning before checkpoint. Initial targeted analyzer reported no errors and four informational lints (one new braces lint corrected).

- 2026-09-20: Final worker-lifecycle checkpoint regression: 174 passed, 0 failed, 3 deliberately skipped database suites (177 total), about 53.6 seconds. No test URI was supplied to the local run; Explore, Search and Workers are independently verified by the user-run Atlas results below. All changed JavaScript files passed syntax checks; Git whitespace checks passed. No live database/provider call, worker deployment, release build or push was performed.

- 2026-09-20: User ran Workers against the isolated Atlas database after checkpoint 485efdf. Run 112424a7e8be4f40a4dc8e8fc1d6bac6 passed 5 tests (four subtests plus parent), 0 failed, 0 skipped, about 50.9 seconds; no cleanup error reported. Independent processes verified competing claims, retry identity after simulated provider acceptance and crash, graceful abort and exhausted-job failure. Providers and lease clocks were simulated; actual hosting lifecycle and real delivery remain separate acceptance gates. This supersedes all earlier Workers-pending notes below.
- 2026-09-20: Production worker review found scheduler work could outlive database shutdown and startup/index failures could leave a connection open. Added a shared, idempotent stop path: cancel scans/handlers, stop polling, drain up to 30 seconds, then close Mongo within 5 seconds; failed draining/closing exits unsuccessfully so unacknowledged leases remain recoverable. Startup failures close Mongo and report only sanitized diagnostics. Media scans check cancellation between enqueue/marker operations; retry identities remain unchanged. Targeted offline regression passed 36/36, including 17 new lifecycle tests. No production worker or provider was started.

- 2026-09-20: Worker harness offline safety tests passed 6/6. Full backend regression then passed 157 tests, 0 failed, with 3 opt-in database suites deliberately skipped locally (no test URI supplied). JavaScript/PowerShell syntax and Git whitespace checks passed. No production worker, paid provider, deployment or authenticated database connection was started by the agent; Workers Atlas execution still awaits the user's private-credential run.

- 2026-09-20: User ran Search against the isolated Atlas database after checkpoint 92a0f9a. Run 44e0cbffc664427e94839d4f384e002b passed 13 tests (twelve subtests plus parent), 0 failed, 0 skipped, about 57.4 seconds; no cleanup error reported. Real Mongo verified taxonomy matching, mixed category formats, seller eligibility, combined filters, offer snapshot consistency, all 125 paginated rows, literal/no-result queries, AI filter enforcement and cache/global/per-actor quota/failure recovery. AI HTTP was simulated; this is not a real Gemini/provider or customer-device result.
- 2026-09-20: Prepared Workers suite using independent Node child processes and independent connections to one per-run BackgroundJob collection. Four scenarios: 12 jobs shared by two workers, abrupt exit after simulated delivery, graceful abort before delivery, and exhausted lease failure. Children inherit only test URI plus essential OS variables, not production/provider/Node preload configuration. Only owned child handles may be terminated; all must close before collection cleanup. Actual Atlas Workers execution remains pending; production worker startup/scheduler/drain/monitoring acceptance remains separate.

- 2026-09-20: Final offline search-checkpoint regression: 151 passed, 0 failed, 2 intentionally skipped database suites (Explore and Search) with no test URI supplied. The final targeted search/harness subset passed 15/15. JavaScript and PowerShell syntax and Git whitespace checks passed. This is not an authenticated Atlas Search pass; that is the user's next private-credential test. No new keys, production changes, pushes, deployments or builds were required.

- 2026-09-20: Extended the isolated harness with Search/All selectors (default connection check and Explore behavior preserved). Added a real-Mongo Search suite covering twelve subtests: attributes/synonyms, seller eligibility, combined filters, real offer price/stock, snapshot consistency, 125-row pagination, literal queries, AI filter enforcement and concurrent cache/quota/lease behavior. Only synthetic per-run data and simulated AI HTTP; authenticated Atlas execution remains pending. Five offline tests cover the new harness creation/cleanup boundaries and failure paths.
- 2026-09-20: Review found discovery could expose unapproved owners/offers and resurrect stale product data when only disabled offers existed; discovery now checks seller eligibility and requires either an eligible offer or no offers. It presents the same selected offer snapshot used for filtering instead of requerying changing prices. Dollar-prefixed query text is literal in aggregation expressions. Existing category filtering was moved unchanged into the shared utility for route/test parity. Legacy endpoints, checkout-time stock validation and production data are unchanged.

- 2026-09-20: User confirmed TEST_DATABASE_CONNECTION_OK, then ran the real Atlas suite. Three subtests failed on the same BackgroundJob deliveryKey default (randomUUID called with null); rollback passed. Parent failure accounts for the fourth reported failure. Reproduced the exact failure offline through real Mongoose defaults/upsert casting, fixed the callback, and added four regressions including retry-key preservation. Concurrent integration batches now drain before cleanup and rollback checks the intended error. Full local backend suite: 142 passed, 0 failed, 1 skipped. Real Atlas rerun is pending; no push/deployment or production database change.

- 2026-09-20: User's initial Atlas connection check failed with a generic error; root cause is not yet confirmed. Test cluster SRV/TXT DNS resolution and credential-free URI/driver construction checks passed locally. Added credential-safe staged diagnostics and read-only client lifecycle tests: 16/16 targeted tests passed, plus JavaScript/PowerShell syntax and whitespace checks. Actual authenticated Atlas check and transaction suite remain pending. No production setting or data changed.

- 2026-09-20: User created a separate Atlas testing project/cluster and rotated the test password after a screenshot exposure. Added explicit opt-in for only naijago-testing.kwcvhix.mongodb.net and the fixed naijago_integration_tests database. Hidden-password PowerShell runner defaults to a read-only connection check. Real tests create and remove only uniquely named collections belonging to the current run; no dropDatabase or production MONGO_URI use.
- 2026-09-20: Atlas harness safety tests: 10 passed. Full backend regression: 132 passed, 0 failed, 1 skipped (actual Mongo integration still awaiting private user-run connection). Node and PowerShell syntax checks and Git whitespace validation passed. No Atlas connection or database mutation performed by the agent.

Latest image-refinement checkpoint (2026-09-20): full offline backend regression
passed 214 tests, 0 failed, with 5 isolated database suites deliberately skipped
(219 total; about 55.7 seconds). Twenty new refinement/API tests cover the provider
boundary, original/candidate privacy, transactional rollback, quotas, stale saves,
approval, bounded regeneration and shutdown safety. Admin JavaScript and the Atlas
PowerShell runner passed syntax checks. The vendor notice passed Dart parsing;
no Flutter build or new analyzer/device pass is claimed. Git whitespace checks
passed. The user subsequently verified the Atlas Refinement gate: 8 passed,
0 failed, 0 skipped. Real-provider/browser acceptance remains pending. Only local
commits are being saved; no push, deployment or paid call.

This is a local development checkpoint, NOT completion of the integrated phase.
Previously verified database gate: user-supplied Atlas run
265adef2f39e42df98611b23ba1191ba after fix e4d9a2d passed 5 tests, 0 failed,
0 skipped (four subtests plus parent; about 22.8 seconds). This supersedes the
earlier pending-rerun notes above. The tested queue claims, lease recovery/stale
completion, reaction/comment deduplication and outbox rollback passed against
the isolated database. No cleanup error was reported. This is not a production
deployment or a whole-platform acceptance result.

Verified Search database gate: run 44e0cbffc664427e94839d4f384e002b,
13 passed, 0 failed, 0 skipped. Verified Workers database gate: run
112424a7e8be4f40a4dc8e8fc1d6bac6, 5 passed, 0 failed, 0 skipped.
Verified Requests database gate: run 82f2a8d915cd4ac0b4ee2d9d7ff8c109,
7 passed, 0 failed, 0 skipped. Latest verified database gate: Refinement run
14f152de66ce4493b7257c05ee47223b, 8 passed, 0 failed, 0 skipped. All five prepared
database gates (Explore, Search, Workers, Requests and Refinement) have passed
against the isolated Atlas database with external providers simulated.
These results supersede the earlier pending notes above. Provider, hosting,
deployment and device evidence remain separate; this is not whole-platform sign-off.

No commits from this phase have been pushed/deployed automatically, no paid provider
calls have been made, no production migration/database write has run, and no AAB/IPA
has been produced here. All new runtime features remain gated off by default.

AI concept preview + sourcing requests now have a local implementation and a
verified isolated database gate; real provider, privacy/retention, browser and
device acceptance remain outstanding.
Image refinement now has a local backend/admin implementation and verified Atlas
gate; real-provider, browser/device, privacy/retention and takedown acceptance
remain open.
Still required for completion:
PDF scheduled delivery/photo reviews/group carts/recurring reminder-to-pay integration
and acceptance (shared foundations are now local), previous
radar and security audit, website/privacy/deep links, full regression and device
acceptance, real provider tests, deployment/worker monitoring and signed release.
Do not treat successful unit tests as permission to publish this unfinished release.

## Next actions

1. Save verified local checkpoints; keep flags off and do not deploy the incomplete release automatically.
2. Seven earlier Atlas gates (Explore, Search, Workers, Requests, Refinement, Planning and Checkout) passed at their recorded revisions. The new PlannedCheckout gate is PENDING: run the hidden-password runner with -RunTests -Suite PlannedCheckout on the same dedicated TEST cluster. It checks actual receipt/shipment writes, concurrent source identity and rollback, without provider calls. Never change production MONGO_URI or repeat old passing suites solely to record progress.
3. Actual shared unpaid-order creation is composed with immediate group checkout locally; all planning public APIs remain unmounted. Next finish real scheduled windows/future-time quote rules, then payment-initiation freshness, slot settlement, late-paid/stock-conflict reconciliation and due-only dispatch. Scheduled/recurring order creation deliberately fails closed until those pieces are ready. Continue review submission/media/moderation, authenticated APIs/worker delivery and customer/vendor/admin/rider views. Historical-order compatibility remains a release gate. Preserve delivery/pickup and Squad/legacy flows. Follow ORDER_FEATURES.md; no separate feature release or automatic activation.
4. Keep the real Photoroom sandbox/live trial, private-link checks, browser/device review and shared retention/erasure/takedown work tracked as unfinished release gates (see IMAGE_REFINEMENT.md). Keep flags off pending acceptance; no paid calls have run. Do not rerun already-passed gates solely to claim progress.
5. Close prior radar/security/regression items, rehearse migrations with a fresh backup, then deploy/build/device-test the complete release.
6. Do not mark the programme complete with required items unresolved. Record local tests, deployment and device evidence separately.
