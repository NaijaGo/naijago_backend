# Coordinated scheduled, photo-review, group and recurring order phase

Started 2026-09-20 after the user asked to implement all four in one coordinated
phase. The complete ten-page new_feature_to_add_docs.pdf was read. Its suggested
separate releases are superseded by the user's single-release instruction, not
its payment, privacy, inventory or acceptance requirements.

## Current boundary: foundations and shared checkout, NOT four completed features

The new domain services and schemas are local. No new planning/review public
routes are mounted. Local payment and dispatch hooks now recognize scheduled
receipts, but the public scheduled-checkout gate and planned-order composition
remain closed. No planning/reminder worker is running these new jobs.
Existing order summary/creation now share authoritative
catalog validation; the existing wallet/provider stock hook handles offer variants
transactionally. Provider verification and delivery pricing policies are unchanged.
Payment-review presentation is now connected to existing checkout, My Orders and
admin orders locally. The new scheduled/group/recurring/photo-review screens,
release build, migration and production deployment are not complete.
Do not enable/publish the four features based on these foundations alone.

### Receipt, payment and dispatch checkpoint (2026-09-21, local only)

- Optional `MainOrder.schedule` stores the reservation identity, approved WAT
  window, policy revision, expiry and confirmation. Historical orders do not
  acquire a schedule. Quote comparison includes the window and policy; the private
  creator rechecks availability and reserves capacity in its caller's transaction
  before writing the real receipt/shipments. It does not reserve product stock.
- Wallet debit and provider settlement confirm the owned reservation in the same
  transaction as inventory and the receipt. A verified gateway payment arriving
  after an expired/missing/changed reservation becomes paid `payment_review`, not
  a dispatchable order or a second payment request. Only expired held capacity is
  released automatically; confirmed or mismatched capacity needs support review.
- The shared settlement helper is idempotent for its recorded provider/reference.
  Wallet buyer/vendor alerts and legacy Flutterwave vendor alerts now run after
  commit, matching the existing Squad post-commit path. A failed stock write sends
  no success alert. Durable delivery/retry of these alerts remains an open gate;
  post-commit best effort is not an exactly-once outbox.
- The same paid/confirmed/due/unexpired predicate guards automatic offers, rider
  listing/atomic claims and admin HTTP/socket assignment. Customer pickup and
  company-owned work are excluded from individual rider jobs. The existing timeout
  runner also scans due scheduled orders. Vendor alerts identify the WAT window
  instead of asking for immediate preparation.
- Admin individual/company assignment writes are transactional. Company ownership
  uses the existing `company` field, not the undeclared `assignedToCompany` field;
  company rider IDs no longer enter an individual `Rider` reference. Inactive/
  foreign company riders, unpaid/early/review orders and customer pickup are rejected.

**Required before activation:** compose the real reservation adapter into planned
checkout; authenticated policy/window administration; current-price/eligibility
checks before initiating payment; stock-conflicted verified-payment reconciliation;
browser/device acceptance of payment-review messaging and safe resolution; reservation-expiry
worker; cancellation/rescheduling/refund rules; reminder outboxes; all-app views.
Automatic offer/shipment assignment and expired-offer release now use transactions;
vendor shipment transitions guard paid/review state in a parent-writing transaction.
Finish dispatch lifecycle review too: durable notification outbox integration,
due-scan fairness and bounded no-rider notices, company accept/reject/status/OTP
checks and order/shipment completion synchronization. These existing downstream
paths are not proven end-to-end by the assignment tests.

Offline tests use the actual route/service code with injected databases/providers;
fake transaction rollback and query predicates do not prove Mongo concurrency.
Previous checkpoint's full backend regression: **356 passed, zero failed, eight credential-gated
Mongo suites skipped (364 total, 67879.3626ms)**. All changed JavaScript syntax
and Git diff checks passed. There are 25 new tests beyond the previous checkpoint;
focused reruns are not added to the total. Earlier test-fixture failures are superseded.
Collect current-HEAD isolated Mongo evidence in the combined acceptance run,
then provider/browser/device evidence. No production database change, new key,
provider call, push, deployment, Flutter upgrade or app build accompanies this work.

### Scheduled availability and future quotes (2026-09-20, local only)

The next connected backend slice now includes:

