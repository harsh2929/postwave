-- 0234_send_gates_headers.sql
--
-- Commercial-email send-gate hardening for the List-Unsubscribe wire
-- path (RFC 2369 / RFC 8058 one-click) and the verified-sender-domain
-- compliance gate.
--
-- Why this migration:
--
--   1. The send-gate compliance check in apps/api/internal/campaigns/
--      compliance.go currently reads email_compliance_profiles
--      .verified_sender_domain as a plain boolean. That column is set
--      manually by the settings PUT and does NOT regress when the DKIM/
--      SPF/DMARC records on the corresponding sending_identities row
--      flip back to 'broken'. We want a server-driven sync: when
--      sending_identities.verify_state moves to/away from 'verified',
--      the compliance profile's boolean follows. This migration adds
--      a trigger on sending_identities that updates the per-tenant
--      email_compliance_profiles row in the same transaction.
--
--   2. The mailto-fallback for the List-Unsubscribe header (RFC 2369)
--      currently has no storage. Add a list_unsubscribe_mailto column
--      to email_compliance_profiles so the send loop can attach a
--      mailto: target alongside the https: hosted preference link.
--
--   3. sending_identities (migration 0133) is missing FORCE ROW LEVEL
--      SECURITY and the RESTRICTIVE tenant_isolation policy that every
--      other tenant-scoped table in the codebase carries. Without
--      FORCE, a table owner connection can bypass RLS even on the
--      restricted role; the RESTRICTIVE policy is the documented
--      idiom that pairs with the PERMISSIVE tenant_visible policy to
--      give us defence-in-depth.

BEGIN;

-- 1. email_compliance_profiles: list-unsubscribe mailto fallback.
ALTER TABLE email_compliance_profiles
    ADD COLUMN IF NOT EXISTS list_unsubscribe_mailto text NOT NULL DEFAULT '';

COMMENT ON COLUMN email_compliance_profiles.list_unsubscribe_mailto IS
    'RFC 2369 mailto: target attached to the List-Unsubscribe header alongside the hosted preference-center URL. Empty disables the mailto fallback (header still carries the https link).';

-- 2. sending_identities: harden RLS to match codebase convention.
ALTER TABLE sending_identities FORCE ROW LEVEL SECURITY;

-- The existing tenant_visible policy is PERMISSIVE; add the
-- RESTRICTIVE tenant_isolation companion the codebase convention
-- requires for defence-in-depth.
DROP POLICY IF EXISTS tenant_isolation ON sending_identities;
CREATE POLICY tenant_isolation ON sending_identities
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 3. verified_sender_domain sync from sending_identities.verify_state.
--
-- When a sending_identities row transitions to verify_state='verified',
-- mark the tenant's email_compliance_profiles.verified_sender_domain
-- true. When the LAST verified identity for the tenant regresses
-- (deleted or moved away from 'verified'), flip the boolean back to
-- false so the send gate refuses commercial sends until the operator
-- republishes the DNS records.
--
-- The trigger writes are bound to the same tenant_id as the row being
-- updated, so they pass RLS naturally (the row's tenant_id already
-- matches the GUC for any legitimate update). Inserts that create the
-- profile row are NOT performed here — if no profile exists the sync
-- is a no-op (the compliance gate will already block sends for that
-- tenant on the missing legal_sender_name etc.).
CREATE OR REPLACE FUNCTION sync_verified_sender_domain()
RETURNS trigger AS $$
DECLARE
    has_verified boolean;
    target_tenant uuid;
BEGIN
    -- Resolve the tenant_id we're syncing for. On DELETE OLD is set;
    -- on INSERT/UPDATE NEW is set.
    IF (TG_OP = 'DELETE') THEN
        target_tenant := OLD.tenant_id;
    ELSE
        target_tenant := NEW.tenant_id;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM sending_identities
         WHERE tenant_id = target_tenant
           AND verify_state = 'verified'
    ) INTO has_verified;

    UPDATE email_compliance_profiles
       SET verified_sender_domain = has_verified,
           updated_at = now()
     WHERE tenant_id = target_tenant
       AND verified_sender_domain IS DISTINCT FROM has_verified;

    IF (TG_OP = 'DELETE') THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- SECURITY DEFINER lets the trigger update email_compliance_profiles
-- regardless of the calling role's grants on that table. The function
-- only touches the tenant_id of the row being modified, so it can't
-- leak across tenants.

DROP TRIGGER IF EXISTS trg_sync_verified_sender_domain ON sending_identities;
CREATE TRIGGER trg_sync_verified_sender_domain
    AFTER INSERT OR UPDATE OF verify_state OR DELETE ON sending_identities
    FOR EACH ROW
    EXECUTE FUNCTION sync_verified_sender_domain();

-- Initial backfill: reconcile every existing profile against the
-- current set of sending_identities.
UPDATE email_compliance_profiles p
   SET verified_sender_domain = EXISTS (
        SELECT 1 FROM sending_identities si
         WHERE si.tenant_id = p.tenant_id
           AND si.verify_state = 'verified'
   ),
   updated_at = now()
 WHERE p.verified_sender_domain IS DISTINCT FROM EXISTS (
        SELECT 1 FROM sending_identities si
         WHERE si.tenant_id = p.tenant_id
           AND si.verify_state = 'verified'
   );

COMMIT;
