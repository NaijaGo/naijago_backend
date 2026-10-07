# Stage 1.6: central inventory foundation

Scheduled Delivery remains disabled. Normal checkout rejects scheduled requests
even if its configuration flag is enabled. No scheduling adapter is installed.
No scheduled payment integration, pricing, provider or UI change is included.

## Accounting contract

`Product.stockQuantity` and `ProductOffer.stockQuantity` keep their existing
remaining-stock meaning. They are not independent warehouse balances. Existing
immediate settlement continues to deduct the Product and selected ProductOffer.

Both aggregate records gain `reservedStockQuantity` and `inventoryRevision`.
Missing fields are treated as zero. Available stock is stock minus reserved.
Quantities and revisions must be nonnegative safe integers; mutation quantities
must be positive. Reserved stock must never exceed stock.

Allocation identity is Product plus an optional explicit offer belonging to that
Product. Immediate orders keep existing aggregate variant/size accounting.
Holds reject variant/size selections and variant/size catalogs, because existing
settlement cannot enforce their inventory. No variant stock migration is made.

## Service ownership

All service writes require an active MongoDB transaction. Callers own transaction
commit/abort and must abort after any operation error. There is no sequential-write
fallback for standalone MongoDB or unsupported transactions.

- `getAvailableQuantity`, `assertAvailable`: validate aggregate balances.
- `validateInventoryIdentity`, `normalizeAllocations`: resolve and canonicalize.
- `immediateSale`: stock decreases; reserved does not change.
- `reserve`: reserved increases; stock does not change.
- `confirmReservation`: stock and reserved decrease together, sales count rises.
- `releaseReservation`: reserved decreases; stock does not change.
- `adjustStock`: compare expected revisions and reject quantities below holds.
- `restock`: internal primitive only; no cancellation/return/refund caller.
- `initializeOffer`: deliberate first copy, transactionally fenced on the parent.
- `assertNoHolds`: deletion/reassignment guard, used inside deletion transactions.

Product/offer document saves cannot mutate existing inventory fields. Their
normalization hooks still run, but a stock-changing status save must go through
the service or fail closed. Product edits explicitly coordinate stock adjustment
and offer metadata in a transaction. Metadata-only edits never mirror stock into
an existing offer. Optional client inventoryRevision improves stale-form detection;
otherwise the server-read revision protects changes concurrent with that request.

Receipts are inserted in the same transaction before balances change. Stable
sale keys use order/shipment/item IDs. Holds use user/idempotency keys compatible
with the reservation service. Confirm and release share one terminal key, so
both cannot apply. Reuse with different arguments rejects rather than replaying.
Duplicate-key races require a whole-transaction retry; explicit legacy settlement
transactions may return an error first. Retry never means repeating just a write.

The inventory primitives do not update delivery window capacity or reservation
state. Their future adapter must do those updates in the same transaction.
Confirmation requires persisted order linkage and a server-paid eligible order.
Release refuses paid/payment-referenced linked orders. Payment initiation versus
expiry fencing is NOT implemented: that remains Stage 2 integration work.

## Deployment/database requirements — not executed

The inspected connection uses MONGO_URI without asserting topology. Deployment
must have a replica set or mongos supporting transactions. No production URI was
read, no database connection attempted, no backfill performed.

Required new collection: InventoryOperation (Mongoose `inventoryoperations`).
Required indexes:

- `{ businessKey: 1 }`, unique, non-sparse, without a partial filter.
- `{ reservation: 1, type: 1 }`.
- `{ order: 1, type: 1 }`.

The service checks for the unique business-key index before mutations and fails
closed if absent. Provision and verify it before routing production settlements
through this code; do not depend on asynchronous automatic index creation.
Do not drop this index while the application runs.

Existing Product/offer _id indexes support stock operations; no new stock index is
required. Stage 1 reservation/window/job indexes still need deployment verification.
No TTL applies to receipts or reservations. Missing counters need no destructive
backfill. Invalid/fractional inventory and Product/offer discrepancies require
explicit reconciliation; they are not silently normalized here.

## Remaining boundaries

- Catalog creation still initializes new Product/offer records through its legacy
  creation path; it is not an adjustment to an existing balance.
- Manual catalog migration remains uncoordinated. Do not run it concurrently with
  inventory traffic; review it before reservation activation.
- Variant stock enforcement, returns, refunds and cancellation dispositions are
  unchanged. `restock` is not exposed by an API.
- Notification-before-commit behavior and external-paid/stock-unavailable
  reconciliation are unchanged.
- Vendor account deletion is not redesigned: reservation guards protect its
  product deletion phase, but existing offer cleanup/account lifecycle issues remain.
- Legacy items missing a stable shipment-item ID fail closed for settlement and
  require review rather than an invented receipt identity.
- Loaded stock adjustment revisions are safe against concurrent sales during the
  request. Stale forms that omit inventoryRevision cannot be distinguished from
  an intentional absolute recount made against current data.

## Tests

`node --test test/inventoryService.test.js` runs unit tests; integration subtests
are skipped without INVENTORY_TEST_MONGO_URI. This is a dedicated test-only
configuration, never MONGO_URI. The suite overrides the database name with a
random `naijago_inventory_test_...` name, checks transaction-capable topology,
initializes indexes, and cleans up only that random test database.

Integration coverage includes holds, insufficient stock, duplicate terminal
operations, sales under holds, adjustments, Product/offer rollback, and concurrent
hold/sale/adjustment/confirmation. Live provider settlement, real catalog endpoints,
and payment initiation/expiry integration need separate Stage 2 validation.
