# Stage 2: image-assisted product forms — local implementation

Date: 2026-10-11. Scope: one selected main product photo in the admin dashboard
and vendor app. No bulk-upload workflow or automatic publication was added.

## Implemented workflow

1. A main-photo selection sends one image to the authenticated backend when the
   user leaves AI suggestions enabled. The switch explains that Gemini receives
   the photo and can be disabled for manual entry.
2. Only an administrator or an approved vendor can request analysis. The normal
   authentication middleware loads current account information.
3. The backend uses the existing backend-only `GEMINI_API_KEY`, inline image
   input and structured JSON output. It supplies the complete Stage 1 taxonomy:
   23 main categories and 186 children, with their original stable identities.
4. Suggestions contain name (also the existing listing title), description,
   visible brand/model, relevant tags and editable visible attributes. Price,
   stock, seller, approval and publication fields are excluded. Unknown visible
   facts are requested as empty strings. This is a prompt constraint, not proof
   that the model's visual claims are correct.
5. Stable parent/child IDs are checked against the authoritative manifest. An
   unknown ID, wrong parent, missing child, ambiguity, confidence below 0.85 or
   contradictory medicine/food evidence prevents automatic category selection.
   Model confidence is not a calibrated probability.
6. New-product forms autofill suggestions. Manual changes made while analysis
   is running are preserved. Changing the photo invalidates older responses.
   Existing-product forms show a preview and require an explicit **Use
   suggestions in this form** action before replacing details.
7. Applied suggestions require a human review checkbox before form submission.
   Editing suggested fields clears that confirmation. Admin AI-assisted products
   additionally retain the existing real-product verification and image-rights
   requirements. Vendor save permissions and moderation remain the existing
   workflow; the browser/mobile checkbox is a user-flow guard, not a new backend
   authorization boundary.
8. Saving uses the existing product create/edit API and Cloudinary workflow.
   Analysis does not upload to Cloudinary, save drafts, create categories or
   publish products. Existing Image Studio refinement remains separate.

Existing medicine eligibility, prepared-food information/review, category
consistency, ownership, inventory and payment checks are preserved. An
ineligible vendor's medicine suggestion cannot auto-select a medicine category;
normal create/edit checks still enforce pharmacist eligibility. Misidentification
by AI is possible and must be caught in human review.

## API and operational boundaries

- `GET /api/products/image-analysis/config`: authenticated permission check;
  returns readiness, public model name and maximum image size, never a secret.
- `POST /api/products/image-analysis`: multipart field `image`, exactly one file,
  no extra fields. Maximum 5 MB. JPEG/PNG/WebP signatures are checked; this is
  not a complete local decoder. Gemini must decode the image. Unsupported HEIC,
  SVG, malformed or oversized inputs leave manual entry available.
- One provider attempt, 30-second provider timeout, 2,048 output-token ceiling.
  The default `gemini-2.5-flash` uses a zero thinking budget. Client requests have
  a 40-second timeout. No automatic retries or external search tools.
- Three requests/minute and twenty/day per authenticated account; two
  concurrently running analyses and one hundred attempts/day per process by
  default. Failures consume an attempt. The optional daily-limit environment
  value is bounded at 1,000.
- These counters are process-local, reset at UTC midnight/restart and multiply
  across replicas. They are not a durable billing cap. Provider-side project
  quotas/billing controls must be reviewed before enabling a live service.
- Duplicate warnings are advisory exact-name matches, limited to five listings
  in the requesting vendor's catalogue or the admin's NaijaGo catalogue. Other
  vendors' private listings are not returned. Similar images, renamed products
  and race conditions are not resolved automatically. Lookup failures are shown
  as warnings, not reported as proof that no duplicate exists.
- Provider error details, API headers and image bytes are not returned in error
  messages. No remote image URL fetching or new package dependencies.

## Activation requirements — not performed

The feature is disabled unless **both** of these backend environment conditions
are met:

```text
PRODUCT_IMAGE_ANALYSIS_ENABLED=true
GEMINI_API_KEY=<existing backend-only key>
```

Optional backend settings:

```text
GEMINI_IMAGE_ANALYSIS_MODEL=gemini-2.5-flash
PRODUCT_IMAGE_ANALYSIS_DAILY_LIMIT=100
```

No frontend or Flutter provider API key is needed. No environment file or Render
setting was changed. A feature-disabled/older backend returns an unavailable
response and the new forms retain manual upload.

Taxonomy initialization and product-reference backfill are **not required** for
text-label suggestions. The clients only submit stable references when the
existing Stage 1 hierarchy explicitly reports `referencesReady=true`. Otherwise
they use the valid legacy labels. No initialization/backfill was executed.

### Cost and time estimate

