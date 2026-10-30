-- 2013_campaign_assurance_raw_output_retention.sql
--
-- Exact-version, legal-hold-aware retention for Campaign Assurance raw model
-- output. The existing uploads.Store delete surface is intentionally NOT
-- sufficient: it deletes the current object by key and cannot prove which
-- immutable storage version was removed. This ledger therefore requires a
-- durable version-resolution receipt before a deletion can be attempted.
-- Unversioned storage stays fail-closed and produces an immutable failure
-- receipt; it never silently falls back to key-only deletion.
--
-- Operational tasks are leased and retryable. Version-resolution and attempt
-- receipts are append-only. A tenant advisory transaction fence serializes the
-- final external delete with legal-hold placement/release, closing the race in
-- which a hold could commit between the last database check and object removal.
--
-- rollback-strategy: no-op. These ledgers are evidence of deletion attempts
-- and exact object versions; dropping them would erase retention provenance.

BEGIN;

CREATE TABLE campaign_assurance_raw_output_retention_tasks (
    tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id                        uuid NOT NULL DEFAULT gen_random_uuid(),
    object_ref                text NOT NULL CHECK (
                                  length(object_ref) BETWEEN 1 AND 2000
                                  AND object_ref ~
                                    '^postwave\.tenant-object-ref\.v1:campaign-assurance/raw-output/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}(/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}){0,29}$'
                              ),
    object_ref_sha256         text NOT NULL CHECK (object_ref_sha256 ~ '^[0-9a-f]{64}$'),
    raw_output_sha256         text NOT NULL CHECK (raw_output_sha256 ~ '^[0-9a-f]{64}$'),
    raw_output_expires_at     timestamptz NOT NULL,
    source_extraction_id      uuid NOT NULL,
    source_receipt_sha256     text NOT NULL CHECK (source_receipt_sha256 ~ '^[0-9a-f]{64}$'),
    source_manifest_sha256    text NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
    campaign_ids              uuid[] NOT NULL CHECK (
                                  cardinality(campaign_ids) BETWEEN 1 AND 1000
                              ),
    campaign_scope_sha256     text NOT NULL CHECK (campaign_scope_sha256 ~ '^[0-9a-f]{64}$'),

    state                     text NOT NULL DEFAULT 'pending' CHECK (
                                  state IN ('pending', 'leased', 'retry', 'complete')
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
    UNIQUE (tenant_id, object_ref),
    CONSTRAINT campaign_assurance_raw_output_task_ref_hash_check CHECK (
        object_ref_sha256 = encode(digest(convert_to(object_ref, 'UTF8'), 'sha256'), 'hex')
    ),
    CONSTRAINT campaign_assurance_raw_output_task_state_shape_check CHECK (
        (state IN ('pending', 'retry')
            AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL
            AND completed_at IS NULL)
        OR
        (state = 'leased'
            AND lease_token IS NOT NULL AND lease_owner IS NOT NULL
            AND lease_expires_at IS NOT NULL AND attempt_count >= 1
            AND completed_at IS NULL)
        OR
        (state = 'complete'
            AND lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL
            AND retry_not_before IS NULL AND last_failure_code IS NULL
            AND completed_at IS NOT NULL)
    )
);

CREATE INDEX campaign_assurance_raw_output_retention_due_idx
    ON campaign_assurance_raw_output_retention_tasks (
        retry_not_before, raw_output_expires_at, tenant_id, id
    ) WHERE state IN ('pending', 'retry', 'leased');

-- Seed every still-referenced raw object now, including objects whose expiry is
-- in the future. The task deliberately has no FK to the extraction/run: it has
-- to survive campaign deletion so the object does not become an unreachable
-- orphan before its retention clock elapses. Conflicting identities fail the
-- migration instead of selecting an arbitrary hash/version lineage.
DO $fn$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM campaign_assurance_extractions
         WHERE raw_output_object_ref IS NOT NULL
         GROUP BY tenant_id, raw_output_object_ref
        HAVING count(DISTINCT raw_output_hash) <> 1
            OR count(DISTINCT raw_output_expires_at) <> 1
    ) THEN
        RAISE EXCEPTION 'raw-output references have conflicting hash or expiry identity'
            USING ERRCODE = '55000';
    END IF;
