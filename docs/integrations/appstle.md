# Appstle Native Subscription Integration

Last updated: 2026-07-03

## Runtime Status

Appstle remains `Native / partial` in the catalog, but the implemented REST subscription-contract read-puller slice is `native_runtime_complete_live_certification_pending`. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `appstle:` page cursor checkpoints, canonical subscription/event mapping, subscription sync run history, disconnect-safe local writes, returned/persisted operator-managed `provider_cleanup` evidence, local cleanup acknowledgement, and scheduled retry continuation via `appstle_retry:` cursors.

Plan/order expansion, webhook registration/cleanup, provider-console credential cleanup proof, reconnect/data-delete certification, and live store validation remain open.

## Setup

- `provider`: `appstle`
- `settings.store_domain`: Shopify store domain connected to Appstle.
- `credentials_ref`: vault reference containing Appstle API credentials.
- Optional: `page_size`, `api_base_url`, `endpoint`.

Raw API credentials are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read Appstle subscription contracts with page pagination. The cursor advances as `appstle:{page}` and completes at `appstle:complete`. The mapper imports canonical subscriptions and subscription events.

## Validation Checklist

- Connect with `store_domain` and `credentials_ref`.
- Run empty sync/backfill and confirm subscription rows/events, run history, and an `appstle:` cursor.
- Disconnect and confirm persisted `provider_cleanup` evidence plus local acknowledgement.
- Confirm plan/webhook expansion remains partial.
