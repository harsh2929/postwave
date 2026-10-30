-- 0321_subscriber_view_prefs.sql
--
-- SUB-075: per-user Subscribers-table view preferences.
--
-- Stores the chosen column set, per-column widths, and the active
-- sort key/order for each (tenant, user) viewing the Subscribers list.
-- The Subscribers page reads + writes this row on mount + on every
-- column toggle / column resize so a user's layout survives reloads
-- and follows them between machines (it's server-side, not localStorage).
--
-- One row per (tenant_id, user_id). The unique constraint lets the
-- handler use INSERT ... ON CONFLICT (tenant_id, user_id) DO UPDATE
-- without a separate "exists?" round-trip.
--
-- prefs is jsonb so the column catalog can evolve (add/remove sortable
-- fields) without a schema migration each time. The handler validates
-- keys against the allow-list before persisting — operators can't
-- inject arbitrary SQL-bound column names through this surface.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_view_prefs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL,
    prefs       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_view_prefs TO postwave_app;

ALTER TABLE subscriber_view_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_view_prefs FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON subscriber_view_prefs;
CREATE POLICY tenant_isolation ON subscriber_view_prefs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON subscriber_view_prefs;
CREATE POLICY tenant_visible ON subscriber_view_prefs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
