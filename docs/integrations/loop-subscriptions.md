# Loop Subscriptions Native Integration

Last updated: 2026-07-03

## Runtime Status

Loop Subscriptions remains `Native / partial` in the catalog, but the implemented REST subscription read-puller slice is `native_runtime_complete_live_certification_pending`. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `loop:` page cursor checkpoints, canonical subscription/event mapping, subscription sync run history, disconnect-safe local writes, returned/persisted operator-managed `provider_cleanup` evidence, local cleanup acknowledgement, and scheduled retry continuation via `loop_subscriptions_retry:` cursors.

Contract/order expansion, webhook registration/cleanup, provider-console credential cleanup proof, reconnect/data-delete certification, and live store validation remain open.

## Setup

- `provider`: `loop-subscriptions`
- `settings.store_domain`: Shopify store domain connected to Loop.
- `credentials_ref`: vault reference containing Loop API credentials.
- Optional: `page_size`, `api_base_url`.

Raw API credentials are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read Loop subscriptions with page pagination. The cursor advances as `loop:{page}` and completes at `loop:complete`. The mapper imports canonical subscriptions and subscription events.

## Validation Checklist

- Connect with `store_domain` and `credentials_ref`.
- Run empty sync/backfill and confirm subscription rows/events, run history, and a `loop:` cursor.
- Disconnect and confirm persisted `provider_cleanup` evidence plus local acknowledgement.
- Confirm webhooks are not advertised before callback runtime lands.
