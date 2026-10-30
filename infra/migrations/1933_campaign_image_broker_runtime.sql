-- 1933_campaign_image_broker_runtime.sql
--
-- Tenant-isolated exact-content OCR cache plus immutable versioned raster
-- evidence and exact-version deletion receipts for Campaign Assurance.
-- Expired cache rows may be removed only by the bounded outbox-worker scope;
-- evidence metadata and deletion receipts remain append-only audit records.
--
-- rollback-strategy: no-op. Dropping these tables would destroy retention and
-- deletion evidence and could make a deleted S3 version appear live again.

BEGIN;

CREATE TABLE campaign_image_ocr_cache_entries (
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    asset_sha256         text NOT NULL CHECK (asset_sha256 ~ '^[0-9a-f]{64}$'),
    raster_sha256        text NOT NULL CHECK (raster_sha256 ~ '^[0-9a-f]{64}$'),
    ocr_runtime_version  text NOT NULL CHECK (
                             ocr_runtime_version ~ '^[a-z0-9][a-z0-9._-]{0,159}$'
                         ),
    engine               text NOT NULL CHECK (
                             engine ~ '^[a-z0-9][a-z0-9._-]{0,159}$'
                         ),
    engine_version       text NOT NULL CHECK (
                             engine_version ~ '^[a-z0-9][a-z0-9._-]{0,159}$'
                         ),
    language_hint        text NOT NULL CHECK (
                             length(language_hint) BETWEEN 1 AND 64
                             AND language_hint !~ '[[:cntrl:]]'
                         ),
    ocr_text             text NOT NULL CHECK (
                             octet_length(ocr_text) BETWEEN 1 AND 32768
                             AND ocr_text !~ E'[\\x00]'
                         ),
    ocr_language         text NOT NULL CHECK (
                             length(ocr_language) BETWEEN 1 AND 64
                             AND ocr_language !~ '[[:cntrl:]]'
                         ),
    ocr_confidence       double precision CHECK (
                             ocr_confidence IS NULL
                             OR ocr_confidence BETWEEN 0 AND 1
                         ),
    output_hash          text NOT NULL CHECK (output_hash ~ '^[0-9a-f]{64}$'),
    created_at           timestamptz NOT NULL DEFAULT now(),
    expires_at           timestamptz NOT NULL CHECK (expires_at > created_at),
    PRIMARY KEY (
        tenant_id, asset_sha256, raster_sha256, ocr_runtime_version,
        engine, engine_version, language_hint
    )
);

CREATE INDEX campaign_image_ocr_cache_expiry_idx
    ON campaign_image_ocr_cache_entries (expires_at, tenant_id);

CREATE TABLE campaign_image_raster_evidence (
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id                 uuid NOT NULL DEFAULT gen_random_uuid(),
    object_key         text NOT NULL CHECK (
                           length(object_key) BETWEEN 1 AND 1024
                           AND object_key !~ E'[\\x00\\r\\n]'
                           AND object_key !~ '(^|/)\\.\\.?(/|$)'
                       ),
    bucket             text NOT NULL CHECK (
                           bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
                           AND bucket !~ '\\.\\.'
                       ),
    storage_version_id text NOT NULL CHECK (
                           length(storage_version_id) BETWEEN 1 AND 1024
                           AND storage_version_id !~ '[[:cntrl:]]'
                       ),
    kms_key_id_hash    text NOT NULL CHECK (kms_key_id_hash ~ '^[0-9a-f]{64}$'),
    raster_sha256      text NOT NULL CHECK (raster_sha256 ~ '^[0-9a-f]{64}$'),
    media_type         text NOT NULL CHECK (media_type = 'image/png'),
    byte_size          bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
    created_at         timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL CHECK (expires_at > created_at),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, object_key, storage_version_id)
);

CREATE INDEX campaign_image_raster_evidence_expiry_idx
    ON campaign_image_raster_evidence (expires_at, tenant_id, id);
CREATE INDEX campaign_image_raster_evidence_object_idx
    ON campaign_image_raster_evidence (tenant_id, object_key, created_at DESC);

CREATE TABLE campaign_image_raster_deletion_receipts (
    tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    evidence_id                uuid NOT NULL,
    object_key_sha256          text NOT NULL CHECK (
                                   object_key_sha256 ~ '^[0-9a-f]{64}$'
                               ),
    requested_storage_version text NOT NULL CHECK (
                                   length(requested_storage_version) BETWEEN 1 AND 1024
                                   AND requested_storage_version !~ '[[:cntrl:]]'
                               ),
    response_storage_version  text CHECK (
                                   response_storage_version IS NULL
                                   OR (length(response_storage_version) BETWEEN 1 AND 1024
                                       AND response_storage_version !~ '[[:cntrl:]]')
                               ),
    delete_marker             boolean NOT NULL DEFAULT false,
    provider_request_id_hash  text CHECK (
                                   provider_request_id_hash IS NULL
                                   OR provider_request_id_hash ~ '^[0-9a-f]{64}$'
                               ),
    receipt_hash              text NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
    deleted_at                timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, evidence_id),
    CONSTRAINT campaign_image_raster_deletion_evidence_fk
        FOREIGN KEY (tenant_id, evidence_id)
        REFERENCES campaign_image_raster_evidence (tenant_id, id)
        ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION campaign_image_immutable_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
    ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'campaign image evidence is immutable'
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER campaign_image_raster_evidence_immutable
BEFORE UPDATE OR DELETE ON campaign_image_raster_evidence
FOR EACH ROW EXECUTE FUNCTION campaign_image_immutable_evidence_guard();

