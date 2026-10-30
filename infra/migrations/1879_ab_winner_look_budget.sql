-- 1879_ab_winner_look_budget.sql
--
-- A fixed horizon for A/B winner selection.
--
-- THE MEASURED BUG. The recompute worker re-runs winner selection every 30
-- minutes with no memory of having run before, and each run is an independent
-- significance test at the same nominal alpha. Testing repeatedly on growing
-- data and stopping the first time it clears is the textbook way to manufacture
-- significance, and the simulation in winner_soundness_test.go puts a number on
-- it: with two variants — the literal A/B case, and the common one — a 24-hour
-- test at a 30-minute cadence declared a false winner 36.6% of the time against
-- an advertised 5%.
--
-- It went unnoticed because the only soundness test measured FOUR variants,
-- where the multiple-comparison correction (Šidák over k(k-1)/2 pairs, z = 2.63)
-- happened to over-cover the peeking as a side effect. At k = 2 that correction
-- is exactly 1 comparison, so it does nothing at all, and the guard that existed
-- to catch this reported green over the worst case for eighteen months.
--
-- WHY A COUNTER AND NOT JUST A HIGHER CUTOFF. Raising the bar controls the error
-- only if the number of looks is bounded. `POST /ab/evaluate` is operator-
-- triggered, so without a budget somebody refreshing a decision they dislike can
-- take unlimited looks at any cutoff and eventually clear it. The counter is
-- what makes the horizon fixed rather than aspirational.
--
-- The budget itself is not a new setting: the operator already declares
-- `evaluation_window_hours` and `recompute_interval_minutes`, and their ratio is
-- the number of looks they asked for.

BEGIN;

ALTER TABLE campaign_ab_settings
    ADD COLUMN IF NOT EXISTS winner_looks_taken integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN campaign_ab_settings.winner_looks_taken IS
    'Significance tests already spent on this campaign. The alpha budget is '
    'divided across ceil(evaluation_window_hours*60 / recompute_interval_minutes) '
    'looks; once spent, the test is concluded rather than re-tested, because an '
    'unbounded number of looks makes any cutoff clearable by chance.';

ALTER TABLE campaign_ab_settings
    ADD CONSTRAINT campaign_ab_settings_looks_nonneg
    CHECK (winner_looks_taken >= 0);

COMMIT;
