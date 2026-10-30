-- 1863_sms_consent_phone_binding.sql
--
-- Refuse to project SMS consent when the phone that consented is CONTRADICTED
-- by the subscriber's own number on file.
--
-- `internal/sms.RecordConsent` takes a caller-supplied `subscriber_email` and
-- never checks that it belongs to the phone that consented. That was inert
-- while `subscribers.consent_sms_marketing_at` was permanently NULL — nothing
-- read the result. Projecting the column (1861/1862) made it consequential: a
-- write-scoped call could open ANOTHER subscriber's SMS activation gate simply
-- by naming their address, and because that gate also carries whatsapp and rcs
-- (omnichannel/runtime.go), it is a send authorisation.
--
-- WHY "NOT CONTRADICTED" AND NOT "MUST MATCH". Demanding that
-- subscribers.phone_e164 equal the consenting number would be the stronger rule
-- and the wrong one: most subscribers have no phone recorded, so it fails closed
-- for entire tenants and reinstates exactly the "SMS resolves nobody" outage
-- 1861 existed to remove. A subscriber with no number on file has no evidence
-- either way and the SMS subscription is the best evidence available. A
-- subscriber whose number IS on file and is a DIFFERENT number is affirmative
-- evidence that this consent was not theirs.
--
-- This is a projection-level guard, not an authorisation fix. The API still
-- accepts an arbitrary `subscriber_email`, and a caller who supplies an address
-- with no phone on file still opens that subscriber's gate. Closing that needs
-- a decision about the public SMS consent contract — whether the endpoint should
-- require a verified binding, and what existing integrations break if it does —
-- which is a product call rather than a migration. Recorded here so the residual
-- is visible at the place that mitigates it.

BEGIN;

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
    -- Eligible: an opted-in subscription, on a phone that is neither actively
    -- suppressed nor contradicted by the subscriber's own recorded number.
    SELECT EXISTS (
        SELECT 1
          FROM public.sms_subscriptions x
          JOIN public.subscribers s
            ON s.tenant_id = x.tenant_id AND s.email = x.subscriber_email
         WHERE x.tenant_id = p_tenant_id
           AND x.subscriber_email = p_email
           AND x.status = 'opted_in'
           AND (s.phone_e164 IS NULL OR s.phone_e164 = x.phone_e164)
           AND NOT EXISTS (
               SELECT 1 FROM public.sms_suppressions p
                WHERE p.tenant_id = x.tenant_id
                  AND p.phone_e164 = x.phone_e164
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

    -- Withdrawn: affirmative evidence that SMS consent ended. Deliberately NOT
    -- symmetric with the binding rule above — a contradicted binding means "we
    -- have no evidence this person consented", not "this person withdrew", so it
    -- must never be a reason to clear an existing grant. See 1862 on why the
    -- third outcome (leave alone) exists.
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

COMMIT;
