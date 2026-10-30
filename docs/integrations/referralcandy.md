# ReferralCandy Native Loyalty Integration

Last updated: 2026-06-30

## Runtime Status

ReferralCandy is local-runtime-complete/live-certification-pending for the implemented signed REST referrer puller. Moosewave owns credential references, signed API credential shape validation, empty `/sync` and `/backfill` provider pulls, `referralcandy:` page cursor checkpoints, canonical loyalty profile/referral-code mapping, loyalty sync run history, disconnect-safe local writes, scheduled retry continuation via `referralcandy_retry:` cursors, and operator-managed `provider_cleanup` evidence on disconnect.

Callback authenticity, campaign deepening, reward-event expansion, credential cleanup proof, reconnect certification, data-delete behavior, and live campaign validation remain open before full availability.

## Setup

- `provider`: `referralcandy`
- `settings.access_id`: ReferralCandy API access ID.
- `credentials_ref`: vault reference containing the ReferralCandy API secret.
- Optional: `campaign_id`, `shop_domain`.

Raw API secrets are not accepted in settings.

## Sync Behavior

Empty sync/backfill calls read ReferralCandy referrers with page pagination. The cursor advances as `referralcandy:{page}` and completes at `referralcandy:complete`. The mapper imports canonical loyalty profile and referral-code evidence.

## Validation Checklist

- Connect with `access_id` and `credentials_ref`.
- Run empty sync/backfill and confirm referral/reward events, run history, and a `referralcandy:` cursor.
- Confirm no webhook/callback authenticity claim is advertised until certified.
