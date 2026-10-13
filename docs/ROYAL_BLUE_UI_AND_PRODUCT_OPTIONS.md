# Royal Blue UI and product colour/size options — local review

Date: 13 October 2026. This report records local implementation and validation before the separately requested GitHub publication. No hosting deployment, production database connection or database migration was performed.

## Implementation and scope

- Customer, vendor and rider Flutter apps each have an `AppColors` file with the same requested tokens: Royal Blue `#4169E1`, Dark Royal Blue `#1E3A8A`, Light Blue `#EFF6FF`, Accent Green `#16A34A`, White `#FFFFFF`, background `#F8FAFC`, text `#0F172A`, secondary text `#64748B`, borders `#E2E8F0`.
- Central `AppTheme`, existing colour aliases and vendor/pharmacy theme helpers use those tokens. Buttons, active navigation, tabs, links, progress, controls and existing screens inherit the theme. Colours used by Google branding, warning/error states, product swatches and original image/logo assets retain their purpose. Layouts, labels and navigation destinations were preserved.
- Accessible dark green text (`#166534`) is used with success surfaces. Green is for positive states rather than the primary action colour. White text on the brighter green does not meet normal-text contrast; admin success buttons use its accessible dark companion.
- Customer dark mode remains supported through centralized `AppTheme.darkTheme`, readable white-on-Royal-Blue actions, light-blue links and adaptive bottom navigation. Vendor and rider apps had no dark mode, and no new mode was introduced.
- The admin uses one shared `css/brand-colors.css`, loaded after page styles on every shared admin page and login. Legacy CSS class names remain compatible. The page structure, permissions and actions are unchanged.

## Product options

- Admins and approved vendors can enter optional available colours. Vendor size controls remain mandatory for the existing applicable new-listing categories; other materials can expose optional sizes/custom dimensions. Existing legacy listings without size metadata remain editable. Saved custom dimensions are preserved during vendor editing. Optional sizes can be explicitly cleared; omission preserves saved values.
- `availableColors` is an optional product array. Multipart and JSON requests use the existing create/edit APIs. Labels are validated, trimmed and deduplicated while preserving seller spelling and order; up to 32 names, each up to 40 characters.
- Product detail pages display labelled colour choices and the existing size controls. Quick-add opens details for products with options. Different colour/size choices remain separate cart lines, survive quantity changes/removal and reach checkout, shipment history, vendor fulfilment views and planned-order baskets.
- The server checks supplied colour/size choices against the actual product. Mocked actual checkout handlers return HTTP 400 for stale/tampered choices without saving orders, and persist valid choices at HTTP 201. Existing pricing, vendor ownership/approval, category policy, medicine/food moderation and payment/inventory services remain in use.
- All choices share the existing aggregate stock and price. This change does not introduce per-colour SKU stock, new variant prices, or colour-specific image replacement. Sellers must list only colours available in every listed size. Aggregate cart quantities cannot exceed product stock across option lines. The server remains authoritative at checkout.
- Older clients may omit colour fields. Non-option products retain their existing flow. Legacy reservation identities and planned approval fingerprints stay unchanged for orders without colours. Colour/size-specific holds remain unsupported and fail closed instead of claiming aggregate stock protects individual options.

## Screens covered

- Customer: shared entrance/authentication, home, category/subcategory navigation, Explore, product details/reviews, cart, checkout, orders/tracking, group/recurring/planned orders, account/wallet and pharmacy styling.
- Vendor: authentication/registration, navigation/dashboard, product creation/editing/listings, product details/cart, orders/fulfilment, account, disputes, pharmacy and shared surfaces.
- Rider: central app theme applies to registration/login, dashboard, delivery maps/routes, agreement, earnings/wallet, profile, online controls and delivery confirmation. Direct notification/order success colours also use central tokens.
- Admin: all pages that used the shared admin styles, plus login, product options and the activity panel.

## Actual local checks

| Check | Result |
|---|---|
| Customer full Flutter suite, bounded concurrency | 236 passed, 0 failed |
| Vendor full Flutter suite, including legacy fashion edit regression | 101 passed, 0 failed |
| Rider full Flutter suite | 130 passed, 0 failed |
| Backend full suite, database integration disabled | 578 total: 570 passed, 0 failed, 8 skipped |
| Admin full suite, real database integration disabled | 67 total: 65 passed, 0 failed, 2 skipped |
| Actual admin CSS in exact iframe viewports | 320px and 1440px passed; localhost fixtures only |
| Customer/vendor option widgets | 320px at 2x text passed; primary actions/tabs at 1.5x text passed |
| Brand contrast tests | Royal Blue/white, main/secondary text and accessible success text passed |
| Rider analyzer | No issues found |
| Customer JavaScript web build | Passed |
| Vendor JavaScript web build | Passed |
| Rider Android debug build, cached dependencies/offline | Passed; 339 tasks: 24 executed, 315 up to date |
| Git diff whitespace checks | Passed in all five repositories |
| Changed/new JavaScript syntax checks | 18 files passed |
| Final focused reruns after style cleanup | Customer 8 passed; vendor 7 passed (subsets of the full suites above) |

