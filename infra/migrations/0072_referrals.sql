-- 0039_referrals.sql
--
-- Referral / share-to-grow widget. Three tables, all tenant-scoped via the
-- usual restrictive RLS policy:
--
--   referral_programs     — at most one active row per tenant; milestones
--                            (count + reward label) live in jsonb.
--   referral_codes        — one row per subscriber that has ever been issued
--                            a share code. Codes are short, URL-safe, and
--                            globally unique to keep public lookups O(1).
--   referral_conversions  — append-only ledger of (referrer, referee) pairs
--                            written when a referee finishes a signup form.

BEGIN;

CREATE TABLE referral_programs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    milestones   jsonb NOT NULL DEFAULT '[]'::jsonb,
    active       boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX referral_programs_tenant_active_uniq
    ON referral_programs (tenant_id) WHERE active = true;

GRANT SELECT, INSERT, UPDATE, DELETE ON referral_programs TO postwave_app;

ALTER TABLE referral_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_programs FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON referral_programs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TABLE referral_codes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id   text NOT NULL,
    code            text NOT NULL UNIQUE,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX referral_codes_subscriber_uniq
    ON referral_codes (tenant_id, subscriber_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON referral_codes TO postwave_app;

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_codes FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON referral_codes
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Public lookup of a code -> tenant_id is needed by the GET /api/public/r/{code}
-- redirect path. The token itself is the credential.
CREATE POLICY referral_codes_public_lookup ON referral_codes
    AS PERMISSIVE FOR SELECT
    USING (true);

CREATE TABLE referral_conversions (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    referrer_subscriber_id   text NOT NULL,
    referee_subscriber_id    text NOT NULL,
    created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX referral_conversions_referrer_idx
    ON referral_conversions (tenant_id, referrer_subscriber_id);

CREATE UNIQUE INDEX referral_conversions_pair_uniq
    ON referral_conversions (tenant_id, referrer_subscriber_id, referee_subscriber_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON referral_conversions TO postwave_app;

ALTER TABLE referral_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_conversions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON referral_conversions
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMIT;
