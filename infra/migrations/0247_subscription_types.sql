-- 0247_subscription_types.sql
--
-- GAP-LS-092: Subscription Types — per-tenant catalog of topical
-- subscription categories (default Marketing / Product Updates;
-- HubSpot allows up to 1000 per account). Each (subscriber,
-- subscription_type, channel) tuple has an opt-out state; absence of
-- a row means the subscriber is opted IN to that type on that channel.
--
-- This is the single biggest privacy feature missing for any
-- GDPR-serious customer in 2026. It closes parity with HubSpot
-- subscription types, Resend Unsubscribe Topics, and SendGrid ASM
-- (Advanced Suppression Manager) groups.
--
-- The opt-out table is intentionally separate from
-- subscriber_suppressions: a topic-level opt-out is NOT a hard
-- suppression. The send loop checks subscription_type_opt_outs only
-- when a campaign is bound to a subscription_type (campaign metadata
-- column lands later).
--
-- Default rows: we seed two defaults per tenant on first create via
-- a trigger that fires AFTER INSERT on tenants. This keeps the
-- preference center usable from day one without a separate
-- materializer step.

BEGIN;

CREATE TABLE IF NOT EXISTS subscription_types (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name         text NOT NULL,
    description  text NOT NULL DEFAULT '',
    channel      text NOT NULL DEFAULT 'email'
                 CHECK (channel IN ('email','sms','push','all')),
    is_default   boolean NOT NULL DEFAULT false,
    is_internal  boolean NOT NULL DEFAULT false,
    sort_order   int NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS subscription_types_tenant_sort_idx
    ON subscription_types (tenant_id, sort_order, name);

CREATE TRIGGER subscription_types_set_updated_at
    BEFORE UPDATE ON subscription_types
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON subscription_types TO postwave_app;

ALTER TABLE subscription_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_types FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscription_types
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscription_types
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Per-(subscriber, type, channel) opt-out ledger. Absence of a row =
-- opted IN. One row per opt-out event so we can show "opted out 3
-- times, last on date X"; UNIQUE collapses re-opt-outs from the same
-- source so duplicate webhook deliveries are no-ops.
CREATE TABLE IF NOT EXISTS subscription_type_opt_outs (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id         uuid NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    subscription_type_id  uuid NOT NULL REFERENCES subscription_types(id) ON DELETE CASCADE,
    channel               text NOT NULL DEFAULT 'email'
                          CHECK (channel IN ('email','sms','push','all')),
    opted_out_at          timestamptz NOT NULL DEFAULT now(),
    source                text NOT NULL DEFAULT 'preference_center'
                          CHECK (source IN (
                              'preference_center','api','admin','one_click',
                              'import','webhook'
                          )),
    source_event_id       text,
    UNIQUE (tenant_id, subscriber_id, subscription_type_id, channel)
);

CREATE INDEX IF NOT EXISTS subscription_type_opt_outs_type_idx
    ON subscription_type_opt_outs (tenant_id, subscription_type_id, opted_out_at DESC);

CREATE INDEX IF NOT EXISTS subscription_type_opt_outs_subscriber_idx
    ON subscription_type_opt_outs (tenant_id, subscriber_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON subscription_type_opt_outs TO postwave_app;

ALTER TABLE subscription_type_opt_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_type_opt_outs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON subscription_type_opt_outs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON subscription_type_opt_outs
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Seed defaults for existing tenants so the preference center has
-- something to render the day this migration lands. Idempotent via
-- the unique (tenant_id, name) constraint.
INSERT INTO subscription_types (tenant_id, name, description, channel, is_default, sort_order)
SELECT t.id, 'Marketing emails',
       'Promotional emails, newsletters, and product announcements.',
       'email', true, 10
  FROM tenants t
 ON CONFLICT (tenant_id, name) DO NOTHING;

INSERT INTO subscription_types (tenant_id, name, description, channel, is_default, sort_order)
SELECT t.id, 'Product updates',
       'Release notes, changelogs, and feature launches.',
       'email', false, 20
  FROM tenants t
 ON CONFLICT (tenant_id, name) DO NOTHING;

-- Forward-fire trigger: every newly-created tenant gets the same two
-- defaults so the preference center is never empty.
CREATE OR REPLACE FUNCTION seed_subscription_types_for_tenant()
RETURNS trigger AS $$
BEGIN
    INSERT INTO subscription_types (tenant_id, name, description, channel, is_default, sort_order)
    VALUES
        (NEW.id, 'Marketing emails',
         'Promotional emails, newsletters, and product announcements.',
         'email', true, 10),
        (NEW.id, 'Product updates',
         'Release notes, changelogs, and feature launches.',
         'email', false, 20)
    ON CONFLICT (tenant_id, name) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS seed_subscription_types_on_tenant_create ON tenants;
CREATE TRIGGER seed_subscription_types_on_tenant_create
    AFTER INSERT ON tenants
    FOR EACH ROW EXECUTE FUNCTION seed_subscription_types_for_tenant();

COMMIT;