The API protocol follows Google's
[generateContent reference](https://ai.google.dev/api/generate-content).
The default Gemini 2.5 Flash paid standard rate is $0.30/million text/image input
tokens and $2.50/million output tokens. See the
[official pricing table](https://ai.google.dev/gemini-api/docs/pricing).
For illustration, 8,000 input tokens plus 1,000 output tokens costs about
**$0.0049 per image, or $4.90 per 1,000**. This is arithmetic from assumed token
counts, not a measured bill. Image resolution, taxonomy/prompt size, returned
details, model selection, free-tier eligibility, taxes and provider changes
affect actual cost. The hierarchy alone is approximately 12,554 characters.
Expected interactive time is seconds to tens of seconds, but no latency was
measured against Gemini; timeout boundaries are not performance promises.

## Files changed during this pass

Existing Stage 1 changes were preserved. These are the additional Stage 2 files:

| Repository | State | File |
| --- | --- | --- |
| Backend | Modified | `routes/productRoutes.js` — mounts analysis before product-ID handlers |
| Backend | Created | `routes/productImageAnalysisRoutes.js` |
| Backend | Created | `services/productImageAnalysisService.js` |
| Backend | Created | `test/productImageAnalysis.test.js` |
| Backend | Created | `docs/STAGE2_IMAGE_UPLOAD_REVIEW.md` |
| Admin | Modified | `product-moderation.html` |
| Admin | Modified | `js/admin/product-moderation.js` |
| Admin | Created | `js/admin/product-image-analysis.js` |
| Admin | Created | `test/product-image-analysis.test.js` |
| Vendor | Modified | `lib/screens/vendor/add_product_screen.dart` |
| Vendor | Created | `lib/services/product_image_analysis_service.dart` |
| Vendor | Created | `test/product_image_analysis_test.dart` |

Customer and rider source files, taxonomy manifests/fallbacks, dependencies and
lockfiles, migration scripts, payment logic and production configuration were
unchanged compared with the start-of-pass file-hash baseline. Tests may produce
ignored local build/visual artifacts. No real customer/vendor records were used.

## Test evidence

All new AI responses, uploaded-photo processing and duplicate lookups use local
fixtures/mocks. Full backend runs unset real-database test URIs and preload a
guard that rejects Mongoose/MongoClient connection attempts.

| Run | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Backend `node --test --test-reporter=tap`, DB guard | 481 | 0 | 8 |
| Admin `node --test` | 30 | 0 | 2 |
| Vendor `flutter test --no-pub --reporter expanded` | 93 | 0 | 0 |
| Customer `flutter test --no-pub --reporter expanded` | 203 | 0 | 0 |

The new suites contribute 14 backend, 9 admin and 10 vendor tests. They cover
strict response/category validation, account permissions, malformed/oversized
uploads, quota/provider failure behavior, duplicate scope, editable autofill,
commercial-field preservation, review gating, existing products, in-flight
manual edits, image changes and the manual fallback. Node syntax and diff
whitespace checks passed. The vendor analyzer reports **0 errors, 0 warnings**
and four pre-existing info-level style/deprecation findings; its exit code is
1 because those infos remain. There are no added analyzer findings.

Intermediate test failures were corrected: a test used the wrong Flutter field
getter, decoded binary multipart data as UTF-8 and expected a category path as a
single Text widget. The final tests check the actual inner field/dropdown state.
An initial admin directory invocation was unsupported by Node; automatic test
discovery passed. These intermediate failures are not pending failures.

### Skipped/unverified behavior

Eight existing backend skips need a disposable MongoDB instance: Deals
persistence/aggregation/indexes, Google unique-subject concurrency, Image Studio
integration, Image Studio collection setup, Image Studio setup API, inventory
transactions/concurrency, legacy settlement/receipt rollback, and Group/Recurring
lifecycle. Two admin skips require browser integration: Deals UI and Image
Studio UI. Mocked Stage 2 tests do not prove Mongo transaction/index behavior,
browser multipart behavior, provider output quality, real-photo OCR/category
accuracy, Cloudinary operation, native image picking, physical-device behavior,
App Store/Play Store builds or live deployment compatibility.

No paid provider request, production database connection/write, migration,
taxonomy initialization, deployment, publication, commit or push occurred.

## Rollback and next safe action

No Stage 2 database migration or schema change exists, so no data rollback is
needed. Keep the backend feature flag disabled to retain manual entry. For a
source rollback, remove only Stage 2 analysis route mounting/new files, script
include/form controls and vendor analysis additions. **Do not reset whole files
or delete pre-existing uncommitted Stage 1 work.** Products manually saved later
would need their own authorized review; disabling suggestions does not undo
saved details.

Next safe action: review the Stage 2 diff and this report, then separately
authorize a staging provider/device check with a small agreed image budget and
a disposable database. Live activation/deployment requires separate approval.
