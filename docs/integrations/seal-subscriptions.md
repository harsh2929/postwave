# Seal Subscriptions Native Integration

Last updated: 2026-07-03

## Runtime Status

Seal Subscriptions remains `Native / partial` in the catalog, but the implemented REST subscription read-puller slice is `native_runtime_complete_live_certification_pending`. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `seal:` page cursor checkpoints, canonical subscription/event mapping, subscription sync run history, disconnect-safe local writes, returned/persisted operator-managed `provider_cleanup` evidence, local cleanup acknowledgement, and scheduled retry continuation via `seal_subscriptions_retry:` cursors.

Rules/order expansion, webhook registration/cleanup, provider-console credential cleanup proof, reconnect/data-delete certification, and live store validation remain open.

## Setup

- `provider`: `seal-subscriptions`
- `settings.store_domain`: Shopify store domain connected to Seal.
- `credentials_ref`: vault reference containing Seal Subscriptions API credentials.
- Optional: `page_size`, `api_base_url`.

Raw API credentials are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read Seal subscriptions with page pagination. The cursor advances as `seal:{page}` and completes at `seal:complete`. The mapper imports canonical subscriptions and subscription events.

## Validation Checklist

- Connect with `store_domain` and `credentials_ref`.
- Run empty sync/backfill and confirm subscription rows/events, run history, and a `seal:` cursor.
- Disconnect and confirm persisted `provider_cleanup` evidence plus local acknowledgement.
- Confirm rules/webhook expansion remains partial.
