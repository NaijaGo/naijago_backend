# Kora verification — 16 October 2026

## Result

**55 targeted local tests passed; live checkout and bank transfers are not yet
verified.** The current app backend's Kora webhook returns HTTP 404. This must be
resolved before claiming that the deployed integration works.

The user identified Render's source revision as
`7892e43853f04548d01343cd8a8d2c5bbb47c885`. That revision contains the Kora route.
Its appearance as a source revision does not establish which revision is serving
the public app URL. The actual Render service URL and successful live deployment
need confirmation, especially if Kora was deployed as a separate service.

## Public endpoint checks

Origin: `https://naijago-backend.onrender.com`. Requests were unauthenticated,
unsigned and contained no real order, customer or payment reference.

| Request | Observed result |
|---|---|
| POST `/api/orders/webhooks/korapay`, JSON `{}` | 404, `{"message":"Route not found"}` |
| POST `/api/orders/webhooks/squad`, JSON `{}` | 401, `Signature mismatch` |
| POST `/api/orders/webhooks/flutterwave`, JSON `{}` | 401, `Signature mismatch` |
| GET `/api/wallet/banks`, no authorization | 401 |
| POST `/api/orders/000000000000000000000000/payment-intent`, no authorization | 401 |

No redirects were returned by the three webhook probes. The 401 responses show
access/signature rejection; they do not validate any provider credentials.

With the checked-in Kora route mounted, an unsigned request should return 401
when configured, or 503 when Kora configuration is unavailable. A 404 indicates
that the checked route is unavailable at this public origin. It does not show
that Kora rejected a key.

## Local checks

Run from the backend folder:

```powershell
node --test --test-reporter=spec test/koraPayment.test.js test/koraPaymentService.test.js test/koraCheckoutService.test.js test/koraPayoutService.test.js test/koraWebhook.test.js test/orderPayment.test.js test/paymentRouteRegression.test.js test/squadPayment.test.js test/squadPaymentService.test.js
```

Observed: **55 passed, 0 failed, 0 skipped**. The full repository test suite was
not run. No dependencies were added.

Coverage includes:

- Integer-kobo validation, exact amount/reference/currency checks, customer and
  order metadata checks, and webhook signature/tamper handling.
- Documented initialization/payout payloads, fixed API origin, checkout URL
  restrictions, key/mode validation, public-key bank listing and payout gating.
- Checkout reference reservation, lease contention, retries retaining the same
  reference, and preservation of historical gateway references.
- Withdrawal reservation before dispatch, OTP reuse, insufficient balances,
  provider-confirmed completion/failure, duplicate refund handling, uncertain
  transfers, and rider admin approval/cancellation.
- The actual checked-in Kora handler, loaded with isolated dependencies:
  unsigned requests, missing configuration, verified settlement, duplicate
  delivery, mismatched amounts, retryable errors and payout event routing.
- Existing Flutterwave/Squad payment regression checks.

The Kora fixtures do not bootstrap `server.js`, load `.env`, connect to a
database or contact Kora. Their in-memory transaction/query adapters do not
prove MongoDB transaction, persistence or concurrency behavior. The webhook
tests extract the handler from the real route source, but do not test the full
production middleware stack or public deployment.

## Fix found during verification

`nairaToKobo` accepted an extremely small positive number that rounded to zero
kobo. It now also requires `kobo > 0`. A regression test covers this. This fix
and the added tests follow revision `7892e43`; a deployment of that original
revision does not contain this later change.

## Remaining verification

1. Confirm the Render service's actual public URL and running revision. Correct
   the backend deployment/origin so POST `/api/orders/webhooks/korapay` reaches
   the handler. Keep app API origin and Kora notification URL consistent.
2. On isolated staging with a test database and Kora test keys, exercise hosted
   checkout success/pending/failure, real signed notifications, concurrent
   verification and transaction retry behavior.
