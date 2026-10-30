# Friendbuy Native Loyalty Integration

Last updated: 2026-06-30

## Runtime Status

Friendbuy is local-runtime-complete/live-certification-pending for the implemented token-exchange REST loyalty puller. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `friendbuy:` cursor checkpoints, canonical loyalty profile/referral-code mapping, loyalty sync run history, disconnect-safe local writes, scheduled retry continuation via `friendbuy_retry:` cursors, and operator-managed `provider_cleanup` evidence on disconnect.

Referral/reward event expansion, managed webhook registration/cleanup, credential cleanup proof, reconnect certification, data-delete behavior, and live campaign validation remain open before full availability.

## Setup

- `provider`: `friendbuy`
- `settings.campaign_id`: Friendbuy referral campaign identifier.
- `credentials_ref`: vault reference containing Friendbuy API credentials.
- Optional: `shop_domain`.

Raw API credentials and webhook secrets are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read Friendbuy customers/advocates and referral-code evidence. The cursor advances as `friendbuy:{cursor}` and completes at `friendbuy:complete`. The mapper imports canonical loyalty profile evidence.

## Validation Checklist

- Connect with `campaign_id` and `credentials_ref`.
- Run empty sync/backfill and confirm referral/reward events, run history, and a `friendbuy:` cursor.
- Confirm webhook topics and webhook secrets remain suppressed.
