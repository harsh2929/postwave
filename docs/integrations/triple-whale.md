# Triple Whale Native Analytics Integration

Last updated: 2026-10-25

## Runtime Status

Triple Whale remains `Native / partial` in the catalog, but the implemented customer profile-puller slice is `native_runtime_complete_live_certification_pending`. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `triplewhale:` page checkpoints, canonical profile mapping, analytics sync run history, disconnect-safe local writes, returned/persisted operator-managed `provider_cleanup` evidence, local cleanup acknowledgement, and scheduled retry continuation via `triple_whale_retry:` cursors.

Metrics/reporting expansion, provider-managed webhooks, warehouse adapters, provider credential cleanup proof, reconnect/data-delete certification, and live Triple Whale account validation remain open.

## Setup

- `provider`: `triple-whale`
- `credentials_ref`: vault reference containing Triple Whale API credentials.
- The secret contains `api_key` and `shop_id`. Alternatively, supply the exact
  `shop-id` from the Triple Whale app URL as the `shop_id` setting. This supports
  custom sales platforms as well as Shopify. `shop_domain` remains a legacy
  Shopify-domain alias. A setting must agree with the shop in the secret.
- Optional: `shop_id`, `shop_domain`, `start_date`, `end_date`, `lookback_days`, `page_size`, `endpoint`, `api_base_url`.

Raw API credentials are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls query `customers_table` through the [documented Data-Out SQL API](https://triplewhale.readme.io/reference/data-out-execute-custom-sql-query), using `x-api-key` authentication and an explicit `shopId`. Customer profiles contain lifetime data; the configured period is supplied to the API without filtering customers by creation date. Stable ordering with bounded LIMIT/OFFSET pages supplies `triplewhale:` checkpoints. The runtime maps customer rows into canonical profiles and preserves Retry-After-aware retry cursors when provider calls fail. Explicit custom endpoint overrides retain their existing `{customers, hasNextPage}` response contract.

## Validation Checklist

- Connect with `credentials_ref` and a shop identifier in either its secret or `shop_id`.
- Run empty sync/backfill and confirm profile rows, run history, and `triplewhale:` cursor evidence.
- Confirm disconnected rows reject manual sync/backfill and scheduled pulls skip them.
- Disconnect and confirm persisted `provider_cleanup` evidence plus local acknowledgement.
- Confirm metrics/report/webhook/warehouse objects are not advertised before live certification.