3. Exercise sandbox bank listing and payouts, including admin approval,
   provider failure, timeout, delayed notifications and exactly-once refunds.
4. Confirm live channel activation, payout access and available provider balance.
   Then use explicitly approved low-value live payment/payout examples and
   confirm the corresponding app order, wallet ledger and bank result.

No charge, payout, production database connection, migration, key inspection
or Render configuration change was made during these checks.

## Subsequent live checkout diagnosis

After deployment of `64543d7`, the public Kora webhook became reachable and
returned 401 to unsigned probes. This confirms route availability and basic
key/mode validation, not provider acceptance of the key or a successful payment.

The customer's subsequent checkout attempts first reported an unsupported
provider setting, then invalid notification/redirect URL configuration. Later
Render logs showed `KORAPAY_INITIALIZE_UNAVAILABLE` during checkout initialization.
That error alone does not distinguish a Kora HTTP rejection from DNS, TLS,
timeout or other transport failure. The actual cause is not yet established.

The diagnostic patch preserves the existing failure code/customer message,
checkout reference, payload, URL validation and retry behavior. It adds bounded,
allowlisted `providerDiagnostic` fields to the `[PAYMENT INTENT]` server log:

- `providerHttpStatus`: numeric HTTP status, or null when none was received.
- `reason`: a diagnostic category, inferred from HTTP status and limited error
  text matching, not the full provider response or a definitive root cause.
- `fields`: recognized validation field names only, when supplied by Kora.
- `transportCode`: a recognized network error code only, when applicable.

Categories include `authentication_rejected`, `permission_rejected`,
`ip_restricted`, `account_restricted`, `channel_rejected`, `reference_conflict`,
`request_rejected`, `rate_limited`, `provider_unavailable` and `transport_error`.
No raw provider messages/bodies, Axios config, authorization headers, keys,
customer values or original exception causes are logged by this addition.

The same targeted local command above now passes **57 tests**, including two
new diagnostic tests exercising HTTP/error categories and redaction with
synthetic private values. Parser and Git whitespace checks passed. No real Kora
API request or database transaction was made by those tests.

After deploying this patch, resume the existing unpaid order once. If checkout
still fails, inspect the new diagnostic object in Render logs to identify the
next account/configuration/request investigation. This patch improves diagnosis;
it does not establish that the live checkout failure has been fixed.

## Reference validation follow-up

The subsequent Render screenshot records HTTP **422**, `request_rejected`, and
`fields: ['reference']`. This identifies a provider reference validation error;
it does not reveal the exact length/character rule. The public Checkout Redirect
guide requires a unique reference but does not publish a complete length and
character constraint for that endpoint. Do not claim an unverified maximum.

The previous generator produced `NGK_<24-character order ID>_<24 hex digits>`,
53 characters including underscores. New checkout attempts now reserve a compact
35-character, alphanumeric reference: `NGK` plus 32 random hex digits (128 random
bits). Order identity remains in stored payment data and the existing `order-id`
metadata. This is a conservative compatibility correction based on the rejected
field; live provider acceptance still needs confirmation.

Existing references are **not** rewritten, truncated or replaced, including
references with an existing checkout URL or an ambiguous initialization result.
Their reconciliation and verification remain available. No order, payment,
wallet or database record was manually changed by this patch.

The user confirmed no Kora payment page opened and no money was sent for the
reported ₦700 order. After this backend patch is live, test a **fresh checkout
from Cart**, not `Continue secure payment` on an old rejected attempt. The old
unpaid attempts retain their original references. A previous successful,
pending or uncertain payment must instead be reconciled before another payment.

New tests cover reference format/length, distinct generation across 100 orders,
the real initialization payload with an isolated HTTP fixture, preservation of
historical references/URLs, and unchanged same-reference retries/concurrency.
The targeted command passes **61 tests, 0 failures and 0 skipped** after this
change. Parser and Git whitespace checks also passed. Live Kora acceptance of
the compact reference remains to be checked after deployment.
