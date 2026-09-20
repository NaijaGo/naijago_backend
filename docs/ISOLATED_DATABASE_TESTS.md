# Isolated MongoDB regression tests

The opt-in suites are test/integration/exploreMongo.test.js and
test/integration/searchMongo.test.js. They never read MONGO_URI. Do not modify
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

Use -Suite All to run both sequentially. Search uses the actual Mongoose schemas,
indexes, aggregation, population, cache leases and quota writes, with synthetic
fixtures and simulated Gemini responses. It does not contact a paid AI provider,
create real listings, or change deployment flags. The actual Search Atlas result
is still pending; offline syntax/unit tests do not establish a database pass.

The script restores the previous test environment variables on exit. Atlas use
requires NAIJAGO_ALLOW_ATLAS_TESTS=true; the interactive script supplies it only
for its child process. TLS, majority writes, retryable writes and the test database
are enforced. Unknown/unsafe connection options are rejected.

Explore creates four uniquely named ngtest_<random-run-id>_* collections; Search
creates five (users, products, offers, AI cache and quota). All uses a separate
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

Clear the test variable afterward. Normal npm test deliberately reports this
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

Current assertions: concurrent enqueue/claim uniqueness, expired lease recovery,
stale-worker acknowledgment rejection, concurrent reactions/comments with their
transactional notification outbox, and rollback on outbox failure. Expand with
search aggregates, media moderation races, scheduling, group carts and payment
settlement before the integrated release. No provider calls or payments belong
in this isolated suite.

## Search gate prepared for the next Atlas run

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
customer-device UI checks. No Search database pass is claimed before user output.
