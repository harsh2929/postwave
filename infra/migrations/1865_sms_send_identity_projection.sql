-- SUPERSEDED BY 1866. This migration derived the identity into
-- `subscribers.phone_e164`, which `sms_binding_not_contradicted` reads as
-- binding evidence — a self-poisoning loop that locked a subscriber out of SMS
-- permanently after a number change. 1866 moves the derivation to a separate
-- column and undoes these writes. Kept as the record of what was done.
--
-- 1865_sms_send_identity_projection.sql
--
-- migration-execution: phased
--
-- REQUIRED. The backfill below is a DO block containing COMMIT, which Postgres
-- rejects inside an enclosing transaction. Without this directive
-- `requiresStatementExecution` returns false (there is no CREATE INDEX
-- CONCURRENTLY here to trigger it incidentally, as in 1861), the runner wraps
-- the file in one transaction, and the migration fails on deploy while passing
-- every local psql run.
--
-- Give omnichannel a send identity for the subscribers who consented.
--
-- Migrations 1861/1862/1864 closed the CONSENT half of the SMS outage: the
-- activation gate is now open for anyone with an eligible opt-in. That was
-- necessary and not sufficient, and the shortfall is silent.
--
-- `internal/omnichannel/runtime.go:57` uses `subscribers.phone_e164` as the send
-- identity for sms, whatsapp AND rcs, and its materialization filters
-- `phone_e164 IS NOT NULL AND phone_e164::text <> ''` before inserting an
-- omni_recipients row. Nothing writes that column: 0476 adds it with no
-- backfill, `subscriberColumns` does not select it, CreateInput/UpdateInput have
-- no phone field, and its only writers (privacy/erasure.go,
-- subscribers/merge_canonical.go) set it to NULL.
--
-- So a fully consenting subscriber would materialize ZERO recipients.
--
-- CORRECTION (see 1866). An earlier version of this paragraph said "and the run
-- reported success". That is false: `omnichannel.go:23` sets
-- `omnichannelRuntimeQualified = false`, so every Materialize call returns
-- ErrOmnichannelRuntimeUnavailable before touching the pool. Nothing reports
-- success because nothing runs. The shortfall is real but CONDITIONAL — it is
-- what would happen when the runtime is enabled, not what happens today.
--
-- DERIVED FROM THE SAME SOURCE AS CONSENT, deliberately. The number that
-- authorises the send and the number the send goes to must be one fact. Taking
-- the identity from anywhere else — a custom field, a merge field, an import
-- column — reintroduces exactly the split this work exists to close: a message
-- delivered to a number whose opt-in nobody can produce.
--
-- FILLS, NEVER OVERWRITES, NEVER CLEARS.
--   * `phone_e164` is a profile field a tenant may maintain through their own
--     import. Derivation fills a gap; overwriting operator data with a number
--     that merely happens to carry a subscription is not its business.
--   * It is never cleared on revoke. Consent ending does not make the number
--     wrong, and identity is not the gate — `consent_sms_marketing_at` is, and
--     that IS cleared. Erasing the identity too would destroy profile data to
--     achieve something the consent projection already achieves.
--
-- The chosen number is the most recently consented eligible subscription, with
-- the phone as a deterministic tiebreak.
--
-- CORRECTION (see 1866). This originally added "so two runs cannot disagree",
-- which was false while the write was fill-only: the ORDER BY then ran exactly
-- once, and the stored value was "the first eligible number that existed while
-- the column was empty", not "the most recently consented". 1866 makes the
-- write an assignment on a column it owns, which is what makes the claim true.

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
    v_identity  text;
    v_withdrawn boolean;
BEGIN
    -- The eligible subscription, if any: opted in, not actively suppressed, and
    -- on a number not contradicted by one recorded for the subscriber. Its phone
    -- is both the evidence of consent and the send identity.
    SELECT x.phone_e164
      INTO v_identity
      FROM public.sms_subscriptions x
     WHERE x.tenant_id = p_tenant_id
       AND x.subscriber_email = p_email
       AND x.status = 'opted_in'
       AND public.sms_binding_not_contradicted(p_tenant_id, p_email, x.phone_e164)
       AND NOT EXISTS (
           SELECT 1 FROM public.sms_suppressions p
            WHERE p.tenant_id = x.tenant_id
              AND p.phone_e164 = x.phone_e164
              AND (p.expires_at IS NULL OR p.expires_at > now()))
     ORDER BY COALESCE(x.consent_at, x.created_at) DESC, x.phone_e164
     LIMIT 1;

    IF v_identity IS NOT NULL THEN
        UPDATE public.subscribers s
           SET consent_sms_marketing_at = COALESCE(s.consent_sms_marketing_at, now()),
               -- COALESCE, not assignment: fills a gap, never overwrites.
               phone_e164 = COALESCE(s.phone_e164, v_identity),
               updated_at = now()
         WHERE s.tenant_id = p_tenant_id AND s.email = p_email
           AND (s.consent_sms_marketing_at IS NULL OR s.phone_e164 IS NULL);
        RETURN;
    END IF;

    -- Withdrawal clears the GATE and leaves the identity alone. See the header.
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

COMMENT ON COLUMN public.subscribers.phone_e164 IS
    'Send identity for sms/whatsapp/rcs (internal/omnichannel materializes on '
    'this column). Filled from the subscriber''s eligible SMS opt-in by the '
    'sms_subscriptions/sms_suppressions triggers (1865) when empty, so the '
    'number a message goes to is the number whose opt-in authorises it. Never '
    'overwritten — a tenant may maintain it directly — and never cleared on '
    'revoke, because consent ending does not make the number wrong; the gate is '
    'consent_sms_marketing_at, and that is cleared.';

COMMIT;

-- Backfill the subscribers whose opt-in predates this derivation. Batched: the
-- table carries 18 triggers, and each UPDATE re-enters the projection function.
DO $$
DECLARE
    v_rows integer;
BEGIN
    LOOP
        UPDATE subscribers s
           SET phone_e164 = c.phone_e164,
               updated_at = now()
          FROM (
            SELECT DISTINCT ON (x.tenant_id, x.subscriber_email)
                   x.tenant_id, x.subscriber_email, x.phone_e164
              FROM sms_subscriptions x
             WHERE x.status = 'opted_in'
               AND x.subscriber_email IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM sms_suppressions p
                    WHERE p.tenant_id = x.tenant_id
                      AND p.phone_e164 = x.phone_e164
                      AND (p.expires_at IS NULL OR p.expires_at > now()))
             ORDER BY x.tenant_id, x.subscriber_email,
                      COALESCE(x.consent_at, x.created_at) DESC, x.phone_e164
          ) c
         WHERE s.tenant_id = c.tenant_id
           AND s.email = c.subscriber_email
           AND s.phone_e164 IS NULL
           AND s.id IN (
               SELECT s2.id FROM subscribers s2
                WHERE s2.tenant_id = c.tenant_id AND s2.email = c.subscriber_email
                  AND s2.phone_e164 IS NULL
                LIMIT 5000);
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        EXIT WHEN v_rows = 0;
        COMMIT;
    END LOOP;
END $$;
