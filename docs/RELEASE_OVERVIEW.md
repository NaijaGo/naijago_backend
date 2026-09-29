# NaijaGo: overall release checklist

Updated 2026-09-28. One coordinated release across the customer app, vendor app,
rider app, backend, admin panel and website. Internal checkpoints are not separate
public launches. No completion percentage is claimed.

This is the readable overview. Detailed evidence remains in
[INTEGRATED_RELEASE_CHECKLIST.md](INTEGRATED_RELEASE_CHECKLIST.md), with the PDF
features in [ORDER_FEATURES.md](ORDER_FEATURES.md).

## Where we are

The existing commerce platform and several earlier fixes have been deployed and
tested by the user. The newer integrated release is still being implemented and
validated locally. It is NOT ready for a final all-app release build. Some items
need real-provider/device acceptance; others still need actual code and screens.

Terms used below:

- **Earlier implementation:** recorded prior work; do not confuse earlier device
  feedback with a fresh regression of the current release.
- **Local implementation:** code exists, with the stated tests; not live sign-off.
- **Partial:** foundations exist but required integrations/screens are unfinished.

## A. Earlier commerce, design and reliability work to preserve

| Area | Achieved / recorded evidence | Remaining acceptance or correction |
|---|---|---|
| NaijaGo + vendor catalog | Seller-neutral products/offers, admin catalog management, vendor listings, ownership/reassignment and order history support. User applied the 331-product migration and verified a repeat dry run required zero changes. | Regression of both sellers through real cart/payment/fulfilment; do not rerun the old migration blindly. |
| AI catalog creation | Gemini research drafts, generated images, admin review, required fulfilment/product details and category selectors. User confirmed the end-to-end admin creation flow. | Source accuracy, image rights/identity, real supplier price/stock, failure/retry and publication checks. Draft research is not verified inventory. |
| Customer storefront | Earlier NaijaGo branding, Cosmetics and Beauty/category edits, Low Cost store, product-card spacing and ratings/sales work. | Verify every requested visible label/color/category removal and consistent cards on actual screens; no invented customer ratings or sales presented as facts. |
| Low Cost and restaurants | Fixed 57-naira commission and per-item restaurant notes have checkout regression coverage. | Check line quantities, discounts, seller statements and vendor-visible notes end to end. |
| Address entry | Autocomplete, manual/current-location flow, coordinate/quote handling and stale-response checks. User previously reported improvement. | Manual mode must stay selected; 3-4 suggestions visible, scrolling/neutral scrollbar, keyboard avoidance, fast typing, GPS permission failures and final-total updates on devices. |
| Pickup | Earlier per-seller pickup, zero delivery fee, code/QR verification, tracking/location/contact, vendor statuses/configuration and admin analytics. | Multi-seller isolation, valid/invalid/replayed code, owner permissions, hours/capacity, paid-only collection, notifications and analytics acceptance. |
| Account and pharmacy | Earlier new-device verification, pharmacy role/session/presence/chat recovery fixes. | Two-account/two-device checks, immediate presence, correct sender identity and bubble alignment, resume/reconnect/session expiry, and verified-device state refresh. |
| Vendor ownership | Earlier editing controls and ordered-product restrictions. | Both server enforcement and UI messages; images/stock/variants, another vendor's access and seller reassignment. |
| Admin/rider notifications | Earlier activity center and rider sound/notification navigation; user reported rider notification success. | Complete event/audience coverage, permission states, foreground/background/closed-app behavior, tap routing and actual sound on devices. No guarantee an OS will force-open an app when push arrives. |
| Vendor communications | Existing push/WhatsApp integration. | Earlier logs showed missing vendor OneSignal configuration and a WhatsApp connection failure. Recheck and fix operational configuration/delivery. |

## B. New features: implementation versus what is still missing

