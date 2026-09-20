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
| BASE-01 | Regression tests for payments, stock, sellers, pickup, addresses, notifications; document existing failures | Backend/apps | Working |
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
| MEDIA-04 | Video moderation/admin reason/approval, publish gates, processing retries, abandoned upload cleanup | Admin/backend | Working: review implemented, cleanup/revocation pending |
| EXP-01 | Explore tab, paginated mixed feed, pinned active admin campaigns, Sponsored labels and vendor/product links | Customer/backend | Pending |
| EXP-02 | Admin banner/video form; advertiser/vendor/destination, preview, WAT scheduling/expiry, pause/reject | Admin/backend | Pending |
| EXP-03 | Like/Love/Wow/Thumbs Down; one current reaction/user, comments/replies, reporting/blocking and moderation | Apps/backend/admin | Pending |
| EXP-04 | Defined views/watch time/impressions; deduplicated server counters, concurrency/idempotency | Backend/customer | Pending |
| EXP-05 | Vendor engagement notices and replies; aggregation/preferences and deep links | Vendor/backend | Pending |
| EXP-06 | Visible-only video playback, caching, data usage, performance/accessibility | Customer | Pending |
| SEARCH-01 | Central taxonomy; category path/audience/gender/type/brand/tags/vendor fields; legacy backfill/create/edit | Backend/admin/vendor | Working: attributes/forms/dry-run migration added; data audit pending |
| SEARCH-02 | Structured intent/synonyms, broad/specific searches and combined filters; true availability; relevance tests | Backend | Unit tests passed; Mongo integration/performance pending |
| SEARCH-03 | Collection heading/View All/subcategory chips/products across vendors, filters and pagination | Customer | Implemented; contract/device checks in progress |
| SEARCH-04 | Gemini strict-schema ambiguous-query classification; fast deterministic path, cache/timeouts/fallback/rate-cost limits | Backend | Pending |
| REQUEST-01 | Explicit zero-result AI preview; AI concept/not for sale label; no fake price/cart; async generation | Customer/backend | Pending |
| REQUEST-02 | Request This Product; admin sourcing queue/status/vendor match, customer history/notifications | Customer/admin/backend | Pending |
| REFINE-01 | Preserve original; automatic derivative refinement, background/light/centering/shadow; product identity preserved | Backend | Pending |
| REFINE-02 | Original/refined compare, approve/reject/regenerate, versioned publication; bulk/retries/rate-cost controls | Admin/backend | Pending |
| SCHED-01 | Now/scheduled, WAT windows/lead time/cutoffs/advance bounds/capacity; expiring payment holds and booking races | Backend/customer | Pending |
| SCHED-02 | Multi-vendor split rules, reminders/reschedule/cancel, due-only dispatch and ops visibility | All relevant | Pending |
| REVIEW-01 | Delivered verified purchase; stars/text/max 5 JPEG-PNG-HEIC images, max 10MB originals, conversion/thumbnails/EXIF stripping | Backend/customer | Pending |
| REVIEW-02 | Reports/admin moderation/audit/customer notice; vendor replies without deleting criticism; photo filter/lazy load | Apps/admin/backend | Pending |
| GROUP-01 | Single vendor; owner pays; one destination/fee; invite/code, configurable limit (default 10), cutoff/realtime cart | Backend/customer | Pending |
| GROUP-02 | Member permissions/privacy, stock-price-availability rechecks, failure/cancel/expiry, analytics/order linkage | All relevant | Pending |
| RECUR-01 | Weekly/biweekly/monthly/custom; reminder-to-pay, next/all edits, pause/resume/skip/cancel, occurrence linkage | Backend/customer | Pending |
| RECUR-02 | Current price-stock-vendor-address-slot checks, substitution preference/approval threshold, reminders/failure/admin oversight | Apps/backend/admin | Pending |
| RECUR-03 | PDF initial scope is reminder-to-pay; automatic charges require provider support/consent verification before inclusion | Backend | Pending decision |
| OPS-01 | Durable jobs, leases/retries/idempotency, feature flags, audit/analytics/permissions | Backend/admin | Pending |
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

