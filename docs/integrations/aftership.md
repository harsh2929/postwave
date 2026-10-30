# AfterShip Native Shipping Integration

Last updated: 2026-07-03

## Runtime Status

AfterShip remains `Native / partial` in the catalog, but the implemented tracking REST read-puller slice is `native_runtime_complete_live_certification_pending`. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `aftership:` page cursor checkpoints, canonical shipment/event mapping, subscription sync run history, disconnect-safe local writes, returned/persisted operator-managed `provider_cleanup` evidence, local cleanup acknowledgement, and scheduled retry continuation via `aftership_retry:` cursors.

Tracking webhooks, provider-console credential cleanup proof, reconnect/data-delete certification, and live account validation remain open.

## Setup

- `provider`: `aftership`
- `settings.account_id`: AfterShip account or organization identifier.
- `credentials_ref`: vault reference containing the AfterShip API key.
- Optional: `page_size`, `api_base_url`.

Raw API keys are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read AfterShip trackings with page pagination. The cursor advances as `aftership:{page}` and completes at `aftership:complete`. The mapper imports canonical shipment rows and delivery events.

## Validation Checklist

- Connect with `account_id` and `credentials_ref`.
- Run empty sync/backfill and confirm shipments/events, run history, and an `aftership:` cursor.
- Disconnect and confirm persisted `provider_cleanup` evidence plus local acknowledgement.
- Confirm webhook topics are not advertised before callback runtime lands.
