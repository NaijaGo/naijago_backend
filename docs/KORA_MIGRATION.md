# Kora checkout and bank-transfer integration

Prepared 16 October 2026. Local implementation only: no deployment, live-key
request, production database connection, charge or bank transfer was performed.
No dependencies were added. Existing gateway secrets were not read or changed.

## Scope

- New customer checkout uses Kora hosted checkout, initialized by the backend.
  Squad initialization is removed from the order endpoint. The default provider
  is now `korapay`; explicitly setting `PAYMENT_PROVIDER=squad` does not create
  new Squad charges. Set the new Render variables together with deployment.
- Existing Squad and Flutterwave references keep their original verification
  and webhook handlers. An existing reference is never overwritten by Kora.
  Historical pending payments return a review state, not a new payment page.
- The customer app already supports `checkout.korapay.com`. Its advertised
  provider list now omits Squad. Keep historical URL recognition for old orders.
- Vendor/customer wallet withdrawals retain OTP and balance checks, reserve
  the debit in a committed database transaction, then request a Kora bank payout.
- The separate `/api/riders/withdraw` endpoint retains admin approval. It uses
  the rider's registered account and matches its bank name to Kora's bank list.
  It allows one pending Kora request per rider. The individual admin completion
  action authorizes dispatch; it does not claim the transfer is already complete.
- Submitted/uncertain payouts are queried, never automatically sent again.
  A network error or a not-found response does not trigger a refund.
  A provider-verified failed payout refunds its reserved debit once, in a
  transaction. An awaiting-approval request can be cancelled before dispatch.
- Withdrawal history is now explicitly represented in the User schema so
  records survive normal saves. Vendor administration recognizes `isVendor`
  as well as historical `role: vendor` records; vendor ownership is a flag in
  the current User schema.
- Existing order-completion rules for earning vendor/rider wallet balances
  remain in effect. This integration does not release earnings before completion.
- Wallet top-ups still use the existing Flutterwave flow. Keep its configuration
  while that feature and historical payments need it.

## Exact Render variables

Backend service: `naijago_backend`. In Render open **Environment** and enter
each name and value in separate fields, with no spaces in a variable name.

| Variable | Live value | Purpose |
|---|---|---|
| `PAYMENT_PROVIDER` | `korapay` | New order checkout |
| `PAYOUT_PROVIDER` | `korapay` | Bank list and withdrawals |
| `KORAPAY_MODE` | `live` | Must match the key prefixes |
| `KORAPAY_SECRET_KEY` | Your actual `sk_live_...` secret | Server initialization, verification, payouts and webhook signatures |
| `KORAPAY_PUBLIC_KEY` | Your actual `pk_live_...` key | Kora's miscellaneous bank-list API |
| `KORAPAY_NOTIFICATION_URL` | `https://naijago-backend.onrender.com/api/orders/webhooks/korapay` | Shared charge/payout webhook |
| `KORAPAY_CHANNELS` | `bank_transfer,card` | Enabled NGN checkout channels; use only channels approved for your account |
| `KORAPAY_PAYOUTS_ENABLED` | Initially `false`; `true` at approved payout cutover | Gates new bank transfers |

`KORAPAY_REDIRECT_URL` is optional. Leave it unset unless you have an actual
payment return page. Kora can display its own completion page, and NaijaGo's
existing flow asks the customer to return to the app and verify payment.
Do not invent a return-page URL or use an unimplemented deep link.

No Kora key is required in Codemagic or a Flutter build. The hosted-checkout
and bank APIs in this implementation run on the backend. No encryption key or
separate webhook secret is needed for this integration. Never put the Kora
secret key in Dart, browser JavaScript, a screenshot, chat or committed files.

The API base is fixed to `https://api.korapay.com/merchant/api/v1`; the configured
key selects its account/mode. Test and live keys cannot be mixed. When
`NODE_ENV=production`, Kora operations reject test mode. Use an isolated staging
database and test keys for provider validation; do not use real wallets for that.

## Kora dashboard

Configure the **live** webhook URL in Kora's API Configuration settings:

```text
https://naijago-backend.onrender.com/api/orders/webhooks/korapay
```

The configured backend URL above comes from the existing app's default API
origin. If production uses another API origin, substitute that actual origin in
both places. This path accepts signed `charge.success`, `charge.failed`,
`transfer.success` and `transfer.failed` notifications. Kora's HMAC-SHA256 is
computed over `JSON.stringify(body.data)` with the secret key and compared with
`x-korapay-signature` using a constant-time comparison. The backend then queries
Kora before changing payment state; webhook amounts alone are not proof.