## Configuration register (names only)

| Service | Known state | Required work |
|---|---|---|
| Gemini | Existing catalog integration | Verify supported APIs; reuse backend key/models; classify/preview limits |
| Cloudinary | Existing images/carousels | Signed video uploads/transcoding/storage capacity |
| Geoapify | Existing autocomplete | Preserve config and test resolution |
| Squad | Hosted checkout/recovery live | Preserve rotated secret/webhook/recovery; wallet coverage audit |
| OneSignal | Existing audience services | Vendor config missing in latest logs; verify each audience |
| Photoroom | No confirmed key/integration | Verify API, choose adapter, document setup |
| Video moderation | No confirmed provider | Inspect existing moderation before selecting service |
| Jobs | In-process runners exist | Audit durable Mongo queue vs external queue; avoid unnecessary paid infrastructure |
| WhatsApp | Provider connection error | Operational connection/configuration check |

## Execution evidence

- 2026-09-20: Authorized by user. All source repositories clean; requirements PDF preserved. Sandbox fails with Windows deny-read ACL errors; direct apply_patch executable works through approved escalation.
- 2026-09-20: Confirmed manual Apply calls quote while address readiness is false; quote exits. Current-location card marks ready manual addresses selected. Saved-address switch may reuse older coordinates. Fix/tests in progress.
- 2026-09-20: Checkout state and widget tests passed (11): manual selection/automatic quote, required postcode/Apply, stale geocode/quote rejection, saved-address coordinate change, invalid coordinates. Homepage category block removed, main Categories tab retained.
- 2026-09-20: Pinned Flutter 3.35.6 / Dart 3.9.2 used. Local generated package config initially pointed to another SDK; refreshed with pinned SDK. No Flutter upgrade. Added video_player 2.10.0; lockfiles retain compatible resolution.
- 2026-09-20: Backend baseline 35 tests passed; after video additions 46 passed; after structured search 53 passed. Video tests include real HTTP routes with mocked database/provider, owner isolation, moderation authorization/revision/audit, feature flag and signed-upload validation. No paid API call or live database test performed.
- 2026-09-20: Customer and vendor targeted analyzer checks report no compile errors. Remaining findings are informational style/deprecation lints; device/build validation remains outstanding.
- 2026-09-20: Media API, vendor upload warning/preview/retry, admin video review and customer playback implemented behind PRODUCT_VIDEO_ENABLED (off by default). See PRODUCT_VIDEO.md for configuration and remaining cleanup/revocation/provider checks.
- 2026-09-20: Catalog search attributes, editable vendor/admin fields, deterministic intent/type/audience matching, offer-aware budget sorting, collection chips/pagination and dry-run metadata migration added. See SMART_SEARCH.md. Gemini/preview/request work not yet implemented.
- 2026-09-20: Combined customer test run passed all 13 tests (11 checkout + 2 search HTTP contract/error tests). Admin JavaScript syntax and Git whitespace checks passed. No production migration, provider call, release build or deployment performed.

## Next actions

1. Finish customer search contract tests and save verified source checkpoints; do not deploy the incomplete release automatically.
2. Build durable jobs needed for moderation/media cleanup, image refinement, AI requests and scheduled workflows.
3. Finish media cleanup/revocation, Explore/engagement, Gemini interpretation and preview/request flow, image refinement.
4. Implement PDF scheduled delivery, photo reviews, group ordering and recurring reminder-to-pay workflows with integration tests.
5. Close prior radar/security/regression items, rehearse migrations with a fresh backup, then deploy/build/device-test the complete release.
6. Do not mark the programme complete with required items unresolved. Record local tests, deployment and device evidence separately.
