-- 1765_subscriber_email_consent_invariants.sql
--
-- Subscriber Detail previously treated a freshly attached address as
-- subscribed by default and allowed a side-table `is_primary` flip even though
-- campaign delivery still uses subscribers.email. This migration makes the
-- all-writer database boundary fail closed:
--
--   * omitted consent defaults to never_subscribed;
--   * at most five addresses can be inserted for one profile, including under
--     concurrent writers;
--   * an is_primary row must equal the subscriber's real delivery identity;
--   * a new transition to subscribed cannot commit unless the same transaction
--     (or an earlier reviewed action) leaves a latest canonical
--     email_marketing grant for the exact address.
--
-- Existing subscribed rows are deliberately not rewritten in this DDL
-- migration: a table-wide rewrite would create an unsafe lock/latency event at
-- large tenants. Send-time eligibility additionally requires the legacy
-- subscriber purpose projection, and a separate bounded reconciliation job
-- can classify retained legacy rows without blocking deploys.
--
-- Deployment order: deploy evidence-writing application code and drain old
-- writers before applying this contract. An old replica that explicitly
-- inserts `subscribed` without evidence will fail at COMMIT after this lands;
-- that is the intended safe outcome, but draining avoids avoidable 5xxs.
--
-- rollback-strategy: additive safety contract. Application rollback is safe
-- while these guards remain. Emergency hard rollback may drop the two triggers
-- and functions and restore the old default, but doing so re-opens fabricated
-- consent and decorative-primary writes and therefore requires security signoff.

BEGIN;

ALTER TABLE public.subscriber_emails
    ALTER COLUMN consent_status SET DEFAULT 'never_subscribed';

COMMENT ON COLUMN public.subscriber_emails.consent_status IS
    'Per-address email-marketing state. Omitted writes fail closed to never_subscribed; transitions to subscribed require canonical evidence.';

-- Fold the two retained canonical consent ledgers onto one exact-address
-- terminal decision. A positive event is accepted only when it carries the
-- evidence envelope written by reviewed application/import paths. At equal
-- timestamps a non-grant wins, keeping ambiguous chronology fail closed.
CREATE OR REPLACE FUNCTION public.subscriber_email_latest_decision(
    p_tenant_id uuid,
    p_subscriber_id uuid,
    p_address_id uuid,
    p_email text
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
    SELECT decision
      FROM (
            SELECT CASE
                       WHEN event.action = 'granted'
                        AND event.source IN (
                            'double_optin', 'single_optin',
                            'preference_center', 'signed_form',
                            'direct_request'
                        )
                        AND pg_catalog.btrim(
                            COALESCE(event.proof_text, '')
                        ) <> ''
                        AND pg_catalog.btrim(event.policy_version) <> ''
                        AND event.preferences ->> 'legal_basis' IN (
                            'consent', 'contract', 'legitimate_interest',
                            'legal_obligation'
                        )
                        AND pg_catalog.btrim(
                            COALESCE(
                                event.preferences ->> 'jurisdiction', ''
                            )
                        ) <> ''
                           THEN 'granted'
                       WHEN event.action = 'granted' THEN 'invalid_grant'
                       ELSE event.action
                   END AS decision,
                   event.created_at AS occurred_at,
                   event.created_at AS recorded_at,
                   event.id::text AS decision_id
              FROM public.consent_events AS event
             WHERE event.tenant_id = p_tenant_id
               AND event.subject_type = 'subscriber'
               AND event.category = 'email_marketing'
               AND pg_catalog.lower(event.subject_email::text) =
                   pg_catalog.lower(p_email)
               AND (
                    event.subject_id = p_subscriber_id::text OR
                    (
                        p_address_id IS NOT NULL AND
                        event.subject_id = p_address_id::text
                    )
               )
               AND event.created_at <=
                   pg_catalog.now() + pg_catalog.make_interval(mins => 5)
            UNION ALL
            SELECT CASE
                       WHEN record.consent_status = 'granted'
                        AND record.source <> 'unknown'
                        AND record.evidence <> '{}'::jsonb
                           THEN 'granted'
                       WHEN record.consent_status = 'granted'
                           THEN 'invalid_grant'
                       ELSE record.consent_status
                   END AS decision,
                   record.captured_at AS occurred_at,
                   record.created_at AS recorded_at,
                   record.id::text AS decision_id
              FROM public.consent_records AS record
             WHERE record.tenant_id = p_tenant_id
               AND record.subscriber_id = p_subscriber_id
               AND record.channel = 'email'
               AND pg_catalog.lower(record.email::text) =
                   pg_catalog.lower(p_email)
               AND record.captured_at <=
                   pg_catalog.now() + pg_catalog.make_interval(mins => 5)
           ) AS decisions
     ORDER BY occurred_at DESC,
              CASE WHEN decision = 'granted' THEN 1 ELSE 0 END ASC,
              recorded_at DESC, decision_id DESC
     LIMIT 1
$function$;

REVOKE ALL ON FUNCTION public.subscriber_email_latest_decision(
    uuid, uuid, uuid, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscriber_email_latest_decision(
    uuid, uuid, uuid, text
) TO postwave_app;

CREATE OR REPLACE FUNCTION public.enforce_subscriber_email_shape()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
    sibling_count integer;
    canonical_matches boolean;
BEGIN
    -- OLD is not assigned for INSERT triggers. Keep the branches separate so
    -- PostgreSQL never has to evaluate an unassigned transition record.
    IF TG_OP = 'INSERT' THEN
        -- Serialize the application-level five-address cap for every writer.
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(
                NEW.tenant_id::text || ':' || NEW.subscriber_id::text,
                1765
            )
        );
        SELECT pg_catalog.count(*)::integer
          INTO sibling_count
          FROM public.subscriber_emails AS address
         WHERE address.tenant_id = NEW.tenant_id
           AND address.subscriber_id = NEW.subscriber_id
           AND address.id <> NEW.id;
        IF sibling_count >= 5 THEN
            RAISE EXCEPTION 'subscriber email address limit reached'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'subscriber_emails_max_five';
        END IF;
    ELSIF NEW.subscriber_id IS DISTINCT FROM OLD.subscriber_id OR
          NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(
                NEW.tenant_id::text || ':' || NEW.subscriber_id::text,
                1765
            )
        );
        SELECT pg_catalog.count(*)::integer
          INTO sibling_count
          FROM public.subscriber_emails AS address
         WHERE address.tenant_id = NEW.tenant_id
           AND address.subscriber_id = NEW.subscriber_id
           AND address.id <> NEW.id;
        IF sibling_count >= 5 THEN
            RAISE EXCEPTION 'subscriber email address limit reached'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'subscriber_emails_max_five';
        END IF;
    END IF;

    IF NEW.is_primary THEN
        SELECT EXISTS (
            SELECT 1
              FROM public.subscribers AS subscriber
             WHERE subscriber.tenant_id = NEW.tenant_id
               AND subscriber.id = NEW.subscriber_id
               AND pg_catalog.lower(subscriber.email::text) =
                   pg_catalog.lower(NEW.email::text)
        ) INTO canonical_matches;
        IF NOT canonical_matches THEN
            RAISE EXCEPTION 'primary subscriber email must match the delivery identity'
                USING ERRCODE = '23514',
                      CONSTRAINT = 'subscriber_emails_primary_matches_subscriber';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_subscriber_email_shape() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_subscriber_email_shape() TO postwave_app;