- Optional, typed `AppSetting.scheduledDelivery` on the existing settings model,
  under key `scheduled_delivery_program`. Existing settings remain unchanged.
  Nothing seeds or enables this policy automatically. An admin configuration UI,
  audited policy-revision changes and window publication are still required; do
  not populate production settings manually to bypass these remaining gates.
- `deliveryScheduleService` reads that policy in the caller's transaction and
  derives the area, rider pool and distinct shop/warehouse resource keys from
  the authoritative catalog locations. Client-supplied resource/window IDs do
  not select capacity. Each resource must have the exact same enabled window and
  policy revision. Missing, duplicate, invalid or full resources fail closed.
- WAT opening intervals cover preparation through the end of the chosen window,
  including overnight openings. Explicit geographical coverage replaces guesswork;
  ambiguous overlapping areas require operational review. Current vendor closure,
  radius, preparation time, hours and last-order cutoff can narrow the operational
  policy. This path does not inherit the legacy 1000-km restaurant test override.
- The reservation adapter re-resolves those server-owned resources in an active
  transaction, then delegates to the existing atomic reservation service. Repeated
  products share one shop claim; the service does not reject a retry merely because
  the existing hold itself filled a capacity bucket. It does not create a receipt,
  charge a customer or reserve product inventory.
- Planned quote composition uses this database-backed check when the required
  models are supplied. The chosen window cannot silently move. The shared checkout
  quote evaluates restaurant WAT availability and subscription expiry/benefit hours
  at the selected delivery time. Ordinary HTTP summaries cannot supply a fake
  pricing date. Prices and stock still come from today's real catalog and must be
  checked again before payment; this is not a future price guarantee.

Verification: focused offline scheduling/catalog/HTTP regressions passed 44/44
after correcting a shared-reference test fixture. After adding configuration-schema
coverage, the complete offline suite passed 331 tests, zero failed, eight credential-gated
database suites skipped (339 total, 150101.7335ms, serial execution). No timeouts were
increased. A connected isolated-Mongo case also extends Planning
with stored-policy reads, derived resources, concurrent reservations, repeat identity,
rollback and revision mismatch. Its real Atlas result is **pending**, to be collected
in the combined acceptance run, not through another user test interruption now.

**Historical boundary at this earlier checkpoint (superseded by 2026-09-21 above):**
scheduled/recurring receipt creation, payment-slot confirmation, late-success
reconciliation and actual rider dispatch guards were not integrated. Rescheduling,
reminders and app/admin screens remain open. No public scheduling API was enabled, no database
was changed, and no provider, push, deployment or app build was performed for this
checkpoint. Next integrate receipt/hold lifecycle and payment freshness/settlement,
then every dispatch entry point before relaxing the existing scheduled-checkout gate.

### Shared checkout checkpoint (2026-09-20)

- `checkoutCatalogService` reads actual Product/ProductOffer and approved seller
  records, checks publication, whole-number quantities, aggregate stock across all
  submitted shipments, explicit offer ownership/status, variant price/stock/SKU,
  real sizes and configured locations. Disabled offers never fall back to stale
  product stock. Legacy no-offer products and string/object/custom-dimension sizes
  remain supported. Ambiguous/missing structured variants fail closed.
- Both normal checkout routes use the resolver. Submitted product names, seller
  identities, warehouse coordinates and item prices cannot replace catalog values.
  Different fulfilment points remain separate; mixed-point shipments are rejected.
  No server tax calculation is configured in these routes, so tax remains zero;
  arbitrary client-supplied tax/discount values no longer change the payable total.
  Any future tax policy must be implemented server-side, not restored as client input.
- `checkoutInventoryService` requires an active settlement transaction. It checks
  parent/variant stock in the same conditional update, mirrors primary offer stock
  to Product, leaves other sellers' stock independent, and increments sales only
  inside the caller's payment transaction. Existing payment idempotency/verification
  remains with the wallet/Squad/legacy settlement flow, not this inventory helper.
- Delivery fees, zero-fee pickup, subscription free delivery, Low Cost's fixed
  57-naira-per-unit commission and per-item restaurant notes have HTTP regressions.
  Safe short validation errors replace raw exceptions in summary/creation responses.
