# Isolated MongoDB regression tests

The opt-in suite is test/integration/exploreMongo.test.js. It does not read
MONGO_URI. Never point it at Atlas, a production clone with credentials, or an
existing database. It accepts only an explicitly supplied loopback Mongo replica
set URL without a database/user/password, and creates a random naijago_test_*
database. It verifies that exact name before deleting its own test database.

Prerequisite: a running local Mongo replica set, optionally via Docker Desktop.
Docker was installed but its engine was not running during implementation; no
container or paid service has been created and no real Mongo test has run yet.

In a disposable local test environment, expose Mongo only on loopback. Start a
single-node replica set, initialize it and wait for PRIMARY before testing.
Example URL when its host port is 27018:

    mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true

Set NAIJAGO_TEST_MONGO_URI to that local test URL in the test terminal, then run:

    node --test test/integration/exploreMongo.test.js

Clear the test variable afterward. Normal npm test deliberately reports this
suite as skipped without the variable. A skipped test is not a pass.

Current assertions: concurrent enqueue/claim uniqueness, expired lease recovery,
stale-worker acknowledgment rejection, concurrent reactions/comments with their
transactional notification outbox, and rollback on outbox failure. Expand with
search aggregates, media moderation races, scheduling, group carts and payment
settlement before the integrated release. No provider calls or payments belong
in this isolated suite.