Initial customer failures were three expectations for the previous muted-blue/light-chip/dark-button palette. Those expectations were updated for the approved Royal Blue direction while retaining contrast and interaction assertions; the final full suite passed. New local syntax/style issues were corrected. The browser harness was corrected to avoid Chromium's minimum desktop window size; exact iframe widths are asserted.

### Analyzer comparison

Committed source copies were inspected/analyzed in temporary folders with the existing package configuration. No packages were installed or upgraded in the projects.

- `naijagomainapp`: 35 remaining pre-existing diagnostics ({'warning': 4, 'info': 31}); committed baseline had 36. No new diagnostic signatures.
- `go-vendor`: 61 remaining pre-existing diagnostics ({'info': 61}); committed baseline had 61. No new diagnostic signatures.

The pre-existing customer warnings involve an unused Explore import/unused helpers. Other existing findings are style/deprecation notices. No compiler errors remain. Dependencies, environment files, OAuth/API settings and signing configuration are unchanged. The subsequent GitHub publication request increments the vendor app version from `1.0.8+13` to `1.0.9+14`; dependencies are unchanged.

### Subsequent home food framing check

The customer home restaurant banner now fits the original food photo without cropping, inside an inset frame beside the dish and restaurant names. Its existing menu tap, carousel, filtering and rotation behavior is preserved. The updated focused suite passed all 18 tests, including light/dark themes, 320px/390px widths, a constrained banner inside a 600px viewport and 1.5x text. An existing rotation fixture was stabilized by waiting for the MaterialApp theme transition before measuring the timer; its isolated repeat also passed. Analysis of both changed files reported no issues. This check does not replace the full-suite results recorded above.

### Skipped and unverified

- Backend skips are opt-in real MongoDB integration tests for Deals, Google persistence/concurrency, Image Studio processing/setup, inventory settlement, and planned orders. Real database transactions/index behavior and live data were not verified.
- The two original admin skips are the opt-in Deals/Image Studio feature browser suites. The new colour-system browser checks run independently against local fixtures and passed.
- Customer/vendor native Android builds were not executed; their JavaScript web compilations and Flutter tests passed. Rider Android debug compilation passed. iOS native/store builds require macOS/Xcode and were not run on this Windows host. Signed store releases, live accounts, actual device display/notification behavior and production end-to-end order fulfilment were not verified.
- Existing Gradle/Kotlin deprecation/minimum-version warnings remain. The customer default web build reported existing secure-storage WebAssembly incompatibilities, but its JavaScript build succeeded. The final JS check used `--no-wasm-dry-run`; no dependency upgrade was made.
- The previously implemented rider agreement still requires its approved content/database setup before a coordinated live release; this colour task does not publish or initialize it.

## Data, rollout and rollback

No database migration/backfill/init is required or run. New optional fields are `Product.availableColors`, `Shipment.items.selectedColor` and planned item `selectedColor`. Existing records without them remain valid. Explicit future form saves add options through existing authenticated/moderated APIs.

Before any separately authorized live release, review vendor stock/options using a staging product, then verify both colours/sizes in cart, summary, customer order history and vendor fulfilment. Check restricted listings still enter their required review. If releasing these changes, backend support should precede clients that send colour selections. Production approval/deployment is a separate action.

Rollback should revert this reviewed patch in the five repositories. Keep any stored order colour/size history; do not delete or rewrite data. Optional added fields do not require a destructive rollback migration. Reconfirm compatibility with orders created after any future rollout before rolling back backend validation.

## Every created/modified repository file

The following lists exclude ignored local build/cache outputs and temporary inspection scripts. Preview PNGs use local fixture content, not live customer data.

### naijagomainapp