- Focused offline checks: 21 passed, zero failed (12 service + 9 real HTTP-route
  tests with injected databases/providers). Final full regression: 277 passed,
  zero failed, seven credential-gated Mongo suites skipped (284 total,
  63803.3936ms). JavaScript/PowerShell parsing and tracked diff checks passed.
  User-run `Checkout` Atlas acceptance after checkpoint 9c1cd18 passed all six
  tests (five subtests plus parent), zero failed, zero skipped, 43191.5829ms.
  Run: 509083010de949d8b4f8f2d912e8a4ce. No cleanup error was reported.
  This verifies real catalog queries, aggregate variant quantities, competing
  variant stock updates, primary mirrors, secondary-seller isolation, identity
  mismatch rejection, rollback and legacy no-offer stock protection. It does
  not verify real payment-provider settlement, dispatch or application screens.

The shared unpaid-order creation adapter passed the isolated PlannedCheckout
gate after checkpoint 66a0e1c (details below). Next: finish scheduled quote/slot
validation, enforce quote freshness
again at payment initiation, link slot confirmation
to settlement, preserve late/stock-conflicted
successful-payment evidence for reconciliation, and guard every dispatch entry.
Historical pending orders without offer IDs, seller reassignment and existing
variant-offer synchronization need compatibility/reconciliation acceptance before
deployment. Quotes do not reserve inventory. A successful charge must never lead
to an instruction to pay again when stock/slot confirmation needs support review.

For future inventory/catalog regressions only; no repeat is needed now:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\runAtlasIntegrationTests.ps1 -RunTests -Suite Checkout

Use the same dedicated TEST credentials privately. No new API key, production URI,
paid provider call, deployment or app rebuild is needed for this gate.
All eight prepared Atlas gates passed at their recorded revisions, including
PlannedCheckout below. This is not completion or production
approval of the coordinated release.

| Feature | Local foundation | Still required for the complete feature |
|---|---|---|
| Scheduled delivery | WAT rules, calendar validation, reservation/expiry models, transactional area/vendor/rider capacity claims, idempotent confirmation/release, due-only dispatch policy | Authoritative slot generation from actual vendor hours, product restrictions and area/rider policy; checkout/price/stock/payment hooks; late-paid-slot support/reconciliation; reschedule/cancel transaction; actual dispatch guards on every rider entry point; customer/vendor/admin/rider views; reminders and analytics |
| Photo reviews | Delivered paid-purchase eligibility including verified pickup; max five photo IDs; strict stars/optional text; JPEG/PNG/HEIC byte/10MB limits; private Cloudinary incoming resize/conversion/metadata-strip adapter and thumbnail request | Durable owned upload records/quotas, actual decode and EXIF/HEIC verification, delivered-only submit route using existing Review model, transaction-safe review/rating updates, customer editor/gallery/filter, vendor reply permissions, moderation/reporting/audit, edit/delete period, retention/takedown and notifications |
| Group ordering | One owner/fulfilment point, private member DTOs, hashed invite, participant limits, revision-protected controls, cutoff scan/outbox; real catalog/stock adapter, shared quote and owner approval; actual one-shipment MainOrder creation composed in one transaction; PlannedCheckout Atlas concurrency/rollback/source-index gate passed 6/6 | Authenticated/rate-limited HTTP/deep links; group creation idempotency/invite regeneration; payment integration, unavailable-item removal, abandoned-group expiry, completion state, realtime notifications and customer/vendor/admin views |
| Recurring orders | WAT calendar retaining month-end anchor, reminder-only plans/occurrences, owner controls, bounded generation/outbox; real catalog validation retaining sizes, explicit quote approval and price-change metadata; future basket/address edits propagate to pending occurrences | Scheduled coverage/slot and future-time pricing, actual order/payment adapter, future schedule editing, expiry/completion worker, substitution approval and threshold UI, real notification delivery and customer/admin screens |

### Planned checkout approval checkpoint (2026-09-20, local only)

`plannedOrderServiceFactory` explicitly composes group/recurring services with the
real Product/ProductOffer resolver. It does not mount a route, start a worker,
connect a database or read production configuration. Legacy string/option/custom
sizes survive saved templates and occurrences; catalog validation supplies the
actual option, variant and offer identity. Group members may select the same
product, but checkout checks their combined quantity against authoritative stock.
Mixed sellers/fulfilment points cannot be combined into one group shipment.

