# Stage 1.7 inventory verification and payment-race decision

## Decision: NO-GO — remain on Stage 1.7

Scheduled Delivery is disabled and its inventory adapter remains unconnected.
This document is a design proposal, not an implemented payment integration.
No production database, provider, pricing, connection or UI configuration changed.

## Environment evidence

Node/npm are not discoverable in the current shell or the checked common Node
installation locations. `node --version` and `npm --version` fail with command
not found. mongod/mongosh are also undiscoverable. Project-local Mongoose is not
installed at node_modules/mongoose/package.json.

Neither MONGO_URI nor INVENTORY_TEST_MONGO_URI is set in the current process;
no root .env file or repository deployment/Render manifest was found. No URI or
credential value was printed. The deployed environment can differ from this shell.

config/db.js connects using MONGO_URI without explicit topology assertions or
transaction options. Existing transaction calls prove intended usage only.
Production replica-set/mongos support, effective write concern, permissions,
session support and receipt indexes remain unverified.

InventoryOperation declares a unique businessKey index (non-sparse, no partial
filter) and compound reservation/type and order/type lookup indexes. The inventory
service checks the unique index before mutations. Actual production indexes were
not inspected. Index creation is a separate deployment prerequisite; no migration
or initialization was run against production.

## Test preparation

test/inventoryService.test.js now includes the exact one-unit hold/hold and
hold/sale collisions, stock 10/held 4 adjustment cases (3 rejected, 10 allowed),
duplicate hold receipts, changed hold keys, post-mutation/pre-commit abort,
required runtime receipt indexes, duplicate terminal operations, and parent/offer
rollback. Concurrency assertions reject unexpected failures instead of ignoring
every Promise.allSettled rejection. Business keys are stable across transaction
callback retries.

The suite remains opt-in for MongoDB. It never falls back to MONGO_URI and creates
only a randomly named test database. No tests have been executed under Node or
Mongoose in this environment. Syntax/pure-helper checks cannot prove transactions.

When a maintained Node runtime and the existing locked dependencies are available:

    node --test test/inventoryService.test.js test/scheduledDeliveryFoundations.test.js
    npm test

For real integration tests, configure INVENTORY_TEST_MONGO_URI to a dedicated
test replica set/mongos, then run the first command again. It checks hello and
uses a random database name. Do not supply production credentials. Verify the
integration parent and all its subtests ran rather than reporting only unit passes
or a skipped integration test. A transaction-capable hello alone is insufficient:
the actual commit, rollback, receipt and concurrency assertions must pass.

The existing confirm/release concurrency test starts with an already-paid order.
It tests the terminal inventory boundary; it does not simulate an external payment
completing while an unrecorded initiation or expiry operation is in progress.
The real payment-attempt fence below needs separate Stage 2 integration tests.

## Current payment/expiry gap

POST /api/orders/:id/payment-intent is not coordinated with DeliveryReservation.
For Squad, initiateSquadPayment runs before order.paymentResult is saved. For
Flutterwave, a reference is persisted before the checkout intent is returned, but
there is still no reservation fence or atomic order/reservation linkage.

Reservation expiry reads its linked MainOrder. An observed isPaid or tx_ref sends
the reservation to review without releasing stock. That is conservative but does
not fence another writer: initiation can be in flight with no persisted reference,
or expiry can read a snapshot before an independently saved reference commits.
Confirmation and release share a unique inventory terminal key; this prevents two
inventory terminal mutations, not provider success outside MongoDB.

No live scheduled checkout exists today, so the scenario is not reachable through
approved public scheduled checkout. It is a blocker before wiring that checkout.

## Smallest proposed scheduled-only payment fence

Reuse MainOrder.paymentResult for provider/reference/amount/currency and verified
evidence, MainOrder.fulfillmentHold and schedule.state for fulfillment review, and
the existing reservation revision and inventory receipts. Do not introduce another
payment provider, charge amount or immediate-order workflow.

Proposed Stage 2 additions to DeliveryReservation, not implemented here:

- paymentFence.state: not_started, initiating, initiated, unknown, verified, failed.
- paymentFence.attemptKey: server-generated stable attempt identity.
- paymentFence.provider and reference: the server-generated provider reference.
- paymentFence.startedAt and resolvedAt.
- inventoryDisposition: held, sold, released, retained when reservation enters review.
- An explicit expiring reservation transition (extend the state enum) and its
  timestamp/history. Align the inventory service's current held-state guard with
  this authorized transition before integration; do not bypass it ad hoc.

