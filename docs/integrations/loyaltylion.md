# LoyaltyLion Native Loyalty Integration

Last updated: 2026-06-30

## Runtime Status

LoyaltyLion is local-runtime-complete/live-certification-pending for the implemented REST loyalty puller. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `loyaltylion:` page cursor checkpoints, canonical loyalty profile mapping, loyalty sync run history, disconnect-safe local writes, scheduled retry continuation via `loyaltylion_retry:` cursors, and operator-managed `provider_cleanup` evidence on disconnect.

Reward-event expansion, managed webhook registration/cleanup, OAuth refresh, credential cleanup proof, reconnect certification, data-delete behavior, and live program validation remain open before full availability.

## Setup

- `provider`: `loyaltylion`
- `settings.site_id`: LoyaltyLion site identifier.
- `credentials_ref`: vault reference containing LoyaltyLion API credentials.
- Optional: `program_id`.

Raw API credentials and webhook secrets are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read customers, approved points, and tiers with page pagination. The cursor advances as `loyaltylion:{page}` and completes at `loyaltylion:complete`. The mapper imports canonical loyalty profile evidence.

## Validation Checklist

- Connect with `site_id` and `credentials_ref`.
- Run empty sync/backfill and confirm loyalty profiles/events, run history, and a `loyaltylion:` cursor.
- Confirm webhook topics and webhook secrets are not advertised before callback certification.
