# Google sign-in and signup - local implementation

Google authentication is implemented for the customer, vendor and independent rider apps.
Public Google OAuth client IDs have been supplied during setup. Console audience settings, saved Render/Codemagic configuration, release signing registration and live login still require independent verification. The implementation remains local until it is reviewed and released.

## Account and security behavior

- The backend verifies Google signatures, audience, issuer, expiry and verified email with google-auth-library.
- Stable Google subjects identify linked accounts; client-supplied emails, prices and roles are not trusted.
- Existing email/password accounts require their existing NaijaGo password once before Google is linked.
- Customer/vendor signup requires first name, last name, a valid Nigerian phone number and consent.
- New vendors remain ordinary accounts and use the existing business application/approval screens.
- Riders complete the existing registration fields and all four verification documents. New Google rider registration does not issue an operational JWT. Pending/rejected/suspended riders cannot log in as approved riders.
- Existing customer/vendor device verification remains in force. Verify the email link and retry Google sign-in on that screen.
- Gmail and verified Google Workspace emails can be verified by Google. Other Google account emails still require NaijaGo email verification. Independent Google riders use /api/riders/verify-email/:token.
- Google tokens and linking passwords stay in memory for the request, are not persisted or logged, and are not returned as app sessions.
- The apps retain email/password login and clear the Google SDK session when logging out.

## Google Cloud setup

Use Google Auth Platform in your Google Cloud project. Configure branding, consent/audience and any test users before device testing.

Create a Web application OAuth client for backend ID-token audiences. You may use one shared Web client or one per app in the same Google project. Do not put a client secret in Flutter.

Register Android OAuth clients using the exact package and the appropriate signing SHA-1 certificate for each build:

| App | Android package | iOS bundle identifier |
| --- | --- | --- |
| Customer | com.naijago.naija_go | com.naijago.naijaGo |
| Vendor | com.naijago.govendor | com.naijago.govendor |
| Rider | com.naijago.gorider | com.naijago.gorider |

For Play-installed apps, register the Play app-signing certificate SHA-1, not just the upload certificate. Register the debug signing SHA-1 for local debug builds. A directly distributed signed APK uses its actual signing certificate.

Create a separate iOS OAuth client for each bundle identifier. Google returns a public client ID ending in .apps.googleusercontent.com.

## Supplied public OAuth configuration

These are public identifiers supplied by the project owner, not client secrets. Their presence here does not prove live sign-in.

Shared Web/backend audience:

    878060644963-ujmbu0ka7g3rh07muknotij2lbsaq4oh.apps.googleusercontent.com

| App | iOS client ID |
| --- | --- |
| Customer | 878060644963-fidv0hop5uu6ekj6ee0tts9885jluoc8.apps.googleusercontent.com |
| Vendor | 878060644963-1m0q9ou6b8c9lskvvrh31q2s142j1pgb.apps.googleusercontent.com |
| Rider | 878060644963-pfh25sa295qbh5fqqbhecegnpnclsc95.apps.googleusercontent.com |

The owner reports creating the Rider Play Store Android client:

    878060644963-gjcd0ccav2cr2h20kmmb2a8ek7626rah.apps.googleusercontent.com

with package com.naijago.gorider and supplied Play app-signing SHA-1:

    7B:02:81:E6:13:CC:F1:09:00:F5:BE:70:85:6F:5A:94:EE:F2:EF:56

The Android client ID belongs to package/certificate registration. GOOGLE_SERVER_CLIENT_ID and all three backend GOOGLE_*_CLIENT_ID variables use the shared Web ID above. Do not substitute an Android or iOS client ID as the backend audience.

Customer and Vendor Play app-signing fingerprints were not supplied during this setup. Their debug registration is not sufficient for a Play-installed release.

The Customer visual workflow pre-build position and iOS arguments were inspected from screenshots/pasted text. Android arguments and saved values, Vendor/Rider workflow settings, and Render values have not been independently inspected.

## Verified local Android signing fingerprint

