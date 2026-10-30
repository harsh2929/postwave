-- 0487_subscriber_merge_audit_log.sql
--
-- SUB-025 — Identity graph audit log with signal breakdown.
--
-- The merge path (merge.go) already writes a single high-level audit_log row
-- per merge with aggregate counts (events_moved, suppressions_moved,
-- tags_merged, custom_fields_merged). What it does NOT capture is WHICH
-- identity-resolution signals fired and at what confidence. The dedupe
-- surface classifies candidate pairs by signal kind (case_diff / plus_alias /
-- dot_alias) with a confidence score, and the identify path merges on
-- external_id + email matches — but neither persists structured signal
-- provenance, so an auditor cannot reconstruct *why* two profiles were judged
-- the same person.
--
-- This migration adds a granular, append-only evidence table: one row per
-- signal that contributed to a given merge decision. It complements (does not
-- replace) the existing audit_log row — audit_log records the high-level
-- "subscriber.merged" action, this table records the per-signal breakdown so
-- identity resolution is transparent and reviewable. Audit detail views can
-- JOIN to it later by (primary_id, at) if desired.
--
-- Tenant-scoped table -> tenant_id uuid + RLS, with the GUC read via
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid so an unset GUC
-- does not crash the policy. Shape copied from
-- 0475_subscriber_dedupe_settings.sql / 0463_tenant_identifier_transforms.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_merge_audit_log (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The surviving (primary_id) and deleted (duplicate_id) subscriber row
    -- ids for this merge. duplicate_id is recorded as text because the row it
    -- pointed at is gone after the merge commits — there is no FK to enforce.
    primary_id    uuid        NOT NULL,
    duplicate_id  uuid        NOT NULL,
    -- The identity-resolution signal that fired (e.g. case_diff, plus_alias,
    -- dot_alias, external_id_claim, manual). Free text so new heuristics can
    -- land without a migration; the application owns the vocabulary.
    signal_kind   text        NOT NULL,
    -- Per-signal confidence in [0,1]. NULL when the path that produced the
    -- merge did not carry a score (e.g. an operator-initiated manual merge).
    confidence    numeric(4,3),
    -- Optional structured context for this signal (matched value, normaliser
    -- version, ...). Defaults to an empty object so readers never see NULL.
    metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT subscriber_merge_audit_log_confidence_chk
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

-- Lookup by the surviving subscriber, newest first — the natural read for an
-- audit detail view ("show me why this profile absorbed others").
CREATE INDEX IF NOT EXISTS subscriber_merge_audit_log_primary_idx
    ON subscriber_merge_audit_log (tenant_id, primary_id, at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_merge_audit_log TO postwave_app;

ALTER TABLE subscriber_merge_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_merge_audit_log FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriber_merge_audit_log
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
