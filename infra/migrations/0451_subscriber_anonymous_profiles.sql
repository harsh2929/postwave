-- 0451_subscriber_anonymous_profiles.sql
--
-- SUB-003 — Anonymous-to-known stitching with a retroactive trigger window.
--
-- Modern CDP-grade ESPs (Segment, Customer.io, Klaviyo's "Active on Site"
-- tracking) let a browser/device accrue activity under an anonymous_id
-- BEFORE the visitor ever hands over an email. On the eventual identify
-- call the platform must (a) merge that pre-identification activity onto the
-- now-known profile and (b) replay any automation triggers that would have
-- fired during a backward window (we use 72h) so a welcome/abandon flow
-- still fires for the activity that happened while the visitor was anonymous.
--
-- Postwave already has profile_aliases (migration 0324) with an
-- alias_type='anonymous_id' slot, but it had no place to record that an
-- anonymous_id was seen BEFORE any known profile existed — subscriber_events
-- is keyed on subscriber_email (citext NOT NULL) and therefore cannot hold a
-- truly anonymous hit. This table is the lightweight pre-identification
-- registry: one row per (tenant_id, anonymous_id), created the first time we
-- see the anonymous_id on an identify call, carrying the timestamps the
-- replayer reads to bound its 72h backward window.
--
-- The events themselves continue to live in subscriber_events keyed by the
-- placeholder/known email; on identify we reparent them and emit a synthetic
-- 'identified' event (an event_type already allow-listed by migration 0324)
-- for trigger replay.
--
-- rollback-strategy: additive. Hard rollback = DROP TABLE
-- subscriber_anonymous_profiles.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriber_anonymous_profiles (
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    anonymous_id text NOT NULL CHECK (char_length(anonymous_id) BETWEEN 1 AND 512),
    -- subscriber_id is set once the anonymous_id is stitched onto a known
    -- profile; NULL = still anonymous. ON DELETE SET NULL so erasing the
    -- subscriber leaves the anonymous registry intact (audit/replay keys
    -- survive) rather than cascading a delete.
    subscriber_id uuid REFERENCES subscribers(id) ON DELETE SET NULL,
    identified_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, anonymous_id)
);

-- "All anonymous_ids stitched to subscriber X" — a tight tenant-scoped scan
-- used by the identify reparent path. Partial: only stitched rows indexed.
CREATE INDEX IF NOT EXISTS subscriber_anonymous_profiles_subscriber_idx
    ON subscriber_anonymous_profiles (tenant_id, subscriber_id)
    WHERE subscriber_id IS NOT NULL;

CREATE TRIGGER subscriber_anonymous_profiles_set_updated_at
    BEFORE UPDATE ON subscriber_anonymous_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_anonymous_profiles TO postwave_app;

ALTER TABLE subscriber_anonymous_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_anonymous_profiles FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscriber_anonymous_profiles
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscriber_anonymous_profiles
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
