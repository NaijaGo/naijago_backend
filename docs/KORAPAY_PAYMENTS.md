# KoraPay order-payment rollout

Local implementation, 2026-09-28. This is part of the same coordinated release,
not permission to change live payments. Provider calls in automated tests are
simulated. No KoraPay account transaction has been performed by this work.

## Scope and compatibility

- New online **order checkout** can select KoraPay using PAYMENT_PROVIDER=korapay.
  Existing MainOrder/Shipment, quote validation, inventory settlement and paid
  review handling are reused. There is no separate KoraPay order database.
- The authenticated backend initializes hosted checkout, returning only public
  checkout details. The app advertises KoraPay support and opens only the official
  HTTPS checkout host. Older apps receive an update-required response rather than
  falling through to the Flutterwave SDK.
- Each receipt retains its provider, reference and test/live mode. Initialization
  claims a single reference/lease. Repeated taps reuse that identity; ambiguous
  failures verify it before trying initialization again. They do not create a new
  reference. If the provider accepted a charge but its checkout link could not be
  persisted, the app holds it for reconciliation rather than risking a second
  charge; operational recovery of that case still needs sandbox acceptance.
- Signed webhooks, authenticated confirmation and background recovery all verify
  server-to-server. Status, reference, NGN currency and actual received amount
  must match. The requested amount and browser-return parameters are not proof.
- A verified payment whose stock/eligibility settlement fails uses the existing
  paid-review hold. Audited fulfil/refund/cancel resolution remains unfinished.
- Squad and legacy Flutterwave verification/webhooks/recovery remain available
  for their original receipts. Switching PAYMENT_PROVIDER cannot rewrite an old
  payment attempt. Do not delete old keys/webhooks while those receipts remain.
- **Wallet deposits, withdrawals/payouts and other legacy payment consumers are
  NOT migrated by this order-checkout change.** Their coverage must be audited
  and separately implemented/tested before claiming a platform-wide migration.
- Vendor notification/referral failures after settlement do not reverse the paid
  response. Durable notification retries are still a shared release requirement.

## Safe test configuration

Use a separate Render test service and separate database on the existing test
cluster, for example naijago_korapay_sandbox. Do not replace the production
MONGO_URI. Do not point a public customer release at this test service.

Only synthetic users, products, stock and orders should exist there. Do not copy
production payment, email, push or WhatsApp credentials into this service.
Keep new feature flags off except those being explicitly tested. Test funds can
still cause application order/stock transitions, so a test key alone is NOT
adequate isolation.

Set these privately in the **test backend** environment:

| Name | Test value |
|---|---|
| PAYMENT_PROVIDER | korapay |
| KORAPAY_MODE | test |
| KORAPAY_SECRET_KEY | Your KoraPay test secret key, entered privately |
| NODE_ENV | staging (test/development are also recognized; production or unset fails closed for test payments) |
| KORAPAY_REDIRECT_URL | https://YOUR-TEST-BACKEND/api/orders/payments/korapay/return |
| KORAPAY_WEBHOOK_URL | https://YOUR-TEST-BACKEND/api/orders/webhooks/korapay |

Replace YOUR-TEST-BACKEND with the actual HTTPS hostname, not a placeholder.
Configure the corresponding test webhook in KoraPay. The backend also passes the
notification URL when initializing checkout. The return page is informational:
switch back to NaijaGo and tap Verify payment, or inspect the order in My Orders.
It neither echoes query parameters nor marks an order paid.

The updated test app uses API_BASE_URL pointing at this test backend. No KoraPay
secret or public key is added to Dart defines, app assets, Git or chat. Existing
Flutterwave settings remain necessary for unmigrated consumers. A future live
switch needs a live secret, live mode, production callbacks and provider/device
acceptance; never change an existing test receipt into a live receipt.

## Acceptance checklist (not yet completed)

- [ ] Confirm the test backend/database cannot access production records or send
  real fulfilment, payout, email, WhatsApp or push effects.
- [ ] Initialize one test order and verify the KoraPay page shows the approved
  amount; confirm actual sandbox response fields and NGN units.
- [ ] Complete a sandbox payment: one paid receipt, one stock decrement and the
  expected vendor/customer order statuses.
- [ ] Close/cancel checkout; pending/failed payment must not fulfil an order.
- [ ] Verify provider-return, duplicate webhook, delayed webhook and recovery
  after app/backend restart do not create another receipt or stock movement.
- [ ] Test wrong signature/reference/currency and underpayment without fulfilment;
  inspect overpayment and refund/support policy rather than inventing balances.
- [ ] Test repeated Pay taps, initialization timeout, lease expiry and recovery
  after provider acceptance before the checkout URL was saved.
- [ ] Test stock/price changes, late scheduled payment and paid-review visibility;
  never ask a debited customer to pay again.
- [ ] Test old Squad/Flutterwave pending receipts and both old/updated app versions.
- [ ] Run relevant real-Mongo concurrency/rollback tests on isolated data; the
  new initialization unit fixture is NOT proof of real Mongo concurrency.
- [ ] Confirm alerts, referrals, wallet scope, reconciliation/refunds, logs and
  operational monitoring before live activation.

## Rollback

Changing the configured provider affects new payment attempts only. Existing
receipts remain bound to the original provider/reference/mode; leave the matching
key, webhook and recovery support in place. Do not manually reset isPaid, erase a
reference or create another payment to repair a delayed confirmation. Reconcile
the provider transaction and original receipt through an audited support flow.

## Provider contracts

The integration follows Kora's [hosted checkout documentation](https://developers.korapay.com/docs/checkout-redirect)
and [webhook signature documentation](https://developers.korapay.com/docs/webhooks).
Verification uses the single-charge endpoint in the [official API reference](https://docs.korapay.com/).
Documentation review is not real-provider acceptance evidence.
