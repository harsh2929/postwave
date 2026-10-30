-- 0398_sequence_funnel_variant_key.sql
--
-- Per-variant A/B funnel stats: stampable variant identity on
-- sequence_funnel_events.
--
-- WHY (verified against the repo, 2026-06-13): A sequence email step can
-- carry 2..4 A/B variants (services/voice/internal/generation/variants.go
-- ValidateVariants). The arm a subscriber sees is a PURE deterministic
-- hash over (lower(trim(email)), sequence_id, position) — see
-- generation.AssignVariant — so per-variant funnel stats can be computed
-- READ-SIDE by recomputing the assignment for each funnel row; no
-- send-time stamping is strictly required. The analytics aggregation
-- (apps/api/internal/analytics SequenceFunnel) does exactly that.
--
-- This column is the OPTIONAL fast path: the external sequence dispatcher
-- (the sequence_funnel_events producer named in migration 0052) MAY stamp
-- the resolved variant_key directly on insert. When present the
-- aggregation PREFERS the stamped value (it is authoritative — the
-- producer knows which arm it actually sent, e.g. after a mid-flight
-- weight change); when NULL the aggregation recomputes AssignVariant.
-- Recompute and a correctly-stamped value agree exactly for a stable
-- variant list, so the column is purely additive — legacy rows (NULL)
-- behave exactly as before.
--
-- PRODUCER STATUS (unchanged from 0367): NO code in THIS repository
-- writes sequence_funnel_events. The producer lives engine-side; the
-- stamping contract is documented in
-- apps/desktop/SEQUENCE-LOOP-ENGINE-CONTRACT.md. Until the engine ships
-- variant_key, every row arrives NULL and the analytics endpoint
-- recomputes the arm deterministically.
--
-- No new index: per-variant grouping happens in Go after the existing
-- (tenant_id, sequence_id, position) index serves the same per-sequence
-- scan the funnel already runs. Adding a variant_key index would only
-- pay off for a producer-side dedupe we don't do here.

BEGIN;

ALTER TABLE sequence_funnel_events
    ADD COLUMN IF NOT EXISTS variant_key text;

COMMIT;