The existing POST /orders/summary calculation is also a server-only function used
by the planning adapter: no copied delivery, subscription or commission formula.
HTTP identity/session cannot be overridden in the request body. Quote calculation
creates neither an order nor a payment and does not reserve inventory.

The owner must present a five-minute HMAC-signed approval matching the current
quote, owner, record/revision, destination, schedule and item/fee snapshot. Changed,
expired, tampered or missing approval fails before the order adapter is called.
Tokens contain hashes, not addresses. Group checkout requires one shipment; both
flows reject an adapter result with wrong owner/total, paid state or wrong shipment
count. Order linking and notification enqueue share the caller's transaction.
Repeated checkout returns the existing link. Recurring checkout also writes the
plan to conflict with concurrent pause/cancel/template controls; its real Mongo
race acceptance is still pending, not proven by fake-transaction tests.

Future item/address edits update already-generated, future unpaid occurrences,
invalidate their estimates and require review. Paid/checkout-linked, skipped and
past occurrences are untouched. Price-threshold metadata is available, but never
authorizes an automatic charge. Recurrence remains reminder-to-pay only.

Boundary at this approval checkpoint: the actual creation adapter was still
pending (now connected locally for immediate groups; see the next checkpoint).
Authenticated planning routes, payment-initiation freshness, settlement and
scheduled dispatch are still not connected. Scheduled quotes deliberately fail with SCHEDULE_UNAVAILABLE (503)
without a real checkSchedule dependency. That future adapter must validate vendor
hours, lead time, coverage, capacity and dispatch readiness; the shared quote must
also gain future-time restaurant/subscription rules before schedules are enabled.
Do not use an always-eligible callback in production. Current shared quote rules
remain the existing immediate-order rules. No runtime activation is authorized by
these offline tests, and no provider verification flow was changed here.

Final local regression: 298 passed, zero failed, seven credential-gated Mongo
suites deliberately skipped (305 total, 35199.8806ms). Twenty-one new cases cover
quote identity/expiry/tampering, real catalog/size/aggregate-stock composition,
owner-only approval, repeat checkout, future edits and rollback, plus actual
HTTP/server-only quote parity and transaction/identity handling. Providers and
database storage remain simulated in these new tests. No new Atlas, production,
browser/device or real-provider pass is claimed.

Configuration: no new paid API or mobile key. The future private composition needs
a backend-only signing secret of at least 32 bytes (the existing JWT_SECRET may be
reused if it meets that requirement). Never put it in Dart defines, Git or chat;
do not rotate a live authentication secret just to run these tests. Tests use only
a synthetic key. All existing Atlas passes remain historical scoped evidence;
updated planning adapters need their own real integration/race acceptance before
release. No repeat of an old passing gate is requested solely to record progress.

The new services require injected trusted catalog/order adapters. The mocks used
in tests are NOT runtime catalog validation. Never mount the services using the
test adapters or accept client-supplied resource keys, totals, seller eligibility
or delivery policies as authoritative.

### Actual group order creation checkpoint (2026-09-20, local only)

The existing order route now exposes a server-only `createUnpaidOrder` helper.
Ordinary HTTP checkout still owns its session; planned checkout supplies the
source/order/outbox transaction. The helper never commits or ends that session,
charges a payment, or reserves/decrements inventory. It reuses the existing
MainOrder and Shipment models, catalog validation and fee rules.

Immediate group checkout claims its source document before receipt creation so
competing transactions retry against the committed order link. A partial unique
index on optional server-owned planning kind/source ID provides an additional
receipt identity guard; ordinary historical orders need no planning field.
Review/rehearse that index with a fresh backup before any production deployment.
No production index or database was changed in this checkpoint.

The owner-approved quote is checked against recalculated items, seller/location,
individual fees, discounts and totals immediately before persistence. Equal
grand totals cannot conceal changed components. HTTP bodies cannot supply the
private approval, owner, transaction or planning context. Payment-initiation
freshness and successful-payment reconciliation remain separate pending work.

Scheduled and recurring creation deliberately returns SCHEDULE_UNAVAILABLE even
if a test availability callback approves: real future-time pricing, capacity
holds, settlement confirmation and due-only dispatch are not connected yet.
Planning public APIs and screens remain unavailable; this is not feature launch.

