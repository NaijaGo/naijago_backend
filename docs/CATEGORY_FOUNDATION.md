# Stage 1 category foundation

## Scope and implementation

Stage 1 only. No image recognition, Gemini/provider integration, bulk uploads,
new publishing workflow, package installation, production configuration changes,
deployment, or production database access was performed.

`config/catalogTaxonomy.json` is the authoritative version 1 manifest. It keeps
all **23 main categories and 186 subcategories**, their original labels and order,
and the legacy parent/child aliases. Each of the 209 nodes has a fixed MongoDB
ObjectId, a stable internal key, and an explicit parent relationship. IDs and keys
must never be regenerated from edited labels or reordered positions.

The public, read-only `GET /api/categories` endpoint returns this hierarchy,
version, checksum and `referencesReady`. It can serve labels without creating or
initializing any collections. The Category model disables automatic collection
and index creation. There are no category write endpoints or startup migrations.

Products keep their existing `category` and `subcategory` strings. Optional
`categoryId` and `subcategoryId` references are validated against the manifest and
the supplied labels. Unknown legacy labels remain usable without fabricated IDs.
ID-only requests generate compatible labels; unchanged legacy selections retain
their original representation. Partial edits clear stale references when labels
change. ID filtering also includes legacy label matching so a backfill is not
required to browse old products. Existing text, alias and search intersections
are retained.

Reference writes default to **disabled**. They require
`CATEGORY_REFERENCE_WRITES_ENABLED=true`, a connected database, all 209 exact
manifest records, and the unique key index. Incomplete or conflicting records,
missing index/read permissions, or readiness errors leave reference writes off.
An explicit reference request while disabled returns 503; label-only requests
remain compatible. This flag was not added to any runtime configuration here.

The admin, vendor and customer clients load the same hierarchy and ship generated
fallback JSON. Unsupported, malformed or identity-mismatched API responses leave
the fallback usable. Fallbacks and stored caches never enable reference writes.
Vendor/admin forms preserve unknown or aliased legacy selections during edits.
The customer keeps subcategory-first navigation and pharmacy entry points.
Restaurant is retained in the full hierarchy and upload form; existing category
browsing presentation still omits its sidebar entry because restaurants already
have their own entry points. No category is removed from the hierarchy.

Shared backend moderation evaluates category, subcategory, known IDs and the
existing restricted-medicine access/prescription flags. Approved vendor,
pharmacist, ownership, product approval, food detail and order-history checks
remain in place. An explicit Restaurant parent cannot be hidden by an equipment
child. Restaurant equipment under Food & Beverage keeps its equipment exclusion.
Checkout uses the same classification helpers; payment, inventory and dispatch
implementations were not changed.

## Explicit initialization (not executed)

Initialization and product backfill are separate operations. No application,
worker, deployment or test starts database initialization automatically.

For a separately authorized **local or isolated staging database**, first verify
the database identity and take a backup. Supply `CATEGORY_SETUP_MONGO_URI` directly
in that operation's environment; the script never loads `.env` or `MONGO_URI`.

```text
node scripts/initializeCatalogTaxonomy.js --database=naijago_category_stage1_test
```

This is a read-only dry run. Stop on unexpected records, IDs, keys, labels,
ordering, parent relationships or missing permissions. Existing conflicting
records are rejected before index creation or upserts.

Only after explicit approval to initialize that particular database:

```text
node scripts/initializeCatalogTaxonomy.js --database=naijago_category_stage1_test --apply --confirm-database=naijago_category_stage1_test
```

The write operation creates the uniqueness guard first, then inserts missing
manifest records using `$setOnInsert`. It neither renames existing records nor
drops/rebuilds existing indexes. Interrupted initialization can be rerun after
review: existing matching records remain unchanged. Concurrent unauthorized
changes can make post-write verification fail; leave reference writes disabled
and investigate rather than repairing records automatically.

A production setup requires a separate reviewed approval. None is authorized or
performed by this implementation. After authorized setup, separately review
enabling reference writes. Old clients can continue submitting labels regardless.

## Product-reference audit and migration safeguards

`scripts/migrateProductCategories.js` has **no database writer**. It rejects
`--apply`, `--write`, `--execute` and `--rollback` before connecting. It only
proposes reference additions, never price, inventory, status, text or image edits.

