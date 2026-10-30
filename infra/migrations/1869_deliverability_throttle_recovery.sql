-- 1869_deliverability_throttle_recovery.sql
--
-- Track the sustained HIGH-score period, so an automatic throttle can lift
-- itself.
--
-- `observeAndMaybeAutoThrottle` installs a repair override automatically after a
-- continuous 24-hour low-score period. `clearOverride` had exactly one non-test
-- caller: the admin route. So a tenant whose reputation recovered stayed capped
-- at half their sending rate until a human noticed and clicked — and nothing
-- prompts that, because recovery is precisely the event that produces no alert.
-- A machine-applied cap needs a machine-lifted release.
--
-- `deliverability_throttle_state` already tracks `low_since` for entry. This is
-- its mirror: the instant the score first went above the recovery threshold and
-- has stayed there. Reset to NULL by any sample that falls back below, exactly
-- as `low_since` is reset by a sample that rises above the entry threshold.
--
-- WHY A SECOND COLUMN AND NOT low_since's ABSENCE. "Not currently low" is not
-- the same fact as "has been high for six hours". Entry needs 24h of continuous
-- low; release needs its own continuous window at a HIGHER bar, and the band
-- between the two thresholds is neither — a tenant there is not accumulating
-- evidence in either direction, and one column cannot represent that.

BEGIN;

ALTER TABLE deliverability_throttle_state
    ADD COLUMN IF NOT EXISTS high_since timestamptz;

COMMENT ON COLUMN deliverability_throttle_state.high_since IS
    'When the score first rose above AutoThrottleRecoveryThreshold and stayed '
    'there. NULL when the most recent qualified sample was below it. Mirrors '
    'low_since, which drives entry; this drives release. The gap between the '
    'entry and recovery thresholds is the hysteresis band — a tenant in it '
    'accumulates neither, so the two columns cannot be collapsed into one.';

COMMIT;
