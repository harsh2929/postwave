-- Subject-scoped erasure for F03 conversion identity.
--
-- Migration 2017 cryptoshreds email-HMAC evidence when a SIGNING KEY is
-- revoked, but a data-subject erasure previously changed only the subscriber
-- row and its current projection binding. Historical conversion facts retained
-- subscriber_email, rotating HMAC identity, click/external identifiers, and
-- attribution-touch links to the anonymized subscriber. This migration adds a
-- tenant-fenced, least-privileged erasure boundary that removes those identity
-- fields while retaining aggregate conversion/campaign facts and a content-free
-- immutable receipt.
--
-- Signed ingest takes the shared side of advisory fence 2029 before its tenant
-- transaction resolves or writes identity. Erasure takes the exclusive side.
-- Therefore every ingest transaction is wholly before the erasure (and is
-- included in its fresh READ COMMITTED snapshot) or wholly after it; a request
-- cannot commit old subject identity behind an already-written receipt.
--
-- migration-execution: phased
-- rollback-strategy: no-op
-- rollback-details: Identity already cryptoshredded by this migration cannot and must not be reconstructed. Application rollback may leave the receipt/function/indexes unused.

CREATE INDEX CONCURRENTLY IF NOT EXISTS conversions_subject_identity_erasure_idx
    ON public.conversions (tenant_id, subscriber_email, id)
    WHERE subscriber_email IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS conversion_attribution_touches_subject_erasure_idx
    ON public.conversion_attribution_touches
       (tenant_id, subscriber_id, conversion_id)
    WHERE subscriber_id IS NOT NULL;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- A subject erasure is not a key revocation. Give its value-free tombstone an
-- honest vocabulary instead of reusing `email_hmac_cryptoshredded`, whose name
-- and value specifically attest that a signing key was destroyed. Every
-- identity candidate on a subject-associated conversion becomes this generic
-- tombstone; campaign-touch facts retain campaign/time but lose subscriber_id.
ALTER TABLE public.conversion_attribution_touches
    DROP CONSTRAINT conversion_attribution_touches_identity_kind_check,
    DROP CONSTRAINT conversion_attribution_touches_shape;
