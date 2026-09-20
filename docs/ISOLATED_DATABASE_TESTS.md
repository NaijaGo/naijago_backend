# Isolated MongoDB regression tests

## Follow-up planning adapters: offline checkpoint only

After the verified Checkout gate below, group/recurring composition now uses real
catalog validation and the shared quote calculation, preserves legacy selections,
requires expiring owner-approved quotes and checks the unpaid-order adapter result.
The Planning suite's simulated commercial validators were updated to the new
return contract; the suite was not rerun against Atlas at this checkpoint.
The previously reported ten-test pass remains evidence for its earlier revision,
not proof of new quote, future-edit or checkout-versus-pause/cancel races.

Before activation, add/run combined real catalog/order/slot/plan concurrency cases
after the actual order and scheduled adapters are connected. Offline rollback
fixtures are orchestration tests, not Mongo isolation evidence. Keep credentials
private; no new connection, key, production database, deployment or device build
is needed just to record this local stage.

## Latest verified gate: Checkout

User-supplied Atlas output (2026-09-20), after checkpoint 9c1cd18, verifies run
509083010de949d8b4f8f2d912e8a4ce: six passed (five subtests plus parent), zero
failed, zero skipped, 43191.5829ms overall. No cleanup error was reported.
All seven prepared database suites have passed; the complete release has not.

The existing order routes share authoritative catalog/variant validation and
transaction-only inventory handling. Checkout tests these real services on the
dedicated test database, independently of the already-passed Planning gate.
Do not repeat it solely to record progress. For relevant future regressions:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\runAtlasIntegrationTests.ps1 -RunTests -Suite Checkout

Verified scope: five subtests plus parent; only Product, ProductOffer and User
collections under the newly generated run prefix. The existing safety helper
creates indexes and removes only those owned collections. No production setting
is loaded or changed; no order, charge, provider call or paid service is invoked.
The `All` runner now includes this seventh suite.

Cases: real catalog/offer/variant resolution and aggregate stock; concurrent last
variant sales; transaction rollback of parent/variant/sales counters; independent
secondary-seller stock and seller/variant mismatch rejection; legacy no-offer
variant stock. This does not prove payment idempotency, historical pending-order
recovery, dispatch safety or app/device acceptance. Offline HTTP tests use fake
database queries and cannot replace this real-Mongo gate.

Keep credentials in the existing hidden prompt. Do not paste passwords/URIs into
chat, put them in the repository, or substitute the live MONGO_URI.

## Previously verified gate: Planning

User-supplied Atlas output (2026-09-20), after checkpoint 9f64da3, verifies run
e66534eddf03421eb7f0934a13ac8bcd: 10 passed (nine subtests plus parent), zero
failed, zero skipped, 43644.541ms overall. No cleanup error was reported.

Verified scenarios: competing capacity claims across area/vendor/rider resources;
retry identity without partial reservations; one-time expiry release and rejection
of late hold confirmation; payment-transaction rollback and confirmed hold safety;
group membership limits/privacy; group outbox rollback; recurring occurrence and
reminder uniqueness; recurring outbox rollback; owner-only skip/pause/cancel.

All six previously prepared database gates passed: Explore (5), Search (13),
Workers (5), Requests (7), Refinement (8) and Planning (10). Counts include parent
tests. External providers and commercial adapters were simulated. This is not
real payment, photo moderation, app/device or completed-release acceptance.
Next: finish real checkout/payment/dispatch and review integration plus all-app
interfaces. Do not rerun passed gates solely to claim progress or deploy the
incomplete release. See ORDER_FEATURES.md and INTEGRATED_RELEASE_CHECKLIST.md.

### Earlier connection investigation (superseded by the passing run)

The first user-run attempt on 2026-09-20 reported one failed parent and no
subtests because openIsolatedTestDatabase could not connect. It stopped before
collection creation or fixtures. This is connection-setup evidence, not a failed
capacity/privacy/recurrence assertion. The root cause is not identified by the
generic error. For any future connection-only investigation, the existing
credential-safe, read-only diagnostic remains available:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\runAtlasIntegrationTests.ps1

Share only its diagnostic code, stage and guidance, never the password or URI.
Check only the TEST project's cluster/IP access and database user as indicated;
do not change production MONGO_URI or allow access from everywhere as a shortcut.

Local foundation validation passed 248 tests with zero failures and six deliberate
Mongo-suite skips. The test cluster SRV records resolved successfully from this
workspace. The user subsequently obtained TEST_DATABASE_CONNECTION_OK from the
read-only diagnostic, then Planning failed again during connection setup in
13.2 seconds, before any fixtures or subtests. The subsequent successful Planning
run resolves the current blocker, but the earlier failures' cause remains unknown.

