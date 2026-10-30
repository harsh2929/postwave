-- 1871_ab_winner_inconclusive.sql
--
-- Record WHY an A/B winner was chosen, so a report cannot present a timeout as
-- a result.
--
-- The auto-promote scheduler discarded the evaluator's verdict: when no variant
-- cleared the significance bar it fell back to `results[0]`, which
-- `ListResults` orders by `variant_label` — so every inconclusive test promoted
-- variant A, mailed it to the whole held-back audience, and stamped
-- `winner_decided_at`. Nothing downstream could tell that apart from a real
-- win, because the row looked identical either way.
--
-- Two facts, one column each:
--
--   winner_conclusive     did the statistics decide, or did the window close?
--   winner_decision_note  the operator-facing sentence explaining the choice.
--
-- DEFAULT TRUE is deliberate for the backfill. Every existing decided row was
-- written by the old code path, which is precisely the ambiguity this column
-- resolves — but retro-labelling historical winners as inconclusive would
-- assert something we cannot know, and would rewrite reports operators have
-- already read. New rows carry the truth; old rows keep their existing meaning
-- and the note stays NULL, which is itself the signal that the distinction
-- predates this column.

BEGIN;

ALTER TABLE campaign_ab_settings
    ADD COLUMN IF NOT EXISTS winner_conclusive boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS winner_decision_note text;

COMMENT ON COLUMN campaign_ab_settings.winner_conclusive IS
    'False when auto-promotion shipped a variant WITHOUT a statistically '
    'significant result — the test window closed and the best observed arm was '
    'sent so the held-back audience would receive something. Reporting must not '
    'call such a variant a winner. True for rows written before this column '
    'existed, because their basis is unknowable, not because it was verified.';

COMMENT ON COLUMN campaign_ab_settings.winner_decision_note IS
    'Operator-facing explanation of the basis for the choice. NULL on rows that '
    'predate the column.';

COMMIT;
