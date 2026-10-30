# ShipStation Native Shipping Integration

Last updated: 2026-07-03

## Runtime Status

ShipStation remains `Native / partial` in the catalog, but the implemented order-to-shipment REST read-puller slice is `native_runtime_complete_live_certification_pending`. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `shipstation:` page cursor checkpoints, canonical shipment/event mapping, subscription sync run history, disconnect-safe local writes, returned/persisted operator-managed `provider_cleanup` evidence, local cleanup acknowledgement, and scheduled retry continuation via `shipstation_retry:` cursors.

Fulfillment webhooks, provider-console credential cleanup proof, reconnect/data-delete certification, and live account validation remain open.

## Setup

- `provider`: `shipstation`
- `settings.account_id`: ShipStation account or store identifier.
- `credentials_ref`: vault reference containing ShipStation API credentials.
- Optional: `order_status`, `page_size`, `api_base_url`.

Raw API credentials are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read ShipStation orders/shipments with page pagination. The cursor advances as `shipstation:{page}` and completes at `shipstation:complete`. The mapper imports canonical shipment rows and fulfillment/delivery events.

## Validation Checklist

- Connect with `account_id` and `credentials_ref`.
- Run empty sync/backfill and confirm shipments/events, run history, and a `shipstation:` cursor.
- Disconnect and confirm persisted `provider_cleanup` evidence plus local acknowledgement.
- Confirm webhook topics remain suppressed until callback runtime lands.
