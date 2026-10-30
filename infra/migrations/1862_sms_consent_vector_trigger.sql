-- 1862_sms_consent_vector_trigger.sql
--
-- Move the SMS consent projection from a Go call site into the database.
--
-- 1861 added the projection to `internal/sms.RecordConsent`, which was the
-- writer we had in mind. It is not the only one. An adversarial review found
-- three more, and the gap they left was FAIL-OPEN — strictly worse than the
-- defect being fixed:
--
--   * `recordConsentTx` (store.go) is what the carrier webhook and the Twilio
--     handler actually call when a subscriber texts STOP. It writes
--     sms_consent_events and sms_suppressions and never touched the projection.
--     So the grant path OPENED the activation gate and the statutory opt-out
--     path could not close it. Before 1861 the column was always NULL and
--     omnichannel resolved nobody — broken, but fail-closed. After it, an
--     unprojected STOP left a live grant behind.
--   * `AddSuppression` / `DeleteSuppression` (suppressions.go) — the admin
--     surface — left the two audiences disagreeing in both directions.
--
-- A rule that every writer must remember to call is not one rule; it is one
-- rule and N opportunities to forget, and the next writer has no way to know.
-- As a trigger it cannot be bypassed, including by a backfill, an admin script
-- or a future code path nobody has written yet.
--
-- WHOM A CHANGE ADJUDICATES. Deliberately narrow, because the previous version
-- was too broad and destroyed data. Its `affected` set was every subscriber
-- email ever attached to the phone, and its CASE had no ELSE, so one person's
-- consent write could NULL an unrelated subscriber who merely shared the
-- number — including a subscriber whose grant came from the email era via
-- subscribers/merge_canonical.go, which 1861's own text promised never to
-- clear. The rules now:
--
--   * a sms_subscriptions change adjudicates ONLY that row's subscriber_email;
--   * a sms_suppressions change adjudicates only subscribers holding an
--     `opted_in` row on that phone — those whose eligibility actually depends
--     on it. A subscriber with merely a `pending` row never had an SMS-derived
--     grant, so their column is left alone.

BEGIN;

-- The rule, in one place. THREE outcomes, not two:
--
--   eligible  — an opted-in subscription on a phone that is not actively
--               suppressed. Set the column (keeping any existing date, which is
--               the evidence a consent receipt reports).
--   withdrawn — affirmative SMS evidence that consent ended: an `opted_out` row,
--               or a row on an actively-suppressed phone. Clear the column.
--   neither   — LEAVE IT ALONE.
--
-- That third case is the one a two-outcome rule gets wrong, and it destroys
-- data. `subscribers/merge_canonical.go` writes this column from the email era,
-- and 1861 promised derivation would never clear such a grant. A rule of "set
-- when eligible, else NULL" breaks that promise the moment the subscriber
-- merely ACQUIRES a pending SMS row — they were never SMS-consenting, nothing
-- was withdrawn, and their original grant date is gone unrecoverably.
CREATE OR REPLACE FUNCTION public.sms_consent_recompute_for_email(
    p_tenant_id uuid,
    p_email     citext
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
    v_eligible  boolean;
    v_withdrawn boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM public.sms_subscriptions x
         WHERE x.tenant_id = p_tenant_id AND x.subscriber_email = p_email
           AND x.status = 'opted_in'
           AND NOT EXISTS (
               SELECT 1 FROM public.sms_suppressions p
                WHERE p.tenant_id = x.tenant_id AND p.phone_e164 = x.phone_e164
                  AND (p.expires_at IS NULL OR p.expires_at > now())))
    INTO v_eligible;

    IF v_eligible THEN
        UPDATE public.subscribers s
           SET consent_sms_marketing_at = COALESCE(s.consent_sms_marketing_at, now()),
               updated_at = now()
         WHERE s.tenant_id = p_tenant_id AND s.email = p_email
           AND s.consent_sms_marketing_at IS NULL;
        RETURN;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.sms_subscriptions x
         WHERE x.tenant_id = p_tenant_id AND x.subscriber_email = p_email
           AND (x.status = 'opted_out'
                OR EXISTS (
                    SELECT 1 FROM public.sms_suppressions p
                     WHERE p.tenant_id = x.tenant_id AND p.phone_e164 = x.phone_e164
                       AND (p.expires_at IS NULL OR p.expires_at > now()))))
    INTO v_withdrawn;

    IF v_withdrawn THEN
        UPDATE public.subscribers s
           SET consent_sms_marketing_at = NULL,
               updated_at = now()
         WHERE s.tenant_id = p_tenant_id AND s.email = p_email
           AND s.consent_sms_marketing_at IS NOT NULL;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.sms_subscriptions_project_consent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
    -- Both images: an UPDATE that re-points subscriber_email must adjudicate
    -- the person losing the row as well as the one gaining it.
    IF TG_OP <> 'INSERT' AND OLD.subscriber_email IS NOT NULL THEN
        PERFORM public.sms_consent_recompute_for_email(OLD.tenant_id, OLD.subscriber_email);
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.subscriber_email IS NOT NULL THEN
        PERFORM public.sms_consent_recompute_for_email(NEW.tenant_id, NEW.subscriber_email);
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.sms_suppressions_project_consent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
    v_tenant uuid;
    v_phone  text;
    r        record;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_tenant := OLD.tenant_id; v_phone := OLD.phone_e164;
    ELSE
        v_tenant := NEW.tenant_id; v_phone := NEW.phone_e164;
    END IF;
    -- Only subscribers whose eligibility genuinely depends on this phone. A
    -- `pending` row is not an SMS-derived grant, and clearing it would destroy
    -- an email-era consent date that is evidence in a consent receipt.
    FOR r IN
        SELECT DISTINCT ss.subscriber_email AS email
          FROM public.sms_subscriptions ss
         WHERE ss.tenant_id = v_tenant
           AND ss.phone_e164 = v_phone
           AND ss.subscriber_email IS NOT NULL
           AND ss.status = 'opted_in'
    LOOP
        PERFORM public.sms_consent_recompute_for_email(v_tenant, r.email);
    END LOOP;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS sms_subscriptions_project_consent_trg ON public.sms_subscriptions;
CREATE TRIGGER sms_subscriptions_project_consent_trg
    AFTER INSERT OR UPDATE OR DELETE ON public.sms_subscriptions
    FOR EACH ROW EXECUTE FUNCTION public.sms_subscriptions_project_consent();

DROP TRIGGER IF EXISTS sms_suppressions_project_consent_trg ON public.sms_suppressions;
CREATE TRIGGER sms_suppressions_project_consent_trg
    AFTER INSERT OR UPDATE OR DELETE ON public.sms_suppressions
    FOR EACH ROW EXECUTE FUNCTION public.sms_suppressions_project_consent();

COMMENT ON COLUMN public.subscribers.consent_sms_marketing_at IS
    'State-of-record for SMS marketing consent. NULL = no recorded grant. '
    'Maintained by triggers on sms_subscriptions and sms_suppressions '
    '(migration 1862): present iff some subscription is opted in on a phone '
    'that is not actively suppressed. Not maintained by the consent_events '
    'trigger — SMS evidence lives in sms_consent_events. A subscriber with no '
    'opted-in SMS subscription is never cleared by a suppression change, so an '
    'email-era grant written by another path survives.';

COMMIT;
