# Commerce & Payments Live Certification (Wave 1)

Use this checklist before promoting a native commerce/payments connector from
`RuntimePartial` to `RuntimeAvailable`. It covers the five connectors whose
native runtime is already complete and only awaits evidence from a real merchant
account: **Shopify, Stripe, WooCommerce, BigCommerce, Square**.

Each connector already ships managed credentials/OAuth, REST (or Admin GraphQL
bulk) backfill, webhook receive + signature verification, scheduled retry
cursors, and disconnect cleanup. The remaining gate is live evidence.

## Harness layout

Shared, provider-agnostic evidence tooling:

```text
apps/api/internal/integrations/livecert/livecert.go   # Recorder, SanitizeDetails, ReadReport, ValidateCompleteness
```

Per-connector opt-in harnesses (one file each):

```text
apps/api/internal/commerce/commerce_livecert_test.go  # shared gate, REST runner, contract + completeness helpers
apps/api/internal/commerce/shopify_live_test.go
apps/api/internal/commerce/stripe_live_test.go
apps/api/internal/commerce/woocommerce_live_test.go
apps/api/internal/commerce/bigcommerce_live_test.go
apps/api/internal/commerce/square_live_test.go
```

Each harness has four tests:

| Test | Runs | Needs credentials |
| --- | --- | --- |
| `Test<P>LiveCertificationEvidenceContract` | always (CI) | no |
| `Test<P>LiveCertificationWebhookSignature` | always (CI) | no — round-trips the real verifier crypto |
| `Test<P>LiveCertificationBackfillReadPaths` | only when `COMMERCE_LIVE_CERTIFICATION=1` + provider creds | yes |
| `Test<P>LiveCertificationReportCompleteness` | only when `COMMERCE_LIVE_CERTIFICATION_VALIDATE_REPORT=1` | reads the on-disk report |

The two credential-free tests run in normal CI and guard the verifier crypto and
the evidence contract without any provider traffic. The read-path test exercises
the real backfiller against the provider and appends sanitized evidence. The
completeness test is the promotion gate.

## Evidence report

Set `COMMERCE_LIVE_CERTIFICATION_REPORT=/abs/path/report.jsonl` on any run to
append sanitized JSONL evidence. The recorder **drops any detail key that looks
like a token, secret, password, apikey, signature, or credential**, so raw
material never reaches disk — record booleans/counts, not values.

Each row is one JSON object:

```json
{"provider":"shopify","check":"backfill_bulk_page","status":"passed","recorded_at":"2026-06-20T00:00:00Z","details":{"orders":1,"cursor_present":true}}
```

## Per-connector credentials

All live runs require `COMMERCE_LIVE_CERTIFICATION=1`. Use **sandbox / test-mode
keys** and a disposable store.

| Connector | Required env | Optional env |
| --- | --- | --- |
| Shopify | `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_SHOP_DOMAIN` | `SHOPIFY_BACKFILL_CURSOR` |
| Stripe | `STRIPE_API_KEY` (restricted read key) | `STRIPE_API_BASE_URL`, `STRIPE_ACCOUNT_ID` |
| WooCommerce | `WOOCOMMERCE_STORE_URL`, `WOOCOMMERCE_CONSUMER_KEY`, `WOOCOMMERCE_CONSUMER_SECRET` | — |
| BigCommerce | `BIGCOMMERCE_STORE_HASH`, `BIGCOMMERCE_ACCESS_TOKEN` | `BIGCOMMERCE_API_BASE_URL` |
| Square | `SQUARE_ACCESS_TOKEN` | `SQUARE_API_BASE_URL`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_MERCHANT_ID`, `SQUARE_LOCATION_ID` |

## Running a certification (Stripe shown)

```sh
cd apps/api
COMMERCE_LIVE_CERTIFICATION=1 \
COMMERCE_LIVE_CERTIFICATION_REPORT=../../artifacts/stripe-live-certification.jsonl \
STRIPE_API_KEY=rk_test_... \
go test -count=1 -run 'TestStripeLiveCertification(WebhookSignature|BackfillReadPaths)' ./internal/commerce
```

This records the automated rows: `backfill_<object>` for every object the
connector pulls, plus `webhook_signature_verify`.

## Manual evidence rows

Automated tests cannot prove behaviors a human must witness against a live
account. After observing each, append a row to the report file:

```sh
printf '{"provider":"stripe","check":"manual_data_delete_behavior","status":"passed","recorded_at":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> ../../artifacts/stripe-live-certification.jsonl
```

Required manual rows (every connector):

| Check | What to witness |
| --- | --- |
| `manual_webhook_delivery` | A real provider webhook is delivered, signature-verified, and ingested |
| `manual_disconnect_cleanup` | `DELETE` the integration; provider-side webhooks/registrations are removed |
| `manual_reconnect_resume` | Reconnect resumes from the stored cursor without duplicating rows |
| `manual_rate_limit_retry_after` | A 429/Retry-After is honored and the retry cursor advances |
| `manual_data_delete_behavior` | A customer delete / GDPR erasure propagates correctly |
| `manual_credential_rotation` | Rotating the key/token (or webhook secret) keeps sync healthy |

Connector-specific extra rows:

| Connector | Extra checks |
| --- | --- |
| Shopify | `manual_oauth_install`, `manual_privacy_webhooks`, `manual_app_uninstall` |
| WooCommerce, BigCommerce | `manual_webhook_register_cleanup` (programmatic webhook lifecycle) |

## Promotion gate

Once all automated and manual rows are present, the gate must pass:

```sh
cd apps/api
COMMERCE_LIVE_CERTIFICATION_VALIDATE_REPORT=1 \
COMMERCE_LIVE_CERTIFICATION_REPORT=../../artifacts/stripe-live-certification.jsonl \
go test -count=1 -run 'TestStripeLiveCertificationReportCompleteness' ./internal/commerce
```

A green run is the evidence required to promote the connector. **Only then**
make the two-line catalog flip:

1. `apps/api/internal/integrations/catalog.go` — change the connector's
   `RuntimeStatus` from `RuntimePartial` to `RuntimeAvailable` and refresh its
   summary to drop the "live certification pending" caveat.
2. `apps/api/internal/integrations/contracts.go` —
   `isNativeRuntimeCompleteLiveCertificationPending`: a connector that has fully
   certified no longer needs the cert-pending contract language; if you instead
   want to advertise "native runtime complete, certification pending" *before*
   the flip, add its slug to that allowlist.

Do not flip either point without a passing completeness run for the connector —
the catalog's honesty discipline depends on it.