The read-only probe uses the MongoClient exposed by Mongoose, while integration
tests use mongoose.createConnection(). Both use the validated test target, TLS
and a 10-second server selection timeout. Their pool ceilings differ (1 and 20),
and the Mongoose path also disables automatic collection/index creation. These
differences are not proven causes and have not been changed speculatively.

The shared integration helper now uses the existing credential-safe classifier
instead of discarding its connection error. It reports TEST_DATABASE_* code,
stage and guidance, recognizes MongooseServerSelectionError, unwraps nested
authentication/DNS/TLS errors, and never retains the raw driver error as a cause.
Focused diagnostics/harness/safety tests: 29 passed, zero failed. Full offline
regression after this change: 256 passed, zero failed, six credential-gated Mongo
suites deliberately skipped (262 total, 68189.5904ms). Production
settings, timeout/pool policy, TLS validation and collection guards are unchanged.
The command below is retained for future relevant regression tests. There is no
need to rerun this passed checkpoint. The raw-driver connection check alone is
never evidence that the Mongoose integration suite passed.

The original five gates below passed. The coordinated four-feature phase adds
test/integration/planningMongo.test.js: nine subtests plus parent for concrete
window capacity/reservation/expiry/settlement rollback, group join limits/privacy
and outbox rollback, and recurring occurrence/reminder identity and controls.
Catalog/checkout/provider adapters are simulated; this is not real payment,
inventory, photo-moderation, browser or app acceptance. See ORDER_FEATURES.md.

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\runAtlasIntegrationTests.ps1 -RunTests -Suite Planning

The gate uses six isolated collections: DeliveryWindow, DeliveryReservation,
GroupOrder, RecurringPlan, RecurringOccurrence and BackgroundJob. The whitelist
now contains 16 model names, but each suite can create/clean only its own declared
collections with a unique run prefix. Production settings remain untouched.

## Previously verified gate: Refinement

User-supplied Atlas output (2026-09-20), after checkpoint e2afcfe, verifies run
14f152de66ce4493b7257c05ee47223b: 8 passed, 0 failed, 0 skipped, about 71.8 seconds
overall. All seven subtests and their parent passed; no cleanup error was reported.

At that checkpoint, all five prepared gates had passed: Explore (5), Search (13), Workers (5),
Requests (7) and Refinement (8). These counts include the parent tests; they do
not mean the entire release is tested or ready to deploy.

For relevant future regressions, from the backend repository (no repeat needed
solely to record this successful run):

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\runAtlasIntegrationTests.ps1 -RunTests -Suite Refinement

Seven subtests plus their parent use real isolated Product, ImageRefinement,
BackgroundJob and AiUsageBucket collections: concurrent dedupe/quotas, outbox
rollback, preserved originals, approval/publication concurrency, stale vendor-save
rejection, seller reassignment, global budget bounds and durable upload scheduling.
Photoroom and Cloudinary are simulated; no provider key or paid call is needed.
Existing Explore/Search/Workers/Requests passes remain recorded below. Actual
Photoroom quality, Cloudinary access/expiry, browser/device review, retention and
hosting acceptance remain separate release gates. See IMAGE_REFINEMENT.md.

The opt-in suites are test/integration/exploreMongo.test.js,
test/integration/searchMongo.test.js, test/integration/workerMongo.test.js,
test/integration/requestMongo.test.js, test/integration/refinementMongo.test.js
and test/integration/planningMongo.test.js.
They never read MONGO_URI to connect. Do not modify
the production connection or Render configuration. They accept either a loopback
replica set or the one user-approved, separate Atlas
TEST cluster. Production hosts and other Atlas hosts are rejected.

## Atlas alternative (no Docker required)

Approved host: naijago-testing.kwcvhix.mongodb.net.
Fixed database: naijago_integration_tests.
Keep this cluster in the separate NaijaGo Testing project, with test-only
credentials and only the testing computer's current IP allowed. Prefer a database
user restricted to readWrite on naijago_integration_tests in this test cluster.
Do not add production data or live provider credentials to the test database.

From the backend repository, check the connection first:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\runAtlasIntegrationTests.ps1

The script prompts for the test username and a hidden password, URL-encodes them,
and places the connection only in temporary process environment variables. It
does not write credentials to a file or use MONGO_URI. Bypass applies only to
this PowerShell process, not to the computer's persistent execution policy.
Do not share the password, a completed URI, or screenshots containing credentials.

