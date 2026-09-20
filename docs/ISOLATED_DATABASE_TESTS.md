# Isolated MongoDB regression tests

The opt-in suite is test/integration/exploreMongo.test.js. It never reads
MONGO_URI. Do not modify the production connection or Render configuration.
It accepts either a loopback replica set or the one user-approved, separate Atlas
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

The script restores the previous test environment variables on exit. Atlas use
requires NAIJAGO_ALLOW_ATLAS_TESTS=true; the interactive script supplies it only
for its child process. TLS, majority writes, retryable writes and the test database
are enforced. Unknown/unsafe connection options are rejected.

Each run creates four uniquely named ngtest_<random-run-id>_* collections and
their indexes. The test suite refuses existing collection names. Cleanup checks
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
suite as skipped without the variable. A skipped test is not a pass.

## Coverage and remaining verification

The user confirmed the Atlas connection. The first actual Mongo suite reported
one passing rollback test and three failing subtests (four failures including
the parent test). All three shared the same BackgroundJob.deliveryKey default
error: Mongoose supplied null to a directly registered crypto.randomUUID callback
during an upsert. This was reproduced offline through the real Mongoose query
pipeline and fixed by wrapping randomUUID in a zero-argument callback.

Four new regression tests cover upsert defaults, ordinary documents, preserving
explicit/retried delivery keys, and session propagation. Full local backend
suite after the fix: 142 passed, 0 failed, 1 skipped (real Mongo). An Atlas rerun
with the private test password is still required; do not count local tests as
proof that the real concurrency suite has passed. Concurrent test batches now
settle every request before cleanup; rollback asserts the exact injected error.

Current assertions: concurrent enqueue/claim uniqueness, expired lease recovery,
stale-worker acknowledgment rejection, concurrent reactions/comments with their
transactional notification outbox, and rollback on outbox failure. Expand with
search aggregates, media moderation races, scheduling, group carts and payment
settlement before the integrated release. No provider calls or payments belong
in this isolated suite.
