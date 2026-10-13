# Rider partnership and daily bonus — local implementation

Date: 13 October 2026. Status: locally implemented and verified; GitHub publication subsequently authorized by the owner. Production deployment and production verification remain outstanding. The backend commit uses `[skip render]` to prevent automatic deployment before the approved agreement and explicit database setup are ready. No real database, payment provider or notification provider was used for testing. No agreement has been published and no real acceptance or bonus has been saved.

## Delivered

- Backend-owned complete agreement documents with unique version identifiers, canonical NFC/LF UTF-8 content and SHA-256 hashes. Draft editing requires a matching revision. Publication locks content; selecting a required published effective version is a separate audited administrator action.
- Append-only acceptance records identify the authenticated rider, exact agreement/version/hash, server UTC timestamp, actor, explicit consent method, server request identifier and bounded platform/app-version metadata. Client identity, timestamps and audit fields are rejected. Unique rider/version indexes and transaction serialization make retries idempotent.
- Agreement checks on HTTP online status, order discovery, order claim, nearby eligibility, automatic dispatch, manual admin assignment, delivery-offer notification, socket availability and socket assignment. Required-version changes share a transaction fence with acceptance and work transitions. Changing requirements takes unaccepted riders offline and releases only unclaimed offers. Claimed deliveries, OTP completion, tracking, balances and payouts remain accessible under existing authorization rules.
- Registration returns an agreement-only JWT. Pending riders may obtain a replacement limited session through verified password/Google sign-in with `agreementOnly: true`; older sign-in requests retain their pending-account rejection. Limited sessions cannot access operational HTTP or delivery sockets. Suspended/rejected accounts remain blocked. Existing email verification, approval and account-linking protections remain.
- Flutter full-document review, unchecked consent, protected navigation, login/restoration/resume checks and action checks. A POST response alone never establishes acceptance: an authoritative status GET must confirm the exact tuple. A timed-out POST is reconciled with GET before retry; failed reconciliation disables resubmission until a successful refresh. A changed version resets consent. No permanent local accepted flag is trusted. An approved operational session can restore an already claimed delivery from the agreement screen, including when agreement verification is unavailable; this does not claim an order or change availability.
- A dashboard card shows authoritative paid completed MainOrder count in an Africa/Lagos calendar day. Twenty qualify for NGN 10,000. Request creation never credits money. Admin approval rechecks eligibility and credits walletBalance/totalEarnings within the same transaction as the claim state change. One rider/day unique claim prevents duplicate credit. Shipments, unpaid orders and unfinished orders do not count.
- Admin Rider Partnership page provides full-text draft editing, separate immutable publication and required-version controls, acceptance history and reasoned bonus approvals/rejections. Text is rendered inertly; secrets and timestamps are never generated in the browser. Lost write responses trigger authoritative reloads.

## Important incomplete inputs and verification

**The user supplied implementation instructions, not the legal agreement itself. No legal text was invented or seeded. Provide the complete approved Rider Partnership Agreement before publication.** The UI loads its full text from the backend. Until explicit database setup and a valid required document exist, new delivery work fails closed with HTTP 503. Existing versions of Go-Rider cannot accept a new agreement; distribute the updated app before enabling enforcement on production.

Transactions require a MongoDB replica set or compatible sharded deployment and appropriate privileges. Local fixtures exercise transaction rollback, concurrent requests and checks, but do not establish real MongoDB transaction retries, index creation, unique-key races, fleet scale performance or live socket/OneSignal delivery. Test those on a separately authorized disposable staging replica set before rollout. The single policy fence intentionally serializes sensitive transitions; measure contention in staging.

Bonus requests are made for the current Lagos day. Riders should request before midnight. An admin can review that pending claim later; the service rechecks its original calendar day. Bonus credit appears in the existing wallet balance/total earnings; historical delivery-only daily/weekly charts have not been rewritten to represent bonuses. The bonus claim is the audit ledger for this credit.

## APIs

