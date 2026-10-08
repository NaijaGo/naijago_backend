# NaijaGo Deals — Stage 1

Backend API foundation only. No customer/vendor/Admin UI, paid placement,
student discount, Buy 1 Get 1 or new delivery promotion system is included.
No database migration, production configuration change or deployment was run.

## Vendor requests

Existing JWT authentication and approved vendor status are required.

- `GET /api/deals/mine?page=1&limit=20&status=pending`
- `POST /api/deals`: `{ productId, productOfferId?, discountType,
  discountValue, startAt, endAt, status? }`. Status defaults to `pending`;
  vendors may request only `draft` or `pending`.
- `PATCH /api/deals/:id`: edit discount/date fields on draft, rejected or
  paused Deals; optional status is draft/pending. Edits clear approval.
- `PATCH /api/deals/:id` with `{ "action": "pause" }`: pause pending or
  approved content. An approved Deal must be paused before editing.

Targets cannot be reassigned by editing. Vendor ID, price, featured state and
approval are never accepted from vendor request bodies. Use ISO timestamps
with an explicit timezone, e.g. `2026-10-10T09:00:00+01:00`.

An existing active vendor ProductOffer must be selected when the product has
offers. Aggregate-only Deals are restricted to legacy products without active
or out-of-stock offers. Variant/size Deals fail closed in this first version.

## Admin requests

- `GET /api/admin/deals?page=1&limit=20&status=pending`
- `PATCH /api/admin/deals/:id/moderation`: `{ action, reason? }`.
  Actions: approve, reject, pause, unpause, feature, unfeature.
  Rejection requires a non-empty reason of at most 500 characters.

Only pending Deals may be approved. Unpause requires a previously approved,
unedited paused Deal, revalidation and an available approval slot. Featuring
is editorial only; no payment or paid placement is implemented.
Every transition records actor and timestamp. Revision comparisons reject
concurrent stale writes with HTTP 409.

## Customer requests

- `GET /api/deals?page=1&limit=20`
- `GET /api/deals/:id`

Lists return `{ deals, total, page, limit, hasMore, serverTime }`.
Details return `{ deal, serverTime }`; inactive/unavailable IDs return 404.
Limits are 1–50; pages are 1–1000. Ordering is featured first, then expiry,
then ID. Each Deal includes product/offer/vendor IDs, public product/vendor
information, originalPrice, finalPrice, savingsAmount, savingsPercentage,
discountType/value, startAt/endAt and featured. Internal moderation history
and user credentials are not exposed through customer responses.

The database filters approval, dates, ownership, vendor approval, product/
offer status, reserved-stock availability, unsupported variants, restricted
medicines and restaurant ordering/operating hours before pagination.
Destination-specific delivery availability still requires normal checkout.
Restaurant hour interpretation intentionally matches existing checkout's
server-local time behavior; this stage does not change that behavior.

## Pricing

`services/productPriceService.js` owns price resolution. Existing regular and
discount prices are never overwritten. A timed Deal is calculated from the
regular selected-offer/product price, rounded to two decimals, and compared
with the existing effective discount. Only the lower price applies, once.
If the existing discount is equal or better, the timed Deal is not applied
or advertised. Percentage range: greater than 0 through 100; fixed discounts
must be positive, at most NGN 1 billion, and no greater than current regular
price. Values support at most two decimal places.

Listing, summary, legacy delivery-quote and final immediate order creation
share the resolver. Deal reads are batched per cart with one evaluation time.
Final creation reads within the existing MongoDB transaction; no parallel
operations are introduced within that session. Client price/snapshot fields
are replaced by server-derived values. Shipment items persist dealSnapshot
alongside the existing final item price. Old shipments remain unchanged.

The server re-evaluates pricing at order creation. A Deal can expire or be
paused after a summary, causing a new authoritative total; the existing
customer approved-total check must present the change before payment.
No provider/payment initiation or settlement behavior is modified.
Group/Recurring request contexts explicitly retain legacy pricing and no Deal
snapshot; their services and Scheduled Delivery are unchanged.

## Required database indexes before approval

Deal declares:

- `one_approved_deal_per_target`: `{ targetKey: 1 }`, unique, partial filter
  `{ status: 'approved' }`.
- `{ status: 1, startAt: 1, endAt: 1 }`.
- `{ vendorId: 1, createdAt: -1, _id: -1 }`.
- `{ productId: 1, productOfferId: 1 }`.

Approval/unpause checks the unique index at runtime and fails closed if absent.
An expired approved Deal still occupies its slot: pause it before approving its
replacement. This intentionally permits only one approved Deal per target,
including future schedules, without a background expiry writer.
Deployment index provisioning and real MongoDB concurrency verification are
required separately. Do not run destructive syncIndexes against production.

## Verification still required before activation

Dedicated MongoDB tests must cover simultaneous approvals, CAS edit/moderation
races, index absence, aggregation/count pagination, ownership transfers,
price changes, expiry, parent/offer reserved-stock availability and persisted
snapshots. API tests must cover 401/403, malformed inputs, unknown fields,
vendor ownership and rejection/unpause rules. No runtime test or production
database result is implied by JavaScript syntax checks.

Existing general catalog price filters/sorts still use their existing database
expressions, before Deal decoration. Prices returned are authoritative, but
deal-aware budget filtering/ranking is a later separate enhancement; use the
active Deals API for Stage 1 discovery.