DROP TRIGGER IF EXISTS subscriber_emails_enforce_shape
    ON public.subscriber_emails;
CREATE TRIGGER subscriber_emails_enforce_shape
    BEFORE INSERT OR UPDATE OF subscriber_id, tenant_id, email, is_primary
    ON public.subscriber_emails
    FOR EACH ROW EXECUTE FUNCTION public.enforce_subscriber_email_shape();

CREATE OR REPLACE FUNCTION public.require_subscriber_email_grant_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
    latest_action text;
BEGIN
    IF NEW.consent_status <> 'subscribed' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND OLD.consent_status = 'subscribed'
       AND OLD.tenant_id = NEW.tenant_id
       AND OLD.subscriber_id = NEW.subscriber_id
       AND pg_catalog.lower(OLD.email::text) =
           pg_catalog.lower(NEW.email::text) THEN
        RETURN NEW;
    END IF;

    latest_action := public.subscriber_email_latest_decision(
        NEW.tenant_id,
        NEW.subscriber_id,
        NEW.id,
        NEW.email::text
    );

    IF latest_action IS DISTINCT FROM 'granted' THEN
        RAISE EXCEPTION 'subscribed email address requires latest canonical grant evidence'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'subscriber_emails_subscribed_requires_grant';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.require_subscriber_email_grant_evidence()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.require_subscriber_email_grant_evidence()
    TO postwave_app;

DROP TRIGGER IF EXISTS subscriber_emails_require_grant
    ON public.subscriber_emails;
CREATE CONSTRAINT TRIGGER subscriber_emails_require_grant
    AFTER INSERT OR UPDATE OF consent_status, email, subscriber_id, tenant_id
    ON public.subscriber_emails
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.require_subscriber_email_grant_evidence();

-- Every subscriber writer, including imports, identify/merge adapters, privacy
-- erasure, and compatibility APIs, converges onto the junction at COMMIT. New
-- identities start never_subscribed unless the same transaction leaves both a
-- positive purpose projection and exact reviewed evidence. Email rotations
-- preserve an already-known target address; genuinely new addresses replace
-- the prior canonical row and never inherit its consent.
CREATE OR REPLACE FUNCTION public.reconcile_subscriber_email_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
    canonical_email text;
    purpose_granted boolean;
    target_id uuid;
    replacement_id uuid;
    sibling_count integer;
    target_status text := 'never_subscribed';
