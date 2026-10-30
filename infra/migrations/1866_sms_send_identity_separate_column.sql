-- 1866_sms_send_identity_separate_column.sql
--
-- migration-execution: phased
--
-- Corrects 1865, which created a self-poisoning feedback loop.
--
-- THE LOOP. 1865 derived the send identity into `subscribers.phone_e164`. That
-- is the exact column `sms_binding_not_contradicted` (1864) reads as EVIDENCE
-- about which number belongs to a subscriber. The guard was built to arbitrate
-- against operator-supplied data; it began arbitrating against 1865's own
-- output, and "never cleared on revoke" made that permanent:
--
--   opt in on A      -> identity = A, gate open
--   STOP on A        -> identity = A (kept by design), gate closed
--   opt in on NEW B  -> guard sees A as evidence, contradicts B,
--                       gate stays closed FOREVER
--
-- Meanwhile `sms_subscriptions` still holds B as opted_in, so the broadcast
-- audience texts B while the activation gate reports no consent — the exact
-- two-audiences-disagree split this whole chain exists to close, reopened in the
-- opposite direction. It outlived remediation too:
-- `channel_consent_canonical.go` copies `subscribers.phone_e164` into
-- `subscriber_channel_consents.phone_e164` on the next channel-consent write of
-- ANY channel, and that is the guard's primary source.
--
-- THE FIX. Derived identity gets its own column that the guard does not read.
-- Operator-supplied phone and system-derived send identity are different facts
-- with different provenance, and collapsing them is what created the loop.
--
-- This also removes two other consequences of writing `phone_e164`:
--   * `sync_subscriber_dedupe_keys` (1757) digests `phone_e164` into
--     `subscriber_dedupe_keys.phone_key`, and `subscriber_dedupe/scan.go` emits
--     a `phone_collision` duplicate proposal at 0.900 confidence with no
--     group-changed gate. Two people on one household or business line — legal
--     under `sms_subscriptions`' (tenant, list, phone) uniqueness — were being
--     presented as duplicates of each other.
--   * `subscribers.phone_e164` has no operator surface (`subscriberColumns`
--     omits it; Create/Update have no phone field), so a tenant could not
--     inspect or correct a value the system derived about them, while it
--     surfaced in SAR exports and automation branch conditions.
--
-- WHAT READS THE NEW COLUMN. `internal/omnichannel` resolves the send identity
-- as COALESCE(phone_e164, sms_send_identity) — operator data first, derived only
-- as a fallback. Nothing else reads it, and the binding guard must not.

BEGIN;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS sms_send_identity text;

COMMENT ON COLUMN subscribers.sms_send_identity IS
    'DERIVED send identity for sms/whatsapp/rcs, filled from the subscriber''s '
    'eligible SMS opt-in by the sms_subscriptions/sms_suppressions triggers. '
    'Deliberately separate from phone_e164, which is operator-supplied and is '
    'read by sms_binding_not_contradicted as evidence — deriving INTO that '
    'column made the guard arbitrate against its own output and locked a '
    'subscriber out permanently after a number change (see 1866). Never read as '
    'binding evidence, never digested into dedupe keys.';

-- Undo 1865's writes. Any value in phone_e164 that came from derivation is
-- guard-poisoning evidence the operator never supplied. Identified as: equal to
-- one of the subscriber's own SMS subscription phones, and with no
-- corresponding operator record in subscriber_channel_consents.
UPDATE subscribers s
   SET phone_e164 = NULL,
       sms_send_identity = s.phone_e164,
       updated_at = now()
 WHERE s.phone_e164 IS NOT NULL
   AND EXISTS (
       SELECT 1 FROM sms_subscriptions x
        WHERE x.tenant_id = s.tenant_id AND x.subscriber_email = s.email
          AND x.phone_e164 = s.phone_e164)
   AND NOT EXISTS (
       SELECT 1 FROM subscriber_channel_consents scc
        WHERE scc.tenant_id = s.tenant_id AND scc.subscriber_id = s.id
          AND scc.phone_e164 IS NOT NULL);

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
        -- Assignment, not COALESCE. 1865 filled only when NULL and claimed "two
        -- runs cannot disagree" — false, because the ORDER BY then ran exactly
        -- once and the stored value was "the first eligible number that existed
        -- while the column was empty", not "the most recently consented". This
        -- column is derived and owned by this function, so re-deriving is
        -- correct and makes the ordering rule true. Operator data is untouched:
        -- it lives in phone_e164 and omnichannel prefers it.
        UPDATE public.subscribers s
           SET consent_sms_marketing_at = COALESCE(s.consent_sms_marketing_at, now()),
               sms_send_identity = v_identity,
               updated_at = now()
         WHERE s.tenant_id = p_tenant_id AND s.email = p_email
           AND (s.consent_sms_marketing_at IS NULL
                OR s.sms_send_identity IS DISTINCT FROM v_identity);
        RETURN;
    END IF;

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

COMMIT;

-- Backfill, corrected twice over 1865's version.
--
-- 1. It applies the binding guard. 1865's did not, so it wrote identities the
--    trigger had deliberately REFUSED — and because it wrote them into the
--    column the guard reads, the next projection run then treated the refusal as
--    approval and opened consent on a contradicted number.
-- 2. It is actually batched. 1865's `LIMIT 5000` correlated on
--    (tenant_id, email), which carries a UNIQUE constraint, so the subquery
--    returned at most one row and the limit was a no-op: the first statement
--    touched every eligible subscriber at once. Under statement_timeout that
--    fails and every retry restarts the same all-rows statement, so it never
--    converges. Batching now walks the driving set by id.
-- No cursor is needed: the batch predicate is self-consuming. A row whose
-- identity already equals the derived value is excluded by
-- `IS DISTINCT FROM`, so each pass strictly shrinks the candidate set and the
-- loop terminates without tracking a position.
DO $$
DECLARE
    v_rows integer;
BEGIN
    LOOP
        WITH batch AS (
            SELECT s.id, c.phone_e164
              FROM subscribers s
              JOIN LATERAL (
                SELECT x.phone_e164
                  FROM sms_subscriptions x
                 WHERE x.tenant_id = s.tenant_id
                   AND x.subscriber_email = s.email
                   AND x.status = 'opted_in'
                   AND public.sms_binding_not_contradicted(s.tenant_id, s.email, x.phone_e164)
                   AND NOT EXISTS (
                       SELECT 1 FROM sms_suppressions p
                        WHERE p.tenant_id = x.tenant_id
                          AND p.phone_e164 = x.phone_e164
                          AND (p.expires_at IS NULL OR p.expires_at > now()))
                 ORDER BY COALESCE(x.consent_at, x.created_at) DESC, x.phone_e164
                 LIMIT 1
              ) c ON true
             WHERE s.sms_send_identity IS DISTINCT FROM c.phone_e164
             ORDER BY s.id
             LIMIT 5000
        )
        UPDATE subscribers s
           SET sms_send_identity = b.phone_e164, updated_at = now()
          FROM batch b
         WHERE s.id = b.id;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        EXIT WHEN v_rows = 0;
        COMMIT;
    END LOOP;
END $$;
