# Stage 1 final local remediation review

Date: 11 October 2026. Scope: category compatibility, classification policy,
permissions, affected checkout checks, client integration and regression tests.
No Stage 2 implementation.

## Findings and corrections

| Area | Result | Evidence |
| --- | --- | --- |
| Taxonomy integrity | PASS | `test/catalogTaxonomy.test.js:9`; independent comparison against committed original admin definitions; exporter `--check` |
| Legacy partial edits and stale references | PASS | `services/catalogTaxonomyService.js:64`, `:81`, `:94`; real hydrated Product validation in handler fixtures |
| Parent-scoped aliases and duplicate names | PASS | Resolver, filter and client tests; unambiguous mapping only |
| Medicine and conflicting food evidence | PASS | `utils/categoryPolicy.js:20`; `routes/productRoutes.js:855`; permanent handler tests |
| Vendor/admin authorization and ownership | PASS | Actual JWT middleware plus actual product/admin routers in `test/productCategoryAuthorization.test.js` |
| Moderation, restoration and seller reassignment | PASS | Admin approval checks, restricted vendor restoration enters review, medicine sellers must be eligible |
| Checkout approval, medicine and food checks | PASS | Actual summary/final handler bodies exercised with isolated VM dependencies in `test/dealsStage1.test.js` |
| Inventory service compatibility | PASS for mocks | `test/categoryInventoryCompatibility.test.js`; actual service commands, revisions, sessions and retry receipts |
| Database concurrency, atomicity and rollback | NOT VERIFIED | Eight opt-in backend integration tests skipped; mocks cannot prove MongoDB transaction behavior |
| Mobile release and production runtime | NOT VERIFIED | No release builds, real catalog reads, production database operations or deployment |

All 23 main categories, 186 children, existing labels, ordering, aliases and
stable identities were preserved. The manifest and all three generated client
artifacts are byte-for-byte unchanged from the pre-remediation baseline. The
labels/order were also independently compared with the original committed admin
taxonomy. The 209 identities remain distinct; repeated child labels retain
their parent scope.

Unrelated edits preserve raw category/subcategory text and valid references.
Unknown or conflicting saved references no longer fail an unchanged hydrated
legacy classification. Reconciliation occurs only with reference readiness,
an unambiguous scoped mapping and no loss of restrictive evidence. Ambiguous
records retain their saved classification for manual resolution. Newly supplied
invalid references and genuinely invalid new parent/child selections still fail.
This compatibility allowance does not apply to new products or modified invalid
references. Unchanged admin/vendor forms no longer generate replacement IDs.

Classification uses effective labels, known reference evidence and medicine
access/prescription/approval flags. Equipment evidence cannot cancel separate
food evidence; OTC flags cannot cancel a prescription requirement. New medicine
flags on partial edits receive permission and moderation checks. Vendors cannot
erase their only medicine or food classification without administrative review.

The user explicitly confirmed retaining mandatory review for every vendor edit
of medicine or prepared-food listings. Such edits become pending/inactive;
reference reconciliation alone never grants approval or changes availability.
Legacy approved pharmacist-role accounts with missing/`none` pharmacist status
remain compatible, but explicit pending, rejected or suspended pharmacist status
does not qualify. Vendor approval is always additionally required.

The update, archive and delete handlers now check approved vendor status as well
as ownership. Admin access uses the authenticated `isAdmin` capability. The User
enum accepts the existing administrative suspended state. Approval/restoration
checks reject contradictory classifications, missing restaurant information or
ineligible sellers. Medicine reassignment and admin editing also enforce seller
eligibility before inventory/upload work.

Checkout rejects explicit pending/rejected/disabled/inactive listings and
ineligible or missing vendor accounts. It retains pharmacist consultation and
food ordering windows. Summary and final creation load operating-hours/closure
metadata and check the selected seller. Pricing, payment, inventory receipt,
settlement and rider implementations were not rewritten.

## Actual handler compatibility cases

These are executed fixture results, not production observations. Fixtures use
real Product validation; the stock service and transactions are mocked unless
otherwise noted. A restricted listing requires an eligible pharmacist where
applicable. Existing order-history locking still returns 409 independently.

| Request | Observed HTTP | Saved? | Review/availability |
| --- | --- | --- | --- |
| Text-only ordinary product: description only | 200 | Yes | Existing approved/active state retained |
| Text-only ordinary product: price or valid stock only | 200 | Yes | Existing state retained; stock uses central service |
| Unchanged ordinary labels, missing or stale IDs | 200 | Yes | Existing state retained; reconcile only when safe/ready |
| Change parent while omitting incompatible saved child | 400 | No | Existing classification retained |
| Explicitly clear child or replace with matching child on ordinary product | 200 | Yes | Existing state retained |
| Eligible pharmacist: unrelated medicine edit | 200 | Yes | Pending/inactive; omitted medicine flags retained |
| Invalid newly supplied parent/child references or labels | 400 | No | No unsafe update |
| New contradictory food parent/child | 400 | No | Cannot bypass food review |
| Unchanged legacy contradictory food: unrelated edit | 200 | Yes | Pending/inactive; food details/window retained |
| Unapproved/rejected/suspended vendor edit | 403 | No | No inventory/upload/save operation |
| Wrong owner / unauthorized admin action | 401 / 403 | No | Existing permissions retained |
| Explicit valid IDs when reference writes are unavailable | 503 | No | Refresh readiness or submit compatible legacy labels |

## Actual verification results

