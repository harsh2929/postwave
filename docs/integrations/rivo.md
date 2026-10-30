# Rivo Native Loyalty Integration

Last updated: 2026-06-30

## Runtime Status

Rivo is local-runtime-complete/live-certification-pending for the implemented REST loyalty puller. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `rivo:` page cursor checkpoints, canonical loyalty profile mapping, loyalty sync run history, disconnect-safe local writes, scheduled retry continuation via `rivo_retry:` cursors, and operator-managed `provider_cleanup` evidence on disconnect.

Reward-event expansion, managed webhook registration/cleanup, credential cleanup proof, reconnect certification, data-delete behavior, and live store validation remain open before full availability.

## Setup

- `provider`: `rivo`
- `settings.shop_domain`: Shopify domain connected to Rivo.
- `credentials_ref`: vault reference containing the Rivo API key.
- Optional: `program_id`.

Raw API keys and webhook secrets are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read Rivo customers, points, and tier/referral evidence with page pagination. The cursor advances as `rivo:{page}` and completes at `rivo:complete`. The mapper imports canonical loyalty profile evidence.

## Validation Checklist

- Connect with `shop_domain` and `credentials_ref`.
- Run empty sync/backfill and confirm loyalty profiles/events, run history, and a `rivo:` cursor.
- Confirm webhook topics and webhook secrets remain suppressed.
