-- 0425_subscriber_attribute_history.sql
--
-- SUB-008 — temporal attribute history (Type-2 SCD-ish append-only log).
--
-- Today three subscriber-mutation surfaces leave an audit trail:
--   * subscribers.updated_at (0003 trigger) — timestamp only, no before/after.
--   * tag_history (0292) — auto-logged tag add/remove deltas.
--   * contact_history_events (0226) — opt-in rating/event append.
--
-- What's missing is a per-FIELD before/after record for the *mutable
-- attributes* that aren't tags: status, custom_fields, merge_fields, and
-- the localization columns. Operators auditing a profile want to see
-- "status changed from enabled to disabled on 2025-06-15" and
-- "custom_field 'phone' changed from '555-1234' to '555-5678'".
--
-- This migration adds a dedicated, immutable, append-only table. One row
-- per (subscriber, field) change. The writer (subscribers/repo.go
-- EmitAttributeHistory) dual-writes inside the same tx as the Upsert/
-- Update mutation, mirroring how tag_history is emitted. We keep it a
-- dedicated table rather than reusing contact_history_events because the
-- SCD volume (one row per changed field per mutation) can dwarf the
-- event log and we want it independently retention-managed.
--
-- For GDPR erasure the writer can null the field_value columns while
-- preserving field_name + changed_at so the audit chain survives without
-- leaking PII.
--
-- rollback-strategy: additive table; prior releases never read it, so it
-- is safe to leave in place during a rollback. Hard rollback =
-- DROP TABLE subscriber_attribute_history.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_attribute_history (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    -- Logical field that changed. For scalar columns this is the column
    -- name ("status", "locale"); for jsonb maps it is the dotted path
    -- ("custom_fields.phone", "merge_fields.FNAME").
    field_name    text NOT NULL CHECK (length(field_name) BETWEEN 1 AND 256),
    -- before/after rendered as text. NULL means "absent" (field did not
    -- exist before, or was removed). Stored as text so a timeline render
    -- needs no per-type branching; the writer stringifies scalars and
    -- compact-JSON-encodes nested values.
    old_value     text,
    new_value     text,
    -- source verb mirrors the tag_history "source" column vocabulary —
    -- which repo path emitted the change.
    source        text NOT NULL DEFAULT 'subscriber_update'
        CHECK (length(source) BETWEEN 1 AND 64),
    changed_by    uuid,
    changed_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE subscriber_attribute_history IS
    'SUB-008 append-only per-field before/after log for subscriber attribute mutations (status, custom_fields, merge_fields, localization). Dual-written by subscribers/repo.go EmitAttributeHistory inside the same tx as the Upsert/Update.';

-- B-tree on (tenant_id, subscriber_id, changed_at DESC) for the per-
-- subscriber drill-down (GET /api/v1/subscribers/{id}/attribute-history).
CREATE INDEX IF NOT EXISTS subscriber_attribute_history_subscriber_idx
    ON subscriber_attribute_history (tenant_id, subscriber_id, changed_at DESC);

-- BRIN on (tenant_id, changed_at) for time-range retention sweeps over
-- this append-only table.
CREATE INDEX IF NOT EXISTS subscriber_attribute_history_brin_idx
    ON subscriber_attribute_history USING BRIN (tenant_id, changed_at);

GRANT SELECT, INSERT, DELETE ON subscriber_attribute_history TO postwave_app;

ALTER TABLE subscriber_attribute_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_attribute_history FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON subscriber_attribute_history;
CREATE POLICY tenant_isolation ON subscriber_attribute_history
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON subscriber_attribute_history;
CREATE POLICY tenant_visible ON subscriber_attribute_history
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
