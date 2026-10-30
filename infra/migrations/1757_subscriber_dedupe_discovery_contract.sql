-- Server-complete subscriber duplicate discovery.
-- migration-execution: phased
--
-- The historical detector sampled the oldest 2,000 rows for fuzzy rules and
-- silently swallowed individual query failures. That made an empty response
-- impossible to interpret as a complete workspace scan. This migration adds
-- a privacy-minimised, transactionally maintained key projection plus
-- short-lived materialised scan manifests. Canonical identifiers are stored
-- only as tenant-scoped SHA-256 digests, preventing cross-workspace hash
-- correlation; raw email, phone and external identifiers remain in subscribers
-- and never enter the scan tables.
--
-- Rollout is expand-only: the trigger is installed before the backfill so
-- concurrent subscriber writes cannot be missed. Indexes are built
-- concurrently on the new projection table, and the final INSERT is
-- idempotent/resumable.
-- rollback-strategy: no-op - old code ignores these additive tables; remove the trigger only after all new readers are rolled back.

BEGIN;

CREATE OR REPLACE FUNCTION subscriber_dedupe_digest(p_tenant_id uuid, p_value text)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT digest(convert_to(p_tenant_id::text || ':' || p_value, 'UTF8'), 'sha256');
$$;

CREATE OR REPLACE FUNCTION subscriber_dedupe_plus_canonical(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT regexp_replace(lower(btrim(p_email)), '\+[^@]*@', '@');
$$;

CREATE OR REPLACE FUNCTION subscriber_dedupe_domain_canonical(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT split_part(lower(btrim(p_email)), '@', 1) || '@' ||
           CASE split_part(lower(btrim(p_email)), '@', 2)
               WHEN 'googlemail.com' THEN 'gmail.com'
               ELSE split_part(lower(btrim(p_email)), '@', 2)
           END;
$$;

CREATE OR REPLACE FUNCTION subscriber_dedupe_dot_canonical(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN split_part(lower(btrim(p_email)), '@', 2) IN ('gmail.com', 'googlemail.com')
        THEN replace(split_part(lower(btrim(p_email)), '@', 1), '.', '') ||
             '@' || CASE split_part(lower(btrim(p_email)), '@', 2)
                       WHEN 'googlemail.com' THEN 'gmail.com'
                       ELSE 'gmail.com'
                     END
        ELSE lower(btrim(p_email))
    END;
$$;

CREATE OR REPLACE FUNCTION subscriber_dedupe_homoglyph_canonical(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT translate(
        lower(btrim(p_email)),
        'аеорсхукоαιν01',
        'aeopcxykoaivol'
    );
$$;

CREATE TABLE IF NOT EXISTS subscriber_dedupe_keys (
    tenant_id          uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscriber_id      uuid        NOT NULL,
    subscriber_created_at timestamptz NOT NULL,
    subscriber_updated_at timestamptz NOT NULL,
    email_key          bytea       NOT NULL,
    plus_key           bytea       NOT NULL,
    dot_key            bytea       NOT NULL,
    domain_key         bytea       NOT NULL,
    homoglyph_key      bytea       NOT NULL,
    phone_key          bytea,
    external_id_key    bytea,
    plus_changed       boolean     NOT NULL,
    dot_changed        boolean     NOT NULL,
    domain_changed     boolean     NOT NULL,
    homoglyph_changed  boolean     NOT NULL,
    PRIMARY KEY (tenant_id, subscriber_id),
    CONSTRAINT subscriber_dedupe_keys_subscriber_fk
        FOREIGN KEY (tenant_id, subscriber_id)
        REFERENCES subscribers (tenant_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE subscriber_dedupe_keys IS
    'RLS-protected tenant-scoped SHA-256 projections used for exhaustive deterministic subscriber duplicate scans; contains no raw identifiers.';

CREATE TABLE IF NOT EXISTS subscriber_duplicate_scans (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    status              text        NOT NULL DEFAULT 'running',
    subscriber_count    bigint      NOT NULL DEFAULT 0,
    candidate_count     bigint      NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    completed_at        timestamptz,
    expires_at          timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
    UNIQUE (tenant_id, id),
    CONSTRAINT subscriber_duplicate_scans_status_check
        CHECK (status IN ('running', 'complete', 'failed'))
);

CREATE TABLE IF NOT EXISTS subscriber_duplicate_scan_pairs (
    tenant_id            uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    scan_id              uuid        NOT NULL,
    ordinal              bigint      NOT NULL,
    primary_id           uuid        NOT NULL,
    duplicate_id         uuid        NOT NULL,
    primary_updated_at   timestamptz NOT NULL,
    duplicate_updated_at timestamptz NOT NULL,
    confidence           numeric(4,3) NOT NULL,
    evidence             jsonb       NOT NULL,
    PRIMARY KEY (tenant_id, scan_id, ordinal),
    UNIQUE (tenant_id, scan_id, primary_id, duplicate_id),
    CONSTRAINT subscriber_duplicate_scan_pairs_scan_fk
        FOREIGN KEY (tenant_id, scan_id)
        REFERENCES subscriber_duplicate_scans (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT subscriber_duplicate_scan_pairs_distinct_check
        CHECK (primary_id <> duplicate_id),
    CONSTRAINT subscriber_duplicate_scan_pairs_confidence_check
        CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT subscriber_duplicate_scan_pairs_evidence_check
        CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) > 0)
);

CREATE OR REPLACE FUNCTION sync_subscriber_dedupe_keys()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    normalized_email text := lower(btrim(NEW.email::text));
    plus_canonical text := subscriber_dedupe_plus_canonical(NEW.email::text);
    dot_canonical text := subscriber_dedupe_dot_canonical(NEW.email::text);
    domain_canonical text := subscriber_dedupe_domain_canonical(NEW.email::text);
    homoglyph_canonical text := subscriber_dedupe_homoglyph_canonical(NEW.email::text);
BEGIN
    INSERT INTO subscriber_dedupe_keys (
        tenant_id, subscriber_id, subscriber_created_at, subscriber_updated_at,
        email_key, plus_key, dot_key, domain_key, homoglyph_key,
        phone_key, external_id_key, plus_changed, dot_changed,
        domain_changed, homoglyph_changed
    ) VALUES (
        NEW.tenant_id, NEW.id, NEW.created_at, NEW.updated_at,
        subscriber_dedupe_digest(NEW.tenant_id, normalized_email),
        subscriber_dedupe_digest(NEW.tenant_id, plus_canonical),
        subscriber_dedupe_digest(NEW.tenant_id, dot_canonical),
        subscriber_dedupe_digest(NEW.tenant_id, domain_canonical),
        subscriber_dedupe_digest(NEW.tenant_id, homoglyph_canonical),
        CASE WHEN NULLIF(btrim(NEW.phone_e164), '') IS NULL THEN NULL
             ELSE subscriber_dedupe_digest(NEW.tenant_id, btrim(NEW.phone_e164)) END,
        CASE WHEN NULLIF(btrim(NEW.external_id), '') IS NULL THEN NULL
             ELSE subscriber_dedupe_digest(NEW.tenant_id, btrim(NEW.external_id)) END,
        plus_canonical <> normalized_email,
        split_part(normalized_email, '@', 2) IN ('gmail.com', 'googlemail.com')
            AND replace(split_part(normalized_email, '@', 1), '.', '') <>
                split_part(normalized_email, '@', 1),
        domain_canonical <> normalized_email,
        homoglyph_canonical <> normalized_email
    )
    ON CONFLICT (tenant_id, subscriber_id) DO UPDATE SET
        subscriber_created_at = EXCLUDED.subscriber_created_at,
        subscriber_updated_at = EXCLUDED.subscriber_updated_at,
        email_key = EXCLUDED.email_key,
        plus_key = EXCLUDED.plus_key,
        dot_key = EXCLUDED.dot_key,
        domain_key = EXCLUDED.domain_key,
        homoglyph_key = EXCLUDED.homoglyph_key,
        phone_key = EXCLUDED.phone_key,
        external_id_key = EXCLUDED.external_id_key,
        plus_changed = EXCLUDED.plus_changed,
        dot_changed = EXCLUDED.dot_changed,
        domain_changed = EXCLUDED.domain_changed,
        homoglyph_changed = EXCLUDED.homoglyph_changed;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscribers_sync_dedupe_keys ON subscribers;
CREATE TRIGGER subscribers_sync_dedupe_keys
AFTER INSERT OR UPDATE
ON subscribers
FOR EACH ROW EXECUTE FUNCTION sync_subscriber_dedupe_keys();

GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_dedupe_keys TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_duplicate_scans TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON subscriber_duplicate_scan_pairs TO postwave_app;

ALTER TABLE subscriber_dedupe_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_dedupe_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriber_duplicate_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_duplicate_scans FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriber_duplicate_scan_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_duplicate_scan_pairs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON subscriber_dedupe_keys;
CREATE POLICY tenant_isolation ON subscriber_dedupe_keys
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_visible ON subscriber_dedupe_keys;
CREATE POLICY tenant_visible ON subscriber_dedupe_keys
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON subscriber_duplicate_scans;
CREATE POLICY tenant_isolation ON subscriber_duplicate_scans
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_visible ON subscriber_duplicate_scans;
CREATE POLICY tenant_visible ON subscriber_duplicate_scans
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON subscriber_duplicate_scan_pairs;
CREATE POLICY tenant_isolation ON subscriber_duplicate_scan_pairs
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_visible ON subscriber_duplicate_scan_pairs;
CREATE POLICY tenant_visible ON subscriber_duplicate_scan_pairs
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_dedupe_keys_email_idx
    ON subscriber_dedupe_keys (tenant_id, email_key, subscriber_created_at, subscriber_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_dedupe_keys_plus_idx
    ON subscriber_dedupe_keys (tenant_id, plus_key, subscriber_created_at, subscriber_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_dedupe_keys_dot_idx
    ON subscriber_dedupe_keys (tenant_id, dot_key, subscriber_created_at, subscriber_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_dedupe_keys_domain_idx
    ON subscriber_dedupe_keys (tenant_id, domain_key, subscriber_created_at, subscriber_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_dedupe_keys_homoglyph_idx
    ON subscriber_dedupe_keys (tenant_id, homoglyph_key, subscriber_created_at, subscriber_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_dedupe_keys_phone_idx
    ON subscriber_dedupe_keys (tenant_id, phone_key, subscriber_created_at, subscriber_id)
    WHERE phone_key IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_dedupe_keys_external_idx
    ON subscriber_dedupe_keys (tenant_id, external_id_key, subscriber_created_at, subscriber_id)
    WHERE external_id_key IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_duplicate_scans_expiry_idx
    ON subscriber_duplicate_scans (tenant_id, expires_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriber_duplicate_scan_pairs_page_idx
    ON subscriber_duplicate_scan_pairs (tenant_id, scan_id, ordinal);

INSERT INTO subscriber_dedupe_keys (
    tenant_id, subscriber_id, subscriber_created_at, subscriber_updated_at,
    email_key, plus_key, dot_key, domain_key, homoglyph_key,
    phone_key, external_id_key, plus_changed, dot_changed,
    domain_changed, homoglyph_changed
)
SELECT s.tenant_id, s.id, s.created_at, s.updated_at,
       subscriber_dedupe_digest(s.tenant_id, lower(btrim(s.email::text))),
       subscriber_dedupe_digest(s.tenant_id, subscriber_dedupe_plus_canonical(s.email::text)),
       subscriber_dedupe_digest(s.tenant_id, subscriber_dedupe_dot_canonical(s.email::text)),
       subscriber_dedupe_digest(s.tenant_id, subscriber_dedupe_domain_canonical(s.email::text)),
       subscriber_dedupe_digest(s.tenant_id, subscriber_dedupe_homoglyph_canonical(s.email::text)),
       CASE WHEN NULLIF(btrim(s.phone_e164), '') IS NULL THEN NULL
            ELSE subscriber_dedupe_digest(s.tenant_id, btrim(s.phone_e164)) END,
       CASE WHEN NULLIF(btrim(s.external_id), '') IS NULL THEN NULL
            ELSE subscriber_dedupe_digest(s.tenant_id, btrim(s.external_id)) END,
       subscriber_dedupe_plus_canonical(s.email::text) <> lower(btrim(s.email::text)),
       split_part(lower(btrim(s.email::text)), '@', 2) IN ('gmail.com', 'googlemail.com')
           AND replace(split_part(lower(btrim(s.email::text)), '@', 1), '.', '') <>
               split_part(lower(btrim(s.email::text)), '@', 1),
       subscriber_dedupe_domain_canonical(s.email::text) <> lower(btrim(s.email::text)),
       subscriber_dedupe_homoglyph_canonical(s.email::text) <> lower(btrim(s.email::text))
  FROM subscribers s
ON CONFLICT (tenant_id, subscriber_id) DO UPDATE SET
    subscriber_created_at = EXCLUDED.subscriber_created_at,
    subscriber_updated_at = EXCLUDED.subscriber_updated_at,
    email_key = EXCLUDED.email_key,
    plus_key = EXCLUDED.plus_key,
    dot_key = EXCLUDED.dot_key,
    domain_key = EXCLUDED.domain_key,
    homoglyph_key = EXCLUDED.homoglyph_key,
    phone_key = EXCLUDED.phone_key,
    external_id_key = EXCLUDED.external_id_key,
    plus_changed = EXCLUDED.plus_changed,
    dot_changed = EXCLUDED.dot_changed,
    domain_changed = EXCLUDED.domain_changed,
    homoglyph_changed = EXCLUDED.homoglyph_changed;