The default command runs only ping/topology checks: no data writes or deletions.
Expected output: TEST_DATABASE_CONNECTION_OK. Connection failures report a safe
diagnostic code, stage and guidance instead of raw driver errors or credentials.
Codes distinguish authentication, permission, DNS, TLS, network/access,
configuration and unsupported topology. NETWORK_OR_ACCESS is not proof that the
password is wrong or that the IP allowlist is the sole cause. Share only these
safe diagnostic lines; do not log the original driver error or completed URI.

The first user-run check failed with the old generic message; its exact cause
was not confirmed. A subsequent user-run check succeeded with
TEST_DATABASE_CONNECTION_OK. No change to production settings was needed.

After the connection check succeeds, explicitly run the isolated tests:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\runAtlasIntegrationTests.ps1 -RunTests

That command keeps running the original Explore suite. Run the new Search gate:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\runAtlasIntegrationTests.ps1 -RunTests -Suite Search

Use -Suite All to run all six sequentially. Search uses the actual Mongoose schemas,
indexes, aggregation, population, cache leases and quota writes, with synthetic
fixtures and simulated Gemini responses. It does not contact a paid AI provider,
create real listings, or change deployment flags. The user-run Search Atlas gate
passed 13 tests with no failures/skips; evidence is recorded below.

The Requests gate has six subtests plus its parent. User-supplied Atlas output
after backend checkpoint c67194b verified run 82f2a8d915cd4ac0b4ee2d9d7ff8c109:
7 passed, 0 failed, 0 skipped, approximately 78.0 seconds overall. No cleanup error
was reported. The command below is retained for future regressions; no repeat is
needed solely to record this successful run:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\runAtlasIntegrationTests.ps1 -RunTests -Suite Requests

It exercises real request uniqueness/owner isolation, concurrent submission with
transactional notification outbox, rollback on outbox failure, simultaneous
preview taps, concurrent global quotas and notification inbox deduplication.
Only synthetic ProductRequest/BackgroundJob/AiUsageBucket/User collections are
created under the same per-run cleanup guards. AI, storage, catalog eligibility
and push providers are simulated here (real catalog rules have the Search gate).
It makes no paid call, order, payment or production change. See PRODUCT_REQUESTS.md.

The script restores the previous test environment variables on exit. Atlas use
requires NAIJAGO_ALLOW_ATLAS_TESTS=true; the interactive script supplies it only
for its child process. TLS, majority writes, retryable writes and the test database
are enforced. Unknown/unsafe connection options are rejected.

Explore creates four uniquely named ngtest_<random-run-id>_* collections; Search
creates five (users, products, offers, AI cache and quota). Workers creates one
BackgroundJob collection, shared only by that run's child processes. Requests uses
four (requests, jobs, quota buckets and users). All uses a separate
run ID and cleanup boundary for each suite. Each suite creates its own indexes
and refuses existing collection names. Cleanup checks
the connected database and the complete list of names against that run's allowed
collections before deleting only collections actually created by the run. It
never calls dropDatabase, deletes other runs, or removes pre-existing collections.
An interrupted process may leave test collections; do not use broad cleanup
commands. Review the printed run ID and exact cluster/database before any manual
cleanup. No live application collections are used by this suite.

## Local alternative

Prerequisite: a running local Mongo replica set, optionally via Docker Desktop.
Docker was installed but its engine was unavailable during implementation. The
local URL must not include credentials or an existing database name. It uses a
random naijago_test_* database and the same per-run collection cleanup rules.

In a disposable local test environment, expose Mongo only on loopback. Start a
single-node replica set, initialize it and wait for PRIMARY before testing.
Example URL when its host port is 27018:

    mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true

Set NAIJAGO_TEST_MONGO_URI to that local test URL in the test terminal, then run:

    node --test test/integration/exploreMongo.test.js

Clear the test variable afterward. Normal npm test deliberately reports these
suites as skipped without the variable. A skipped test is not a pass.

## Coverage and remaining verification

The user confirmed the Atlas connection. The first actual Mongo suite reported
one passing rollback test and three failing subtests (four failures including
the parent test). All three shared the same BackgroundJob.deliveryKey default
error: Mongoose supplied null to a directly registered crypto.randomUUID callback
during an upsert. This was reproduced offline through the real Mongoose query
pipeline and fixed by wrapping randomUUID in a zero-argument callback.

Four new regression tests cover upsert defaults, ordinary documents, preserving
explicit/retried delivery keys, and session propagation. Full local backend
suite after the fix: 142 passed, 0 failed, 1 skipped (real Mongo). Concurrent test
batches settle every request before cleanup; rollback asserts the exact injected
error.