ALTER TABLE public.conversion_attribution_touches
    ADD CONSTRAINT conversion_attribution_touches_identity_kind_check CHECK (
        identity_kind IN (
            'email_sha256', 'email_hmac_sha256',
            'email_hmac_cryptoshredded', 'identity_subject_erased',
            'click_id', 'external_id'
        )
    ) NOT VALID,
    ADD CONSTRAINT conversion_attribution_touches_shape CHECK (
        (
            touch_kind = 'identity'
            AND identity_kind IS NOT NULL
            AND identity_value IS NOT NULL
            AND resolution_rank IS NOT NULL
            AND (
                (
                    identity_kind = 'email_hmac_cryptoshredded'
                    AND identity_value = 'revoked:cryptoshredded'
                    AND identity_key_id IS NULL
                    AND subscriber_id IS NULL
                    AND NOT is_winner
                )
                OR
                (
                    identity_kind = 'identity_subject_erased'
                    AND identity_value = 'subject:cryptoshredded'
                    AND identity_key_id IS NULL
                    AND subscriber_id IS NULL
                    AND NOT is_winner
                )
                OR
                (
                    identity_kind = 'email_hmac_sha256'
                    AND identity_key_id IS NOT NULL
                    AND length(identity_key_id) BETWEEN 1 AND 200
                )
                OR
                (
                    identity_kind NOT IN (
                        'email_hmac_sha256', 'email_hmac_cryptoshredded',
                        'identity_subject_erased'
                    )
                    AND identity_key_id IS NULL
                )
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

ALTER TABLE public.conversion_attribution_touches
    VALIDATE CONSTRAINT conversion_attribution_touches_identity_kind_check;
ALTER TABLE public.conversion_attribution_touches
    VALIDATE CONSTRAINT conversion_attribution_touches_shape;

CREATE TABLE public.conversion_subject_identity_erasure_receipts (
    id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    request_id                   uuid NOT NULL,
    conversions_redacted         bigint NOT NULL CHECK (conversions_redacted >= 0),
    identity_touches_shredded    bigint NOT NULL CHECK (identity_touches_shredded >= 0),
    campaign_links_severed       bigint NOT NULL CHECK (campaign_links_severed >= 0),
    click_bindings_deleted       bigint NOT NULL CHECK (click_bindings_deleted >= 0),
    previous_receipt_fingerprint text CHECK (
        previous_receipt_fingerprint IS NULL
        OR previous_receipt_fingerprint ~ '^[0-9a-f]{64}$'
    ),
    recorded_at                  timestamptz NOT NULL,
    receipt_fingerprint          text NOT NULL CHECK (
        receipt_fingerprint ~ '^[0-9a-f]{64}$'
    ),
    UNIQUE (tenant_id, request_id)
);

COMMENT ON TABLE public.conversion_subject_identity_erasure_receipts IS
    'Immutable, content-free F03 subject-erasure receipts. Contains counts and chain provenance only: never an email, subscriber id, HMAC digest, click id, external id, or secret.';

CREATE INDEX conversion_subject_identity_erasure_receipts_chain_idx
    ON public.conversion_subject_identity_erasure_receipts
       (tenant_id, recorded_at DESC, id DESC);

ALTER TABLE public.conversion_subject_identity_erasure_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversion_subject_identity_erasure_receipts FORCE ROW LEVEL SECURITY;

DO $role$
DECLARE
    eraser pg_catalog.pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
         WHERE rolname = 'postwave_conversion_identity_eraser'
    ) THEN
        CREATE ROLE postwave_conversion_identity_eraser
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION NOBYPASSRLS;
    END IF;
    SELECT * INTO eraser FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_conversion_identity_eraser';
    IF eraser.rolcanlogin OR eraser.rolsuper OR eraser.rolcreatedb OR
       eraser.rolcreaterole OR eraser.rolinherit OR eraser.rolreplication OR
       eraser.rolbypassrls THEN
        RAISE EXCEPTION 'postwave_conversion_identity_eraser has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members
         WHERE member = eraser.oid OR roleid = eraser.oid
    ) THEN
        RAISE EXCEPTION 'postwave_conversion_identity_eraser must have no memberships or members';
    END IF;
END
$role$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
    FROM postwave_conversion_identity_eraser;
GRANT USAGE, CREATE ON SCHEMA public TO postwave_conversion_identity_eraser;

GRANT SELECT (tenant_id, id, email, primary_email, external_id)
    ON public.subscribers TO postwave_conversion_identity_eraser;
-- SELECT ... FOR UPDATE also requires UPDATE authority. Restrict that
-- authority to the immutable primary-key column: the role is NOLOGIN with no
-- members, and the function never changes it, but can hold the subject row
-- stable until the application performs the profile scrub in this transaction.
GRANT UPDATE (id) ON public.subscribers TO postwave_conversion_identity_eraser;
GRANT SELECT (tenant_id, subscriber_id, email)
    ON public.subscriber_emails TO postwave_conversion_identity_eraser;
GRANT SELECT (
    tenant_id, id, subscriber_email, email_sha256, email_hmac_sha256,
    email_hmac_key_id, click_id, external_id
) ON public.conversions TO postwave_conversion_identity_eraser;
GRANT UPDATE (
    subscriber_email, email_sha256, email_hmac_sha256,
    email_hmac_key_id, click_id, external_id
) ON public.conversions TO postwave_conversion_identity_eraser;
GRANT SELECT (
    tenant_id, conversion_id, touch_kind, identity_kind, identity_value,
    identity_key_id, subscriber_id, is_winner
) ON public.conversion_attribution_touches TO postwave_conversion_identity_eraser;
GRANT UPDATE (
    identity_kind, identity_value, identity_key_id, subscriber_id, is_winner
) ON public.conversion_attribution_touches TO postwave_conversion_identity_eraser;
GRANT SELECT (tenant_id, click_id, subscriber_id)
    ON public.conversion_click_identities TO postwave_conversion_identity_eraser;
GRANT DELETE ON public.conversion_click_identities TO postwave_conversion_identity_eraser;
GRANT SELECT (tenant_id, key_id, digest, subscriber_id)
    ON public.conversion_email_hmac_bindings
    TO postwave_conversion_identity_eraser;
GRANT SELECT (
    id, tenant_id, request_id, conversions_redacted,
    identity_touches_shredded, campaign_links_severed,
    click_bindings_deleted, previous_receipt_fingerprint,
    recorded_at, receipt_fingerprint
) ON public.conversion_subject_identity_erasure_receipts
    TO postwave_conversion_identity_eraser;
GRANT INSERT (
    id, tenant_id, request_id, conversions_redacted,
    identity_touches_shredded, campaign_links_severed,
    click_bindings_deleted, previous_receipt_fingerprint,
    recorded_at, receipt_fingerprint
) ON public.conversion_subject_identity_erasure_receipts
    TO postwave_conversion_identity_eraser;

-- The four existing ledgers FORCE RLS. Add role-specific permissive policies;
-- their tenant predicates intentionally match the application policy exactly.
CREATE POLICY conversion_subject_identity_eraser_subscribers
    ON public.subscribers FOR SELECT TO postwave_conversion_identity_eraser
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY conversion_subject_identity_eraser_subscriber_emails
    ON public.subscriber_emails FOR SELECT TO postwave_conversion_identity_eraser
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY conversion_subject_identity_eraser_conversions
    ON public.conversions FOR ALL TO postwave_conversion_identity_eraser
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY conversion_subject_identity_eraser_touches
    ON public.conversion_attribution_touches FOR ALL TO postwave_conversion_identity_eraser
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY conversion_subject_identity_eraser_click_bindings
    ON public.conversion_click_identities FOR ALL TO postwave_conversion_identity_eraser
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY conversion_subject_identity_eraser_hmac_bindings
    ON public.conversion_email_hmac_bindings
    FOR SELECT TO postwave_conversion_identity_eraser
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY conversion_subject_identity_eraser_receipts
    ON public.conversion_subject_identity_erasure_receipts
    FOR ALL TO postwave_conversion_identity_eraser
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY conversion_subject_identity_receipts_tenant_select
    ON public.conversion_subject_identity_erasure_receipts
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON public.conversion_subject_identity_erasure_receipts
    FROM PUBLIC, postwave_app;
GRANT SELECT ON public.conversion_subject_identity_erasure_receipts TO postwave_app;

CREATE OR REPLACE FUNCTION public.conversion_subject_identity_privacy_erase(
    p_tenant_id uuid,
    p_subject_email citext,
    p_erased_email citext,
    p_request_id uuid
)
RETURNS TABLE (
    receipt_id uuid,
    conversions_redacted bigint,
    identity_touches_shredded bigint,
    campaign_links_severed bigint,
    click_bindings_deleted bigint
)
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET TimeZone = 'UTC'
AS $function$
DECLARE
    v_subject_ids uuid[];
    v_subject_addresses citext[];
    v_subject_external_ids text[];
    v_subject_email citext := lower(btrim(p_subject_email::text))::citext;
    v_erased_email citext := lower(btrim(p_erased_email::text))::citext;
    v_receipt_id uuid := gen_random_uuid();
    v_recorded_at timestamptz := clock_timestamp();
    v_previous_fingerprint text;
    v_receipt_fingerprint text;
    v_conversions_redacted bigint := 0;
    v_identity_touches_shredded bigint := 0;
    v_campaign_links_severed bigint := 0;
    v_click_bindings_deleted bigint := 0;
BEGIN
    IF p_tenant_id::text IS DISTINCT FROM
       NULLIF(current_setting('app.tenant_id', true), '') THEN
        RAISE EXCEPTION 'conversion subject erasure tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;
    IF pg_catalog.octet_length(v_subject_email::text) NOT BETWEEN 3 AND 320
       OR v_erased_email::text !~
          '^erased\+[a-z0-9_-]{16}@erased\.invalid$' THEN
        RAISE EXCEPTION 'conversion subject erasure identity is invalid'
            USING ERRCODE = '22023';
    END IF;

    -- Re-entrant when the Go erasure orchestrator already owns it. Keeping the
    -- lock here makes the database capability safe when invoked by another
    -- reviewed erasure caller later.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_tenant_id::text, 2029)
    );

    -- Request ids make a retry return the immutable original receipt rather
    -- than rewriting already-redacted rows or appending an ambiguous duplicate.
    RETURN QUERY
    SELECT receipt.id, receipt.conversions_redacted,
           receipt.identity_touches_shredded,
           receipt.campaign_links_severed,
           receipt.click_bindings_deleted
      FROM public.conversion_subject_identity_erasure_receipts AS receipt
     WHERE receipt.tenant_id = p_tenant_id
       AND receipt.request_id = p_request_id;
    IF FOUND THEN
        RETURN;
    END IF;

    SELECT COALESCE(
               pg_catalog.array_agg(locked.id ORDER BY locked.id),
               '{}'::uuid[]
           ),
           COALESCE(
               pg_catalog.array_agg(DISTINCT locked.external_id)
                   FILTER (
                       WHERE locked.external_id IS NOT NULL
                         AND pg_catalog.btrim(locked.external_id) <> ''
                   ),
               '{}'::text[]
           )
      INTO v_subject_ids, v_subject_external_ids
      FROM (
          SELECT subscriber.id, subscriber.external_id
            FROM public.subscribers AS subscriber
           WHERE subscriber.tenant_id = p_tenant_id
             AND (
                 subscriber.email IN (v_subject_email, v_erased_email)
                 OR subscriber.primary_email IN (v_subject_email, v_erased_email)
                 OR EXISTS (
                     SELECT 1
                       FROM public.subscriber_emails AS address
                      WHERE address.tenant_id = subscriber.tenant_id
                        AND address.subscriber_id = subscriber.id
                        AND address.email IN (v_subject_email, v_erased_email)
                 )
             )
           ORDER BY subscriber.id
           FOR UPDATE
      ) AS locked;

    SELECT pg_catalog.array_agg(DISTINCT candidate.address)
      INTO v_subject_addresses
      FROM (
          SELECT v_subject_email AS address
          UNION ALL
          SELECT v_erased_email
          UNION ALL
          SELECT subscriber.email
            FROM public.subscribers AS subscriber
           WHERE subscriber.tenant_id = p_tenant_id
             AND subscriber.id = ANY(v_subject_ids)
          UNION ALL
          SELECT subscriber.primary_email
            FROM public.subscribers AS subscriber
           WHERE subscriber.tenant_id = p_tenant_id
             AND subscriber.id = ANY(v_subject_ids)
             AND subscriber.primary_email IS NOT NULL
          UNION ALL
          SELECT address.email
            FROM public.subscriber_emails AS address
           WHERE address.tenant_id = p_tenant_id
             AND address.subscriber_id = ANY(v_subject_ids)
      ) AS candidate
     WHERE lower(btrim(candidate.address::text)) <> '';

    -- target_conversions is materialized once from the pre-redaction snapshot.
    -- The data-modifying CTEs can then remove identity from both ledgers without
    -- retaining an unbounded UUID array in the application process.
    WITH target_conversions AS MATERIALIZED (
        SELECT conversion.id
          FROM public.conversions AS conversion
         WHERE conversion.tenant_id = p_tenant_id
           AND (
               conversion.subscriber_email = ANY(v_subject_addresses)
               OR conversion.email_sha256 = ANY(
                   SELECT pg_catalog.encode(
                       public.digest(
                           pg_catalog.convert_to(
                               pg_catalog.lower(pg_catalog.btrim(address::text)),
                               'UTF8'
                           ),
                           'sha256'
                       ),
                       'hex'
                   )
                     FROM pg_catalog.unnest(v_subject_addresses) AS address
               )
               OR conversion.external_id = ANY(v_subject_external_ids)
               OR EXISTS (
                   SELECT 1
                     FROM public.conversion_email_hmac_bindings AS binding
                    WHERE binding.tenant_id = conversion.tenant_id
                      AND binding.key_id = conversion.email_hmac_key_id
                      AND binding.digest = conversion.email_hmac_sha256
                      AND binding.subscriber_id = ANY(v_subject_ids)
               )
               OR EXISTS (
                   SELECT 1
                     FROM public.conversion_click_identities AS click_binding
                    WHERE click_binding.tenant_id = conversion.tenant_id
                      AND click_binding.click_id = conversion.click_id
                      AND click_binding.subscriber_id = ANY(v_subject_ids)
               )
               OR EXISTS (
                   SELECT 1
                     FROM public.conversion_attribution_touches AS touch
                    WHERE touch.tenant_id = conversion.tenant_id
                      AND touch.conversion_id = conversion.id
                      AND touch.subscriber_id = ANY(v_subject_ids)
               )
           )
    ), redacted_conversions AS (
        UPDATE public.conversions AS conversion
           SET subscriber_email = NULL,
               email_sha256 = NULL,
               email_hmac_sha256 = NULL,
               email_hmac_key_id = NULL,
               click_id = NULL,
               external_id = NULL
         WHERE conversion.tenant_id = p_tenant_id
           AND conversion.id IN (SELECT id FROM target_conversions)
        RETURNING 1
    ), shredded_identity_touches AS (
        UPDATE public.conversion_attribution_touches AS touch
           SET identity_kind = 'identity_subject_erased',
               identity_value = 'subject:cryptoshredded',
               identity_key_id = NULL,
               subscriber_id = NULL,
               is_winner = false
         WHERE touch.tenant_id = p_tenant_id
           AND touch.touch_kind = 'identity'
           AND (
               touch.conversion_id IN (SELECT id FROM target_conversions)
               OR touch.subscriber_id = ANY(v_subject_ids)
           )
        RETURNING 1
    ), severed_campaign_links AS (
        UPDATE public.conversion_attribution_touches AS touch
           SET subscriber_id = NULL
         WHERE touch.tenant_id = p_tenant_id
           AND touch.touch_kind = 'campaign_click'
           AND touch.subscriber_id = ANY(v_subject_ids)
        RETURNING 1
    ), deleted_click_bindings AS (
        DELETE FROM public.conversion_click_identities AS binding
         WHERE binding.tenant_id = p_tenant_id
           AND binding.subscriber_id = ANY(v_subject_ids)
        RETURNING 1
    )
    SELECT (SELECT count(*) FROM redacted_conversions),
           (SELECT count(*) FROM shredded_identity_touches),
           (SELECT count(*) FROM severed_campaign_links),
           (SELECT count(*) FROM deleted_click_bindings)
      INTO v_conversions_redacted, v_identity_touches_shredded,
           v_campaign_links_severed, v_click_bindings_deleted;

    SELECT receipt.receipt_fingerprint
      INTO v_previous_fingerprint
      FROM public.conversion_subject_identity_erasure_receipts AS receipt
     WHERE receipt.tenant_id = p_tenant_id
     ORDER BY receipt.recorded_at DESC, receipt.id DESC
     LIMIT 1;

    v_receipt_fingerprint := encode(digest(convert_to(jsonb_build_object(
        'schema', 'postwave.conversion-subject-identity-erasure-receipt.v1',
        'id', v_receipt_id,
        'tenant_id', p_tenant_id,
        'request_id', p_request_id,
        'conversions_redacted', v_conversions_redacted,
        'identity_touches_shredded', v_identity_touches_shredded,
        'campaign_links_severed', v_campaign_links_severed,
        'click_bindings_deleted', v_click_bindings_deleted,
        'previous_receipt_fingerprint', v_previous_fingerprint,
        'recorded_at', v_recorded_at
    )::text, 'UTF8'), 'sha256'), 'hex');

    INSERT INTO public.conversion_subject_identity_erasure_receipts (
        id, tenant_id, request_id, conversions_redacted,
        identity_touches_shredded, campaign_links_severed,
        click_bindings_deleted, previous_receipt_fingerprint,
        recorded_at, receipt_fingerprint
    ) VALUES (
        v_receipt_id, p_tenant_id, p_request_id, v_conversions_redacted,
        v_identity_touches_shredded, v_campaign_links_severed,
        v_click_bindings_deleted, v_previous_fingerprint,
        v_recorded_at, v_receipt_fingerprint
    );

    RETURN QUERY SELECT v_receipt_id, v_conversions_redacted,
        v_identity_touches_shredded, v_campaign_links_severed,
        v_click_bindings_deleted;
