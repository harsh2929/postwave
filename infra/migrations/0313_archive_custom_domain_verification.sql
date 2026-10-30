-- 0297_archive_custom_domain_verification.sql
--
-- archive-custom-domain-honor (P1) — vanity-host serving for the public
-- campaign archive.
--
-- The `archive_domain` column has existed since migration 0071 (added
-- alongside `tenant_archive_slug`), but it was never actually honoured at
-- request-resolution time: the public archive handler resolved tenants
-- via `tenant_archive_slug` only, so a CNAME'd vanity host either 404'd
-- (no path on the host matched) or rendered the wrong tenant if it
-- happened to share a slug.
--
-- This migration:
--   1. Adds a partial UNIQUE index on `archive_domain` so two tenants
--      cannot claim the same vanity host. The previous column was
--      ungated, which would have silently let one tenant steal another's
--      DNS once Host-header lookup was wired up.
--   2. Creates `tenant_archive_domain_verifications` — one row per
--      (tenant_id, archive_domain). Holds the CNAME-verification token
--      the operator pastes into their DNS record, the timestamps the
--      verifier writes, and the most-recent failure reason so the UI
--      can render an actionable status panel ("DNS not propagated yet",
--      "CNAME points at wrong target", "ok — verified 5m ago").
--   3. Adds the standard tenant-RLS scaffolding so the verification
--      table follows the same isolation contract as every other
--      per-tenant table.
--
-- Compare-to (2026 SOTA): Substack ($50/mo "Custom domain"), beehiiv
-- (free on any paid plan), Ghost (free), Buttondown (free). Every one
-- of those exposes a CNAME target + verification flow + auto-issued
-- SSL via Caddy/Let's Encrypt. This migration is the schema half of
-- catching up; SSL issuance is wired in the API layer (see
-- archive/custom_domain.go).

BEGIN;

-- (1) Partial UNIQUE index on archive_domain. Mirrors the pattern used
-- for `campaigns_tenant_archive_slug_uniq` in 0071 — only enforce
-- uniqueness on non-NULL values so the default "no custom domain
-- configured" state stays unconstrained across tenants.
--
-- citext gives us case-insensitive matching at index time so a tenant
-- typing "Archive.Example.COM" matches the same host that Cloudflare
-- normalises to lowercase in the inbound Host header.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_public_settings_archive_domain_uniq
    ON tenant_public_settings (archive_domain)
    WHERE archive_domain IS NOT NULL;

-- (2) Verification table. One active row per (tenant_id, archive_domain)
-- — the UNIQUE constraint on archive_domain mirrors the index above so a
-- second tenant configuring the same host immediately collides at insert
-- time (the route handler maps 23505 to a structured `domain_taken`
-- response, mirroring how `tenant_archive_slug` collisions surface).
--
-- Status enum:
--   - 'pending'  — operator saved a domain but has not run verify yet.
--   - 'verified' — last CNAME check succeeded.
--   - 'failed'   — last CNAME check failed; `last_error` carries why.
--
-- Verification tokens are random 32-byte hex; we ALSO accept the CNAME
-- itself as a sufficient verification signal (target host = our
-- canonical custom-domain endpoint) so operators do not need to add a
-- second TXT record. The token column exists for the rare case where a
-- tenant's DNS provider only supports TXT verification (e.g.
-- transferring an existing apex domain that already has a CNAME flat
-- record).
CREATE TABLE IF NOT EXISTS tenant_archive_domain_verifications (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    archive_domain      citext NOT NULL UNIQUE,
    status              text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'verified', 'failed')),
    verification_token  text NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
    cname_target        text NOT NULL DEFAULT 'custom-domains.postwave.com',
    last_checked_at     timestamptz,
    verified_at         timestamptz,
    last_error          text,
    -- ssl_status tracks the managed-SSL issuance we kick off once the
    -- CNAME is verified. Postwave's edge (Caddy in front of the API
    -- service) auto-issues a Let's Encrypt cert on first HTTPS request
    -- to a verified domain; the API records `issued` once the cert
    -- shows up in the cert cache. Operators can monitor the column
    -- without polling the edge directly.
    ssl_status          text NOT NULL DEFAULT 'pending'
                          CHECK (ssl_status IN ('pending', 'issuing', 'issued', 'failed')),
    ssl_last_error      text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_archive_domain_verifications_tenant_idx
    ON tenant_archive_domain_verifications (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_archive_domain_verifications TO postwave_app;

ALTER TABLE tenant_archive_domain_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_archive_domain_verifications FORCE  ROW LEVEL SECURITY;

-- Standard tenant-RLS idiom — NULLIF guards against the unset-GUC crash
-- the raw cast would produce when the public Host-header resolver runs
-- without app.tenant_id set.
CREATE POLICY tenant_isolation ON tenant_archive_domain_verifications
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Public-lookup policy: the host-header resolver runs WITHOUT a tenant
-- context (it is the resolver itself), so it needs to SELECT this table
-- to map archive_domain → tenant_id BEFORE app.tenant_id is set. Gated
-- by `status = 'verified'` so unverified domains never resolve — the
-- worst case is an attacker pointing their CNAME at our edge and
-- claiming the host before the rightful owner; the verification step
-- closes that race because the token check requires control of the DNS
-- record.
CREATE POLICY tenant_archive_domain_public_lookup ON tenant_archive_domain_verifications
    AS PERMISSIVE FOR SELECT
    USING (status = 'verified');

COMMIT;
