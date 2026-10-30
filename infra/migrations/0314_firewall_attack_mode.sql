-- 0297_firewall_attack_mode.sql
--
-- archive-firewall-attack-mode (P3, surface=archive)
--
-- Buttondown's "attack mode" is a tenant-scoped firewall that auto-tightens
-- signup acceptance thresholds when a spam surge is detected on the public
-- form endpoint. The defense is in three parts:
--
--   1. SCORING — every public signup attempt gets a 0-100 risk score
--      computed from four signals:
--        * browser_fp_present  — did the embedded form post a fingerprint
--          token? (iframe-based mass-signup bots can't produce one because
--          the cross-origin iframe doesn't have access to the host's
--          fingerprinting JS.)
--        * ua_quality          — does the User-Agent look like a real browser
--          (Mozilla/* with a plausible version)?
--        * referer_quality     — is there a Referer header? does it match
--          the form's allowed origins?
--        * rate                — how many signup attempts has this IP made
--          in the last 5 minutes?
--      The four signals are persisted on every attempt so an operator can
--      audit what tripped attack mode.
--
--   2. ATTACK MODE — when the per-tenant `attack_mode_enabled` flag is
--      true, signups below `attack_mode_threshold` (default 50) are
--      REJECTED instead of accepted. Without attack mode, the score is
--      logged but the signup proceeds (observation-only).
--
--   3. AUTO-DETECT — when `auto_attack_mode` is true, a background sweep
--      compares the last hour's signup count against the rolling 7-day
--      baseline. A surge (>= 5x baseline AND >= 50 attempts/hour) flips
--      `attack_mode_enabled` ON and stamps `attack_mode_auto_enabled_at`.
--      Operators can manually disable; the auto-detector won't re-enable
--      until `attack_mode_auto_cooldown_until` passes.
--
-- Inspired by 2026 SOTA: Buttondown (attack mode + opt-in browser
-- fingerprinting), Substack (iframe form anti-bot), Klaviyo (signup
-- form risk scoring).
--
-- All three tables follow the canonical NULLIF GUC RLS idiom from 0079.

BEGIN;

-- 1. Per-tenant firewall settings. One row per tenant; created lazily by
--    the GET handler so we don't have to backfill the table on rollout.
CREATE TABLE IF NOT EXISTS firewall_settings (
    tenant_id                       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    -- Master switch. When false the scorer still runs (so we have data
    -- to detect surges with) but no signup is rejected.
    attack_mode_enabled             boolean      NOT NULL DEFAULT false,
    -- Auto-detect toggle. When true the background worker may flip
    -- attack_mode_enabled ON during a detected surge.
    auto_attack_mode                boolean      NOT NULL DEFAULT true,
    -- Browser-fingerprint requirement. Opt-in (default false) because
    -- embedding a fingerprint script changes the integration story
    -- with sites running CSP'd iframes — we don't force it on.
    -- When true, any signup with browser_fp_present=false is penalized
    -- with a large risk-score addend.
    fingerprint_required            boolean      NOT NULL DEFAULT false,
    -- Score cutoff: signups with risk_score >= threshold are rejected
    -- when attack_mode_enabled is true.
    attack_mode_threshold           int          NOT NULL DEFAULT 50,
    -- Auto-detect: a surge is N x baseline. Operators can tune.
    surge_multiplier                int          NOT NULL DEFAULT 5,
    -- Auto-detect: minimum absolute attempts/hour to count as a surge.
    -- Without this the relative multiplier triggers on tiny lists
    -- (3 signups vs 0.5 baseline = 6x — meaningless).
    surge_min_per_hour              int          NOT NULL DEFAULT 50,
    -- When the auto-detector last flipped attack_mode_enabled on.
    attack_mode_auto_enabled_at     timestamptz,
    -- Auto-detector cooldown — don't re-flip while this is in the future.
    -- Set when an operator manually flips attack_mode_enabled OFF.
    attack_mode_auto_cooldown_until timestamptz,
    updated_at                      timestamptz  NOT NULL DEFAULT now(),
    -- Field-level bounds so a malformed PUT can't poison the scorer.
    CONSTRAINT firewall_threshold_range
        CHECK (attack_mode_threshold BETWEEN 0 AND 100),
    CONSTRAINT firewall_surge_multiplier_range
        CHECK (surge_multiplier BETWEEN 2 AND 100),
    CONSTRAINT firewall_surge_min_per_hour_range
        CHECK (surge_min_per_hour BETWEEN 1 AND 100000)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON firewall_settings TO postwave_app;

ALTER TABLE firewall_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE firewall_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON firewall_settings
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON firewall_settings
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2. Per-signup audit + analytics. Append-only; the surge detector reads
--    this to compute counts. We keep ~30 days of history (a separate
--    retention sweep prunes anything older).
CREATE TABLE IF NOT EXISTS firewall_signup_events (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Nullable: a signup that hit a non-existent slug still records on
    -- the platform-level row so we can monitor probing.
    form_id             uuid REFERENCES forms(id) ON DELETE SET NULL,
    -- Inputs to the score, persisted so an operator can audit what
    -- tripped a rejection.
    browser_fp_present  boolean      NOT NULL DEFAULT false,
    ua_quality          smallint     NOT NULL DEFAULT 0,  -- 0..100
    referer_quality     smallint     NOT NULL DEFAULT 0,  -- 0..100
    rate_5m             int          NOT NULL DEFAULT 0,  -- IP attempts in last 5m
    risk_score          smallint     NOT NULL DEFAULT 0,  -- 0..100
    -- Action taken given the score + tenant settings.
    -- 'accepted' | 'rejected' | 'observed' (scored but attack mode off)
    action              text         NOT NULL DEFAULT 'observed',
    -- IP is INET so we get native indexing + cidr-aware queries.
    ip                  inet,
    user_agent          text,
    -- The email attempted (we record it so an operator can correlate
    -- with their list — it's the same data we already store on
    -- form_submissions, so no new disclosure surface).
    email               text,
    at                  timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT firewall_signup_score_range CHECK (risk_score BETWEEN 0 AND 100),
    CONSTRAINT firewall_signup_action CHECK (action IN ('accepted', 'rejected', 'observed'))
);

-- Surge-detector scans (tenant_id, at DESC); operator audit pages drill
-- by (tenant_id, at DESC) too.
CREATE INDEX IF NOT EXISTS firewall_signup_events_tenant_at_idx
    ON firewall_signup_events (tenant_id, at DESC);

-- IP-rate lookup: how many recent attempts from this IP? Partial index
-- to keep the small/recent slice hot.
CREATE INDEX IF NOT EXISTS firewall_signup_events_ip_at_idx
    ON firewall_signup_events (tenant_id, ip, at DESC)
    WHERE ip IS NOT NULL;

GRANT SELECT, INSERT, DELETE ON firewall_signup_events TO postwave_app;

ALTER TABLE firewall_signup_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE firewall_signup_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON firewall_signup_events
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON firewall_signup_events
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The public form submit handler runs without an app.tenant_id GUC; it
-- binds app.public_form_tenant_id instead (see forms/repo.go
-- InsertSubmission). Allow inserts where the firewall row's tenant_id
-- matches that public GUC, so the public path can append events too.
CREATE POLICY public_form_insert ON firewall_signup_events
    AS PERMISSIVE FOR INSERT
    TO postwave_app
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.public_form_tenant_id', true), '')::uuid
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

COMMIT;
