-- 0085_sequence_step_types.sql
--
-- Adds the v0.3+ sequence step shape to voice_sequences as a sibling
-- jsonb column. Why a new column rather than reusing the existing
-- `emails` array: the legacy GeneratedEmail array is a tight projection
-- shape (subject/body/delay_seconds/score) that the runtime + analytics
-- already SELECT against. The richer Step shape (condition with two
-- branches, standalone delays, tag mutations, exit) doesn't fit inside
-- a GeneratedEmail without a tagged-union escape hatch — and that
-- breaks readers that expect the legacy projection. Cleaner to keep
-- the legacy column intact for back-compat and add a parallel
-- `steps` column that the new producers write to.
--
-- Producers send EITHER `emails` or `steps`, never both — see the
-- handler in services/voice/internal/handlers/sequences.go which
-- 400s on mixed requests. Readers that only know about emails see the
-- empty/legacy projection; readers that know about steps see the
-- richer shape.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, no destructive operations.
-- RLS already enabled on voice_sequences (migration 0010); adding a
-- column inherits the existing policy.

BEGIN;

ALTER TABLE voice_sequences
    ADD COLUMN IF NOT EXISTS steps jsonb;

-- Defensive: make sure the column is nullable + has no default so
-- existing rows stay untouched. (Postgres ALTER ADD COLUMN with no
-- default is a metadata-only change, but we re-state for clarity.)
ALTER TABLE voice_sequences
    ALTER COLUMN steps DROP DEFAULT;

COMMIT;