Offline evidence: 310 passed, zero failed, eight credential-gated database suites
skipped (318 total, 48377.2536ms). Twelve new cases cover actual quote/creator
composition and schema validation, identity/session boundaries, fee changes,
receipt/shipment/outbox rollback orchestration, retry links and loader safety.
Storage is simulated in those tests; they do not prove Mongo transaction races.
Existing delivery, pickup, subscription, restaurant notes and Low Cost's fixed
57-naira commission regressions passed. PowerShell parsing and diff checks passed.

PlannedCheckout passed after quote-ID correction 66a0e1c: user-run
eadc272f392c4c0dbfc060368e9237e6, six passed (five subtests plus parent), zero
failed/skipped, 106565.6784ms. No cleanup error was reported. Eight run-prefixed
collections and actual models/indexes verified concurrent unpaid receipt/source
identity, stale/non-owner rejection, receipt/shipment/outbox rollback, ordinary
order compatibility and scheduled fail-closed behavior. Providers and delivery
fee configuration were simulated; actual payment/notification delivery, capacity
integration, dispatch and UI acceptance remain open. The prior offline regression
after this fix passed 316 tests, zero failed, eight skipped (324 total).

For relevant future regressions only; no repeat is needed now:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\runAtlasIntegrationTests.ps1 -RunTests -Suite PlannedCheckout

No new secret or mobile build is needed. All eight passes apply to their
recorded revisions, not a fresh combined run or full-feature acceptance. No push,
deployment or app build was performed. The existing temporary restaurant radius
override is tracked separately as OLD-11 and remains a release issue.

## Shared integration rules

- Reuse MainOrder, Shipment, Product/ProductOffer, Squad/legacy settlement,
  current shipping quotes, pickup handling and Mongo background jobs.
- A group is one seller/fulfilment point, one owner payment and one delivery fee.
  Participants see their own submitted items and the owner's explicitly shared
  destination label, never the exact address/phone or other baskets/payment data.
- Do not drop legacy size selections when moving an existing cart/order into a
  group or recurring plan. Audit selectedSize versus variantId in the shared
  checkout adapter and add regression tests before connecting the screens.
  Legacy selections are now retained and verified against the real catalog; where
  structured variants exist, the resolver supplies the authoritative variant ID.
  Missing/unavailable/ambiguous selections fail rather than silently losing size.
- Scheduling is a delivery option, not a replacement for vendor-specific pickup.
  A multi-vendor scheduled cart requires a common valid window; otherwise ask the
  customer to split it. Capacity resource rows represent area, vendor and rider
  pool constraints and must all reserve in one database transaction.
- Confirm a reservation inside the same transaction as the verified paid order
  and inventory update. If an already-successful payment arrives after hold
  expiry, preserve the payment evidence and raise an operational exception;
  never silently dispatch, reserve over capacity, or ask the customer to pay twice.
- Capacity release is transactional and idempotent; reservation records have no
  TTL deletion. A failed counter release is an operational inconsistency, not
  successful cancellation. Rescheduling must acquire the new capacity and release
  old capacity in one authorized order transaction.
- Existing summary/order creation now share catalog, seller, price, variant and
  aggregate-stock checks, and settlement handles variant stock transactionally.
  Fresh quote acceptance immediately before payment, historical pending-order
  compatibility and paid-but-unfulfillable reconciliation remain prerequisites.
  Never treat a quote-time stock check as a reservation or automatically increase
  an already-authorized payment when prices change.
- Existing reviews currently permit merely paid purchases. The new delivered-only
  policy is tested but NOT yet connected to that route. Do not label this fixed
  in the live app until the route, history UI and rating aggregates are updated.
- Recurring templates never freeze prices or authorize charges. Each occurrence
  needs the owner's current-price approval/payment; automatic charging remains
  unavailable. Cancelling a plan does not automatically cancel/refund a linked
  paid order. Existing order/refund policy governs that separately.
- Reminder/group jobs contain IDs, event and revision, not private addresses.
  Register authenticated audience-aware handlers before runtime activation. No
  generic worker retry should create a second order or payment.

## Image adapter contract and configuration

Reuse existing CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY /
CLOUDINARY_API_SECRET privately on the backend/worker. No new mobile key and no
new AI-image subscription is needed for review photos. This is ordinary customer
photo conversion, not generative refinement of the product image.