Verified Atlas result (user-supplied terminal output, 2026-09-20): run
265adef2f39e42df98611b23ba1191ba, after local fix e4d9a2d, passed all four
subtests and their parent test: 5 passed, 0 failed, 0 skipped, about 22.8 seconds.
This verifies concurrent enqueue/claim identity and lease fencing, reaction and
comment retry uniqueness with transactional notification jobs, and rollback on
the deliberately injected outbox failure. No cleanup error was reported.
It does not establish actual push delivery, independent worker process crash
recovery, product search aggregates, media provider behavior, or device UX.

Explore assertions: concurrent enqueue/claim uniqueness, expired lease recovery,
stale-worker acknowledgment rejection, concurrent reactions/comments with their
transactional notification outbox, and rollback on outbox failure. The subsequent
Search and Workers gates below also passed. Further database gates for media
moderation races, scheduling, group carts and payment settlement remain necessary
before the integrated release. No real provider calls or payments belong here.

## Search gate verified against Atlas

User-supplied terminal output after checkpoint 92a0f9a, 2026-09-20:
run 44e0cbffc664427e94839d4f384e002b, 13 passed, 0 failed, 0 skipped,
approximately 57.4 seconds. No cleanup error was reported. The twelve subtests
below and their parent passed against real Mongo with simulated AI HTTP.

Twelve subtests plus their parent exercise:

- Broad/specific fashion synonyms, explicit attributes, child/adult separation,
  cross-vendor results and collection chip counts.
- Brands, descriptions, tags, store names, combined budget/rating/stock filters,
  and legacy category paths versus separate category/subcategory fields.
- Approved vendor ownership and offer sellers; hidden/unreviewed products;
  disabled offers must not fall back to stale product stock/price.
- Primary-offer selection, null/zero discounts, zero stock, sorting, legacy
  products with no offer, and price changes between filtering and presentation.
- Full 125-product pagination, stable ties, literal dollar-sign input and safe
  no-result behavior for unknown/stopword-only searches.
- AI interpretation restricted by the same real catalog filters; opt-out and
  catalog matches bypass classification.
- Real concurrent cache claims, global/per-actor quotas, cached free reads,
  private hashed identities, failure cooldown and stale lease recovery/fencing.

The new harness also has five offline safety tests: reject invalid model sets
before connecting, sanitize connection errors, scope creation/cleanup, refuse
existing collections, and clean up owned collections after index setup failure.
Future-dated synthetic clocks keep TTL cleanup from racing quota/cache assertions;
they do not change the computer clock or real provider quotas.

Still separate release gates: real provider schema/model validation, representative
catalog query plans/latency, HTTP/proxy limits, metadata backfill rehearsal and
customer-device UI checks. A test fixture pass does not establish production
performance or correctness of every existing product's inferred metadata.

## Worker process gate verified against Atlas

User-supplied terminal output after checkpoint 485efdf, 2026-09-20:
run 112424a7e8be4f40a4dc8e8fc1d6bac6, 5 passed, 0 failed, 0 skipped,
approximately 50.9 seconds. No cleanup error was reported. All four subtests
and their parent passed. Together with Explore (5/5) and Search (13/13), all
three prepared database gates are verified; this does not complete the release.

To repeat this gate when queue/runner/process-harness changes require it, from
the backend repository run:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\runAtlasIntegrationTests.ps1 -RunTests -Suite Workers

The same hidden test-credential prompt applies. Four subtests plus their parent
use actual separate Node processes, separate Mongo connections and the existing
queue/runner implementation. They check competing claims, restart after a crash
between simulated delivery and database acknowledgment, graceful abort before
delivery, and bounded failure when attempts are exhausted.

The provider is a local receipt map, not OneSignal. Reusing a delivery key returns
the same simulated receipt: this verifies retry identity, not exactly-once real
notification delivery. Test clocks are explicitly advanced past recorded leases;
the host clock is unchanged and tests do not wait the production three-minute
lease. Actual hosting shutdown, heartbeat timing, health alerts and real provider
idempotency remain release gates. A separate offline lifecycle suite now checks
production orchestration with simulated adapters: startup/index failure cleanup,
single-flight scheduling, stop/drain deadlines, handler cancellation and database
close ordering. Its 17 tests passed. The production entrypoint imports without
loading live environment settings or starting work. This does not replace an
actual host restart rehearsal; Workers still tests the queue/runner via test
children, not the live production entrypoint.

Child environments exclude MONGO_URI, provider credentials and NODE_OPTIONS.
Credentials stay in the test process environment, never command-line arguments
or files. Child stdout/stderr are not relayed; failures use safe test messages.
Children cannot create/drop collections or import the production worker/providers.
Parent cleanup confirms each owned child has closed before dropping its own
collection; if a child cannot be stopped, it preserves the collection and reports
failure. Never use broad process-kill or database-cleanup commands.
