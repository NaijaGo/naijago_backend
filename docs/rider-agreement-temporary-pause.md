# Temporary rider agreement pause

This is an explicitly authorized operational pause, not acceptance. Authentication,
approval, suspension, order ownership, inventory, payment and delivery checks remain
in place. No acceptance records, timestamps or wallet credits are created by the pause.

## Local implementation and activation

The backend defaults to enforcement. Only the exact environment value
`RIDER_AGREEMENT_ENFORCEMENT=false` pauses it; missing, empty, uppercase or other
values enforce. This is a server setting, never a Flutter build flag or rider preference.

1. Deploy the reviewed backend and admin commits manually on Render. No database
   initialization or migration is required to pause. Do not run the initializer.
2. In the backend service's Render environment, add
   `RIDER_AGREEMENT_ENFORCEMENT` with value `false` and redeploy/restart the backend.
   Ensure all backend/dispatch instances use the same reviewed code and setting.
3. Build and distribute Go-Rider 1.0.5+12 or newer with the existing Codemagic workflow.
   Older rider builds do not understand the paused response and remain gated; an app
   update is required. Backend/client rollout must be coordinated.
4. Using a deliberately chosen approved test rider, verify authenticated
   `/api/riders/agreements/status` returns `enforcementEnabled:false`,
   `enforcementPaused:true`, `accepted:false`, `workAllowed:true`, and null agreement,
   acceptance and timestamps. Do not log JWTs. Status uses the existing rider collection
   and does not read the missing agreement storage.
5. Verify login/session restoration, online toggle, dispatch and notifications on a
   test device. Pending riders must remain pending; suspended/rejected riders must
   remain blocked. New acceptance POSTs return 409 while paused. Existing approval,
   online/capacity, payment and ownership checks still apply to delivery actions.

The admin page displays the pause and keeps publication/setup separate. Preparing
a required version while paused still requires initialized storage, published content,
admin authorization, a reason and revision checks. It does not take riders offline or
release offers during the pause. Acceptance history remains separate and unchanged.
Daily bonus storage/setup and admin approval are unaffected by the pause.

## Resume and rollback

After separately authorized database setup, publish the approved immutable document
and select it as required. Verify its indexes, hash and effective date before resuming.
Set `RIDER_AGREEMENT_ENFORCEMENT=true` (or remove the flag) and restart/redeploy every
backend instance. The next status/work check requires real current-version acceptance;
without valid policy setup it returns unavailable and blocks new work. Riders may finish
already claimed deliveries through existing ownership-protected routes. Resuming does
not create acceptance records or immediately rewrite online flags/offers; shared guards
deny new work and dispatch excludes unaccepted riders. Clients refresh on app resume
and before going online/claiming an order; the dashboard must not be treated as proof
of backend authorization.

Do not roll back to a backend that lacks the pause flag while riders still depend on it:
that backend will enforce the incomplete agreement setup again. The updated client
continues to understand the original enforced response, so resume enforcement before
reverting pause code once setup is complete. No data rollback or destructive migration
is needed. Keep historical acceptance and wallet records.

Local mock tests cannot prove real transaction support, deployed instance consistency,
device notification behavior, Apple upload or production login. No production database
connection, setup, environment change or deployment is performed by these instructions.

## Changed files for this correction

Backend:

- `services/riderAgreementService.js`: default-enforced server flag, approved-only
  operational pause, non-acceptance status, dispatch filtering and resumed enforcement.
- `routes/riderAgreementRoutes.js`: nullable agreement in paused status.
- `routes/riderPartnershipAdminRoutes.js`: enforcement metadata and readable
  historical records for restricted riders without granting work access.
- `test/support/riderPartnershipFixture.js`: injected setting for in-memory tests.
- `test/riderAgreementPause.test.js`: eleven pause/security/HTTP/claim/dispatch regression tests.
- `docs/rider-agreement-temporary-pause.md`: this activation, rollback and local review.

Admin (`naijago.com_admin_panel`):

- `js/admin/rider-partnership.js`: paused status, history wording and accurate policy confirmations.
- `rider-partnership.html`: enforcement and policy-impact status areas.
- `test/rider-partnership.test.js`: four new mocked pause/history checks.

Go-Rider:

- `lib/features/agreement/controller/rider_agreement_controller.dart`: strict server
  pause verification, access distinct from acceptance and invalidation/error handling.
- `lib/features/agreement/view/rider_agreement_view.dart`: verified pause/Continue UI.
- `lib/features/dashboard/view/dashboard_view.dart`: pause notice.
- `lib/features/orders/controller/orders_controller.dart`: verified access for loading orders.
- `lib/core/push/rider_alerts.dart`: verified access for notification routing.
- `pubspec.yaml`: 1.0.5+12.
- `test/rider_agreement_test.dart`: seven controller/layout checks for pause and resume.
- `test/rider_ui_test.dart`: actual order loading and pending-session navigation checks.
- `docs/rider-partnership-local-review.md`: matching rollout notes.

## Local checks (13 October 2026)

- Backend full suite: 601 tests, 593 passed, 8 skipped, 0 failed.
- Backend focused agreement suite after extending real-handler protections:
  62 passed, 0 skipped, 0 failed.
- Admin full suite: 106 tests, 104 passed, 2 skipped, 0 failed.
- Flutter full suite: 154 passed, 0 failed; Dart analysis of lib/test/tool: no issues.
- Android local `flutter build apk --debug --no-pub`: passed, producing
  `build/app/outputs/flutter-apk/app-debug.apk`. This is a debug compilation check,
  not a signed store release or live backend verification. Existing Gradle/Kotlin
  future-support and Android SDK XML metadata warnings remain; tooling versions
  were not changed as part of this agreement correction.
- iOS archive, Apple upload, signed Android release and real-device verification
  were not run locally. iOS requires the configured macOS Codemagic workflow.
- Backend skips require dedicated real MongoDB and cover Deals, Google account
  persistence, Image Studio integration/setup, inventory concurrency, legacy settlement
  and Group/Recurring lifecycle. No real database URI was supplied to the test process.
- Admin skips are unrelated Deals real-database/browser and opt-in Image Studio browser
  tests. Existing partnership browser checks ran with local fixtures.
- Initial new test failures were incorrect authentication/guard dependency injection
  in mocks (three backend checks), a mock pickup-coordinate shape (one backend check),
  and scrolling to a lazily built button (two Flutter checks). These were corrected
  and reruns passed; no assertions or existing tests removed.
- Final diff review: only the 18 files above; no secrets, database configuration,
  dependencies, migration scripts or unrelated business features changed.

These results establish local behavior, not a deployed pause or real rider verification.