Rider routes (authenticated rider identity; agreement-only sessions accepted only on agreement routes):

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/riders/agreements/current` | Complete required document plus authoritative acceptance status |
| GET | `/api/riders/agreements/status` | Same version/hash/status metadata, without full content |
| POST | `/api/riders/agreements/accept` | Explicit current ID/version/hash consent |
| GET | `/api/riders/daily-bonus` | Current-day completion progress and claim state; approved operational account required |
| POST | `/api/riders/daily-bonus/request` | Idempotent pending claim; approved account required |

Admin routes (existing authenticated `isAdmin` authorization, rate limited):

| Method | Route | Purpose |
| --- | --- | --- |
| GET / POST | `/api/admin/rider-partnership/agreements` | List documents / create draft |
| PUT | `/api/admin/rider-partnership/agreements/:id` | Revision-checked draft edit |
| POST | `/api/admin/rider-partnership/agreements/:id/publish` | Immutable publication; does not change requirement |
| PUT | `/api/admin/rider-partnership/required` | Revision-checked required version plus reason |
| GET | `/api/admin/rider-partnership/acceptances?riderId=<id>` | One rider's current status and acceptance history |
| GET | `/api/admin/rider-partnership/bonuses` | Pending claims |
| POST | `/api/admin/rider-partnership/bonuses/:id/review` | Approve/credit or reject with a reason |

Acceptance body: `{agreementId, version, contentHash, accepted: true, platform?, appVersion?}`. Required change: `{agreementId, revision, reason}`. Draft edit/publication requires `revision` matching `__v`. Bonus review: `{state: "approved" | "rejected", reason}`. Authentication identity is never accepted in these bodies. Published effective timestamps are server generated unless an admin supplies a future valid timestamp during publication. Future documents cannot be selected as required.

## Database and explicit setup (not executed)

New collections:

- `rideragreements`: unique `agreement_version_unique` on version.
- `rideragreementpolicies`: singleton `_id: rider-partnership`, revision/fence/history.
- `rideragreementacceptances`: unique `rider_version_unique` on riderId+version; `agreement_riders` lookup index.
- `riderdailybonuses`: unique `rider_bonus_day_unique` on riderId+day; `pending_bonus_review` lookup index.
- Existing `mainorders`: additive `rider_daily_bonus_completion` index on rider/isDelivered/deliveredAt.

New models disable automatic collection/index creation. Server startup never imports or executes setup. No product, order, rider or wallet backfill is included. Existing terms checkboxes are not converted into acceptance records. The setup does not publish documents or credit wallets.

After separate approval of a chosen **disposable staging database**, use a dedicated connection in `RIDER_PARTNERSHIP_SETUP_MONGO_URI`. The script never reads `.env` or `MONGO_URI`. First inspect the no-write plan:

```powershell
node scripts/initializeRiderPartnership.js --database=naijago_rider_staging
```

Applying setup is a separate explicit operation and requires both flags:

```powershell
node scripts/initializeRiderPartnership.js --database=naijago_rider_staging --apply --confirm-database=naijago_rider_staging
```

Do not execute either against production as part of this local task. Review the URI host, database identity, backups and existing data/indexes before any separately authorized rollout. Conflicting index definitions are rejected before writes. Unique-index build failures can leave partial additive setup; inspect and resolve those conflicts manually, then rerun. No destructive index synchronization or collection deletion occurs. Initialization creates an empty policy, so new-work enforcement stays blocked until an admin explicitly publishes and requires the approved document.

Runtime uses existing `JWT_SECRET`, database configuration and admin authentication. No new secret, dependency version or production configuration was added. Optional Flutter `--dart-define=APP_VERSION=<version+build>` enriches audit metadata; it is not an authorization input. Store no backend secrets in Flutter. A usable staging build must retain the existing `ONESIGNAL_APP_ID` public rider-app identifier, Google public OAuth IDs and map configuration, and set `API_BASE_URL` to the authorized staging backend. Existing app startup intentionally displays a configuration error instead of the app when `ONESIGNAL_APP_ID` is absent. The local Gradle APK build establishes compilation, not a configured live rider session; no runtime provider credentials were supplied or exercised.

## Rollout and rollback

1. Provide and review the full legal document; validate database transactions/indexes in authorized staging.
2. Coordinate app distribution, admin deployment, explicit setup, backend deployment, publication and selecting the requirement during a maintenance window. Do not deploy the enforcing backend by itself without preparation: no valid required agreement means no new rider work.
3. Existing accepted versions and records must be retained. A policy rollback is an authorized admin selection of a previously published effective version with a reason and current policy revision. Riders without that version still need to accept it. Previously accepted riders may manually return online after verification.
4. Do not delete history or fabricate acceptance. Do not roll back to backend code that bypasses enforcement as an ordinary policy rollback. Preserve bonus claims: they are necessary to prevent duplicate payment. Reverting UI/code does not reverse a credited bonus; any financial adjustment needs a separate audited process.

## Real test-rider verification (future authorized staging)

1. Create/verify a dedicated staging rider; approve it with the existing admin workflow. Before acceptance, direct online and claim requests must return 403 `RIDER_AGREEMENT_REQUIRED`; unknown configuration/database failure must fail closed.
2. Sign in with updated Go-Rider. Confirm exact full text/version, unchecked checkbox and disabled accept button. Accept; verify the server record and UTC timestamp in admin history. Repeat the POST and confirm the original timestamp/record remain.
3. Go online, inspect vendor/customer mapping, receive an offer and claim it. Run existing pickup/delivery OTP flow. Confirm payments, ownership and capacity checks still apply.
4. Publish/require a second staging version. Verify new work stops, unclaimed offers release, claimed delivery can finish, old acceptance remains and the new document resets consent. Reject a stale ID/hash request with 409.
5. Simulate lost POST response and status-read failures; verify no false success and no work bypass. Expire a limited registration token; verified sign-in should renew only agreement access while pending.
6. Complete 20 **paid** fixture orders on one Lagos day through a sanctioned staging process. Request the bonus; verify no wallet increase. Approve as admin; verify exactly NGN 10,000 credit and no additional credit on a repeated/concurrent approval. Check rejection and day boundary cases.

## Test results

- Backend: `node --test`, database integration environment cleared — **564 total; 556 passed, 0 failed, 8 skipped**. Partnership-specific file contains **39 passing tests**, including the actual claim handler's transactional rider-approval recheck. In-memory fixtures, mocked actual claim/login/auth handlers, and real model middleware without persistence. Socket pathways also receive source trace assertions; no live socket server/database test was run.
- Admin: `node --test` — **60 total; 58 passed, 0 failed, 2 skipped**. New partnership tests: **10 passed**. Skipped tests are opt-in existing Deals/Image Studio browser suites; no partnership browser rendering/live admin login was exercised.
- Go-Rider: `flutter test --no-pub` — **128 passed, 0 failed**. Agreement/bonus/online/claim/token/active-delivery recovery tests run against local fixtures and mocked transport. `dart analyze lib test` — **No issues found**.
- Initial test runs exposed a test import collision and scroll visibility assumptions; corrected and reran. All final executable test failures are resolved.
- Android: `gradlew.bat assembleDebug` — **BUILD SUCCESSFUL**, 8m 34s, 339 tasks (56 executed, 283 up-to-date). Initial offline assembly failed because the existing Google sign-in libraries were not cached; downloading the declared dependencies resolved that failure without changing dependency versions. Final `gradlew.bat assembleDebug --offline` against the latest rider source — **BUILD SUCCESSFUL**, 3m 34s, 339 tasks (24 executed, 315 up-to-date). The local debug APK is at `Go-Rider/build/app/outputs/apk/debug/app-debug.apk`; it is not a signed store release. iOS build unavailable on this Windows host. Release signing, real device sound/background behavior and production verification are not established by local tests.
- Existing native-toolchain warnings remain: Gradle/Kotlin plugin compatibility, upcoming Flutter minimum Gradle/AGP/Kotlin versions and deprecated Gradle features. Existing map tests print the OpenStreetMap tile-usage reminder. These warnings were not suppressed or treated as native/device verification.

The eight backend skips concern real MongoDB Deals, Google concurrency, Image Studio integration/setup/admin setup, inventory transactions, legacy settlement, and Group/Recurring lifecycle. They leave real persistence/transaction behavior unverified. The new feature additionally needs dedicated replica-set integration coverage before production.

## Every file authored or changed for this agreement/bonus task

Paths below are relative to their repository. Earlier local rider UI, map, sound and registration work remains in the working tree and is separately documented; it is not newly authored agreement code.

### naijago_backend

New: `models/RiderAgreement.js`, `models/RiderAgreementPolicy.js`, `models/RiderAgreementAcceptance.js`, `models/RiderDailyBonus.js`, `services/riderAgreementService.js`, `services/riderDailyBonusService.js`, `middleware/riderAgreementGuard.js`, `routes/riderAgreementRoutes.js`, `routes/riderPartnershipAdminRoutes.js`, `scripts/initializeRiderPartnership.js`, `test/riderPartnership.test.js`, `test/support/riderPartnershipFixture.js`, `docs/rider-partnership-local-review.md`.

Modified: `controllers/riderController.js`, `middleware/authMiddleware.js`, `middleware/riderAuthMiddleware.js`, `routes/riderRoutes.js`, `routes/adminRoutes.js`, `services/riderAssignmentService.js`, `server.js`.

### Go-Rider

New: `lib/features/agreement/controller/rider_agreement_controller.dart`, `lib/features/agreement/service/rider_agreement_api.dart`, `lib/features/agreement/view/rider_agreement_view.dart`, `lib/features/dashboard/view/daily_bonus_card.dart`, `test/rider_agreement_test.dart`, `docs/rider-partnership-local-review.md` (pointer to this report).

Modified: `lib/bindings/app_bindings.dart`, `lib/core/api/api_client.dart`, `lib/core/storage/app_storage.dart`, `lib/core/push/onesignal_service.dart`, `lib/core/push/rider_alerts.dart`, `lib/routes/app_routes.dart`, `lib/routes/app_pages.dart`, `lib/features/auth/controller/auth_controller.dart`, `lib/features/auth/view/register_view.dart`, `lib/features/auth/view/google_login_view.dart`, `lib/features/auth/view/splash_view.dart`, `lib/features/orders/controller/orders_controller.dart`, `lib/features/orders/service/rider_api.dart`, `lib/features/dashboard/view/dashboard_view.dart`, `lib/features/notifications/controller/notification_controller.dart`, `test/rider_ui_test.dart` (existing local fixture suite extended).

### naijago.com_admin_panel

New: `rider-partnership.html`, `js/admin/rider-partnership.js`, `test/rider-partnership.test.js`. Modified: `index.html` (one navigation link).

Final diff review: additions are scoped to agreements, bonus claims and associated integrations. No dependency manifest, lockfile, secret, production endpoint/configuration, customer/vendor code, order price, inventory, payment provider or product features were edited for this task. The automatic Flutter analyzer-config additions and macOS generated-registration change were reverted; other generated registrants have no content diff. Earlier local rider UI/maps/notification/registration changes were retained.
