-- 2016_campaign_assurance_raw_output_write_receipts.sql
--
-- Durable, exact-version write provenance for Campaign Assurance raw model
-- output. The intent is committed before S3 PutObject. The immutable version
-- receipt is committed only after exact-VersionId HeadObject verification, and
-- an extraction trigger refuses new object references without that receipt.
--
-- Orphan cleanup uses bounded SKIP LOCKED leases. Claiming a cleanup and
-- linking an extraction both update/lock the same intent row, so an object
-- cannot be deleted while an extraction concurrently starts referring to it.
-- Every storage deletion is represented by a hash-bound append-only receipt;
-- the application role receives no DELETE/TRUNCATE authority.
--
-- rollback-strategy: no-op. Write, version, and cleanup receipts are security
-- and erasure evidence and must not be discarded during rollback.

BEGIN;

CREATE TABLE campaign_assurance_raw_output_write_intents (
    tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id                        uuid NOT NULL,
    object_rest               text NOT NULL CHECK (
                                  length(object_rest) BETWEEN 1 AND 1800
                                  AND object_rest ~
                                    '^campaign-assurance/raw-output/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}(/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}){0,27}/writes/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$'
                                  AND object_rest LIKE '%/writes/' || id::text || '.json'
                              ),
    object_key                text NOT NULL CHECK (
                                  length(object_key) BETWEEN 1 AND 2000
                                  AND object_key = 'tenants/' || tenant_id::text || '/' || object_rest
                              ),
    object_ref                text NOT NULL CHECK (
                                  length(object_ref) BETWEEN 1 AND 2000
                                  AND object_ref = 'postwave.tenant-object-ref.v1:' || object_rest
                              ),
    content_sha256            text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    checksum_sha256_base64    text NOT NULL CHECK (
                                  checksum_sha256_base64 ~ '^[A-Za-z0-9+/]{43}=$'
                                  AND encode(decode(checksum_sha256_base64, 'base64'), 'hex') = content_sha256
                              ),
    content_type              text NOT NULL CHECK (content_type = 'application/json'),
    byte_size                 bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 131072),
    bucket                    text NOT NULL CHECK (
                                  length(bucket) BETWEEN 1 AND 255 AND bucket !~ '[[:cntrl:]]'
                              ),
    kms_key_id_sha256         text NOT NULL CHECK (kms_key_id_sha256 ~ '^[0-9a-f]{64}$'),

    state                     text NOT NULL DEFAULT 'pending' CHECK (
                                  state IN (
                                    'pending', 'ready', 'linked', 'cleanup_leased',
                                    'cleanup_retry', 'cleaned'
                                  )
                              ),
    attempt_count             bigint NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    lease_token               uuid,
    lease_owner               text CHECK (
                                  lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 200
                              ),
    lease_expires_at          timestamptz,
    retry_not_before          timestamptz,
    last_failure_code         text CHECK (
                                  last_failure_code IS NULL OR
                                  last_failure_code ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'
                              ),
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    completed_at              timestamptz,

    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, object_rest),
    UNIQUE (tenant_id, object_key),
    UNIQUE (tenant_id, object_ref),
    CONSTRAINT campaign_assurance_raw_output_write_intent_state_shape CHECK (
        (state IN ('pending', 'ready', 'linked')
            AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL
            AND retry_not_before IS NULL AND completed_at IS NULL)
        OR
        (state = 'cleanup_retry'
            AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL
            AND retry_not_before IS NOT NULL AND completed_at IS NULL)
        OR
        (state = 'cleanup_leased'
            AND lease_token IS NOT NULL AND lease_owner IS NOT NULL
            AND lease_expires_at IS NOT NULL AND retry_not_before IS NULL
            AND attempt_count >= 1 AND completed_at IS NULL)
        OR
        (state = 'cleaned'
            AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL
            AND retry_not_before IS NULL AND last_failure_code IS NULL
            AND completed_at IS NOT NULL)
    )
);