The newly built customer, vendor and rider debug APKs use this public debug signing certificate SHA-1:

    56:B0:BF:2C:CE:2B:38:3B:35:7E:43:C7:53:F8:08:30:62:36:D3:24

Register this only for local debug OAuth clients with their respective Android package names. Release/Play-installed builds require the actual release or Play app-signing certificate fingerprint; the debug fingerprint is not a production signing credential.

## Backend configuration - later release step

Configure public Web client IDs under these names:

- GOOGLE_CUSTOMER_CLIENT_ID
- GOOGLE_VENDOR_CLIENT_ID
- GOOGLE_RIDER_CLIENT_ID

The existing JWT_SECRET and email-delivery configuration remain required by NaijaGo authentication. BASE_URL must be the public backend URL for verification links. No Google client secret, service-account key or Firebase configuration is needed for this ID-token flow.

Endpoints:

- POST /api/auth/google: app = customer or vendor, idToken, deviceFingerprint, optional oneSignalPlayerId. A 202 GOOGLE_PROFILE_REQUIRED response requests profile completion; repeat with profile containing firstName, lastName, phoneNumber and acceptedTerms=true.
- A 409 GOOGLE_LINK_REQUIRED response requests the existing password; repeat with linkPassword. Google signup does not overwrite or replace an existing account.
- POST /api/riders/google: idToken and optional oneSignalPlayerId/linkPassword. A 202 GOOGLE_RIDER_ONBOARDING_REQUIRED response starts the existing rider application.
- POST /api/riders/register: existing rider profile/documentUrls plus googleIdToken and acceptedTerms=true. The backend derives the email from Google and keeps status=pending.
- Existing successful User/Rider login response formats are reused.

Missing configuration returns a safe 503. Invalid tokens fail closed. Google auth endpoints and Google rider registration are rate limited.

The User and Rider schemas add a unique partial googleSubject index that excludes legacy accounts without that field. Verify those indexes exist before enabling live OAuth; never drop other indexes or migrate old account/order data for this feature.

## App/Codemagic public configuration

For each app/workflow, add:

- GOOGLE_SERVER_CLIENT_ID = the Web OAuth client ID matching that app's backend variable
- GOOGLE_IOS_CLIENT_ID = that app's iOS OAuth client ID (for iPhone builds)

Existing Codemagic build commands pass these public IDs as Dart defines. The iOS build runs tool/configure_google_sign_in.dart, which validates the public IDs and writes the reversed iOS callback scheme into ios/Flutter/GoogleSignIn.xcconfig. Existing referral URL schemes and location permissions are retained.

For a local Android build, use --dart-define=GOOGLE_SERVER_CLIENT_ID=YOUR_PUBLIC_WEB_CLIENT_ID. Android client IDs are registered in Google Cloud, not passed as the server ID.

For a local iOS build on a Mac, set both public environment variables, run dart run tool/configure_google_sign_in.dart from the app root, and pass both as --dart-define values to the Flutter build. Pod installation/native builds must be completed on Mac/Xcode.

Without public IDs, the Google entry shows an availability message and email/password login remains available. Never substitute made-up production IDs or copy Google client secrets into an app.

## Dependencies and CI compatibility

Backend: google-auth-library 10.9.1 (supports Node 18+), plus its required transitive dependencies.
Apps: google_sign_in 7.2.0. Its new platform packages were resolved narrowly to Android 7.1.0, iOS 6.2.0 and web 1.1.0, with google_identity_services_web 0.3.1+2 and platform interface 3.1.0, to avoid forcing a Flutter upgrade beyond existing CI pins. These are newly introduced packages, not downgrades of pre-existing app packages.

Flutter was not upgraded. The installed Flutter 3.47.6 checker rejects Rider Gradle 8.12, AGP 8.9.1 and Kotlin 2.1.0. Rider was aligned narrowly to the checker minimums: Gradle 8.14, AGP 8.11.1 and Kotlin 2.2.20, already used by the successfully built customer/vendor projects. Dependency validation was not bypassed. Pub resolution on the already installed Flutter 3.47.6 required six SDK-pinned transitive lockfile updates in Rider: characters, matcher, material_color_utilities, meta, test_api and vector_math. Customer/vendor existing package versions were retained. Run pub get with the existing pinned CI SDK; do not broadly run pub upgrade.