| Feature | Local progress | Required remaining work |
|---|---|---|
| KoraPay order checkout | Hosted checkout, pinned receipt/reference/mode, safe URLs, signed webhook + server verification, recovery, approved-amount checks, old-client guard and neutral return page. Existing Squad/Flutterwave receipts preserved. | Customer checks, isolated sandbox/provider/device acceptance, real Mongo initialization races and operational reconciliation. No live switch yet. See KORAPAY_PAYMENTS.md. |
| Wallet/payout/provider coverage | Existing wallet/order settlement preserved; it is not silently converted to KoraPay. | Audit deposits, withdrawals/vendor/rider payouts, paid plans and refunds; implement and test the agreed migration scope. Do not remove required legacy keys yet. |
| Checkout/inventory safety | Authoritative prices, seller/offer/variant identity and aggregate stock checks; transactional inventory; duplicate settlement guards; late/stock-conflict paid-review hold. | Audited support resolution for fulfil/refund/cancel/reschedule; current-revision DB and real-provider tests; older installed app compatibility. |
| Product videos | Vendor picker/preview/remove, five-point warning, maximum 60 seconds, backend media ownership/validation/moderation and customer playback UI. | Real upload/transcode/poster/moderation/delete tests, abandoned media cleanup, slow-device/data usage, gallery/fullscreen/mute/error design acceptance. |
| Explore | Customer tab/feed, pinned scheduled admin ads, banner/video form, reactions/comments/replies/reporting, vendor notices and qualified video-watch counters. | Banner impressions/analytics completeness, aggregation/preferences acceptance, actual push, moderation workflow, expired ad behavior, feed density/accessibility/scroll performance. |
| Smart search | Structured taxonomy/attributes/synonyms, broad collection results/chips, product/vendor/brand/tags, combined budget/category/stock filters and pagination. Real Atlas search tests passed at their recorded revision. | Representative real catalog backfill audit, relevant rankings, all-vendor results, no-result/filter/latency/device acceptance. Children/adult collections stay distinct. |
| Gemini search understanding | Fast deterministic search, bounded AI classification, cache/quota/lease/fallback controls with offline and Atlas evidence. | Real Gemini structured responses, usefulness, latency/cost and outage acceptance; actual catalog remains price/availability authority. |
| AI preview + product requests | Clearly labelled non-purchasable concept previews, consent/submission, private request history, admin sourcing/matching and notifications. Offline and Atlas evidence. | Real preview/provider and all-screen acceptance, customer alerts, retention/account erasure/orphan cleanup and privacy copy. |
| AI image refinement | Photoroom adapter, private preserved originals, durable work marker, bulk generation, comparison/approve/reject/regenerate and versioned publication. Offline and Atlas evidence. | Real Photoroom key/trial, product identity/quality, original/candidate access control, provider cleanup/revocation, admin browser and customer-image acceptance. |
| Scheduled deliveries (PDF) | WAT calendar/capacity/hold rules; private receipt/reservation and payment/dispatch guards; transactional foundations tested. | Real slot/policy administration, expiry/reminder/reschedule/cancel/refund lifecycle, all dispatch entry points, authenticated APIs and customer/vendor/rider/admin views. |
| Group orders (PDF) | Owner/member privacy and limits, authenticated create/list/join/edit/control/quote/checkout APIs, atomic initial basket, customer create/join/cart/close/pay/receipt UI, notification routing, owner-only invite rotation, one real unpaid receipt/shipment/fee and transactional source identity. | Website deep-link fallback, realtime collaborative refresh, unavailable-item decision UI, expiry/cancellation acceptance and vendor/admin operational views. |
| Recurring orders (PDF) | Calendar/plans/occurrences, authenticated customer APIs and management screens, future-cart replacement, pause/resume/skip/cancel, reminder-to-pay, signed quote plus real checkout/payment linkage and protected pending basket/address edits. Automatic charging remains off. | Rich substitution/price-threshold editor, schedule-change workflow, customer reminder/device acceptance and admin operational oversight. |
| Photo reviews (PDF) | Delivered-purchase eligibility and photo byte/count rules plus private conversion adapter tested with mocks. | Connect existing review route/model; uploads, decoding/HEIC/EXIF stripping, transactional ratings, customer editor/gallery/filter, vendor replies and reporting/admin moderation. Existing paid-only review behavior is not yet fixed by the unconnected policy. |
| Background jobs | Durable job claims, retry identity, leases, transaction-linked notifications and process-crash/shutdown tests. | Remaining handlers, durable dispatch/alerts, fair scanning, production worker rehearsal/health/alerts and provider acceptance. |

## C. Screens/designs that are still required or need acceptance

- [ ] Finish scheduled checkout, available windows/ETA, order tracking/reschedule
  and support-review actions; matching vendor/rider queues and admin operations.
- [ ] Accept the implemented group creation/invite/join/cart/owner approval/payment/
  status screens; add website deep links, realtime refresh and admin oversight.
- [ ] Extend the implemented recurring plan/occurrence/payment screens with rich
  substitutions, price thresholds and admin oversight.
- [ ] Finish photo-review composer/gallery/filter, vendor reply UI and admin
  report/moderation/audit screens.
- [ ] Accept the existing Explore/ad/media/refinement/request screens in real
  browsers/devices: loading, empty, error, offline, keyboard and accessibility.
- [ ] Check every earlier customer design request: branding, category renames and
  removals, Low Cost card/store, home category-strip removal, search alignment,
  product-card spacing and pharmacy bubble identity/alignment.