CREATE TRIGGER campaign_image_raster_deletion_receipts_immutable
BEFORE UPDATE OR DELETE ON campaign_image_raster_deletion_receipts
FOR EACH ROW EXECUTE FUNCTION campaign_image_immutable_evidence_guard();

CREATE OR REPLACE FUNCTION campaign_image_raster_deletion_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    evidence campaign_image_raster_evidence%ROWTYPE;
BEGIN
    IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'campaign image raster deletion requires worker scope'
            USING ERRCODE = '42501';
    END IF;
    SELECT * INTO evidence
    FROM public.campaign_image_raster_evidence
    WHERE tenant_id = NEW.tenant_id AND id = NEW.evidence_id;
    IF NOT FOUND OR evidence.expires_at > statement_timestamp()
       OR evidence.storage_version_id <> NEW.requested_storage_version
       OR encode(digest(convert_to(evidence.object_key, 'UTF8'), 'sha256'), 'hex')
            <> NEW.object_key_sha256
       OR (NEW.response_storage_version IS NOT NULL
           AND NEW.response_storage_version <> evidence.storage_version_id) THEN
        RAISE EXCEPTION 'campaign image raster deletion is not exact-version expired evidence'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_image_raster_deletion_receipts_insert_guard
BEFORE INSERT ON campaign_image_raster_deletion_receipts
FOR EACH ROW EXECUTE FUNCTION campaign_image_raster_deletion_insert_guard();

CREATE OR REPLACE FUNCTION campaign_image_ocr_cache_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
    ) THEN
        RETURN OLD;
    END IF;
    IF TG_OP = 'DELETE'
       AND current_setting('app.outbox_worker', true) = 'true'
       AND OLD.expires_at <= statement_timestamp() THEN
        RETURN OLD;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'campaign image OCR cache entry is not expired or worker-scoped'
            USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'campaign image OCR cache entries are immutable'
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER campaign_image_ocr_cache_immutable
BEFORE UPDATE OR DELETE ON campaign_image_ocr_cache_entries
FOR EACH ROW EXECUTE FUNCTION campaign_image_ocr_cache_guard();

ALTER TABLE campaign_image_ocr_cache_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_image_ocr_cache_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_image_raster_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_image_raster_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_image_raster_deletion_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_image_raster_deletion_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_image_ocr_cache_scope
    ON campaign_image_ocr_cache_entries
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
CREATE POLICY campaign_image_ocr_cache_tenant_select
    ON campaign_image_ocr_cache_entries FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_image_ocr_cache_worker_insert
    ON campaign_image_ocr_cache_entries FOR INSERT TO postwave_app
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY campaign_image_ocr_cache_worker_select
    ON campaign_image_ocr_cache_entries FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY campaign_image_ocr_cache_worker_delete
    ON campaign_image_ocr_cache_entries FOR DELETE TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY campaign_image_raster_evidence_scope
    ON campaign_image_raster_evidence
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
CREATE POLICY campaign_image_raster_evidence_tenant_select
    ON campaign_image_raster_evidence FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_image_raster_evidence_worker_insert
    ON campaign_image_raster_evidence FOR INSERT TO postwave_app
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY campaign_image_raster_evidence_worker_select
    ON campaign_image_raster_evidence FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY campaign_image_raster_deletion_scope
    ON campaign_image_raster_deletion_receipts
    AS RESTRICTIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
CREATE POLICY campaign_image_raster_deletion_tenant_select
    ON campaign_image_raster_deletion_receipts FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_image_raster_deletion_worker_select
    ON campaign_image_raster_deletion_receipts FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY campaign_image_raster_deletion_worker_insert
    ON campaign_image_raster_deletion_receipts FOR INSERT TO postwave_app
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

GRANT SELECT, INSERT, DELETE ON campaign_image_ocr_cache_entries TO postwave_app;
GRANT SELECT, INSERT ON campaign_image_raster_evidence TO postwave_app;
GRANT SELECT, INSERT ON campaign_image_raster_deletion_receipts TO postwave_app;

REVOKE UPDATE, TRUNCATE ON campaign_image_ocr_cache_entries FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON campaign_image_raster_evidence FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON campaign_image_raster_deletion_receipts FROM postwave_app;

COMMIT;
