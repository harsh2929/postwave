-- 0561_pii_token_mappings.sql
--
-- SUB-072 — AI gateway / privacy firewall for prompts (token reversal store).
--
-- Why this migration:
--   When the sanitizer tokenizes a sensitive value before an LLM call it must
--   keep a token->value reversal so the model's response can be detokenized
--   back to the real value. Within a single request the reversal lives in an
--   in-memory token registry, but a two-phase flow — tokenize the prompt now,
--   detokenize an *async* completion later (a different process, e.g. a queued
--   campaign-generation worker) — needs a durable, short-lived store.
--
--   This table is that ephemeral store. Each row maps a tenant-scoped opaque
--   token to its cleartext value with an expires_at TTL; a purge job (or the
--   PurgeExpired repo method) deletes rows past TTL so cleartext PII never
--   lingers. The token is the lookup key, never a stable identifier — it is
--   request-local and single-use in practice.
--
--   Storing cleartext PII is unavoidable for reversal, so the table is tightly
--   RLS-scoped, TTL-purged, and granted only to postwave_app. The expires_at
--   default (30 minutes) bounds the exposure window for an abandoned flow.
--
-- rollback-strategy: additive. Hard rollback = DROP TABLE pii_token_mappings.

BEGIN;

CREATE TABLE IF NOT EXISTS pii_token_mappings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- The opaque placeholder the sanitizer substituted into the prompt
    -- (e.g. "[[PII:EMAIL:7f3a]]"). Lookup key for detokenization.
    token           text NOT NULL,
    -- The cleartext value the token stands in for. Reversed on response.
    value           text NOT NULL,
    -- Optional kind label (email / phone / custom field name) for diagnostics.
    field_kind      text NOT NULL DEFAULT '',
    -- TTL: rows past this are eligible for purge and treated as absent.
    expires_at      timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- One mapping per (tenant, token); re-tokenizing the same value yields a
    -- fresh token (collisions are not merged here on purpose — tokens are
    -- request-local).
    UNIQUE (tenant_id, token)
);

COMMENT ON TABLE pii_token_mappings IS
    'SUB-072 ephemeral PII gateway token->value reversals for async detokenization. TTL-purged; never long-lived.';

-- Lookup by token within tenant — the detokenize read shape.
CREATE INDEX IF NOT EXISTS pii_token_mappings_token_idx
    ON pii_token_mappings (tenant_id, token);

-- Purge sweep: "everything past TTL".
CREATE INDEX IF NOT EXISTS pii_token_mappings_expiry_idx
    ON pii_token_mappings (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON pii_token_mappings TO postwave_app;

ALTER TABLE pii_token_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii_token_mappings FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON pii_token_mappings
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_visible ON pii_token_mappings
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