For a separately authorized isolated audit database, supply
`CATEGORY_AUDIT_MONGO_URI` and run:

```text
node scripts/migrateProductCategories.js --database=naijago_category_stage1_test --report=category-audit.json
```

The report file is created exclusively (an existing file is not overwritten).
Use read-only database credentials for audits. Records with unknown/deeper paths,
contradictory labels, or conflicting references require manual review. Repeated
subcategory names resolve only within their parent. Already valid references are
not proposed for replacement. Reports retain raw labels, expected references,
updated timestamps and the manifest checksum for review. The report is held in
memory, so plan bounded batches before auditing a very large catalog.

**No backfill may be applied yet.** A future separately approved migration must:

1. Review unknown/conflicting records and duplicate-listing concerns manually.
2. Back up the target collection and freeze the approved manifest checksum.
3. Use bounded batches and a per-record journal of actual changes, including
   before/after references, label values, field presence and update timestamps.
4. Conditionally update only unchanged, still-unreferenced products. Skip
   concurrent edits; never overwrite labels, approval state or commercial data.
5. Record results and verify both label-based and ID-based browsing before
   advancing. Initialization alone is not product migration approval.

No production audit, reference backfill or existing-product moderation rewrite
was performed. Database readiness and production legacy-data quality remain
unverified.

## Rollback

Before any database operation, rollback is simply reverting these Stage 1 code
and generated artifact changes together. Preserve the manifest/ID mapping in the
release record; do not replace it with newly generated identities.

After a future approved category initialization, first disable reference writes.
Clients continue using labels. Leave the additive category collection and indexes
in place; this implementation provides no automatic deletion or destructive index
rollback. Removing them would need an approved backup/dependency review.

After a future approved backfill, rollback must use the actual migration journal
and conditional checks. `planCategoryRollback` is a **pure planning helper only**:
it proposes restoring prior references only if the manifest, product identity,
labels and current references still match the journal. Changed products are
skipped. It cannot execute writes. Keep the corrected medicine/food safeguards
when disabling references; rolling back references must not weaken moderation.

## Artifact consistency

With the backend, admin, customer and vendor repositories checked out beside
one another, this read-only check verifies all generated fallbacks:

```text
node scripts/exportCatalogTaxonomy.js --check
```

`--write` is a local artifact export only; it contacts no database or provider.
For future approved taxonomy revisions, review exact labels/order/aliases and
stable identities before exporting. Version 1 clients reject another checksum
and retain their bundled hierarchy; additions/removals are outside this stage.

## Historical implementation verification and file inventory

This section records the earlier implementation report. It is superseded by
[the final remediation review](STAGE1_REMEDIATION_REVIEW.md), which reports the
fresh test runs, corrections, current file inventory and remaining limitations.

Earlier implementation verification, recorded on 11 October 2026:

| Repository/check | Actual result |
| --- | --- |
| Backend `node --test` | 367 tests: **359 passed, 8 skipped, 0 failed** |
| Admin `node --test` | 22 tests: **20 passed, 2 skipped, 0 failed** |
| Customer `flutter test --no-pub --reporter expanded` | **201 passed, 0 failed** |
| Vendor `flutter test --no-pub --reporter expanded` | **75 passed, 0 failed** |
| Customer analysis, four changed Dart implementation files | No issues; exit 0 |
| Vendor analysis, five changed Dart implementation files | Four pre-existing informational lints; exit 1 |
| Fallback exporter `--check` | All three artifacts match the backend manifest |
| Comparison with committed original admin taxonomy | Exact 23/186 labels and ordering retained |
| `git diff --check`, all four changed repositories | Passed |

**655 passing tests in total; 10 skipped.** The eight backend skips require an
opt-in isolated MongoDB fixture (inventory, Deals, Google-auth persistence, image
refinements, Image Studio setup and setup API, order inventory reconciliation,
planned orders). `INVENTORY_TEST_MONGO_URI` was explicitly empty for the backend
suite, so no database integration connection occurred. The two admin skips are
the Deals and Image Studio browser harnesses; their local browser fixture paths
were not configured, and the Deals harness additionally needs isolated MongoDB.
No live-provider, mobile release build, production-data, or production-runtime
verification is implied by fixture/widget tests.