The order verifier requires the stored reference, NGN currency, success status,
and exact expected amount in naira. Integer kobo comparisons avoid rounding
ambiguity. Checkout passes `merchant_bears_cost: true` so fees are not silently
added to the customer's approved order total.

## Settlement and payout availability

T+0 is a Kora account/channel settlement arrangement, not an API flag. Confirm
with Kora which channels on NaijaGo's live account settle at T+0, when funds
become available in its payout balance, fees, limits and bank-transfer access.
Enable only the intended checkout channels. Kora's published settlement guide
says settlement timing depends on the payment channel.

Payouts are sent from the available Kora balance and need sufficient funds for
the principal and provider fees. Changing the integration does not itself
activate T+0 or guarantee a bank arrival time.

## Cutover and checks still required

1. Review this local change and validate it on isolated staging with Kora test
   keys. Check hosted success/pending/failure, amount/reference mismatches,
   duplicate and delayed webhooks, concurrent verification, payout success/
   failure/timeout, OTP reuse, approval, and exactly-once refund handling.
2. Confirm live T+0 channels, payout activation, fees and available Kora balance.
3. Deploy the reviewed backend revision with the matching Render configuration.
   The public webhook must be reachable by Kora. No dependency installation or
   manual database/index migration was added by this change; schema additions
   take effect with the backend code. No backfill or production write was run.
4. Keep payouts disabled until the reviewed deployment and webhook are ready.
   Enabling `KORAPAY_PAYOUTS_ENABLED=true` permits authenticated customer/vendor
   OTP withdrawals and admin-approved rider requests to send real bank transfers.
   Verify approved low-value live examples before broad rollout.
5. Reconcile all outstanding Squad payments before removing its keys/webhook.
   Retain Flutterwave keys for historical payments and current wallet top-ups.
6. Release a customer build with the current hosted-checkout code if the installed
   version lacks it. Unsupported clients receive an update message before a new
   Kora reference is reserved. Existing vendor and rider request shapes remain
   supported; a registered rider bank must match a bank in Kora's NGN list.

The reconciliation runner uses `PAYMENT_RECOVERY_INTERVAL_MS` (default five
minutes). It runs Kora checkout/payout checks plus historical gateway recovery.
Do not set `DISABLE_PAYMENT_RECOVERY_RUNNER=true` unless a replacement runner
is deployed. Awaiting-approval rider requests are excluded from auto-dispatch.

If a request was claimed for dispatch but the process stopped before/after the
provider call, it stays pending for verification. A repeated 404 needs operator
investigation with Kora; it is deliberately not treated as proof of failure.
Do not create a replacement payout or refund an uncertain transfer manually.

## Validation performed

The initial integration received JavaScript parser and Git whitespace checks.
The subsequent verification on 16 October 2026 passed 55 targeted local tests,
including 39 Kora checks with isolated provider/database fixtures and 16 existing
payment regression checks. A tiny positive amount rounding to zero kobo is now
rejected. See [the verification report](KORA_VERIFICATION_2026-10-16.md).

The later checkout-diagnostic patch passes 57 targeted local tests. No provider
test/live transaction, signed provider delivery or real database transaction
was exercised by those tests. Local tests do not establish production readiness.
The initial Kora webhook 404 was resolved after deployment; unsigned requests
now receive 401. Customer attempts subsequently reached initialization but
failed with `KORAPAY_INITIALIZE_UNAVAILABLE`. The new server diagnostic reports
an allowlisted HTTP status/category without raw provider/customer/key data.
See the subsequent-diagnosis section of the verification report. Successful
live checkout and bank transfers still require confirmation.

## Official references consulted

- [Checkout Redirect](https://developers.korapay.com/docs/checkout-redirect)
- [Checkout Standard](https://developers.korapay.com/docs/checkout-standard)
- [Signed webhooks](https://developers.korapay.com/docs/webhooks)
- [Payout API and bank listing](https://developers.korapay.com/docs/payout-via-api)
- [Query a payout by reference](https://developers.korapay.com/docs/bulk-payouts-via-api)
- [NGN charge verification](https://developers.korapay.com/docs/virtual-bank-accounts-ngn)
- [Settlement timing](https://support.korapay.com/hc/en-us/articles/33568298706194-Settlements)