| Run | Result |
| --- | --- |
| Final backend full suite, TAP, database guard enabled | 475 total: 467 passed, 8 skipped, 0 failed |
| Admin full `node --test --test-reporter=tap` | 23 total: 21 passed, 2 skipped, 0 failed |
| Customer full `flutter test --no-pub --reporter expanded` | 203 passed, 0 failed |
| Vendor full `flutter test --no-pub --reporter expanded` | 83 passed, 0 failed |
| Customer targeted analyzer including category tests | Exit 1: 3 informational notices for pre-existing relative test imports; no errors/warnings |
| Vendor targeted analyzer including category tests | Exit 1: 7 informational notices; 3 pre-existing relative test imports, 1 existing unbraced return, 3 existing deprecated form `value` arguments; no errors/warnings |
| Original committed taxonomy comparison and fallback exporter | PASS |
| Final file hash/diff/whitespace review | PASS: 32 changed/added files; `git diff --check` passed across all five repositories |

Backend runs explicitly emptied all database test/setup/audit URIs. A temporary
preload blocked Mongoose connections, connection creation and MongoClient
connections. No real database was accessed. Initialization unit tests use fake
collections only; no database-writing CLI command was executed. Flutter tests
use fixtures/mocks and the test binding's blocked network client.

The eight backend skips cover Deals persistence/aggregation/indexes; Google
account persistence; Image Studio integration; Studio setup; Studio setup API;
inventory concurrency; legacy order settlement/duplicate receipts/rollback; and
planned-order lifecycle. Permanent mocked tests now cover category-related
permissions, actual update/moderation handlers, checkout rejection, service
session/revision commands, duplicate receipt retries and propagated stock
conflicts. They do not replace actual unique-index, concurrency or rollback
verification. The two admin skips are Deals and Image Studio browser harnesses
whose opt-in environment was not configured.

Intermediate failures were observed and corrected: stale-reference/permission
regressions, one missing restaurant-closure summary check, two checksum validator
tests (manifest property order), and two approved-pharmacist widget tests
(prescription checkbox needed its own Material ancestor). One guarded test-run
launcher failed before running tests due to a Windows preload-path quoting issue;
the corrected launcher then ran successfully. Final test results are reported
above; analyzer informational exits are not claimed as clean passes.

## Migration safety and rollback

No initialization or backfill runs at startup. `Category` has `autoCreate:false`
and `autoIndex:false`. The initializer is a separately invoked, explicit-database
operation; writes additionally require `--apply` and a matching database
confirmation. Conflicts stop initialization before writes. No initializer was
run against any database here.

`scripts/migrateProductCategories.js` remains audit/dry-run-only. It rejects
apply/write/execute/rollback flags before connecting and contains no database
writer. It never rewrites labels, approval, stock, prices or photos. Neither it
nor production initialization was executed.

Next safe action: review this local diff, then separately authorize verification
against a disposable replica-set database with synthetic legacy fixtures. Cover
category readiness/indexes, actual save persistence, concurrent stock updates,
duplicate receipt fencing and transactional rollback before any release decision.
Production audit, initialization, backfill, deployment and Stage 2 each still
need separate authorization. Keep category-reference writes disabled until
explicit initialization/readiness verification succeeds.

Rollback locally means reverting only these reviewed remediation changes while
preserving the user's pre-existing Stage 1 changes. Do not use a repository-wide
reset. For a future deployed category rollback, disable reference writes and keep
the stable manifest plus additive category collection/indexes. Product-reference
rollback needs an approved writer, backup and actual per-record journal with
conditional identity/label/reference checks. The current rollback helper only
plans changes and cannot write them. Retain medicine/food/permission safeguards.

## Every file changed in this remediation pass

`M`/`A` are relative to the file-hash baseline taken before this pass, including
files already untracked then. Earlier user changes remain intact. 32 files in
four repositories; no Go-Rider files changed.

### Backend (21)

```text
M docs/CATEGORY_FOUNDATION.md
A docs/STAGE1_REMEDIATION_REVIEW.md
M models/Product.js
M models/User.js
M routes/adminRoutes.js
M routes/orderRoutes.js
M routes/productRoutes.js
M services/catalogSearchService.js
M services/catalogTaxonomyService.js
M utils/categoryPolicy.js
M utils/productFilters.js
A utils/productPermissions.js
M test/catalogTaxonomy.test.js
M test/categoryPlacement.test.js
M test/categoryProtectionRegression.test.js
M test/categoryRoutes.test.js
M test/checkoutDeliveryArea.test.js
M test/dealsStage1.test.js
M test/productCategoryCompatibility.test.js
A test/categoryInventoryCompatibility.test.js
A test/productCategoryAuthorization.test.js
```

### Admin (3)

```text
M js/admin/catalog-taxonomy.js
M js/admin/product-moderation.js
M test/catalog-taxonomy-client.test.js
```

### Customer (3)

```text
M lib/models/catalog_category.dart
M lib/models/product.dart
M test/catalog_category_test.dart
```

### Vendor (5)

```text
M lib/models/catalog_category.dart
M lib/models/product.dart
M lib/screens/vendor/add_product_screen.dart
M test/catalog_category_test.dart
M test/creator_equipment_category_test.dart
```

## Final audit and remaining limitations

The baseline hash comparison found only the files listed above changed/added.
Manifest, fallback assets, dependencies/lockfiles, production configuration,
secrets, migration scripts, payment/settlement services and Go-Rider remained
unchanged during remediation. Existing Stage 1 changes to startup route wiring
and other category integrations predate this pass and were preserved.

No production connection, database modification, deployment, publication,
commit or push occurred. No image analysis, Gemini integration or bulk upload
feature was added. Real legacy-data quality, performance/index query plans,
provider operation and mobile release compatibility remain unverified.

The supplied request ends mid-sentence in section 5. This pass completed the
provided requirements and the directly affected order/inventory audit. Additional
requirements in the missing remainder cannot be claimed as fulfilled.
