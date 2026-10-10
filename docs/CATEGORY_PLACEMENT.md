# Product category placement

## Findings

- Read-only audit: 589 active public listings on 10 October 2026. This is not a visual review of every photo.
- Before the patch, requesting /api/products with category=Cosmetics & Beauty > Medicine and q=shirt returned 68 clothing results. Category and search both wrote filter.$or, so the search overwrote the category constraint.
- The Pharmacy page returned zero items under Cosmetics & Beauty > Medicine while 10 active catalog listings were saved under Health & Beauty > Medicine.
- 1 listings have a parent category without a saved subcategory. Their specific subcategory requires item review; it cannot be derived reliably from a vendor role or a generic product name.

## Fix

- Keep the category constraint inside $and for public listing and admin catalog searches.
- Share category matching between public listing and catalog search.
- Recognize equivalent legacy labels for beauty/health, groceries/supermarket, men's fashion, and phone accessories. Aliases are scoped to their parent category; a Fashion accessory cannot match Phones & Tablets.
- Accept hierarchical spacing variations and both combined-category and separate-subcategory storage.

## Validation

- node --test test/productFilters.test.js test/catalogSearchService.test.js test/categoryPlacement.test.js
- 32 passed, 0 failed, 0 skipped.
- Tests use isolated local query/HTTP fixtures, not a production MongoDB connection. Auth middleware is a local GET fixture; this suite does not claim to test authorization.
- Syntax checks passed for the three changed backend source files and the new test file. git diff --check passed.

## Release and remaining catalog work

- This patch is local and has not been committed, pushed or deployed. Customer/Vendor/Rider source and previous Google-auth changes were preserved.
- After backend deployment, verify Pharmacy with no search and with a search for clothing; only the saved medicine branch should be eligible.
- Truly incorrect saved categories and missing subcategories still need authorized catalog edits after reviewing the product. Do not bulk classify products by the vendor's pharmacist role.
- Existing medicine restrictions, moderation, inventory, prices and original/refined product photos are not modified by this filtering patch.

## Entries needing item review before finer classification

These are review candidates, not approved category changes. Names alone do not prove what the photo depicts.

| Product ID | Product | Saved category | Saved subcategory |
| --- | --- | --- | --- |
| 6a7cd5606951dbbb69c33489 | Golden Penny Semovita (2kg) | Groceries | (none) |
| 6978acca8bf986e09951241f | Gino party jollof | Supermarket > Groceries | (none) |
| 6978ac908bf986e099512414 | Spicity seasoning powder | Supermarket > Groceries | (none) |
| 6978ac2b8bf986e099512409 | Golden penny Pasta spaghetti | Supermarket > Groceries | (none) |
| 6978abda8bf986e0995123fe | Knorr Beef maggi | Supermarket > Groceries | (none) |
| 6978ab9f8bf986e0995123f3 | Knorr chicken maggi | Supermarket > Groceries | (none) |
| 6978ab528bf986e0995123e8 | Eggs crate | Supermarket > Groceries | (none) |
| 6978ab038bf986e0995123dd | Golden penny Semovita 1KG | Supermarket > Groceries | (none) |
| 6978aa768bf986e0995123c1 | Golden penny Pasta Twist | Supermarket > Groceries | (none) |
| 6978aa3e8bf986e0995123b6 | Golden penny Pasta Macaroni 500g | Supermarket > Groceries | (none) |
| 6978a9ff8bf986e0995123ab | Golden penny Couscous 500g | Supermarket > Groceries | (none) |
| 6978a98f8bf986e0995123a0 | Crown premium spaghetti | Supermarket > Groceries | (none) |
| 6978a92b8bf986e099512395 | Indomie chicken flavor | Supermarket > Groceries | (none) |
| 6978a8bb8bf986e099512385 | Ducros curry | Supermarket > Groceries | (none) |
| 6978a8938bf986e09951237a | Ducros thyme | Supermarket > Groceries | (none) |
| 6978a8418bf986e09951236f | Farrow’s giant marrowfat peas | Supermarket > Groceries | (none) |
| 6978a7e98bf986e099512364 | Green giant sweet corn | Supermarket > Groceries | (none) |
| 6978a7a08bf986e099512359 | Power oil 75CL | Supermarket > Groceries | (none) |
| 6978a7588bf986e099512348 | Power oil 1.4L | Supermarket > Groceries | (none) |
| 6978a71e8bf986e09951233d | Kings oil 5L | Supermarket > Groceries | (none) |
| 6978a6f48bf986e099512332 | kings oil 3L | Supermarket > Groceries | (none) |
| 6978a6c68bf986e099512327 | kings oil 1L | Supermarket > Groceries | (none) |
| 6978a6908bf986e09951231c | Heinze Bean | Supermarket > Groceries | (none) |
| 6978a6478bf986e099512311 | Jago mayonnaise 443ml | Supermarket > Groceries | (none) |
| 6978a59d8bf986e0995122e7 | Maharani Basmati rice 5kg | Supermarket > Groceries | (none) |
| 6978a56e8bf986e0995122dc | Maharani Basmati rice 1kg | Supermarket > Groceries | (none) |
| 6978a51c8bf986e0995122b7 | Ayoola poundo yam flour 1kg | Supermarket > Groceries | (none) |
| 6978a49d8bf986e0995122a7 | Honeywell wheat 1kg | Supermarket > Groceries | (none) |
| 6977e87f930131239e10d155 | Sonny PlayStation 5 | Electronics > Gaming | (none) |
| 69733fb3cda98f2d313f040b | JBL HARMAN | Electronics > Gaming | (none) |
| 69733f26cda98f2d313f03ea | JBL HARMAN | Electronics > Gaming | (none) |
| 69733e4dcda98f2d313f03d4 | JBL HARMAN | Electronics > Gaming | (none) |
| 69733ceacda98f2d313f03ba | Sony PS5 changing duck | Electronics > Gaming | (none) |
| 69733c12cda98f2d313f03aa | Sony PlayStation controller PS5 pad | Electronics > Gaming | (none) |
| 69733aeacda98f2d313f0398 | Sony PlayStation controller PS5 pad | Electronics > Gaming | (none) |
| 696d302af13e13595fe2a51e | PS5 slime | Electronics > Gaming | (none) |
| 695e3e6d21ab408b5b6c2ab4 | Dry prawn 50g | Supermarket > Groceries | (none) |