CREATE INDEX campaign_assurance_raw_output_write_orphans_due_idx
    ON campaign_assurance_raw_output_write_intents (
        retry_not_before, created_at, tenant_id, id
    ) WHERE state IN ('pending', 'ready', 'cleanup_retry', 'cleanup_leased');

CREATE TABLE campaign_assurance_raw_output_write_receipts (
    tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    intent_id                   uuid NOT NULL,
    resolved_by_claim_token     uuid,
    storage_backend             text NOT NULL CHECK (storage_backend = 's3'),
    bucket                      text NOT NULL CHECK (
                                    length(bucket) BETWEEN 1 AND 255 AND bucket !~ '[[:cntrl:]]'
                                ),
    object_key                  text NOT NULL CHECK (
                                    length(object_key) BETWEEN 1 AND 2000 AND object_key !~ '[[:cntrl:]]'
                                ),
    storage_version_id          text NOT NULL CHECK (
                                    length(storage_version_id) BETWEEN 1 AND 1024
                                    AND storage_version_id !~ '[[:cntrl:]]'
                                ),
    storage_version_sha256      text NOT NULL CHECK (storage_version_sha256 ~ '^[0-9a-f]{64}$'),
    content_sha256              text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    checksum_sha256_base64      text NOT NULL CHECK (
                                    checksum_sha256_base64 ~ '^[A-Za-z0-9+/]{43}=$'
                                    AND encode(decode(checksum_sha256_base64, 'base64'), 'hex') = content_sha256
                                ),
    content_type                text NOT NULL CHECK (content_type = 'application/json'),
    byte_size                   bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 131072),
    kms_key_id_sha256           text NOT NULL CHECK (kms_key_id_sha256 ~ '^[0-9a-f]{64}$'),
    provider_proof_sha256       text NOT NULL CHECK (provider_proof_sha256 ~ '^[0-9a-f]{64}$'),
    receipt_hash                text NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
    recorded_at                 timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, intent_id),
    UNIQUE (tenant_id, object_key),
    CONSTRAINT campaign_assurance_raw_output_write_receipt_intent_fk
        FOREIGN KEY (tenant_id, intent_id)
        REFERENCES campaign_assurance_raw_output_write_intents (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_raw_output_write_version_hash CHECK (
        storage_version_sha256 = encode(
            digest(convert_to(storage_version_id, 'UTF8'), 'sha256'), 'hex'
        )
    )
);

CREATE TABLE campaign_assurance_raw_output_cleanup_receipts (
    tenant_id                    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id                           uuid NOT NULL DEFAULT gen_random_uuid(),
    intent_id                    uuid NOT NULL,
    attempt_no                   bigint NOT NULL CHECK (attempt_no >= 1),
    claim_token                  uuid NOT NULL,
    outcome                      text NOT NULL CHECK (
                                     outcome IN ('deleted', 'already_missing', 'failure')
                                 ),
    object_ref_sha256            text NOT NULL CHECK (object_ref_sha256 ~ '^[0-9a-f]{64}$'),
    content_sha256               text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    version_receipt_hash         text CHECK (
                                     version_receipt_hash IS NULL OR version_receipt_hash ~ '^[0-9a-f]{64}$'
                                 ),
    requested_version_sha256     text CHECK (
                                     requested_version_sha256 IS NULL OR requested_version_sha256 ~ '^[0-9a-f]{64}$'
                                 ),
    response_version_sha256      text CHECK (
                                     response_version_sha256 IS NULL OR response_version_sha256 ~ '^[0-9a-f]{64}$'
                                 ),
    delete_marker                boolean NOT NULL DEFAULT false,
    provider_request_id_sha256   text CHECK (
                                     provider_request_id_sha256 IS NULL OR
                                     provider_request_id_sha256 ~ '^[0-9a-f]{64}$'
                                 ),
    failure_code                 text CHECK (
                                     failure_code IS NULL OR
                                     failure_code ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'
                                 ),
    failure_sha256               text CHECK (
                                     failure_sha256 IS NULL OR failure_sha256 ~ '^[0-9a-f]{64}$'
                                 ),
    worker_id_sha256             text NOT NULL CHECK (worker_id_sha256 ~ '^[0-9a-f]{64}$'),
    receipt_hash                 text NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
    recorded_at                  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, intent_id, attempt_no),
    CONSTRAINT campaign_assurance_raw_output_cleanup_intent_fk
        FOREIGN KEY (tenant_id, intent_id)
        REFERENCES campaign_assurance_raw_output_write_intents (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_raw_output_cleanup_shape CHECK (
        (outcome = 'deleted'
            AND version_receipt_hash IS NOT NULL
            AND requested_version_sha256 IS NOT NULL
            AND failure_code IS NULL AND failure_sha256 IS NULL)
        OR
        (outcome = 'already_missing'
            AND failure_code IS NULL AND failure_sha256 IS NULL
            AND NOT delete_marker
            AND response_version_sha256 IS NULL
            AND provider_request_id_sha256 IS NULL
            AND (
                (version_receipt_hash IS NULL AND requested_version_sha256 IS NULL)
                OR
                (version_receipt_hash IS NOT NULL AND requested_version_sha256 IS NOT NULL)
            ))
        OR
        (outcome = 'failure'
            AND failure_code IS NOT NULL AND failure_sha256 IS NOT NULL
            AND response_version_sha256 IS NULL
            AND provider_request_id_sha256 IS NULL
            AND NOT delete_marker
            AND (
                (version_receipt_hash IS NULL AND requested_version_sha256 IS NULL)
                OR
                (version_receipt_hash IS NOT NULL AND requested_version_sha256 IS NOT NULL)
            ))
    )
);