BEGIN
    SELECT subscriber.email::text,
           subscriber.status = 'enabled'
           AND subscriber.consent_email_marketing_at IS NOT NULL
           AND subscriber.archived_at IS NULL
      INTO canonical_email, purpose_granted
      FROM public.subscribers AS subscriber
     WHERE subscriber.tenant_id = NEW.tenant_id
       AND subscriber.id = NEW.id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            NEW.tenant_id::text || ':' || NEW.id::text,
            1765
        )
    );

    SELECT address.id
      INTO target_id
      FROM public.subscriber_emails AS address
     WHERE address.tenant_id = NEW.tenant_id
       AND address.subscriber_id = NEW.id
       AND pg_catalog.lower(address.email::text) =
           pg_catalog.lower(canonical_email)
     LIMIT 1;

    IF target_id IS NOT NULL THEN
        UPDATE public.subscriber_emails
           SET is_primary = false,
               updated_at = pg_catalog.clock_timestamp()
         WHERE tenant_id = NEW.tenant_id
           AND subscriber_id = NEW.id
           AND is_primary
           AND id <> target_id;
        UPDATE public.subscriber_emails
           SET is_primary = true,
               updated_at = pg_catalog.clock_timestamp()
         WHERE tenant_id = NEW.tenant_id
           AND subscriber_id = NEW.id
           AND id = target_id
           AND NOT is_primary;
        RETURN NULL;
    END IF;

    IF purpose_granted AND
       public.subscriber_email_latest_decision(
           NEW.tenant_id, NEW.id, NULL, canonical_email
       ) = 'granted' THEN
        target_status := 'subscribed';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        SELECT address.id
          INTO replacement_id
          FROM public.subscriber_emails AS address
         WHERE address.tenant_id = NEW.tenant_id
           AND address.subscriber_id = NEW.id
           AND pg_catalog.lower(address.email::text) =
               pg_catalog.lower(OLD.email::text)
         LIMIT 1;
    END IF;
    IF replacement_id IS NULL THEN
        SELECT address.id
          INTO replacement_id
          FROM public.subscriber_emails AS address
         WHERE address.tenant_id = NEW.tenant_id
           AND address.subscriber_id = NEW.id
           AND address.is_primary
         ORDER BY address.created_at, address.id
         LIMIT 1;
    END IF;

    UPDATE public.subscriber_emails
       SET is_primary = false,
           updated_at = pg_catalog.clock_timestamp()
     WHERE tenant_id = NEW.tenant_id
       AND subscriber_id = NEW.id
       AND is_primary
       AND (replacement_id IS NULL OR id <> replacement_id);

    IF replacement_id IS NOT NULL THEN
        UPDATE public.subscriber_emails
           SET email = canonical_email,
               is_primary = true,
               consent_status = target_status,
               suppressed = false,
               last_engaged_at = NULL,
               updated_at = pg_catalog.clock_timestamp()
         WHERE tenant_id = NEW.tenant_id
           AND subscriber_id = NEW.id
           AND id = replacement_id;
        RETURN NULL;
    END IF;

    SELECT pg_catalog.count(*)::integer
      INTO sibling_count
      FROM public.subscriber_emails AS address
     WHERE address.tenant_id = NEW.tenant_id
       AND address.subscriber_id = NEW.id;
    IF sibling_count >= 5 THEN
        RAISE EXCEPTION 'subscriber email address limit reached during identity reconciliation'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'subscriber_emails_max_five';
    END IF;

    INSERT INTO public.subscriber_emails (
        tenant_id, subscriber_id, email, is_primary, consent_status
    ) VALUES (
        NEW.tenant_id, NEW.id, canonical_email, true, target_status
    );
    RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_subscriber_email_identity()
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_subscriber_email_identity()
    TO postwave_app;

DROP TRIGGER IF EXISTS subscribers_reconcile_email_identity
    ON public.subscribers;
CREATE CONSTRAINT TRIGGER subscribers_reconcile_email_identity
    AFTER INSERT OR UPDATE OF email
    ON public.subscribers
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.reconcile_subscriber_email_identity();

DO $postcheck$
DECLARE
    default_expression text;
BEGIN
    SELECT pg_catalog.pg_get_expr(attribute.adbin, attribute.adrelid)
      INTO default_expression
      FROM pg_catalog.pg_attrdef AS attribute
      JOIN pg_catalog.pg_attribute AS column_def
        ON column_def.attrelid = attribute.adrelid
       AND column_def.attnum = attribute.adnum
     WHERE attribute.adrelid = 'public.subscriber_emails'::pg_catalog.regclass
       AND column_def.attname = 'consent_status';

    IF default_expression IS NULL OR
       default_expression NOT LIKE '%never_subscribed%' THEN
        RAISE EXCEPTION 'subscriber_emails consent default is not fail closed';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger
         WHERE tgrelid = 'public.subscriber_emails'::pg_catalog.regclass
           AND tgname = 'subscriber_emails_enforce_shape'
           AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger
         WHERE tgrelid = 'public.subscriber_emails'::pg_catalog.regclass
           AND tgname = 'subscriber_emails_require_grant'
           AND tgdeferrable AND tginitdeferred AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger
         WHERE tgrelid = 'public.subscribers'::pg_catalog.regclass
           AND tgname = 'subscribers_reconcile_email_identity'
           AND tgdeferrable AND tginitdeferred AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'subscriber email safety triggers are missing or unsafe';
    END IF;
END;
$postcheck$;

COMMIT;
