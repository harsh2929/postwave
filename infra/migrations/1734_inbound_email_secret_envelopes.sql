-- 1734_inbound_email_secret_envelopes.sql
--
-- Inbound-email endpoint signing secrets were historically stored as
-- plaintext in inbound_email_endpoints.secret and returned by every admin
-- GET. Treat every legacy value as compromised: destroy it during migration
-- and require an explicit rotation before the public receiver can ingest.
-- New values exist only as platform envelope ciphertext and are revealed once
-- by the rotate/create response.

BEGIN;

ALTER TABLE public.inbound_email_endpoints
    ADD COLUMN IF NOT EXISTS secret_envelope bytea,
    ADD COLUMN IF NOT EXISTS secret_rotated_at timestamptz;

-- Destructive by design. We cannot safely wrap legacy plaintext in SQL because
-- the platform envelope cipher/KMS boundary lives in the API. Keeping a
-- plaintext compatibility path would preserve the original breach impact.
UPDATE public.inbound_email_endpoints
SET secret = 'rotation-required',
    secret_envelope = NULL,
    secret_rotated_at = NULL;

ALTER TABLE public.inbound_email_endpoints
    ALTER COLUMN secret SET DEFAULT 'rotation-required';

ALTER TABLE public.inbound_email_endpoints
    ADD CONSTRAINT inbound_email_endpoints_no_plaintext_secret_chk
    CHECK (secret = 'rotation-required') NOT VALID;

ALTER TABLE public.inbound_email_endpoints
    ADD CONSTRAINT inbound_email_endpoints_envelope_state_chk
    CHECK (
        (secret_envelope IS NULL AND secret_rotated_at IS NULL)
        OR
        (octet_length(secret_envelope) > 0 AND secret_rotated_at IS NOT NULL)
    ) NOT VALID;

ALTER TABLE public.inbound_email_endpoints
    VALIDATE CONSTRAINT inbound_email_endpoints_no_plaintext_secret_chk;

ALTER TABLE public.inbound_email_endpoints
    VALIDATE CONSTRAINT inbound_email_endpoints_envelope_state_chk;

COMMENT ON COLUMN public.inbound_email_endpoints.secret IS
    'Non-secret compatibility sentinel. Must always equal rotation-required; plaintext signing secrets are forbidden.';
COMMENT ON COLUMN public.inbound_email_endpoints.secret_envelope IS
    'Platform envelope ciphertext for the inbound-email HMAC key. NULL means rotation is required.';
COMMENT ON COLUMN public.inbound_email_endpoints.secret_rotated_at IS
    'Time the current envelope-encrypted signing secret was created or rotated.';

-- Return only ciphertext to the application receive path. Lock the definer
-- search path and schema-qualify the relation so caller-controlled objects can
-- never shadow it. The function intentionally returns rows with NULL envelope
-- values; the API maps those to signing_unavailable and fails closed.
DROP FUNCTION public.inbound_email_endpoint_lookup(text);

CREATE FUNCTION public.inbound_email_endpoint_lookup(p_slug text)
RETURNS TABLE (id uuid, tenant_id uuid, secret_envelope bytea)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
    SELECT endpoint.id, endpoint.tenant_id, endpoint.secret_envelope
    FROM public.inbound_email_endpoints AS endpoint
    WHERE endpoint.slug = p_slug;
$$;

REVOKE ALL ON FUNCTION public.inbound_email_endpoint_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inbound_email_endpoint_lookup(text) TO postwave_app;

COMMIT;