CREATE UNIQUE INDEX campaign_assurance_raw_output_cleanup_success_once_idx
    ON campaign_assurance_raw_output_cleanup_receipts (tenant_id, intent_id)
    WHERE outcome IN ('deleted', 'already_missing');

CREATE OR REPLACE FUNCTION campaign_assurance_raw_output_write_evidence_immutable()
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
    RAISE EXCEPTION 'campaign assurance raw-output write evidence is immutable'
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER campaign_assurance_raw_output_write_receipts_immutable
    BEFORE UPDATE OR DELETE ON campaign_assurance_raw_output_write_receipts
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_raw_output_write_evidence_immutable();

CREATE TRIGGER campaign_assurance_raw_output_cleanup_receipts_immutable
    BEFORE UPDATE OR DELETE ON campaign_assurance_raw_output_cleanup_receipts
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_raw_output_write_evidence_immutable();

CREATE OR REPLACE FUNCTION campaign_assurance_raw_output_write_intent_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'campaign assurance raw-output write intents cannot be deleted'
            USING ERRCODE = '55000';
    END IF;
    IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'raw-output write intent mutation requires worker scope'
            USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'INSERT' AND (
        NEW.state <> 'pending' OR NEW.attempt_count <> 0 OR
        NEW.lease_token IS NOT NULL OR NEW.lease_owner IS NOT NULL OR
        NEW.lease_expires_at IS NOT NULL OR NEW.retry_not_before IS NOT NULL OR
        NEW.last_failure_code IS NOT NULL OR NEW.completed_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'new raw-output write intent is not pending'
            USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'UPDATE' AND (
        NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR
        NEW.object_rest <> OLD.object_rest OR NEW.object_key <> OLD.object_key OR
        NEW.object_ref <> OLD.object_ref OR NEW.content_sha256 <> OLD.content_sha256 OR
        NEW.checksum_sha256_base64 <> OLD.checksum_sha256_base64 OR
        NEW.content_type <> OLD.content_type OR NEW.byte_size <> OLD.byte_size OR
        NEW.bucket <> OLD.bucket OR NEW.kms_key_id_sha256 <> OLD.kms_key_id_sha256 OR
        NEW.created_at <> OLD.created_at OR NEW.attempt_count < OLD.attempt_count OR
        (OLD.state = 'cleaned' AND NEW.state <> 'cleaned') OR
        (OLD.state = 'linked' AND NEW.state <> 'linked') OR
        (OLD.state = 'pending' AND NEW.state NOT IN ('pending', 'ready', 'cleanup_leased')) OR
        (OLD.state = 'ready' AND NEW.state NOT IN ('ready', 'linked', 'cleanup_leased')) OR
        (OLD.state = 'cleanup_retry' AND NEW.state NOT IN ('cleanup_retry', 'cleanup_leased')) OR
        (OLD.state = 'cleanup_leased' AND NEW.state NOT IN ('cleanup_leased', 'cleanup_retry', 'cleaned'))
    ) THEN
        RAISE EXCEPTION 'raw-output write intent identity or transition is invalid'
            USING ERRCODE = '55000';
    END IF;
    NEW.updated_at := statement_timestamp();
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_raw_output_write_intents_guard
    BEFORE INSERT OR UPDATE OR DELETE ON campaign_assurance_raw_output_write_intents
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_raw_output_write_intent_guard();

CREATE OR REPLACE FUNCTION campaign_assurance_raw_output_write_receipt_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    intent campaign_assurance_raw_output_write_intents%ROWTYPE;
BEGIN
    IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'raw-output version receipt requires worker scope'
            USING ERRCODE = '42501';
    END IF;
    SELECT * INTO intent
      FROM public.campaign_assurance_raw_output_write_intents
     WHERE tenant_id = NEW.tenant_id AND id = NEW.intent_id
     FOR UPDATE;
    IF NOT FOUND OR intent.state NOT IN ('pending', 'ready', 'cleanup_leased')
       OR intent.bucket <> NEW.bucket OR intent.object_key <> NEW.object_key
       OR intent.content_sha256 <> NEW.content_sha256
       OR intent.checksum_sha256_base64 <> NEW.checksum_sha256_base64
       OR intent.content_type <> NEW.content_type OR intent.byte_size <> NEW.byte_size
       OR intent.kms_key_id_sha256 <> NEW.kms_key_id_sha256
       OR NEW.storage_version_sha256 <>
            encode(digest(convert_to(NEW.storage_version_id, 'UTF8'), 'sha256'), 'hex')
       OR (intent.state = 'cleanup_leased' AND (
            NEW.resolved_by_claim_token IS DISTINCT FROM intent.lease_token
            OR intent.lease_expires_at <= statement_timestamp()
       ))
       OR (intent.state IN ('pending', 'ready') AND NEW.resolved_by_claim_token IS NOT NULL) THEN
        RAISE EXCEPTION 'raw-output version receipt is not bound to its exact write intent'
            USING ERRCODE = '55000';
    END IF;
    NEW.receipt_hash := encode(digest(convert_to(
        jsonb_build_object(
            'tenant_id', NEW.tenant_id::text,
            'intent_id', NEW.intent_id::text,
            'storage_backend', NEW.storage_backend,
            'bucket', NEW.bucket,
            'object_key_sha256', encode(digest(convert_to(NEW.object_key, 'UTF8'), 'sha256'), 'hex'),
            'storage_version_sha256', NEW.storage_version_sha256,
            'content_sha256', NEW.content_sha256,
            'checksum_sha256_base64', NEW.checksum_sha256_base64,
            'content_type', NEW.content_type,
            'byte_size', NEW.byte_size,
            'kms_key_id_sha256', NEW.kms_key_id_sha256,
            'provider_proof_sha256', NEW.provider_proof_sha256
        )::text, 'UTF8'), 'sha256'), 'hex');
    IF intent.state = 'pending' THEN
        UPDATE public.campaign_assurance_raw_output_write_intents
           SET state = 'ready'
         WHERE tenant_id = intent.tenant_id AND id = intent.id;
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_raw_output_write_receipt_insert
    BEFORE INSERT ON campaign_assurance_raw_output_write_receipts
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_raw_output_write_receipt_guard();

CREATE OR REPLACE FUNCTION campaign_assurance_raw_output_cleanup_receipt_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    intent campaign_assurance_raw_output_write_intents%ROWTYPE;
    version campaign_assurance_raw_output_write_receipts%ROWTYPE;
BEGIN
    IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'raw-output cleanup receipt requires worker scope'
            USING ERRCODE = '42501';
    END IF;
    SELECT * INTO intent
      FROM public.campaign_assurance_raw_output_write_intents
     WHERE tenant_id = NEW.tenant_id AND id = NEW.intent_id
     FOR UPDATE;
    IF NOT FOUND OR intent.state <> 'cleanup_leased'
       OR intent.attempt_count <> NEW.attempt_no OR intent.lease_token <> NEW.claim_token
       OR intent.lease_expires_at <= statement_timestamp()
       OR NEW.object_ref_sha256 <>
            encode(digest(convert_to(intent.object_ref, 'UTF8'), 'sha256'), 'hex')
       OR NEW.content_sha256 <> intent.content_sha256
       OR NEW.worker_id_sha256 <>
            encode(digest(convert_to(intent.lease_owner, 'UTF8'), 'sha256'), 'hex')
       OR EXISTS (
            SELECT 1 FROM public.campaign_assurance_extractions extraction
             WHERE extraction.tenant_id = intent.tenant_id
               AND extraction.raw_output_object_ref = intent.object_ref
       ) THEN
        RAISE EXCEPTION 'raw-output cleanup receipt is not bound to an unreferenced active lease'
            USING ERRCODE = '55000';
    END IF;
    SELECT * INTO version
      FROM public.campaign_assurance_raw_output_write_receipts
     WHERE tenant_id = intent.tenant_id AND intent_id = intent.id;
    IF NEW.outcome = 'deleted' AND (
        NOT FOUND OR NEW.version_receipt_hash <> version.receipt_hash OR
        NEW.requested_version_sha256 <> version.storage_version_sha256 OR
        (NEW.response_version_sha256 IS NOT NULL AND
         NEW.response_version_sha256 <> version.storage_version_sha256)
    ) THEN
        RAISE EXCEPTION 'raw-output deletion does not name the durable exact version'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.outcome = 'already_missing' AND (
        (FOUND AND (
            NEW.version_receipt_hash IS NULL OR
            NEW.requested_version_sha256 IS NULL OR
            NEW.version_receipt_hash <> version.receipt_hash OR
            NEW.requested_version_sha256 <> version.storage_version_sha256
        ))
        OR
        (NOT FOUND AND (
            NEW.version_receipt_hash IS NOT NULL OR
            NEW.requested_version_sha256 IS NOT NULL
        ))
    ) THEN
        RAISE EXCEPTION 'raw-output missing receipt does not name the durable exact version'
            USING ERRCODE = '55000';
    END IF;
    IF NEW.outcome = 'failure' AND NEW.version_receipt_hash IS NOT NULL AND (
        NOT FOUND OR NEW.version_receipt_hash <> version.receipt_hash OR
        NEW.requested_version_sha256 <> version.storage_version_sha256
    ) THEN
        RAISE EXCEPTION 'raw-output cleanup failure does not name the durable exact version'
            USING ERRCODE = '55000';
    END IF;
    NEW.receipt_hash := encode(digest(convert_to(
        jsonb_strip_nulls(jsonb_build_object(
            'tenant_id', NEW.tenant_id::text,
            'intent_id', NEW.intent_id::text,
            'attempt_no', NEW.attempt_no,
            'claim_token', NEW.claim_token::text,
            'outcome', NEW.outcome,
            'object_ref_sha256', NEW.object_ref_sha256,
            'content_sha256', NEW.content_sha256,
            'version_receipt_hash', NEW.version_receipt_hash,
            'requested_version_sha256', NEW.requested_version_sha256,
            'response_version_sha256', NEW.response_version_sha256,
            'delete_marker', NEW.delete_marker,
            'provider_request_id_sha256', NEW.provider_request_id_sha256,
            'failure_code', NEW.failure_code,
            'failure_sha256', NEW.failure_sha256,
            'worker_id_sha256', NEW.worker_id_sha256
        ))::text, 'UTF8'), 'sha256'), 'hex');
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_raw_output_cleanup_receipt_insert
    BEFORE INSERT ON campaign_assurance_raw_output_cleanup_receipts
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_raw_output_cleanup_receipt_guard();

-- This BEFORE trigger is the publication boundary: a new unique raw-output
-- reference is accepted only after its exact S3 version receipt exists.
-- Pre-v2016 rows remain intact, but a rolling old worker cannot publish another
-- extraction until it has been upgraded to the receipt-aware writer.
CREATE OR REPLACE FUNCTION campaign_assurance_raw_output_write_receipt_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    intent campaign_assurance_raw_output_write_intents%ROWTYPE;
BEGIN
    IF NEW.raw_output_object_ref IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO intent
      FROM public.campaign_assurance_raw_output_write_intents candidate
     WHERE candidate.tenant_id = NEW.tenant_id
       AND candidate.object_ref = NEW.raw_output_object_ref
     FOR UPDATE;
    IF FOUND THEN
        IF intent.content_sha256 <> NEW.raw_output_hash
           OR intent.state NOT IN ('ready', 'linked')
           OR NOT EXISTS (
                SELECT 1
                  FROM public.campaign_assurance_raw_output_write_receipts receipt
                 WHERE receipt.tenant_id = intent.tenant_id
                   AND receipt.intent_id = intent.id
                   AND receipt.content_sha256 = intent.content_sha256
           ) THEN
            RAISE EXCEPTION 'raw-output extraction lacks a ready exact-version write receipt'
                USING ERRCODE = '55000';
        END IF;
        IF intent.state = 'ready' THEN
            UPDATE public.campaign_assurance_raw_output_write_intents
               SET state = 'linked'
             WHERE tenant_id = intent.tenant_id AND id = intent.id;
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'new raw-output extraction reference has no durable write receipt'
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER campaign_assurance_extractions_raw_output_write_receipt_gate
    BEFORE INSERT ON campaign_assurance_extractions
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_raw_output_write_receipt_gate();

ALTER TABLE campaign_assurance_raw_output_write_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_raw_output_write_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_raw_output_write_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_raw_output_write_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_raw_output_cleanup_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_raw_output_cleanup_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_assurance_raw_output_write_intents_worker
    ON campaign_assurance_raw_output_write_intents FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY campaign_assurance_raw_output_write_receipts_worker_select
    ON campaign_assurance_raw_output_write_receipts FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY campaign_assurance_raw_output_write_receipts_worker_insert
    ON campaign_assurance_raw_output_write_receipts FOR INSERT TO postwave_app
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY campaign_assurance_raw_output_cleanup_receipts_worker_select
    ON campaign_assurance_raw_output_cleanup_receipts FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY campaign_assurance_raw_output_cleanup_receipts_worker_insert
    ON campaign_assurance_raw_output_cleanup_receipts FOR INSERT TO postwave_app
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON campaign_assurance_raw_output_write_intents TO postwave_app;
GRANT SELECT, INSERT ON campaign_assurance_raw_output_write_receipts TO postwave_app;
GRANT SELECT, INSERT ON campaign_assurance_raw_output_cleanup_receipts TO postwave_app;

REVOKE DELETE, TRUNCATE ON campaign_assurance_raw_output_write_intents FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_raw_output_write_receipts FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_raw_output_cleanup_receipts FROM postwave_app;

COMMENT ON TABLE campaign_assurance_raw_output_write_intents IS
    'Durable pre-S3 intents and bounded orphan-cleanup leases for Campaign Assurance raw model output.';
COMMENT ON TABLE campaign_assurance_raw_output_write_receipts IS
    'Immutable exact S3 VersionId, checksum, size, SSE-KMS, and provider-proof receipts committed before extraction publication.';
COMMENT ON TABLE campaign_assurance_raw_output_cleanup_receipts IS
    'Immutable exact-version orphan/compensation deletion and failure receipts; provider request IDs are hash-only.';

COMMIT;
