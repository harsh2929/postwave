-- Signed, idempotent server-side conversion ingest (PRD F03).
--
-- The existing ingest endpoint authenticates with a `pwk_…` site key, which the
-- generated OpenAPI describes verbatim as PUBLISHABLE: it is shipped in browser
-- JavaScript and is a tenant ROUTER, not a credential. Anyone who has ever
-- viewed a customer's page source can post conversions as that customer —
-- inflating revenue, poisoning attribution, and (once holdout lift reads these
-- rows) fabricating the incrementality number the customer reports upward.
--
-- Server-to-server ingest therefore needs a real secret, and the PRD asks for
-- HMAC-SHA256 over the raw body. That is a different credential with a different
-- lifecycle from the site key, so it gets its own table rather than a flag on
-- the existing one: conflating a publishable identifier with a signing secret in
-- one row is how one gets rotated and the other does not.
--
-- rollback-strategy: no-op

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE IF NOT EXISTS conversion_ingest_secrets (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- key_id travels in the signature header so a caller can rotate without a
    -- flag day: two secrets live at once and the header says which one signed.
    key_id       text NOT NULL,
    label        text NOT NULL DEFAULT '',
    -- Envelope-encrypted, NOT hashed.
    --
    -- Storing only a hash is the right instinct for a password and the wrong one
    -- for an HMAC key: verification recomputes the MAC, which needs the
    -- plaintext. A hash would make every signed request unverifiable. This
    -- follows inbound_webhook_endpoints exactly — secret_envelope in production,
    -- the legacy `secret` column as a dev/test fallback when no KEK is
    -- configured, and a sentinel in `secret` when the envelope is authoritative.
    secret          text NOT NULL,
    secret_envelope bytea,
    created_at   timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS conversion_ingest_secrets_key_uniq
    ON conversion_ingest_secrets (tenant_id, key_id);

-- Live-secret lookup by key_id, which is the hot path on every signed request.
CREATE INDEX IF NOT EXISTS conversion_ingest_secrets_live_idx
    ON conversion_ingest_secrets (key_id)
    WHERE revoked_at IS NULL;

ALTER TABLE conversion_ingest_secrets ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'conversion_ingest_secrets'
           AND policyname = 'tenant_isolation'
    ) THEN
        CREATE POLICY tenant_isolation ON conversion_ingest_secrets
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    END IF;
END
$$;

-- Idempotency with STORED RESPONSE REPLAY.
--
-- The PRD requires a duplicate Idempotency-Key to return "the original result,
-- never double-counts". Storing only a marker would satisfy the second half and
-- fail the first: the retry would get a different body from the original, and a
-- client reconciling ids would conclude the first call had failed. So the
-- response is stored and replayed verbatim.
--
-- request_digest exists to catch the dangerous case: the SAME key reused with a
-- DIFFERENT body. That is not a retry, it is either a client bug or an attempt
-- to have one authorised request stand in for another, and replaying the old
-- response would silently discard the new data. It gets a 409.
CREATE TABLE IF NOT EXISTS conversion_ingest_idempotency (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    idempotency_key text NOT NULL,
    request_digest  text NOT NULL,
    status_code     int  NOT NULL,
    response_body   jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL DEFAULT now() + interval '30 days'
);

CREATE UNIQUE INDEX IF NOT EXISTS conversion_ingest_idempotency_key_uniq
    ON conversion_ingest_idempotency (tenant_id, idempotency_key);

CREATE INDEX IF NOT EXISTS conversion_ingest_idempotency_expiry_idx
    ON conversion_ingest_idempotency (expires_at);

ALTER TABLE conversion_ingest_idempotency ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'conversion_ingest_idempotency'
           AND policyname = 'tenant_isolation'
    ) THEN
        CREATE POLICY tenant_isolation ON conversion_ingest_idempotency
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    END IF;
END
$$;

-- Hashed identity on the conversion itself.
--
-- The PRD is explicit: "Never accept plaintext email. Hash client-side or
-- reject." The existing column is a citext holding the address, so a signed
-- ingest that accepted a hash had nowhere to put it. Both columns coexist
-- because the browser path legitimately knows the address and the server path
-- deliberately does not.
ALTER TABLE conversions
    ADD COLUMN IF NOT EXISTS email_sha256 text,
    ADD COLUMN IF NOT EXISTS external_id text,
    ADD COLUMN IF NOT EXISTS click_id text;

-- Identity resolution order is click_id -> email_sha256 -> external_id, so each
-- needs to be findable.
CREATE INDEX IF NOT EXISTS conversions_email_sha256_idx
    ON conversions (tenant_id, email_sha256)
    WHERE email_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversions_external_id_idx
    ON conversions (tenant_id, external_id)
    WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversions_click_id_idx
    ON conversions (tenant_id, click_id)
    WHERE click_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON conversion_ingest_secrets TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON conversion_ingest_idempotency TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE conversion_ingest_idempotency_id_seq TO postwave_app;
