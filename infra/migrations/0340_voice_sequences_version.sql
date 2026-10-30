-- 0339_voice_sequences_version.sql
--
-- Phase 2 `p2-sequences-patch-deltas` — adds an optimistic-concurrency
-- version column to voice_sequences. The PATCH handler is moving from
-- a {steps:[...]} full-array replacement to an op-based delta shape
-- ({ops:[...]}) and needs to reject racing writers without silently
-- clobbering each other's edits.
--
-- Contract:
--   * `version` is monotonically increasing per row.
--   * Reads expose it to the client as the entity etag.
--   * PATCH requires `If-Match: <current_version>` and the store
--     bumps it on a successful apply. A mismatch returns 412
--     Precondition Failed so the canvas can re-fetch and re-emit ops.
--
-- Why a bigint and not a timestamptz "as-of"?
--   * Integer arithmetic is unambiguous (no clock-skew interpretation).
--   * The handler increments by 1 inside the same transaction that
--     applies the ops, so the same row never decreases in version.
--   * Frontends can hash it into an HTTP If-Match header without
--     having to format/parse RFC 3339.
--
-- Backfill: existing rows go to version=1 so any in-flight client that
-- reads-then-writes against the new column will pass the first time and
-- bump to 2 on the first edit under the new contract.

BEGIN;

ALTER TABLE voice_sequences
    ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;

COMMIT;