## Verified local fixes

- Rider Android debug build now passes with Gradle 8.14 / AGP 8.11.1 / Kotlin 2.2.20. Flutter, Java, Android SDK and NDK were not upgraded.
- Backend full tests with google-auth-library 10.9.1: 379 passed, 0 failed, 0 skipped, using the dedicated localhost replica set. Google temporary databases were removed and that server was shut down afterward.
- Customer disabled iOS callback placeholder was corrected to valid URL-scheme syntax; no OAuth client was invented or activated.
- All three Android debug APKs are available at each app repository build/app/outputs/flutter-apk/app-debug.apk. Their successful builds do not verify live Google OAuth or physical-device behavior.

## Final local verification results

| Area | Result |
| --- | --- |
| Backend full suite, final Google library | 379 passed, 0 failed, 0 skipped |
| Customer Flutter full suite | 142 passed, 0 failed |
| Vendor Flutter full suite | 34 passed, 0 failed |
| Vendor model checks | 12 passed, 0 failed |
| Admin existing regression suite | 14 passed, 0 failed |
| Rider Flutter full suite | 20 passed, 0 failed |
| Customer/Vendor/Rider Android debug APKs | All built successfully |
| Flutter analyzer errors | 0 in all three apps |
| Existing analyzer findings | Customer: 4 warnings + 26 info; Vendor: 58 info; Rider: none |
| Git whitespace, all four feature repositories | PASS; no staged files |

All three Android debug APKs were rebuilt successfully with the supplied public Web server client ID and their respective iOS client ID passed as Dart defines: Customer assembleDebug completed in 329.4 seconds, Vendor in 284.7 seconds, and Rider in 247.3 seconds. These are debug builds, not signed release AABs. No local release key.properties configuration was available; release signing must use the correct app upload keystore in Codemagic. No app was installed, no live Google login was attempted, and no production database/configuration, deployment, commit or push was performed. Mac/Xcode, CocoaPods and physical iPhone verification remain outstanding.

## Verification and release limits

Tests use local signed RSA fixtures for Google verification and HTTP routes; no live Google user is impersonated. Google account/index persistence and duplicate-subject races use disposable databases on the existing localhost:27019 MongoDB replica set and remove them afterward. Neither test mode touches production.

Before release, verify actual Google sign-in on Android and iPhone, account linking, new-user profiles, vendor application gates, rider document submission/approval, device-email verification, cancellation, logout and retry. Native platform OAuth configuration is not proved by unit tests.

Apple guideline 4.8 requires an equivalent privacy-preserving login alternative for apps using Google as primary-account login unless an exception applies. The customer app needs this assessed before App Store submission; Sign in with Apple is not implemented by this Google-only task.

Official references:
- https://developers.google.com/identity/sign-in/web/backend-auth
- https://pub.dev/packages/google_sign_in_android
- https://pub.dev/packages/google_sign_in_ios
- https://developer.apple.com/app-store/review/guidelines/#login-services

## Final setup correction and live route check

- Corrected YAML workflows to provide the supplied public Web/iOS IDs directly, removing a dependency on a google_sign_in group that was not created in the visual workflow editor. This does not change the editor workflow or its saved variables.
- Added coverage for each app matching its public IDs, generated reversed iOS callback, and native Debug/Release callback inclusion. No authentication tests were removed or weakened.
- The real localhost replica-set run passed with zero skipped tests. Google temporary database count was zero; no test databases remained. The test server was shut down afterward.
- Empty-token HTTP readiness requests to the deployed backend returned 404 Route not found for /api/auth/google and 401 Not authorized, no token provided for /api/riders/google. These requests could not authenticate or create accounts. They do not verify live Google token exchange or production indexes.
- The Google implementation must be reviewed and released before the configured apps can use these routes. Do not infer live readiness from a successful local build.
- Browser access failed at Windows sandbox initialization, including a fresh-runtime retry. Live Render/Codemagic settings could not be independently inspected.
