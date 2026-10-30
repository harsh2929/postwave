-- 0133_sending_identities.sql
--
-- Sending-domain identity table. Tracks DKIM + SPF + DMARC
-- verification state for each From-domain a tenant sends from.
--
-- Why a dedicated table rather than reusing custom_domains:
--
--   * custom_domains tracks the brand-side hosts (mail.acme.com for
--     tracking, links.acme.com for click rewriting). The sending
--     identity is the FROM address's domain — distinct lifecycle,
--     distinct DNS records, distinct verification cadence.
--
--   * Dispatcher needs a fast "is this from-domain ready to send?"
--     lookup; a partial index on verified_at IS NOT NULL keeps it
--     index-only.
--
--   * DMARC reports already correlate to a domain via the rua=
--     mailbox; this table is the join target.
--
-- The wizard's verify_state machine:
--
--   pending     no records detected yet
--   partial     some records detected; not all aligned
--   verified    DKIM + SPF + DMARC all detected and aligned
--   broken      previously verified but a recheck failed (record
--                  was removed or expired). Sending is still allowed
--                  but the dashboard surfaces a warning.

BEGIN;

CREATE TABLE IF NOT EXISTS sending_identities (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid NOT NULL,
    domain                  text NOT NULL,
    -- DKIM selector + the public key the wizard generated. The
    -- private key is kept in KMS / envelope-encrypted; we don't
    -- store it here.
    dkim_selector           text NOT NULL DEFAULT 'pw',
    dkim_public_key_b64     text NOT NULL,
    -- Tracked verification state per record.
    spf_record_value        text,
    spf_verified_at         timestamptz,
    dkim_verified_at        timestamptz,
    dmarc_record_value      text,
    dmarc_verified_at       timestamptz,
    -- Composite state (computed by the verifier; cached here for
    -- the dispatcher's index lookup).
    verify_state            text NOT NULL DEFAULT 'pending'
                                CHECK (verify_state IN ('pending','partial','verified','broken')),
    verified_at             timestamptz,
    last_verify_attempt_at  timestamptz,
    last_verify_error       text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_sending_identities_tenant
    ON sending_identities (tenant_id, verify_state);

-- Hot path: dispatcher pre-flight checks "is this domain ready?"
-- Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_sending_identities_verified
    ON sending_identities (tenant_id, domain)
    WHERE verify_state = 'verified';

GRANT SELECT, INSERT, UPDATE, DELETE ON sending_identities TO postwave_app;

ALTER TABLE sending_identities ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON sending_identities AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