- [ ] Complete website product/vendor/campaign/group deep-link fallback pages and
  relevant privacy/UGC/advertising/support content. The new backend KoraPay return
  page does not complete the broader website/deep-link work.

## D. Cross-platform release blockers

- [ ] Finish audited payment-review resolution/refunds and wallet/provider scope.
- [ ] Remove/review the temporary restaurant 1000-km minimum-radius override,
  protecting existing coverage with tests.
- [ ] Validate notification configuration for customer/vendor/rider/admin, sound,
  routes, real delivery and permission-denied behavior; resolve WhatsApp outage.
- [ ] Finish media/request/review retention, account erasure, orphan cleanup,
  takedown, moderation and audit requirements.
- [ ] Review dependency vulnerabilities, authentication/authorization, rate
  limits, log redaction and exposed-secret handling. No blind forced upgrades.
- [ ] Rehearse necessary migrations with backup, dry-run, repeatability and
  rollback; preserve historical orders and old installed clients.
- [ ] Run changed database gates plus provider/browser/device/end-to-end tests:
  payment retries, stock races, pickup and delivery, app kill/resume, denied
  permissions, network loss and slow/low-memory devices. Passing unit tests alone
  is not acceptance for these flows.
- [ ] Verify API level 36 in all intended release artifacts, store version/build
  numbers and approved upload certificates; close rider iOS provisioning/
  Codemagic configuration and test iOS notifications.
- [ ] Review scoped commits across all six repositories; exclude keys, env files,
  screenshots and generated artifacts. Push/deploy the agreed complete manifest,
  then build AAB/iOS internal-test artifacts and record device/store acceptance.

## E. Keys/configuration register (never paste values into chat)

| Service | Current action |
|---|---|
| KoraPay | User has test keys. Configure only a separate test backend/database first; hosted order checkout uses the backend secret, not a Flutter public-key define. See KORAPAY_PAYMENTS.md. |
| Squad / Flutterwave | Retain required historical recovery/webhook and unmigrated wallet/payout configuration until reconciled and replaced. |
| Gemini | Reuse existing backend integration; verify classification/preview/catalog model settings, supported responses and budgets. |
| Cloudinary | Existing integration; verify signed media upload, private originals/derivatives, video processing, expiry/revocation and limits on backend/worker. |
| Photoroom | Adapter exists; no confirmed real key/provider trial recorded. Configure privately on backend/worker for controlled acceptance. |
| OneSignal / WhatsApp | Verify each audience's own configuration and current provider connection, not just presence of a variable. |
| Geoapify | Preserve autocomplete configuration and test typed/GPS address resolution and limits. |
| Video moderation | Provider/policy decision remains open; a warning modal is not proof that unsafe uploads are detected. |
| Store signing | Use approved vendor/rider upload-key resets; verify fingerprints privately. Do not create fresh signing keys or commit them. |

## F. Test evidence and immediate sequence

Current local payment checkpoint: **441 backend tests passed, zero failed; eight
credential-gated database suites skipped**. The 95 focused payment/checkout tests
are included in that full result, not additional tests. Customer payment tests
passed **11/11**; all 11 changed JavaScript files passed syntax checks. Focused
customer static analysis reached the analysis stage but did not finish after
more than 14 minutes; only that agent-owned session was stopped. It is an open
release gate, not a pass. No real KoraPay transaction or final phone-to-provider
acceptance is claimed. Customer checkpoint: e42af4d; no push/deployment/build.

The tracker distinguishes historical and current results. Eight user-run Atlas
suites passed at their recorded revisions: Explore, Search, Workers, Requests,
Refinement, Planning, Checkout and PlannedCheckout. Their providers were simulated.
Later changes need relevant regressions. Do not add those counts to the offline
suite or count repeated runs as newly completed features.

Current uncommitted planning checkpoint: the complete focused backend planning
gate passed 46/46, including owner-only invite rotation, old-token invalidation
and outbox rollback. Customer formatting and focused Flutter analysis passed
with no issues; planned-order/payment customer tests passed 13/13.

1. Finish this local KoraPay checkpoint, customer validation and documentation.
2. Confirm a separate Render test backend/database; run controlled KoraPay sandbox
   acceptance without changing production or creating a public build.
3. Finish the remaining actual feature/API/worker/screen work in sections B-D,
   reusing the tested foundations. Keep one coordinated release scope.
4. Close security, migration, real-provider and cross-app acceptance gates; then
   push/deploy/build the complete release for final device/store testing.

No whole-platform completion, zero-lag guarantee or live KoraPay success is claimed.