END
$function$;

ALTER FUNCTION public.conversion_subject_identity_privacy_erase(
    uuid, citext, citext, uuid
) OWNER TO postwave_conversion_identity_eraser;
REVOKE ALL ON FUNCTION public.conversion_subject_identity_privacy_erase(
    uuid, citext, citext, uuid
) FROM PUBLIC, postwave_public;
GRANT EXECUTE ON FUNCTION public.conversion_subject_identity_privacy_erase(
    uuid, citext, citext, uuid
) TO postwave_app;
REVOKE CREATE ON SCHEMA public FROM postwave_conversion_identity_eraser;

CREATE OR REPLACE FUNCTION public.conversion_subject_identity_erasure_receipt_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $trigger$
BEGIN
    -- Tenant deletion remains possible: the receipt FK cascade is the only
    -- permitted delete and executes from an internal trigger nesting level.
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'conversion subject identity erasure receipts are immutable'
        USING ERRCODE = '55000';
END
$trigger$;

CREATE TRIGGER conversion_subject_identity_erasure_receipt_immutable
    BEFORE UPDATE OR DELETE
    ON public.conversion_subject_identity_erasure_receipts
    FOR EACH ROW
    EXECUTE FUNCTION public.conversion_subject_identity_erasure_receipt_immutable();

