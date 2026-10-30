-- 0235_consent_tracking_eligibility.sql
--
-- Tracking-consent governance: recipient-level email tracking eligibility
-- + visitor-consent indexes.
--
-- Why this migration:
--
--   1. consent_events (0094) is the broad consent ledger but lacks an
--      index optimised for visitor lookups by subject_id (cookie-banner
--      flow). The existing tenant_subject composite includes
--      subject_type so an equality probe on (tenant_id, subject_id)
--      with subject_type='visitor' is well-served by an additional
--      partial index. Add it here.
--
--   2. The recipient-level pixel/click tracking opt-out (the
--      "tracking eligibility" rollout called out in
--      docs/compliance-register.json product_controls.tracking_consent)
--      needs a small per-subscriber preference store the send-time
--      link rewriter and pixel injector can short-circuit on. We
--      keep it as a sidecar table (subscriber_tracking_prefs) rather
--      than widening the subscribers table — the lookup cost is one
--      index hit per recipient batch and it keeps the change
--      contained to the consent governance area.
--
--   3. Both surfaces use the canonical NULLIF RLS idiom plus the
--      tenant_isolation RESTRICTIVE pair so a missing
--      app.tenant_id GUC fails closed instead of crashing on the
--      empty-string-to-uuid cast.

BEGIN;

-- 1. consent_events: visitor-id partial index.
CREATE INDEX IF NOT EXISTS consent_events_tenant_visitor_idx
    ON consent_events (tenant_id, subject_id, created_at DESC)
    WHERE subject_type = 'visitor';

-- 2. subscriber_tracking_prefs.
CREATE TABLE IF NOT EXISTS subscriber_tracking_prefs (
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_email   citext NOT NULL,
    open_opt_out_at    timestamptz,
    click_opt_out_at   timestamptz,
    source             text NOT NULL DEFAULT 'admin',
    gpc                boolean NOT NULL DEFAULT false,
    policy_version     text NOT NULL DEFAULT 'v1',
    updated_at         timestamptz NOT NULL DEFAULT now(),
    created_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, subscriber_email)
);

COMMENT ON TABLE subscriber_tracking_prefs IS
    'Recipient-level email tracking eligibility. Send-time link rewriter and pixel injector short-circuit when the relevant *_opt_out_at is non-null.';

CREATE INDEX IF NOT EXISTS subscriber_tracking_prefs_open_optout_idx
    ON subscriber_tracking_prefs (tenant_id, subscriber_email)
    WHERE open_opt_out_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS subscriber_tracking_prefs_click_optout_idx
    ON subscriber_tracking_prefs (tenant_id, subscriber_email)
    WHERE click_opt_out_at IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_tracking_prefs TO postwave_app;

ALTER TABLE subscriber_tracking_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_tracking_prefs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON subscriber_tracking_prefs;
CREATE POLICY tenant_isolation ON subscriber_tracking_prefs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_visible ON subscriber_tracking_prefs;
CREATE POLICY tenant_visible ON subscriber_tracking_prefs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