END;
$fn$;

INSERT INTO campaign_assurance_raw_output_retention_tasks (
    tenant_id, object_ref, object_ref_sha256, raw_output_sha256,
    raw_output_expires_at, source_extraction_id, source_receipt_sha256,
    source_manifest_sha256, campaign_ids, campaign_scope_sha256
)
SELECT extraction.tenant_id, extraction.raw_output_object_ref,
       encode(digest(convert_to(extraction.raw_output_object_ref, 'UTF8'), 'sha256'), 'hex'),
       min(extraction.raw_output_hash), min(extraction.raw_output_expires_at),
       (array_agg(extraction.id ORDER BY extraction.created_at, extraction.id))[1],
       (array_agg(extraction.receipt_hash ORDER BY extraction.created_at, extraction.id))[1],
       encode(digest(convert_to(
           string_agg(extraction.id::text || ':' || extraction.receipt_hash, ','
                      ORDER BY extraction.id::text), 'UTF8'), 'sha256'), 'hex'),
       array_agg(DISTINCT extraction.campaign_id ORDER BY extraction.campaign_id),
       encode(digest(convert_to(
           array_to_string(array_agg(DISTINCT extraction.campaign_id ORDER BY extraction.campaign_id), ','),
           'UTF8'), 'sha256'), 'hex')
  FROM campaign_assurance_extractions extraction
 WHERE extraction.raw_output_object_ref IS NOT NULL
 GROUP BY extraction.tenant_id, extraction.raw_output_object_ref;

CREATE TABLE campaign_assurance_raw_output_version_receipts (
    tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    task_id                   uuid NOT NULL,
    attempt_no                bigint NOT NULL CHECK (attempt_no >= 1),
    resolved_by_claim_token   uuid NOT NULL,
    storage_backend           text NOT NULL CHECK (
                                  storage_backend ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'
                              ),
    bucket                    text NOT NULL CHECK (
                                  length(bucket) BETWEEN 1 AND 255
                                  AND bucket !~ '[[:cntrl:]]'
                              ),
    storage_version_id        text NOT NULL CHECK (
                                  length(storage_version_id) BETWEEN 1 AND 1024
                                  AND storage_version_id !~ '[[:cntrl:]]'
                              ),
    content_sha256            text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    byte_size                 bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 1048576),
    provider_proof_sha256     text NOT NULL CHECK (provider_proof_sha256 ~ '^[0-9a-f]{64}$'),
    object_ref_sha256         text NOT NULL CHECK (object_ref_sha256 ~ '^[0-9a-f]{64}$'),
    storage_version_sha256    text NOT NULL CHECK (storage_version_sha256 ~ '^[0-9a-f]{64}$'),
    receipt_hash              text NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
    resolved_at               timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, task_id),
    CONSTRAINT campaign_assurance_raw_output_version_task_fk
        FOREIGN KEY (tenant_id, task_id)
        REFERENCES campaign_assurance_raw_output_retention_tasks (tenant_id, id)
        ON DELETE CASCADE
);

