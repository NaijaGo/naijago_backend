# Explore release contract

Implemented locally; not deployed or device approved. EXPLORE_ENABLED defaults
off. Product videos additionally need PRODUCT_VIDEO_ENABLED and configured
Cloudinary authenticated video delivery. See PRODUCT_VIDEO.md and BACKGROUND_JOBS.md.

## Existing architecture reused

- Product remains the purchasable listing; price and stock come from real offers.
- CarouselSlide gains the explore placement; main/promo home banners are retained.
- Existing User notifications/preferences and audience-specific OneSignal service
  carry activity notices. Vendor replies use the same comment API as customers.
- Durable BackgroundJob outbox handles notification retries and media revocation;
  it does not replace Squad/Flutterwave recovery.

## Customer and vendor behavior

Explore is a fifth customer navigation destination; previous tab indexes remain
stable. Sign-in is required for the feed/interactions. Product feed pages use an
ID cursor. Up to ten active sponsored campaigns stay in a horizontal strip above
the scrolling product feed. Only scheduled, rights-confirmed campaigns and reviewed
videos appear. Expired ads leave the strip and playing video stops at expiry.
Opening a listing or video rechecks availability; cached feed data is not authority.

Video playback is user initiated and initially muted, with loading/retry controls.
A qualified video watch needs at least three seconds of foreground, unbuffered
playback; seek progress alone does not count. Server checks elapsed time, target
availability and ownership of the view receipt. At most one qualified view per
signed-in account/item/UTC day. These are not unique lifetime viewers, billable
ad impressions, or proof against a malicious automated client. Banner impression
measurement and performance/device acceptance remain release work.

Each account has one current Like/Love/Wow/Thumbs Down per item. Comments require
the current five-point community-guidelines acknowledgement. One-level replies,
author deletion, user reports, account blocking, vendor reply activity and admin
moderation are included. A stable comment request ID prevents duplicate retries;
changed content with the same ID conflicts. Seller badges derive from ownership,
not a client-provided role. Hidden/deleted parent threads cannot receive replies.

Vendor/customer Account > Notification Settings includes Explore activity.
Self, blocked, removed, stale (>7 days) and opted-out notices are skipped.
Reaction notices are deduplicated per reaction kind/account/item/seller; repeated
taps do not create an alert storm. Comment/reply notifications link to the thread,
including after login/cold start; logout clears pending navigation. Push delivery
still depends on correct audience config, device permissions and subscription.

Required existing secrets on backend AND worker where used:
VENDOR_ONESIGNAL_APP_ID / VENDOR_ONESIGNAL_REST_API_KEY;
CUSTOMER_ONESIGNAL_APP_ID / CUSTOMER_ONESIGNAL_REST_API_KEY (customer supports the
existing ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY fallback);
ADMIN_ONESIGNAL_APP_ID / ADMIN_ONESIGNAL_REST_API_KEY for admin recipients.
No secret belongs in a mobile build or this repository.

## Admin

Carousel slides contains the Explore campaign form: advertiser/vendor, image/video,
destination, rights confirmation, WAT start/expiry, priority, enable/disable and
edit. Videos are watched/reviewed before publishing; banners upload through an
authenticated, size-limited route. Campaign cards show actual reaction/comment
and qualified-watch counts, including ended campaigns. All user-controlled display
text is inserted as text, not executable HTML.

Product moderation contains video and reported-comment queues. Decisions require
revision checks and reasons, with audit history. Rejected video access revocation
is processed by the worker and blocks reapproval until completed. Both admin pages
include the bounded Background work retry panel; failed push configuration does
not masquerade as delivered activity.

## Database and deployment gates

Explore ensures required collections/unique indexes exist before enabling its
config or accepting interactions; it fails closed on an index error and retries
initialization after a cooldown. This creates indexes, never drops/syncs existing
indexes. MongoDB transactions require a replica set (Atlas supports this).

Before enabling: isolated Mongo race/rollback tests; browser moderation/upload/
campaign edits; real-provider video approval/revocation; OneSignal foreground/
background/terminated-account tests; Android/iOS playback, accessibility, screen
sizes and slow-network tests; privacy/UGC/advertising terms and support escalation;
worker health/backlog alerts; realistic catalog/feed performance tests.

The worker is not yet deployed. Queued jobs cannot deliver notifications while
no worker is running. Never enable this feature and assume a successful HTTP
response proves push delivery or provider moderation.
