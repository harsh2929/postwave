-- 0299_sto_strategy_persistence.sql
--
-- Send-time-optimization strategy persistence (sto-strategy-persistence, P2).
--
-- Before this migration, the SendTime page lets an operator choose a
-- strategy ("per_recipient" / "modal_hour") for every re-schedule click,
-- but the choice is fire-and-forget — nothing is persisted on the
-- campaign row, there's no tenant-level default, and the campaign
-- detail slideover can't surface "this campaign sends at each
-- recipient's best hour" the next time the operator opens it.
--
-- 2026 SOTA (Klaviyo Personalized Send Time, Braze Intelligent Timing,
-- Iterable STO, MoEngage Sherpa) all store the strategy alongside the
-- campaign and expose a tenant default, so the same campaign always
-- sends with the same strategy on re-runs.
--
-- Schema additions:
--   1. campaigns.send_time_strategy text — 'none' | 'modal_hour' |
--      'per_recipient'. Default 'none' so legacy rows behave
--      identically (no STO inflicted on existing campaigns).
--   2. tenant_send_settings — new 1:1 table for tenant-level send
--      defaults; default_sto_strategy is the first column but the
--      table is shaped to absorb future tenant-level send knobs
--      (newsletter_default_strategy, send_window defaults, …) without
--      another migration. Lazily inserted by the settings handler.

BEGIN;

-- 1) Per-campaign persisted strategy. CHECK constraint pins the
-- vocabulary so unknown values (drift from older clients) cannot
-- silently land in the column.
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS send_time_strategy text NOT NULL DEFAULT 'none';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'campaigns_send_time_strategy_chk'
    ) THEN
        ALTER TABLE campaigns
            ADD CONSTRAINT campaigns_send_time_strategy_chk
            CHECK (send_time_strategy IN ('none', 'modal_hour', 'per_recipient'));
    END IF;
END$$;

-- Index covers the campaign detail / list filter "show me campaigns
-- using per_recipient STO" — small partial index, only the non-default
-- rows occupy space.
CREATE INDEX IF NOT EXISTS campaigns_send_time_strategy_idx
    ON campaigns (tenant_id, send_time_strategy)
    WHERE send_time_strategy <> 'none';

-- 2) Tenant-level send defaults. Standalone table (rather than
-- piggy-backing on tenant_security_settings or workspace_settings)
-- because the operator-facing send surface owns it: it'll grow to
-- carry default warmup posture, newsletter_default_strategy,
-- default_send_window, etc.
CREATE TABLE IF NOT EXISTS tenant_send_settings (
    tenant_id              uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    default_sto_strategy   text NOT NULL DEFAULT 'none',
    -- 'always_use_per_recipient_for_newsletters' rule from the audit
    -- sketch — when true, the API auto-flips send_time_strategy to
    -- 'per_recipient' for any campaign whose campaign_type is
    -- 'newsletter' (or undefined) at create / schedule time.
    newsletters_force_per_recipient boolean NOT NULL DEFAULT false,
    updated_at             timestamptz NOT NULL DEFAULT now(),
    updated_by             uuid REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT tenant_send_settings_default_sto_chk
        CHECK (default_sto_strategy IN ('none', 'modal_hour', 'per_recipient'))
);

GRANT SELECT, INSERT, UPDATE ON tenant_send_settings TO postwave_app;

ALTER TABLE tenant_send_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_send_settings FORCE  ROW LEVEL SECURITY;

-- Same RLS idiom used across the codebase: NULLIF guards against an
-- unset app.tenant_id GUC (raw ::uuid cast crashes on '').
CREATE POLICY tenant_isolation ON tenant_send_settings
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON tenant_send_settings
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