CREATE TABLE campaign_assurance_raw_output_retention_receipts (
    tenant_id                    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id                           uuid NOT NULL DEFAULT gen_random_uuid(),
    task_id                      uuid NOT NULL,
    attempt_no                   bigint NOT NULL CHECK (attempt_no >= 1),
    claim_token                  uuid NOT NULL,
    outcome                      text NOT NULL CHECK (outcome IN ('deleted', 'failure', 'deferred')),
    object_ref_sha256            text NOT NULL CHECK (object_ref_sha256 ~ '^[0-9a-f]{64}$'),
    raw_output_sha256            text NOT NULL CHECK (raw_output_sha256 ~ '^[0-9a-f]{64}$'),
    source_manifest_sha256       text NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
    campaign_scope_sha256        text NOT NULL CHECK (campaign_scope_sha256 ~ '^[0-9a-f]{64}$'),
    version_receipt_hash         text CHECK (
                                     version_receipt_hash IS NULL OR
                                     version_receipt_hash ~ '^[0-9a-f]{64}$'
                                 ),
    requested_version_sha256     text CHECK (
                                     requested_version_sha256 IS NULL OR
                                     requested_version_sha256 ~ '^[0-9a-f]{64}$'
                                 ),
    response_version_sha256      text CHECK (
                                     response_version_sha256 IS NULL OR
                                     response_version_sha256 ~ '^[0-9a-f]{64}$'
                                 ),
    delete_disposition           text CHECK (
                                     delete_disposition IS NULL OR
                                     delete_disposition IN ('deleted', 'already_missing')
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
    UNIQUE (tenant_id, task_id, attempt_no),
    CONSTRAINT campaign_assurance_raw_output_attempt_task_fk
        FOREIGN KEY (tenant_id, task_id)
        REFERENCES campaign_assurance_raw_output_retention_tasks (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT campaign_assurance_raw_output_attempt_shape_check CHECK (
        (outcome = 'deleted'
            AND version_receipt_hash IS NOT NULL
            AND requested_version_sha256 IS NOT NULL
            AND delete_disposition IS NOT NULL
            AND failure_code IS NULL AND failure_sha256 IS NULL)
        OR
        (outcome IN ('failure', 'deferred')
            AND failure_code IS NOT NULL AND failure_sha256 IS NOT NULL
            AND delete_disposition IS NULL
            AND response_version_sha256 IS NULL
            AND provider_request_id_sha256 IS NULL
            AND NOT delete_marker)
    )
);

CREATE UNIQUE INDEX campaign_assurance_raw_output_retention_deleted_once_idx
    ON campaign_assurance_raw_output_retention_receipts (tenant_id, task_id)
    WHERE outcome = 'deleted';

CREATE OR REPLACE FUNCTION campaign_assurance_raw_output_immutable_guard()
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
    RAISE EXCEPTION 'campaign assurance raw-output evidence is immutable'
        USING ERRCODE = '55000';
END;
$fn$;

CREATE TRIGGER campaign_assurance_raw_output_versions_immutable
    BEFORE UPDATE OR DELETE ON campaign_assurance_raw_output_version_receipts
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_raw_output_immutable_guard();

CREATE TRIGGER campaign_assurance_raw_output_attempts_immutable
    BEFORE UPDATE OR DELETE ON campaign_assurance_raw_output_retention_receipts
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_raw_output_immutable_guard();

CREATE OR REPLACE FUNCTION campaign_assurance_raw_output_task_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    canonical_campaign_ids uuid[];
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'campaign assurance raw-output tasks cannot be deleted'
            USING ERRCODE = '55000';
    END IF;
    IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'campaign assurance raw-output task mutation requires worker scope'
            USING ERRCODE = '42501';
    END IF;
    SELECT array_agg(DISTINCT value ORDER BY value)
      INTO canonical_campaign_ids
      FROM unnest(NEW.campaign_ids) AS value;
    IF canonical_campaign_ids IS DISTINCT FROM NEW.campaign_ids THEN
        RAISE EXCEPTION 'campaign assurance raw-output campaign scope is not canonical'
            USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'UPDATE' AND (
        NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR
        NEW.object_ref <> OLD.object_ref OR NEW.object_ref_sha256 <> OLD.object_ref_sha256 OR
        NEW.raw_output_sha256 <> OLD.raw_output_sha256 OR
        NEW.raw_output_expires_at <> OLD.raw_output_expires_at OR
        NEW.source_extraction_id <> OLD.source_extraction_id OR
        NEW.source_receipt_sha256 <> OLD.source_receipt_sha256 OR
        NEW.source_manifest_sha256 <> OLD.source_manifest_sha256 OR
        NEW.campaign_ids <> OLD.campaign_ids OR
        NEW.campaign_scope_sha256 <> OLD.campaign_scope_sha256 OR
        NEW.created_at <> OLD.created_at OR NEW.attempt_count < OLD.attempt_count
    ) THEN
        RAISE EXCEPTION 'campaign assurance raw-output task identity is immutable'
            USING ERRCODE = '55000';
    END IF;
    NEW.updated_at := statement_timestamp();
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_raw_output_tasks_guard
    BEFORE INSERT OR UPDATE OR DELETE ON campaign_assurance_raw_output_retention_tasks
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_raw_output_task_guard();

-- Future extraction receipts enqueue their retention identity in the same
-- transaction. Modeled cache reuse is already constrained to the same
-- campaign and exact raw hash/expiry by migration 1931; any deviation here is
-- treated as an invariant violation, never merged into a broader delete task.
CREATE OR REPLACE FUNCTION campaign_assurance_raw_output_enqueue()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    task campaign_assurance_raw_output_retention_tasks%ROWTYPE;
    singleton_manifest text;
    singleton_campaign_hash text;
BEGIN
    IF NEW.raw_output_object_ref IS NULL THEN
        RETURN NEW;
    END IF;
    singleton_manifest := encode(digest(convert_to(
        NEW.id::text || ':' || NEW.receipt_hash, 'UTF8'), 'sha256'), 'hex');
    singleton_campaign_hash := encode(digest(convert_to(
        NEW.campaign_id::text, 'UTF8'), 'sha256'), 'hex');
    INSERT INTO public.campaign_assurance_raw_output_retention_tasks (
        tenant_id, object_ref, object_ref_sha256, raw_output_sha256,
        raw_output_expires_at, source_extraction_id, source_receipt_sha256,
        source_manifest_sha256, campaign_ids, campaign_scope_sha256
    ) VALUES (
        NEW.tenant_id, NEW.raw_output_object_ref,
        encode(digest(convert_to(NEW.raw_output_object_ref, 'UTF8'), 'sha256'), 'hex'),
        NEW.raw_output_hash, NEW.raw_output_expires_at, NEW.id, NEW.receipt_hash,
        singleton_manifest, ARRAY[NEW.campaign_id], singleton_campaign_hash
    )
    ON CONFLICT (tenant_id, object_ref) DO NOTHING;

    SELECT * INTO task
      FROM public.campaign_assurance_raw_output_retention_tasks
     WHERE tenant_id = NEW.tenant_id AND object_ref = NEW.raw_output_object_ref;
    IF NOT FOUND OR task.raw_output_sha256 <> NEW.raw_output_hash
       OR task.raw_output_expires_at <> NEW.raw_output_expires_at
       OR NOT (NEW.campaign_id = ANY(task.campaign_ids)) THEN
        RAISE EXCEPTION 'raw-output extraction conflicts with its durable retention identity'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_extractions_raw_output_enqueue
    AFTER INSERT ON campaign_assurance_extractions
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_raw_output_enqueue();

CREATE OR REPLACE FUNCTION campaign_assurance_raw_output_version_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    task campaign_assurance_raw_output_retention_tasks%ROWTYPE;
BEGIN
    IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'raw-output version resolution requires worker scope'
            USING ERRCODE = '42501';
    END IF;
    SELECT * INTO task
      FROM public.campaign_assurance_raw_output_retention_tasks
     WHERE tenant_id = NEW.tenant_id AND id = NEW.task_id
     FOR UPDATE;
    IF NOT FOUND OR task.state <> 'leased'
       OR task.attempt_count <> NEW.attempt_no
       OR task.lease_token <> NEW.resolved_by_claim_token
       OR task.object_ref_sha256 <> NEW.object_ref_sha256
       OR task.raw_output_sha256 <> NEW.content_sha256
       OR NEW.storage_version_sha256 <>
            encode(digest(convert_to(NEW.storage_version_id, 'UTF8'), 'sha256'), 'hex') THEN
        RAISE EXCEPTION 'raw-output version resolution is not bound to the active exact object'
            USING ERRCODE = '55000';
    END IF;
    NEW.receipt_hash := encode(digest(convert_to(
        jsonb_build_object(
            'tenant_id', NEW.tenant_id::text,
            'task_id', NEW.task_id::text,
            'object_ref_sha256', NEW.object_ref_sha256,
            'storage_backend', NEW.storage_backend,
            'bucket', NEW.bucket,
            'storage_version_sha256', NEW.storage_version_sha256,
            'content_sha256', NEW.content_sha256,
            'byte_size', NEW.byte_size,
            'provider_proof_sha256', NEW.provider_proof_sha256
        )::text, 'UTF8'), 'sha256'), 'hex');
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_raw_output_version_insert
    BEFORE INSERT ON campaign_assurance_raw_output_version_receipts
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_raw_output_version_insert_guard();

CREATE OR REPLACE FUNCTION campaign_assurance_raw_output_attempt_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    task campaign_assurance_raw_output_retention_tasks%ROWTYPE;
    version campaign_assurance_raw_output_version_receipts%ROWTYPE;
BEGIN
    IF current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'raw-output retention receipt requires worker scope'
            USING ERRCODE = '42501';
    END IF;
    SELECT * INTO task
      FROM public.campaign_assurance_raw_output_retention_tasks
     WHERE tenant_id = NEW.tenant_id AND id = NEW.task_id
     FOR UPDATE;
    IF NOT FOUND OR task.state <> 'leased'
       OR task.attempt_count <> NEW.attempt_no OR task.lease_token <> NEW.claim_token
       OR task.object_ref_sha256 <> NEW.object_ref_sha256
       OR task.raw_output_sha256 <> NEW.raw_output_sha256
       OR task.source_manifest_sha256 <> NEW.source_manifest_sha256
       OR task.campaign_scope_sha256 <> NEW.campaign_scope_sha256 THEN
        RAISE EXCEPTION 'raw-output retention receipt is not bound to the active lease'
            USING ERRCODE = '55000';
    END IF;

    IF NEW.outcome = 'deleted' THEN
        -- Enforce the hold/delete linearization even for a future worker that
        -- bypasses the Go repository. The legal-hold mutation trigger takes
        -- this exact transaction lock before placing or releasing a hold.
        PERFORM pg_advisory_xact_lock(
            hashtextextended(
                'campaign-assurance-raw-output:' || NEW.tenant_id::text, 0
            )
        );
        SELECT * INTO version
          FROM public.campaign_assurance_raw_output_version_receipts
         WHERE tenant_id = NEW.tenant_id AND task_id = NEW.task_id;
        IF NOT FOUND OR version.receipt_hash <> NEW.version_receipt_hash
           OR version.storage_version_sha256 <> NEW.requested_version_sha256
           OR (NEW.response_version_sha256 IS NOT NULL
               AND NEW.response_version_sha256 <> version.storage_version_sha256)
           OR task.raw_output_expires_at > statement_timestamp()
           OR EXISTS (
                SELECT 1
                  FROM public.campaign_assurance_extractions extraction
                 WHERE extraction.tenant_id = task.tenant_id
                   AND extraction.raw_output_object_ref = task.object_ref
                   AND (
                        extraction.raw_output_hash IS DISTINCT FROM task.raw_output_sha256
                        OR extraction.raw_output_expires_at IS NULL
                        OR extraction.raw_output_expires_at > statement_timestamp()
                        OR public.campaign_assurance_legal_hold_active(
                            extraction.tenant_id, extraction.campaign_id
                        )
                   )
           )
           OR EXISTS (
                SELECT 1 FROM unnest(task.campaign_ids) AS held_campaign(campaign_id)
                 WHERE public.campaign_assurance_legal_hold_active(
                    task.tenant_id, held_campaign.campaign_id
                 )
           ) THEN
            RAISE EXCEPTION 'raw-output deletion is not expired, exact-version, and hold-free'
                USING ERRCODE = '55000';
        END IF;
    END IF;

    NEW.receipt_hash := encode(digest(convert_to(
        jsonb_strip_nulls(jsonb_build_object(
            'tenant_id', NEW.tenant_id::text,
            'task_id', NEW.task_id::text,
            'attempt_no', NEW.attempt_no,
            'claim_token', NEW.claim_token::text,
            'outcome', NEW.outcome,
            'object_ref_sha256', NEW.object_ref_sha256,
            'raw_output_sha256', NEW.raw_output_sha256,
            'source_manifest_sha256', NEW.source_manifest_sha256,
            'campaign_scope_sha256', NEW.campaign_scope_sha256,
            'version_receipt_hash', NEW.version_receipt_hash,
            'requested_version_sha256', NEW.requested_version_sha256,
            'response_version_sha256', NEW.response_version_sha256,
            'delete_disposition', NEW.delete_disposition,
            'delete_marker', NEW.delete_marker,
            'provider_request_id_sha256', NEW.provider_request_id_sha256,
            'failure_code', NEW.failure_code,
            'failure_sha256', NEW.failure_sha256,
            'worker_id_sha256', NEW.worker_id_sha256
        ))::text, 'UTF8'), 'sha256'), 'hex');
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_raw_output_attempt_insert
    BEFORE INSERT ON campaign_assurance_raw_output_retention_receipts
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_raw_output_attempt_insert_guard();

-- The same transaction-scoped tenant lock is acquired by the final deletion
-- transaction. Whichever starts second waits, so a deletion can neither start
-- under a committed hold nor race a hold that is being placed.
CREATE OR REPLACE FUNCTION campaign_assurance_legal_hold_retention_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    tenant uuid;
BEGIN
    tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
    PERFORM pg_advisory_xact_lock(
        hashtextextended('campaign-assurance-raw-output:' || tenant::text, 0)
    );
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER campaign_assurance_legal_holds_raw_output_fence
    BEFORE INSERT OR UPDATE OR DELETE ON campaign_assurance_legal_holds
    FOR EACH ROW EXECUTE FUNCTION campaign_assurance_legal_hold_retention_fence();

ALTER TABLE campaign_assurance_raw_output_retention_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_raw_output_retention_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_raw_output_version_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_raw_output_version_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_raw_output_retention_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_assurance_raw_output_retention_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_assurance_raw_output_tasks_scope
    ON campaign_assurance_raw_output_retention_tasks AS RESTRICTIVE
    FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
CREATE POLICY campaign_assurance_raw_output_tasks_tenant_select
    ON campaign_assurance_raw_output_retention_tasks FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_raw_output_tasks_worker_all
    ON campaign_assurance_raw_output_retention_tasks FOR ALL TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY campaign_assurance_raw_output_versions_scope
    ON campaign_assurance_raw_output_version_receipts AS RESTRICTIVE
    FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
CREATE POLICY campaign_assurance_raw_output_versions_tenant_select
    ON campaign_assurance_raw_output_version_receipts FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_raw_output_versions_worker_select
    ON campaign_assurance_raw_output_version_receipts FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY campaign_assurance_raw_output_versions_worker_insert
    ON campaign_assurance_raw_output_version_receipts FOR INSERT TO postwave_app
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

CREATE POLICY campaign_assurance_raw_output_receipts_scope
    ON campaign_assurance_raw_output_retention_receipts AS RESTRICTIVE
    FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.outbox_worker', true) = 'true'
    );
CREATE POLICY campaign_assurance_raw_output_receipts_tenant_select
    ON campaign_assurance_raw_output_retention_receipts FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY campaign_assurance_raw_output_receipts_worker_select
    ON campaign_assurance_raw_output_retention_receipts FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');
CREATE POLICY campaign_assurance_raw_output_receipts_worker_insert
    ON campaign_assurance_raw_output_retention_receipts FOR INSERT TO postwave_app
    WITH CHECK (current_setting('app.outbox_worker', true) = 'true');

GRANT SELECT, INSERT, UPDATE ON campaign_assurance_raw_output_retention_tasks TO postwave_app;
GRANT SELECT, INSERT ON campaign_assurance_raw_output_version_receipts TO postwave_app;
GRANT SELECT, INSERT ON campaign_assurance_raw_output_retention_receipts TO postwave_app;

REVOKE DELETE, TRUNCATE ON campaign_assurance_raw_output_retention_tasks FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_raw_output_version_receipts FROM postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON campaign_assurance_raw_output_retention_receipts FROM postwave_app;

COMMENT ON TABLE campaign_assurance_raw_output_retention_tasks IS
    'Mutable bounded leases for raw-model-output retention; exact identity columns are trigger-immutable.';
COMMENT ON TABLE campaign_assurance_raw_output_version_receipts IS
    'Immutable proof of the exact storage version matching an expiring raw-output hash. Required before deletion.';
COMMENT ON TABLE campaign_assurance_raw_output_retention_receipts IS
    'Immutable, hash-bound success/failure/defer receipts for every claimed raw-output retention attempt.';

COMMIT;