Only one active attempt is allowed per reservation. Multiple historical attempts,
if later required, need a separately approved model; do not overwrite unresolved
attempt evidence. Neither timers nor customer callbacks are payment authority.

### 1. Begin initiation before contacting the provider

In one transaction, conditionally update the reservation's expected revision,
held state, future expiry and not_started payment fence. Persist order/reservation
linkage, the generated attempt/reference and initiating state in both records.
Commit this fence before any external provider initiation or exposing checkout.

If expiry wins first, initiation fails without contacting the provider. If
initiation wins first, expiry observes an unresolved attempt and cannot release.
Both paths write the same reservation revision, so a stale snapshot cannot allow
both transitions to commit. Treat write conflict as a whole-transaction retry.

After the provider responds, update only the matching initiating attempt. A
verification callback that already recorded success must not be downgraded to
initiated. Network timeout means unknown, not failed. Do not automatically create
a second charge or assume provider initiation retries are idempotent.

### 2. Expiry

Conditionally claim expiring using the same reservation revision and payment
fence. With payment not_started, release inventory, reduce window reserved capacity
and mark expired in one transaction. With initiating/initiated/unknown/verified,
retain inventory and move to review with its disposition recorded.

An unresolved provider attempt has no time-only safe release deadline. Reconcile
using server verification. A not-found response or request timeout is not proof
that an existing checkout can never be paid. Final failure/cancellation must be
authoritative; provider-specific invalidation semantics require verification.

### 3. Verified payment

Use existing server verification. For an eligible held reservation, atomically
persist verified payment, run hold confirmation (never immediateSale as well),
change reservation/window/schedule states, and authorize fulfillment. Duplicate
webhooks/recovery use the same attempt and terminal operation identities.

If inventory cannot be confirmed, abort allocation and then persist server-
verified financial success plus a fulfillment hold in a dedicated reconciliation
transaction. External money cannot be rolled back by aborting MongoDB. Failure to
persist that evidence must remain retryable through the same reference; it must
not create another provider charge. No vendor release occurs before allocation.

Immediate orders keep their current settlement timing and provider behavior.

## Payment success after confirmed expiry/release

Expected outcome: paid, unallocated, needs_attention.

- Preserve verified provider/reference/amount/currency/time in MainOrder.paymentResult.
- Record isPaid as financially verified; do not use it alone as fulfillment authority.
- Set the existing fulfillmentHold active and schedule.state to needs_attention.
- Keep inventoryDisposition released and the expired/released reservation evidence.
- Do not run immediateSale, replay hold confirmation, dispatch, or charge again.
- Resolve through an approved refund or explicit fresh allocation decision. Do not
  automatically recreate a reservation or consume inventory allocated elsewhere.

services/scheduledFulfillmentService.js already provides recordFulfillmentAttention.
Reuse this boundary, but it currently has no shared-session input and does not
persist financial success. Stage 2 must integrate it transactionally with verified
evidence, and enforce the hold in all vendor/dispatch/rider authorization paths.
The existing schema/helper alone does not complete reconciliation.

## Existing foundation guarantees and limits

Stock/hold/sale/adjustment operations use atomic conditions and shared transactions.
Receipts are created inside the same transaction, and callers must abort on every
error. Direct service callers must not catch an error and commit remaining partial
writes. Product/offer invariants and rollback still require real runtime proof.

Confirmation/release primitives leave reservation state/window changes to their
transactional caller. Their receipts prevent double inventory mutation, but do not
by themselves provide a full scheduled lifecycle. Invalid/fractional legacy stock
or quantities and missing stable shipment-item IDs fail closed, so deployment must
review that data without normalizing it automatically.

Metadata-only product edits no longer set offer stock. Explicit edits use expected
revisions and reserved-stock bounds. A stale client form omitting inventoryRevision
is still indistinguishable from an intentional absolute recount. Endpoint-level
Mongoose tests remain required; source inspection cannot prove save-hook behavior.

## Remaining go/no-go prerequisites

1. Available Node/npm and existing locked project dependencies.
2. Dedicated transaction-capable MongoDB test environment and executed full suite.
3. Read-only production hello/topology, effective options/permissions and index checks.
4. Provider-free scheduled initiation/expiry state-machine tests after fence approval.
5. Tests for success after expiry and durable paid/unallocated reconciliation.
6. Endpoint-level stock editing/metadata races and immediate settlement regressions.

No GO decision is justified by static checks or a declared unique index alone.
