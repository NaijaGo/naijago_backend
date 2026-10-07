# Scheduled Delivery Stage 1

Status: backend foundations only; NOT ready for activation. No public scheduled checkout,
Admin UI, historical migration, pricing change or payment-provider change.

## Configuration

`AppSetting` key `scheduled_delivery`, optional `scheduledDelivery` subdocument.
Defaults live in `config/scheduledDelivery.js`: enabled=false, hold=15 minutes,
timezone=Africa/Lagos. Reads do not seed/update the database. No settings API or
startup activation was added. Summary/order creation reject scheduled input;
even enabling the setting cannot enable the unfinished checkout workflow.

## Data

DeliveryWindow owns shared reserved+confirmed capacity. Its unique scope/start/end
index prevents duplicate reusable definitions. Scope identity is server-managed.
DeliveryReservation owns exact product/offer/variant allocations, expiry, user,
optional order, request hash, revision and transition history. There is NO TTL.
MainOrder.schedule is an optional immutable promise snapshot; Shipment has optional
preparationDeadline/scheduledReadyAt. Old orders have no new scheduling defaults.
MainOrder.fulfillmentHold records support attention separately from payment success.

## Stopped inventory portion / Stage 2 blocker

Legacy checkout and stock-management writers do not account for temporary holds.
A separate reservation counter would therefore allow legacy orders to consume
reserved stock. Changing those production writers is outside this foundation scope.

No production inventory adapter or independent stock ledger was invented.
Reservation orchestration is transactional, but fails with
INVENTORY_COORDINATION_REQUIRED until an approved inventory adapter coordinates
ALL sales and inventory-edit paths, including product/offer/variant stock.
This is NOT a claim that atomic production inventory reservation is implemented.

The adapter contract is internal: assertCompatible, validateEligibility, reserve,
confirm, release. Every mutation must use the supplied MongoDB session and stable
business/reservation identity. It must resolve trusted catalogue associations,
validate scope eligibility, prevent overselling across legacy writers, aggregate
shared product/offer quantities, and make repeats safe. Never supply an adapter
from request input. MongoDB replica-set/sharded transaction support and installed
indexes must be verified before testing/activation. There is no nontransactional fallback.

Capacity uses a conditional reserved+confirmed < capacity update and transactions;
confirmation moves reserved to confirmed once. Release/expiry only affect held
reservations. Linked paid or payment-initiated holds enter review without releasing
capacity/inventory. Review resolution, provider reconciliation, refunds and late-payment
handling are deliberately unimplemented. Order linkage must be atomic in a later stage.

## Decisions and eligibility

Arrival window differs from dispatch interval. Timing uses explicit Lagos conversion,
UTC instants and server time. Preparation can precede dispatch; dispatch can precede
the arrival window. Evaluators require enabled configuration, verified isPaid,
confirmed owned/linked reservation, matching window snapshot, no support hold,
valid schedule state/timing, and all delivery shipments ready. They are not connected
to production assignment/claim paths. Immediate orders retain legacy readiness logic.

Vendor list adds isPaid and a derived fulfillmentEligibility object without changing
the array response. No UI behavior or existing accept/ready mutations were changed.
Scheduled preparation remains false until integration. Rejection enum adds only
`rejected`, matching the existing route.

## Jobs

`npm run worker:scheduled-delivery` is an explicit command, not API startup wiring.
The worker does no work while configuration is disabled. SchedulingJob records have
dueAt, retry timestamps/counts, lease owner/token/expiry, business key and notification
key. Conditional claims and token-fenced completion permit stale-lease recovery.
Handlers must still tolerate at-least-once execution; leases are not an exactly-once
guarantee. Expiry delegates to guarded reservation transitions. Inventory operations
remain blocked without the approved adapter. Other job types become `blocked`;
they never prepare, dispatch or notify. No scheduling notifications are sent in Stage 1.

Later handlers need transactionally fenced order transitions and notification-key
deduplication. A job recovered after a crash may repeat its handler. No claims of
tested multi-instance correctness or production deployment are made.

## Verification

`npm test` uses the existing node:test runner. Added tests cover timezone boundaries,
disabled defaults, schema compatibility, dispatch/preparation gates, allocation input,
ownership/revisions and the inventory blocker. Database transactions/concurrency,
leases and real payment settlement still require a controlled replica-set integration
environment. Unit/schema tests do not establish database concurrency safety.
