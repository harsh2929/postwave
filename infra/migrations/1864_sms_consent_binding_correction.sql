-- 1864_sms_consent_binding_correction.sql
--
-- Corrects migration 1863, which was INERT and whose comment said otherwise.
--
-- 1863 guarded the projection with `subscribers.phone_e164 IS NULL OR
-- subscribers.phone_e164 = x.phone_e164`. A review established that NO
-- production path ever writes a non-NULL `subscribers.phone_e164`: 0476 adds the
-- column with no backfill, `subscriberColumns` does not select it,
-- CreateInput/UpdateInput have no phone field, and its only writers
-- (privacy/erasure.go, subscribers/merge_canonical.go) set it to NULL. The
-- left-hand side was therefore always true and the guard blocked nothing.
--
-- 1863's comment claimed it closed a hole that "is a send authorisation", and
-- described the remaining case as a residual subcase. It was not a subcase; it
-- was every case. It also said "most subscribers have no phone recorded" — an
-- unmeasured claim that is wrong in kind: not most, all. Both are withdrawn.
--
-- THREE CORRECTIONS.
--
-- 1. Bind against a column that is actually populated.
--    `subscriber_channel_consents.phone_e164` is written for real by
--    `internal/subscribers/channel_consent_canonical.go` when channel consent is
--    recorded. `subscribers.phone_e164` is kept as a secondary source so a
--    tenant that does populate it is still honoured.
--
-- 2. Compare NORMALIZED DIGITS, not raw strings. `sms_subscriptions.phone_e164`
--    is always NormalizePhoneUSCA output (`+1XXXXXXXXXX`), while the
--    subscriber-side normalizers are international and disagree; 0476 explicitly
--    permits "legacy / partially-formatted rows". A raw comparison would refuse
--    a subscriber opting in ON THEIR OWN NUMBER stored as `555 933 0457` — a
--    fail-closed outage dressed as a safety check, and the two audiences would
--    disagree again. Comparing the last 10 digits is the widest rule that still
--    distinguishes two different numbers.
--
-- 3. Guard the WITHDRAW path too. 1863 added the binding only to the eligible
--    branch, so an unbound REVOKE still cleared an unrelated subscriber's
--    consent date — irreversible loss of consent evidence plus a denial of
--    service on the channel, reachable today and needing no `phone_e164` at all.
--    That directly broke the promise 1861 and 1862 each make in their own text.
--
-- STILL NOT CLOSED, stated plainly: this is a projection guard, not an
-- authorisation fix. A caller who supplies an address for a subscriber with NO
-- phone recorded anywhere still opens that subscriber's gate — reachable at
-- write scope via POST /api/v1/social-capture/tap-to-text/{id}/consent. Closing
-- that requires the SMS consent endpoint to demand a verified binding, which is
-- a decision about a public contract and what it breaks, not a migration.

BEGIN;

-- Last ten digits, or NULL when there are fewer. Used on both sides so a
-- comparison is only ever made between comparable things.
CREATE OR REPLACE FUNCTION public.sms_phone_match_key(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
    SELECT CASE
        WHEN length(regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g')) >= 10
        THEN right(regexp_replace(p_phone, '[^0-9]', '', 'g'), 10)
        ELSE NULL
    END;
$$;

-- True when the subscriber has NO phone on record anywhere (no evidence either
-- way — allow), or one that matches (evidence for). False only when a recorded
-- number contradicts the consenting one.
CREATE OR REPLACE FUNCTION public.sms_binding_not_contradicted(
    p_tenant_id uuid,
    p_email     citext,
    p_phone     text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
    WITH known AS (
        SELECT public.sms_phone_match_key(scc.phone_e164) AS k
          FROM public.subscriber_channel_consents scc
          JOIN public.subscribers s
            ON s.id = scc.subscriber_id AND s.tenant_id = scc.tenant_id
         WHERE scc.tenant_id = p_tenant_id
           AND s.email = p_email
           AND public.sms_phone_match_key(scc.phone_e164) IS NOT NULL
        UNION
        SELECT public.sms_phone_match_key(s.phone_e164)
          FROM public.subscribers s
         WHERE s.tenant_id = p_tenant_id
           AND s.email = p_email
           AND public.sms_phone_match_key(s.phone_e164) IS NOT NULL
    )
    SELECT NOT EXISTS (SELECT 1 FROM known)
        OR EXISTS (SELECT 1 FROM known WHERE k = public.sms_phone_match_key(p_phone));
$$;

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
        SELECT 1
          FROM public.sms_subscriptions x
         WHERE x.tenant_id = p_tenant_id
           AND x.subscriber_email = p_email
           AND x.status = 'opted_in'
           AND public.sms_binding_not_contradicted(p_tenant_id, p_email, x.phone_e164)
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

    -- The withdraw path carries the SAME binding requirement. Clearing a consent
    -- date is destructive and unrecoverable, so an unbound revoke must not reach
    -- it. Note this is not the mirror of the rule above: a contradicted binding
    -- means "no evidence about this person", which is a reason to withhold a
    -- grant and never a reason to erase one.
    SELECT EXISTS (
        SELECT 1 FROM public.sms_subscriptions x
         WHERE x.tenant_id = p_tenant_id
           AND x.subscriber_email = p_email
           AND public.sms_binding_not_contradicted(p_tenant_id, p_email, x.phone_e164)
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

-- 1862's comment described the rule without the binding clause, so the
-- database's own documentation disagreed with what it enforced.
COMMENT ON COLUMN public.subscribers.consent_sms_marketing_at IS
    'State-of-record for SMS marketing consent. NULL = no recorded grant. '
    'Maintained by triggers on sms_subscriptions and sms_suppressions '
    '(1862/1864): present iff some subscription is opted in, on a phone that is '
    'not actively suppressed and not contradicted by a number recorded for the '
    'subscriber (compared on the last ten digits). A subscriber with no opted-in '
    'SMS subscription is never cleared, so an email-era grant written by another '
    'path survives. Not maintained by the consent_events trigger — SMS evidence '
    'lives in sms_consent_events.';

COMMIT;

-- The consent receipt reads sms_consent_events by subscriber_email (and by the
-- phones bound to it). The table's only index is
-- (tenant_id, phone_e164, created_at DESC), so the email arm was a sequential
-- scan on an append-only table that only ever grows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sms_consent_events_subscriber_email_idx
    ON sms_consent_events (subscriber_email, created_at DESC)
    WHERE subscriber_email IS NOT NULL;