- `lib/auth/screens/email_verification_screen.dart`
- `lib/main.dart`
- `lib/models/product.dart`
- `lib/providers/cart_provider.dart`
- `lib/screens/Main/cart_screen.dart`
- `lib/screens/Main/categories_screen.dart`
- `lib/screens/Main/explore_screen.dart`
- `lib/screens/Main/home_screen.dart`
- `lib/screens/Main/my_orders_screen.dart`
- `lib/screens/Main/planned_order_composer.dart`
- `lib/screens/Main/planned_orders_screen.dart`
- `lib/screens/Main/product_detail_screen.dart`
- `lib/screens/Main/product_reviews_screen.dart`
- `lib/screens/Main/restaurant_food_screen.dart`
- `lib/screens/Main/reviews_ratings_screen.dart`
- `lib/theme/app_colors.dart`
- `lib/theme/app_theme.dart`
- `lib/widgets/customer_bottom_navigation.dart`
- `lib/widgets/order_tracking_widget.dart`
- `lib/widgets/pharmacy_ui.dart`
- `lib/widgets/product_color_selection.dart`
- `output/previews/checkout-1.0.png`
- `output/previews/checkout-1.3.png`
- `output/previews/customer-premium-preview.png`
- `output/previews/deals-banner.png`
- `output/previews/entrance.png`
- `test/customer_ui_premium_test.dart`
- `test/product_options_test.dart`
- `test/royal_blue_theme_test.dart`

### go-vendor

- `lib/auth/screens/email_verification_screen.dart`
- `lib/auth/screens/registration_screen.dart`
- `lib/constants.dart`
- `lib/models/product.dart`
- `lib/providers/cart_provider.dart`
- `lib/screens/Main/account_screen.dart`
- `lib/screens/Main/cart_screen.dart`
- `lib/screens/Main/categories_screen.dart`
- `lib/screens/Main/create_dispute_screen.dart`
- `lib/screens/Main/dispute_chat_screen.dart`
- `lib/screens/Main/faq_screen.dart`
- `lib/screens/Main/home_screen.dart`
- `lib/screens/Main/main_app_navigator.dart`
- `lib/screens/Main/my_orders_screen.dart`
- `lib/screens/Main/product_detail_screen.dart`
- `lib/screens/Main/restaurant_food_screen.dart`
- `lib/screens/Main/vendor_app_navigator.dart`
- `lib/screens/Main/vendor_desist_confirmation_screen.dart`
- `lib/screens/Main/vendor_screen.dart`
- `lib/screens/vendor/add_product_screen.dart`
- `lib/screens/vendor/my_products_screen.dart`
- `lib/screens/vendor/orders_recived_screen.dart.dart`
- `lib/theme/app_colors.dart`
- `lib/theme/app_theme.dart`
- `lib/vendor/screens/vendor_registration_screen.dart`
- `lib/widgets/order_tracking_widget.dart`
- `lib/widgets/pharmacy_ui.dart`
- `lib/widgets/product_color_selection.dart`
- `lib/widgets/product_colors_field.dart`
- `lib/widgets/tech_glow_background.dart`
- `lib/widgets/vendor_ui.dart`
- `test/product_image_analysis_test.dart`
- `test/product_options_test.dart`
- `test/royal_blue_theme_test.dart`

### Go-Rider

- `lib/core/theme/app_colors.dart`
- `lib/core/theme/app_theme.dart`
- `lib/features/notifications/view/notifications_view.dart`
- `lib/features/orders/controller/orders_controller.dart`
- `test/royal_blue_theme_test.dart`

### naijago_backend

- `docs/ROYAL_BLUE_UI_AND_PRODUCT_OPTIONS.md`
- `models/PlannedOrders.js`
- `models/Product.js`
- `models/Shipment.js`
- `routes/orderRoutes.js`
- `routes/plannedOrderRoutes.js`
- `routes/productRoutes.js`
- `services/deliveryReservationService.js`
- `services/inventoryService.js`
- `services/plannedOrderService.js`
- `test/checkoutDeliveryArea.test.js`
- `test/dealsStage1.test.js`
- `test/productCategoryAuthorization.test.js`
- `test/productOptions.test.js`
- `utils/productOptions.js`

### naijago.com_admin_panel

- `carousel-slides.html`
- `companies.html`
- `css/brand-colors.css`
- `deals.html`
- `delivery-fees.html`
- `dispatch.html`
- `disputes.html`
- `engagement-analytics.html`
- `explore-videos.html`
- `food-readiness-campaigns.html`
- `index.html`
- `js/admin/product-moderation.js`
- `js/admin/product-options.js`
- `login.html`
- `marketing-lists.html`
- `notifications.html`
- `operations-monitor.html`
- `orders.html`
- `people.html`
- `pharmacist-requests.html`
- `pharmacy-chat-prices.html`
- `pickup-orders.html`
- `product-moderation.html`
- `referral-settings.html`
- `reviews.html`
- `rider-partnership.html`
- `rider-requests.html`
- `riders.html`
- `subscriptions.html`
- `test/product-options.test.js`
- `test/royal-blue.browser.test.js`
- `vendor-commissions.html`
- `vendor-requests.html`
- `vendors.html`
- `withdrawals.html`
