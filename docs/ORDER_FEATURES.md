# Coordinated scheduled, photo-review, group and recurring order phase

Started 2026-09-20 after the user asked to implement all four in one coordinated
phase. The complete ten-page new_feature_to_add_docs.pdf was read. Its suggested
separate releases are superseded by the user's single-release instruction, not
its payment, privacy, inventory or acceptance requirements.

## Current boundary: foundations and shared checkout, NOT four completed features

The new domain services and schemas are local. No new planning/review public
routes are mounted, no scheduled payment/dispatch hook is activated, and no worker
is running these new jobs. Existing order summary/creation now share authoritative
catalog validation; the existing wallet/provider stock hook handles offer variants
transactionally. Provider verification and delivery pricing policies are unchanged.
No app screen, release build, migration or production deployment is claimed.
Do not enable/publish the four features based on these foundations alone.

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
  The new `Checkout` Atlas gate is PREPARED, NOT yet verified. It tests five real
  Mongo cases plus parent using only three registered per-run collections.

Next: run the Checkout gate, then connect the resolver to group/recurring adapters
without losing legacy sizes, enforce owner acceptance of changed quotes immediately
before payment, link slot confirmation to settlement, preserve late/stock-conflicted
successful-payment evidence for reconciliation, and guard every dispatch entry.
Historical pending orders without offer IDs, seller reassignment and existing
variant-offer synchronization need compatibility/reconciliation acceptance before
deployment. Quotes do not reserve inventory. A successful charge must never lead
to an instruction to pay again when stock/slot confirmation needs support review.

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\runAtlasIntegrationTests.ps1 -RunTests -Suite Checkout

Use the same dedicated TEST credentials privately. No new API key, production URI,
paid provider call, deployment or app rebuild is needed for this gate.

| Feature | Local foundation | Still required for the complete feature |
|---|---|---|
| Scheduled delivery | WAT rules, calendar validation, reservation/expiry models, transactional area/vendor/rider capacity claims, idempotent confirmation/release, due-only dispatch policy | Authoritative slot generation from actual vendor hours, product restrictions and area/rider policy; checkout/price/stock/payment hooks; late-paid-slot support/reconciliation; reschedule/cancel transaction; actual dispatch guards on every rider entry point; customer/vendor/admin/rider views; reminders and analytics |
| Photo reviews | Delivered paid-purchase eligibility including verified pickup; max five photo IDs; strict stars/optional text; JPEG/PNG/HEIC byte/10MB limits; private Cloudinary incoming resize/conversion/metadata-strip adapter and thumbnail request | Durable owned upload records/quotas, actual decode and EXIF/HEIC verification, delivered-only submit route using existing Review model, transaction-safe review/rating updates, customer editor/gallery/filter, vendor reply permissions, moderation/reporting/audit, edit/delete period, retention/takedown and notifications |
| Group ordering | One owner/fulfilment point, private member DTOs, hashed invite, participant limits, revision-protected own-item edits, owner close/extend/remove/cancel, cutoff scan, transactional event outbox, shared-transaction checkout adapter with retry identity | Authenticated/rate-limited HTTP and deep links; creation idempotency/invite regeneration; real catalog/variant/aggregate-stock validation; current quote/fee acceptance and exactly-one-shipment checkout integration; unavailable-item removal, abandoned-group expiry, payment completion state, realtime notifications and customer/vendor/admin views |
| Recurring orders | WAT weekly/biweekly/monthly/custom-day calendar retaining month-end anchor, reminder-only model, private plans/occurrences, skip/pause/resume/cancel and quantity/address edit services, bounded generation with transactional reminder outbox, no catch-up charges | Real catalog/coverage/slot validation adapter, owner-approved checkout/payment linkage, future schedule editing and propagation to already-generated unpaid occurrences, expiry/completion worker, price threshold display/substitution approval, notification delivery and customer/admin screens |

The new services require injected trusted catalog/order adapters. The mocks used
in tests are NOT runtime catalog validation. Never mount the services using the
test adapters or accept client-supplied resource keys, totals, seller eligibility
or delivery policies as authoritative.

## Shared integration rules

- Reuse MainOrder, Shipment, Product/ProductOffer, Squad/legacy settlement,
  current shipping quotes, pickup handling and Mongo background jobs.
- A group is one seller/fulfilment point, one owner payment and one delivery fee.
  Participants see their own submitted items and the owner's explicitly shared
  destination label, never the exact address/phone or other baskets/payment data.
- Do not drop legacy size selections when moving an existing cart/order into a
  group or recurring plan. Audit selectedSize versus variantId in the shared
  checkout adapter and add regression tests before connecting the screens.
  The current domain gate rejects a legacy selectedSize without an authoritative
  variantId rather than silently losing it; full legacy mapping remains required.
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
- [ ] Finish authoritative shared checkout/variant/stock/payment/dispatch integration.
- [ ] Finish review submission, media lifecycle and moderation integration.
- [ ] Connect authenticated/rate-limited APIs and bounded worker handlers.
- [ ] Build customer, vendor, rider/admin views and website deep-link fallbacks.
- [ ] Test failures, permissions, concurrency, provider behavior and all-app flows.
- [ ] Confirm policies/configuration, update privacy/terms and rehearse rollout/rollback.
- [ ] Commit/push the completed release, deploy, build and device-test.
