-- 1903_audit_log_tenant_cascade.sql
--
-- A tenant with ANY audit rows could not be deleted.
--
-- `audit_log_immutability_guard` refuses every DELETE unless
-- `app.audit_internal_writer` or `app.audit_trim_worker` is set. A tenant
-- delete cascades into audit_log with neither GUC set, so the guard raised and
-- the entire DELETE failed. Every real tenant has audit rows, so offboarding
-- and GDPR erasure were blocked universally — and the error blamed an
-- append-only rule instead of naming the erasure that was refused.
--
-- Same root cause and same fix as 1899 on tenant_pii_scan_config: a cascade is
-- not a rewrite, and a guard that cannot tell them apart blocks the one
-- operation that must always be possible.
--
-- Immutability is untouched for the case it exists to protect: the branch
-- requires the tenant to be GONE already, which only happens inside the
-- cascade. An ordinary tenant-scoped delete still hits the exception.

BEGIN;

CREATE OR REPLACE FUNCTION audit_log_immutability_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    -- THE TENANT-CASCADE CASE.
    --
    -- audit_log.tenant_id cascades from tenants, so deleting a tenant fires
    -- this guard with neither GUC set and the whole DELETE fails:
    --
    --   ERROR: audit_log is append-only (op=DELETE)
    --
    -- Every real tenant accumulates audit rows, so tenant offboarding and GDPR
    -- erasure were blocked for effectively ALL of them — and the error names an
    -- append-only rule rather than the erasure that was actually attempted.
    --
    -- Erasing a tenant SHOULD erase its audit rows: that is what erasure means,
    -- the foreign key requires it, and there is no tenant left for the trail to
    -- be about. Immutability is preserved where it matters — the tenant must
    -- already be gone, so an ordinary tenant-scoped delete still fails.
    -- Nested rather than `TG_OP = 'DELETE' AND NOT EXISTS (...)`: PostgreSQL
    -- does not guarantee short-circuit evaluation of AND, so the combined form
    -- runs the tenants lookup on every INSERT and UPDATE as well.
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
            RETURN OLD;
        END IF;
    END IF;
    IF current_setting('app.audit_internal_writer', true) = 'true' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF TG_OP = 'DELETE' AND current_setting('app.audit_trim_worker', true) = 'true' THEN
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        -- Only retention_override_days + legal_hold may be flipped on
        -- a per-row basis via the standard app role. Everything else
        -- (action, metadata, hashes, actor, etc.) is immutable.
        IF NEW.id = OLD.id
           AND NEW.tenant_id = OLD.tenant_id
           AND NEW.action = OLD.action
           AND NEW.at = OLD.at
           AND COALESCE(NEW.metadata::text, '') = COALESCE(OLD.metadata::text, '')
           AND COALESCE(NEW.row_hash, ''::bytea) = COALESCE(OLD.row_hash, ''::bytea)
           AND COALESCE(NEW.prev_hash, ''::bytea) = COALESCE(OLD.prev_hash, ''::bytea)
           AND COALESCE(NEW.actor_type, '') = COALESCE(OLD.actor_type, '')
           AND COALESCE(NEW.actor_label, '') = COALESCE(OLD.actor_label, '')
        THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'audit_log is append-only (op=%); set app.audit_internal_writer or app.audit_trim_worker GUC to bypass, or update only retention_override_days/legal_hold', TG_OP
        USING ERRCODE = 'check_violation';
END;

$fn$;

COMMIT;