The vendor analyzer notices are an existing unbraced time-parser return and three
existing deprecated DropdownButtonFormField `value` arguments. The corresponding
original statements were verified in the committed source. New category Dart
code has no remaining analyzer notices. These unrelated form API changes were
left outside Stage 1.

Intermediate failures were resolved before the final runs: category widget tests
needed deterministic fallback loading on subsequent openings; two checkout test
harnesses needed to consume the shared helpers after their extraction; and the
new moderation route fixture needed to stub product population. The final suites
above have no failing tests.

Final diff review found only Stage 1 category, client integration, regression test
and documentation changes. No secrets, production environment/configuration,
dependency manifests/locks, Cloudinary/image processing, Gemini, authentication,
wallet/Squad payment, inventory implementation, or rider files were changed.
The order-route change is limited to importing the shared classification helpers
in place of the previous inline helpers. No production database was connected
to, read, initialized, backfilled or otherwise modified. No deployment,
publication, commit or push was performed.

### Remaining risks and next approvals

- Category initialization and index behavior have fixture tests but have **not**
  been exercised against a real database in this session. Production legacy
  labels, conflicting records, approval state and duplicate listings are unknown.
- The migration audit flags uncertain legacy paths; it does not automatically
  correct them, merge categories, deactivate products, or approve products.
- Split-field medicine and food classifications now receive the existing
  restrictions. Existing active listings are not retrospectively rewritten.
- A readiness change during an open form can produce a 503 for explicit IDs;
  refresh the form to reload readiness and submit compatible labels. Never retry
  product creation automatically after an ambiguous save response.
- Future taxonomy changes require a reviewed version/identity policy and updated
  generated artifacts; version 1 clients deliberately keep their fallback when
  another checksum is served.
- Production initialization, any production audit, applied backfill, deployments
  and Stage 2 all require separate approval. Consult the remediation review for
  the current local verification result; this historical report does not
  establish production readiness.

### Every created or modified source, test and documentation file

`A` means created; `M` means modified. Paths are relative to the named repository.
There are **45 files** in four repositories. Go-Rider has no changes.

#### naijago_backend (25)

```text
A config/catalogTaxonomy.json
A docs/CATEGORY_FOUNDATION.md
A models/Category.js
A routes/categoryRoutes.js
A scripts/exportCatalogTaxonomy.js
A scripts/initializeCatalogTaxonomy.js
A scripts/migrateProductCategories.js
A services/catalogTaxonomyService.js
A test/catalogTaxonomy.test.js
A test/categoryMigration.test.js
A test/categoryModerationRoutes.test.js
A test/categoryPolicy.test.js
A test/categoryRoutes.test.js
A test/fixtures/catalogLabels.v1.json
A test/productCategoryCompatibility.test.js
A utils/categoryPolicy.js
M models/Product.js
M routes/orderRoutes.js
M routes/productRoutes.js
M server.js
M services/catalogSearchService.js
M test/categoryPlacement.test.js
M test/checkoutDeliveryArea.test.js
M test/dealsStage1.test.js
M utils/productFilters.js
```

#### naijago.com_admin_panel (5)

```text
A js/admin/catalog-taxonomy.fallback.json
A test/catalog-taxonomy-client.test.js
M js/admin/catalog-taxonomy.js
M js/admin/product-moderation.js
M test/catalog-taxonomy.test.js
```

#### naijagomainapp (7)

```text
A assets/catalog_taxonomy.v1.json
A lib/models/catalog_category.dart
A lib/services/catalog_category_service.dart
A test/catalog_category_test.dart
M lib/models/product.dart
M lib/screens/Main/categories_screen.dart
M test/category_navigation_test.dart
```

#### go-vendor (8)

```text
A assets/catalog_taxonomy.v1.json
A lib/models/catalog_category.dart
A lib/services/catalog_category_service.dart
A test/catalog_category_test.dart
M lib/models/product.dart
M lib/screens/Main/categories_screen.dart
M lib/screens/vendor/add_product_screen.dart
M test/creator_equipment_category_test.dart
```
