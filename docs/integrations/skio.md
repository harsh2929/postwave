# Skio Native Subscription Integration

Last updated: 2026-07-03

## Runtime Status

Skio remains `Native / partial` in the catalog, but the implemented GraphQL read-puller slice is `native_runtime_complete_live_certification_pending`. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `skio:` offset cursor checkpoints, canonical subscription/event mapping, subscription sync run history, disconnect-safe local writes, returned/persisted operator-managed `provider_cleanup` evidence, local cleanup acknowledgement, and scheduled retry continuation via `skio_retry:` cursors.

Shopify lifecycle webhooks, provider-console credential cleanup proof, reconnect/data-delete certification, and live store validation remain open.

## Setup

- `provider`: `skio`
- `settings.store_domain`: Shopify store domain connected to Skio.
- `credentials_ref`: vault reference containing Skio API credentials.
- Optional: `page_size`, `api_base_url`.

Raw API credentials are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read Skio subscriptions with offset pagination. The cursor advances as `skio:{offset}` and completes at `skio:complete`. The mapper imports canonical subscription rows and subscription events.

## Validation Checklist

- Connect with `store_domain` and `credentials_ref`.
- Run empty sync/backfill and confirm subscription rows/events, run history, and a `skio:` cursor.
- Disconnect and confirm persisted `provider_cleanup` evidence plus local acknowledgement.
- Confirm webhook topics are not advertised before lifecycle handlers land.
