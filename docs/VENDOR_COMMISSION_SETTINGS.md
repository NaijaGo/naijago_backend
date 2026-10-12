# Vendor category commissions

## Admin access

Open **Dashboard > Vendor Commissions** in the admin panel after both backend
and admin deployments complete. Only the existing authenticated `isAdmin`
permission can read or save `/api/admin/commission-settings`.

All 23 authoritative main categories are shown in their original order. Enable
a custom percentage for a category, enter 0–100 (up to two decimal places),
enter a reason, and save. This rate applies across that category's subcategories
and vendor sellers. Disable the custom rate to restore legacy defaults.

Existing orders retain their saved commission amounts. Admin-owned sales are
unchanged. Category rates do not override Low Cost World's fixed fee per unit.
These controls do not set other individual vendor rates, rider earnings,
delivery fees or payment fees.
Current defaults include legacy text-dependent differences; the page displays
each category's default range rather than silently converting it to one rate.

## Implementation

- Original category fee table and fallback/alias implementation are moved
  unchanged to `utils/vendorCommissionRates.js`.
- `services/vendorCommissionService.js` resolves configured main category IDs
  through the existing manifest and text/alias resolver. It rejects invalid,
  duplicate or unknown override entries and uses legacy fees without overrides.
- Both order summary and authoritative order creation read current settings
  once per request; final creation forwards its transaction session. Client
  commission percentages are not accepted as authoritative values.
- `AppSetting` has optional rates, revision and audit fields. The isolated key
  is `vendor_category_commissions`. Reads do not initialize or migrate anything.
- Admin changes use revision comparisons and an atomic update; concurrent edits
  return 409. The existing unique `AppSetting.key` index is required for the
  simultaneous first-save safeguard. Audit retains the latest 100 batches,
  including reason, administrator identity, timestamp and old/new overrides.
- The legacy public `/api/orders/commission-rates` response keeps its existing
  keys/fields and includes the authoritative main categories. Audit is private.
- Medicine/food review, seller eligibility, inventory, payment verification and
  settlement code are not altered by commission settings.

## Deployment and operations

### Low Cost World

The same page has a **Low Cost World** section with **Commission per item (₦)**.
It reads the linked store's actual saved commission, or the existing ₦57 default
when a fee is absent. This default is not seeded or automatically changed.
Editing is disabled until Product Moderation has an approved vendor linked.

The protected GET/PUT `/api/admin/commission-settings/low-cost-world` endpoint
updates only `costLowStore.commissionKoboPerUnit` in the existing `cost_low_store`
settings record. Input is in naira and stored as integer kobo. Saving requires
a reason, current store identity and revision. Changing vendor assignment or
category percentage rates through this endpoint is unsupported. Updates use
the previous fee, vendor identity and revision as atomic conditions; concurrent
fee edits or store relinking return 409. The existing checkout already reads
this saved fixed fee and multiplies it by purchased quantity for new orders.

Optional `costLowCommissionRevision` and `costLowCommissionHistory` fields keep
the latest 100 fee changes with actor, linked vendor, old/new kobo amounts,
reason and date. No new collection, initialization or migration is needed.
The existing store linking APIs and storefront discovery are unchanged.

### Publication

Deploy the backend commit, then the admin commit. No environment variable,
dependency, taxonomy initialization or backfill command is required. Until an
administrator explicitly saves a custom rate, the exact existing fees apply.
Do not prefill or seed rates with guessed defaults.

Verify the new page loads all 23 categories and the production settings key's
unique index exists before the first live save. Review any vendor agreement
before choosing a rate. A quote made before a rate change can be recalculated
using the newer rate when a new order is created. Saved orders are unaffected.
An unavailable or malformed settings read fails checkout rather than silently
substituting a different fee.

## Rollback

For a rate rollback, use the page to restore a previous custom rate or disable
it to restore defaults; enter a reason so the reversal remains auditable.
For a code rollback, redeploy the prior backend/admin commits. The old backend
ignores the optional commission fields and uses legacy fees. Keep the settings
record and history intact; restoring this feature later reactivates saved
overrides. Do not delete records, rewrite orders or rerun migrations.

For Low Cost World, restore the previous per-item naira amount in its section
and record a reason. Redeploying older code removes the editor but still reads
the saved fixed fee; restore the fee through the new UI first if a fee rollback
is intended. Store linking and existing order snapshots should remain intact.

## Verification limits

Final local checks including the Low Cost World editor: 203 backend tests
passed, 2 opt-in MongoDB tests skipped; 26 admin tests passed. There were no
failures. The skipped checks cover
transactional inventory concurrency and legacy settlement/rollback against
real MongoDB. Syntax checks and `git diff --check` also passed.

Tests use mock settings, local HTTP and in-memory Mongoose validation. Real
MongoDB index enforcement, transaction snapshot behavior, first-save upsert
concurrency and authenticated browser operation require a dedicated test
deployment. No real database is accessed by the commission test suite. Actual
test results and deployment status are reported in the implementation handoff.