DO $audit$
DECLARE
    eraser_oid oid;
BEGIN
    SELECT oid INTO eraser_oid FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_conversion_identity_eraser';
    IF eraser_oid IS NULL OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
         WHERE oid = eraser_oid
           AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR
                rolinherit OR rolreplication OR rolbypassrls)
    ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members
         WHERE member = eraser_oid OR roleid = eraser_oid
    ) OR pg_catalog.has_schema_privilege(
        'postwave_conversion_identity_eraser', 'public', 'CREATE'
    ) THEN
        RAISE EXCEPTION 'conversion subject identity eraser role is unsafe';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc AS procedure
         WHERE procedure.oid =
               'public.conversion_subject_identity_privacy_erase(uuid,citext,citext,uuid)'::regprocedure
           AND procedure.proowner = eraser_oid
           AND procedure.prosecdef
           AND procedure.proconfig @>
               ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
    ) THEN
        RAISE EXCEPTION 'conversion subject identity erasure definer provenance is unsafe';
    END IF;
    IF NOT pg_catalog.has_function_privilege(
        'postwave_app',
        'public.conversion_subject_identity_privacy_erase(uuid,citext,citext,uuid)',
        'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
        'postwave_public',
        'public.conversion_subject_identity_privacy_erase(uuid,citext,citext,uuid)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'conversion subject identity erasure execute grants are unsafe';
    END IF;
    IF NOT (
        SELECT relation.relrowsecurity AND relation.relforcerowsecurity
          FROM pg_catalog.pg_class AS relation
         WHERE relation.oid =
               'public.conversion_subject_identity_erasure_receipts'::regclass
    ) OR pg_catalog.has_table_privilege(
        'postwave_app',
        'public.conversion_subject_identity_erasure_receipts', 'INSERT'
    ) OR pg_catalog.has_table_privilege(
        'postwave_app',
        'public.conversion_subject_identity_erasure_receipts', 'UPDATE'
    ) OR pg_catalog.has_table_privilege(
        'postwave_app',
        'public.conversion_subject_identity_erasure_receipts', 'DELETE'
    ) OR pg_catalog.has_table_privilege(
        'postwave_app',
        'public.conversion_subject_identity_erasure_receipts', 'TRUNCATE'
    ) THEN
        RAISE EXCEPTION 'conversion subject identity erasure receipt grants are unsafe';
    END IF;
    IF (
        SELECT count(*) <> 2 OR NOT bool_and(index_catalog.indisvalid)
               OR NOT bool_and(index_catalog.indisready)
          FROM pg_catalog.pg_class AS index_relation
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = index_relation.relnamespace
          JOIN pg_catalog.pg_index AS index_catalog
            ON index_catalog.indexrelid = index_relation.oid
         WHERE namespace.nspname = 'public'
           AND index_relation.relname IN (
               'conversions_subject_identity_erasure_idx',
               'conversion_attribution_touches_subject_erasure_idx'
           )
    ) THEN
        RAISE EXCEPTION 'conversion subject identity erasure indexes are unavailable';
    END IF;
END
$audit$;

COMMIT;
