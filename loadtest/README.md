# Separate NaijaGo browsing load-test environment

This prepares the first capacity test: real category, catalog, product-detail and
catalog-search handlers against a separate database. It does **not** yet measure
checkout, orders, wallets, authentication, Socket.IO tracking/chat, mobile rendering,
image downloads/CDN traffic, or background workers. Passing 5,000 browsing sessions
does not prove capacity for 5,000 customers using all app features simultaneously.

Nothing here creates a Render resource, changes billing, installs k6, seeds a
database, contacts the production service, or runs a load test automatically.

## 1. Provision the isolated database first

Use a separate MongoDB cluster/instance, preferably the same tier/region as the
production setup being evaluated. A different database name on the production
cluster still shares its CPU, memory and I/O and is not an isolated capacity test.
Do not copy production customers, passwords, tokens, orders or account details.

Create a database named **naijago_loadtest**. Populate it using a separate seed/admin
account with synthetic products, vendors, categories, offers and deals as needed.
Match the approximate production document counts, field sizes, product variety
and query indexes. Do not use real emails, phone numbers or external image URLs.
Create the schema indexes during provisioning, before using a read-only account.
No seeder is included yet: choose dataset sizes after checking the real catalog
counts, without downloading customer records.

Create a dedicated backend database user with **only** the built-in `read` role on
`naijago_loadtest`. Do not grant `readWrite`, `readAnyDatabase`, admin or custom roles.
The server checks authenticated roles with `connectionStatus` and refuses to start
otherwise. Check the database provider's network access rules for the staging service.

## 2. Create a NEW Render web service

Resolve any Render billing warning before creating paid resources. Choose the
NaijaGo/naijago_backend repository, the branch containing these files, Node runtime,
and name the service **naijago-loadtest**. Use the same region and CPU/RAM as the
production configuration you want to evaluate; pricing changes require your choice.

- Build command: `npm ci`
- Start command: `node server.js`
- Health check path: `/`
- Environment: enter `loadtest/render.env.example` as separate name/value fields,
  replacing the database URI and two new random secrets privately in Render.
- Do not link production environment groups, disks, databases or secret files.
- Do not configure Kora, Flutterwave, Squad, email, push, AI, storage or map keys.
- Do not launch any separate workers for this browsing test.

`NODE_ENV=production` preserves normal production runtime settings. It does not
enable live payments here: `LOAD_TEST_MODE=browse-only` gates access before routes
and explicitly disables automatic collection/index creation, startup index cleanup,
settings initialization, startup runners and Socket.IO handshakes. Only GET/HEAD
root, categories, catalog, search and ObjectId product detail paths are permitted.
All non-root allowed paths also need `X-NaijaGo-Loadtest-Token`.
External AI search is blocked. Provider credentials cause startup to fail.

Do **not** set LOAD_TEST_MODE on the existing live service: it would reject normal
app requests. When the variable is absent or `off`, the existing server path is used.
Do not rely on this mode to enforce a read-only database if a broadly privileged
database user is configured; the role check is required and must pass.

## 3. Install k6 on the test generator, if missing

Follow [Grafana's Windows installation instructions](https://grafana.com/docs/k6/latest/set-up/install-k6/).
For example, if winget is available: `winget install k6 --source winget`.
Check `k6 version` after opening a new terminal. No application npm dependency is added.

Run from the backend repository directory. In PowerShell, set variables in your own
terminal (do not send the token in chat, screenshots or Git):

```powershell
$env:BASE_URL = 'https://naijago-loadtest.onrender.com'
$env:LOAD_TEST_ACCESS_TOKEN = 'PASTE_STAGING_ONLY_TOKEN_LOCALLY'
$env:PROFILE = 'smoke'
k6 run loadtest/browse.k6.js
```

Replace the example URL with the exact URL Render assigned to the **new** service.
Only naijago-loadtest Render hostnames (optional suffix) and explicit localhost
ports are accepted. Redirects are not followed. The script checks the staging marker,
response shapes and a nonempty catalog before creating load. Never remove these guards
to point it at `naijago-backend.onrender.com`.

## 4. Increase traffic only after reviewing each result

Use PROFILE in this order: `smoke`, `baseline`, `500`, `1000`, `2500`, `5000`.
Each run ramps through its smaller stages, holds each smaller stage for 3 minutes
and ramps down. Smoke is about 70 seconds. PROFILE=5000 holds 5,000 virtual users
for 15 minutes and additionally requires:

```powershell
$env:PROFILE = '5000'
$env:CONFIRM_5000 = 'yes'
k6 run --summary-export loadtest/summary-5000.local.json loadtest/browse.k6.js
```

**Do not start with this command.** Start with the smoke run above and review metrics.
Sessions pause between catalog/detail/search actions. VUs are not requests per second.
Most product IDs come from randomly selected catalog pages, not one fixed product.
Search terms are sampled from the first 50 fixture product names: revise the fixture
variety and workload distribution before treating results as representative.

Initial targets (proposed, not a measured service guarantee): p95 request time <2s,
unexpected HTTP failures <1%, invalid response checks <1%, no restarts, stable CPU/RAM
and database latency. Script aborts after its initial evaluation delay if HTTP failures
reach 10% or p95 exceeds 10s. These request-based aborts do not replace human monitoring
of CPU, memory, database connections/latency, network throughput and service restarts.
Stop with Ctrl+C if resources saturate. A failed threshold exits k6 unsuccessfully.

Monitor the generator's CPU/RAM/network too. 5,000 VUs may need a separate adequately
sized generator or distributed execution. Do not attribute generator limits to the API.
Record app commit, dataset/index counts, service/database tiers, test profile,
achieved VUs/RPS, p50/p95/p99, HTTP failures, checks and resource graphs for each run.
Repeat tests and examine recovery after traffic stops.

## Status / next coverage

These files are preparation, not evidence of a deployed or passing load test. The
staging database, synthetic dataset, Render service and metrics still need provisioning.
Local JavaScript syntax checks and Git whitespace checks passed. No runtime,
database integration or HTTP load test has been run; k6 was not found on PATH.
Build separate authenticated/order/Socket.IO workloads after this browsing baseline.
Write scenarios require another isolated configuration with mocked integrations and
reviewed transaction invariants; do not relax browse-only mode for those scenarios.

References: [k6 test progression](https://grafana.com/docs/k6/latest/testing-guides/test-types/stress-testing/),
[large test generators](https://grafana.com/docs/k6/latest/testing-guides/running-large-tests/),
[Render Node deployment](https://render.com/docs/deploy-node-express-app),
[MongoDB built-in roles](https://www.mongodb.com/docs/manual/reference/built-in-roles/).
