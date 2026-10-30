-- 2025_private_tenant_export_cutover.sql
--
-- Tenant export ZIPs formerly shared the public asset/CDN sink and persisted
-- its delivery URL in tenant_exports.download_url. Hiding that URL after
-- expires_at did not revoke a copied or CDN-cached URL. The runtime now writes
-- only to a dedicated private store and exposes an authenticated streaming
-- route. Quarantine every legacy row for delete-only cleanup and make any
-- future attempt to persist a delivery URL fail at the database boundary.

BEGIN;

UPDATE tenant_exports
   SET status = 'expired',
       expires_at = LEAST(COALESCE(expires_at, now()), now()),
       completed_at = COALESCE(completed_at, now()),
       error = COALESCE(
         NULLIF(error, ''),
         'Legacy public export revoked during private-storage cutover.'
       )
 WHERE NULLIF(btrim(download_url), '') IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_tenant_export_delivery_url()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.download_url IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.download_url IS DISTINCT FROM NEW.download_url) THEN
    RAISE EXCEPTION 'tenant export delivery URLs are forbidden; use the authenticated private download route'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenant_exports_reject_delivery_url ON tenant_exports;
CREATE TRIGGER tenant_exports_reject_delivery_url
BEFORE INSERT OR UPDATE OF download_url ON tenant_exports
FOR EACH ROW
EXECUTE FUNCTION reject_tenant_export_delivery_url();

REVOKE ALL ON FUNCTION reject_tenant_export_delivery_url() FROM PUBLIC;

COMMENT ON COLUMN tenant_exports.download_url IS
  'Legacy delete-routing marker only. New non-NULL values are rejected; clients receive an authenticated tenant-bound download path synthesized by the API.';
COMMENT ON COLUMN tenant_exports.object_key IS
  'Opaque server-side private export object key; never expose through API responses.';

COMMIT;

