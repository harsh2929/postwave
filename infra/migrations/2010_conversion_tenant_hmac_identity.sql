-- Replace dictionary-attackable conversion email identity with a tenant/key-
-- scoped HMAC while retaining historical evidence as non-authoritative data.
--
-- The request signing secret is also the email-identity HMAC key. Its signed
-- keyid provides rotation/provenance without allowing a caller to select a
-- different tenant namespace in the body. The application accepts:
--
--   email_hmac_sha256 = hex(HMAC-SHA256(signing_secret,
--                                      lower(trim(email))))
--
-- `email_sha256` remains physically present for old facts and DSAR/history
-- reads, but current ingest rejects it and current lift finalization excludes
-- it from identity proof.
--
-- migration-execution: phased
-- rollback-strategy: no-op. Re-enabling unsalted identity would reopen the
-- dictionary-attack boundary; roll application code back only to a version
-- that leaves email identity unavailable.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE public.conversions
    ADD COLUMN IF NOT EXISTS email_hmac_sha256 text,
    ADD COLUMN IF NOT EXISTS email_hmac_key_id text;

ALTER TABLE public.conversions
    DROP CONSTRAINT IF EXISTS conversions_email_hmac_identity_shape;
ALTER TABLE public.conversions
    ADD CONSTRAINT conversions_email_hmac_identity_shape CHECK (
        (email_hmac_sha256 IS NULL AND email_hmac_key_id IS NULL)
        OR
        (
            email_hmac_sha256 ~ '^[0-9a-f]{64}$'
            AND email_hmac_key_id IS NOT NULL
            AND length(email_hmac_key_id) BETWEEN 1 AND 200
        )
    ) NOT VALID;

ALTER TABLE public.conversion_attribution_touches
    ADD COLUMN IF NOT EXISTS identity_key_id text;

-- The inline identity_kind check from migration 1960 has PostgreSQL's stable
-- generated name. Keep email_sha256 in the historical vocabulary so existing
-- receipts remain readable; application and lift readers refuse it as proof.
ALTER TABLE public.conversion_attribution_touches
    DROP CONSTRAINT IF EXISTS conversion_attribution_touches_identity_kind_check,
    DROP CONSTRAINT IF EXISTS conversion_attribution_touches_shape;
ALTER TABLE public.conversion_attribution_touches
    ADD CONSTRAINT conversion_attribution_touches_identity_kind_check CHECK (
        identity_kind IN (
            'email_sha256', 'email_hmac_sha256', 'click_id', 'external_id'
        )
    ) NOT VALID,
    ADD CONSTRAINT conversion_attribution_touches_shape CHECK (
        (
            touch_kind = 'identity'
            AND identity_kind IS NOT NULL
            AND identity_value IS NOT NULL
            AND resolution_rank IS NOT NULL
            AND (
                (identity_kind = 'email_hmac_sha256'
                    AND identity_key_id IS NOT NULL
                    AND length(identity_key_id) BETWEEN 1 AND 200)
                OR
                (identity_kind <> 'email_hmac_sha256'
                    AND identity_key_id IS NULL)
            )
        )
        OR
        (
            touch_kind = 'campaign_click'
            AND campaign_id IS NOT NULL
            AND touched_at IS NOT NULL
            AND identity_key_id IS NULL
        )
    ) NOT VALID;

COMMENT ON COLUMN public.conversions.email_sha256 IS
    'Historical unsalted digest only. Current signed ingest rejects it and no current lift result treats it as identity proof.';
COMMENT ON COLUMN public.conversions.email_hmac_sha256 IS
    'HMAC-SHA256(signing secret, lower(trim(email))); meaningful only with email_hmac_key_id.';
COMMENT ON COLUMN public.conversions.email_hmac_key_id IS
    'Rotating signed-ingest key id that scoped email_hmac_sha256; the secret is never retained on the fact.';
COMMENT ON COLUMN public.conversion_attribution_touches.identity_key_id IS
    'Rotating signed-ingest key id for email_hmac_sha256 identity evidence; null for other identity/touch kinds.';

COMMIT;

-- Nothing in current application code may resolve a person through an
-- unsalted digest. Removing the old expression index makes that retirement
-- explicit and prevents a future query from quietly reviving it as a trusted
-- identity shortcut.
DROP INDEX CONCURRENTLY IF EXISTS public.subscribers_email_sha256_idx;

CREATE INDEX CONCURRENTLY IF NOT EXISTS conversions_email_hmac_identity_idx
    ON public.conversions (tenant_id, email_hmac_key_id, email_hmac_sha256)
    WHERE email_hmac_sha256 IS NOT NULL;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE public.conversions
    VALIDATE CONSTRAINT conversions_email_hmac_identity_shape;
ALTER TABLE public.conversion_attribution_touches
    VALIDATE CONSTRAINT conversion_attribution_touches_identity_kind_check;
ALTER TABLE public.conversion_attribution_touches
    VALIDATE CONSTRAINT conversion_attribution_touches_shape;

COMMIT;