The adapter requests authenticated, non-overwriting assets under an owned review
path, incoming JPEG conversion with fl_force_strip, bounded 1600px output and a
320px eager thumbnail. Private admin previews expire after five minutes. The
caller must create a durable owned upload record and enforce permission/quotas
before invoking it; ambiguous timeouts reconcile that same asset identity.
Provider errors must not expose credentials or uploaded bytes.

Official contracts inspected (not actual provider-test evidence):

- https://cloudinary.com/documentation/eager_and_incoming_transformations
- https://cloudinary.com/documentation/transformation_reference#fl_force_strip
- https://cloudinary.com/documentation/image_format_support

Real tests must verify HEIC decoding, orientation, GPS/EXIF removal, stored and
delivered bytes, thumbnails, URL expiry, rejection/revocation and slow/error paths.
No upload or paid provider request has been made by this checkpoint.

## Validation evidence and next integration stage

Local checks so far: 17 policy/schema tests, six photo-adapter tests and eleven
service-orchestration tests passed. The fake transactional tests exercise rollback
orchestration; they do not prove real Mongo isolation, index or race behavior.
The first full regression run passed 231 tests, failed zero and deliberately
skipped six isolated suites; it preceded the final photo/service-test additions.
The completed final local regression on 2026-09-20 passed 248 tests, failed zero
and deliberately skipped all six credential-gated Mongo suites (254 total,
179541.7217ms). This includes the final input/legacy-variant guards and all 34
new focused tests. PowerShell runner parsing and tracked diff checks also passed.
No real database or paid-provider acceptance is inferred from this offline run.
The subsequent diagnostic-only checkpoint 9f64da3 passed 256 offline tests,
zero failed, with six credential-gated Mongo suites deliberately skipped.

The combined Planning Atlas gate has nine subtests plus its parent. It checks
competing last-slot claims, all-resource rollback, checkout retry identity,
expiry/late confirmation, settlement rollback, group join capacity/privacy,
outbox rollback and recurring occurrence/reminder uniqueness and controls.
Only synthetic data and simulated catalog/order/notification adapters are used.
It does not test real stock/fees/payments, review moderation, apps or providers.

Verified user-run Atlas result after checkpoint 9f64da3 (2026-09-20): run
e66534eddf03421eb7f0934a13ac8bcd passed all ten tests (nine subtests plus parent),
zero failed, zero skipped, 43644.541ms overall. No cleanup error was reported.
This proves the tested Mongo capacity, retry, expiry, privacy and transactional
rollback cases with simulated external adapters, not full customer-facing flows.

For future relevant regressions from the backend repository (no repeat needed
just to confirm this already-passed checkpoint):

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\runAtlasIntegrationTests.ps1 -RunTests -Suite Planning

Use the same TEST credentials and dedicated Atlas cluster. No production URI or
new secret is needed. This creates/cleans only six registered collections with
this run's unique prefix. It never drops a database. All six prepared Atlas
gates have now passed; the previous five remain separate evidence. Actual
checkout/payment/dispatch, review moderation, APIs/workers and app screens still
need integration and acceptance before release.

Earlier Planning attempts failed during connection setup before fixtures or
subtests. The successful run supersedes that current blocker, but does not
identify the earlier failure's cause. The diagnostic fix exposed safe errors;
it did not change credentials, TLS, network or timeout settings. Preserve the
test-cluster restrictions and never change production settings for tests.

## Completion checklist for this coordinated phase

- [x] Read all PDF requirements and preserve one-release scope.
- [x] Map existing order/payment/pickup/review paths and record gaps.
- [x] Add shared domain rules, models and service foundations for all four.
- [x] Run focused offline validation without provider/database calls.
- [x] Verify the new combined Planning gate against isolated Atlas (10/10).
- [x] Compose real catalog validation and shared quotes with private owner approval, retaining legacy sizes (offline-tested; no public/runtime activation).
- [ ] Finish authoritative shared checkout/variant/stock/payment/dispatch integration.
- [ ] Finish review submission, media lifecycle and moderation integration.
- [ ] Connect authenticated/rate-limited APIs and bounded worker handlers.
- [ ] Build customer, vendor, rider/admin views and website deep-link fallbacks.
- [ ] Test failures, permissions, concurrency, provider behavior and all-app flows.
- [ ] Confirm policies/configuration, update privacy/terms and rehearse rollout/rollback.
- [ ] Commit/push the completed release, deploy, build and device-test.
