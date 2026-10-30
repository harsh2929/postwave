-- Indexed, rotation-aware email-HMAC identity projection for signed conversion
-- ingest (F03).
--
-- Migration 2010 made the signed request's exact key id authoritative, but the
-- resolver still evaluated HMAC over every subscriber in the tenant for every
-- batch. That is unbounded work on the public ingest path and cannot use an
-- index. This migration moves that work behind a durable, bounded lease and
-- gives ingest an exact (tenant, key, digest) index lookup.
--
-- The signing secret is never stored in this projection. Only the key id and
-- derived HMAC are persisted. Key issuance and subscriber mutations enqueue
-- reconciliation in the same transaction as the source change. Until every
-- task for the exact live key is complete, the public contract says pending or
-- failed and email-HMAC ingest fails explicitly rather than returning a false
-- no-match.
--
-- migration-execution: atomic
-- rollback-strategy: no-op
-- rollback-details: Leave the projection unused after application rollback; never restore the subscriber-scan hot path or cryptoshredded HMAC identity material.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- Persist immutable wrapping-key provenance beside every newly issued
-- envelope. Historical live rows deliberately remain NULL: guessing an ARN
-- would turn missing provenance into a false assurance, so those rows fail the
-- projection closed and must be rotated. Revoked material is destroyed now;
-- the row and destruction timestamp remain as the lifecycle receipt.
ALTER TABLE public.conversion_ingest_secrets
    ADD COLUMN secret_kms_key_arn text,
    ADD COLUMN secret_destroyed_at timestamptz;

UPDATE public.conversion_ingest_secrets
   SET secret = 'revoked:cryptoshredded',
       secret_envelope = NULL,
       secret_kms_key_arn = NULL,
       secret_destroyed_at = COALESCE(secret_destroyed_at, revoked_at, statement_timestamp())
 WHERE revoked_at IS NOT NULL;

ALTER TABLE public.conversion_ingest_secrets
    ADD CONSTRAINT conversion_ingest_secret_revoked_cryptoshred CHECK (
        revoked_at IS NULL
        OR (
            secret = 'revoked:cryptoshredded'
            AND secret_envelope IS NULL
            AND secret_kms_key_arn IS NULL
            AND secret_destroyed_at IS NOT NULL
        )
    );

CREATE INDEX conversion_ingest_secrets_live_tenant_idx
    ON public.conversion_ingest_secrets (tenant_id, key_id)
    WHERE revoked_at IS NULL;
CREATE INDEX conversion_attribution_touches_email_hmac_key_idx
    ON public.conversion_attribution_touches (tenant_id, identity_key_id)
    WHERE identity_kind = 'email_hmac_sha256';

-- Revoked credentials have zero pseudonymous-HMAC retention. A value-free
-- tombstone preserves the fact that an identity touch occupied this rank while
-- erasing its digest, key id, resolved subscriber, and winner status. This is
-- deliberately an idempotent UPDATE rather than an apply-time DELETE: the
-- migration runner forbids irreversible cleanup that cannot be resumed or
-- audited, and the lifecycle trigger below applies the same shape atomically
-- to future revocations.
ALTER TABLE public.conversion_attribution_touches
    DROP CONSTRAINT conversion_attribution_touches_identity_kind_check,
    DROP CONSTRAINT conversion_attribution_touches_shape;
ALTER TABLE public.conversion_attribution_touches
    ADD CONSTRAINT conversion_attribution_touches_identity_kind_check CHECK (
        identity_kind IN (
            'email_sha256', 'email_hmac_sha256',
            'email_hmac_cryptoshredded', 'click_id', 'external_id'
        )
    ) NOT VALID,
    ADD CONSTRAINT conversion_attribution_touches_shape CHECK (
        (
            touch_kind = 'identity'
            AND identity_kind IS NOT NULL
            AND identity_value IS NOT NULL
            AND resolution_rank IS NOT NULL
            AND (
                (
                    identity_kind = 'email_hmac_cryptoshredded'
                    AND identity_value = 'revoked:cryptoshredded'
                    AND identity_key_id IS NULL
                    AND subscriber_id IS NULL
                    AND NOT is_winner
                )
                OR
                (
                    identity_kind = 'email_hmac_sha256'
                    AND identity_key_id IS NOT NULL
                    AND length(identity_key_id) BETWEEN 1 AND 200
                )
                OR
                (
                    identity_kind NOT IN (
                        'email_hmac_sha256', 'email_hmac_cryptoshredded'
                    )
                    AND identity_key_id IS NULL
                )
            )
        )
        OR
        (
            touch_kind = 'campaign_click'
            AND campaign_id IS NOT NULL
            AND touched_at IS NOT NULL
            AND identity_key_id IS NULL
        )
    ) NOT VALID;

UPDATE public.conversions AS conversion
   SET email_hmac_sha256 = NULL, email_hmac_key_id = NULL
  FROM public.conversion_ingest_secrets AS secret
 WHERE secret.tenant_id = conversion.tenant_id
   AND secret.key_id = conversion.email_hmac_key_id
   AND secret.revoked_at IS NOT NULL;

UPDATE public.conversion_attribution_touches AS touch
   SET identity_kind = 'email_hmac_cryptoshredded',
       identity_value = 'revoked:cryptoshredded',
       identity_key_id = NULL,
       subscriber_id = NULL,
       is_winner = false
  FROM public.conversion_ingest_secrets AS secret
 WHERE secret.tenant_id = touch.tenant_id
   AND secret.key_id = touch.identity_key_id
   AND secret.revoked_at IS NOT NULL
   AND touch.identity_kind = 'email_hmac_sha256';

ALTER TABLE public.conversion_attribution_touches
    VALIDATE CONSTRAINT conversion_attribution_touches_identity_kind_check;
ALTER TABLE public.conversion_attribution_touches
    VALIDATE CONSTRAINT conversion_attribution_touches_shape;

-- Subscriber-mutation fanout is therefore capped at eight durable writes.
-- Abort instead of silently accepting a pre-existing unbounded tenant.
DO $live_limit_precheck$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.conversion_ingest_secrets
         WHERE revoked_at IS NULL
         GROUP BY tenant_id
        HAVING count(*) > 8
    ) THEN
        RAISE EXCEPTION 'a tenant has more than eight live conversion signing keys; revoke before migration 2017';
    END IF;
END
$live_limit_precheck$;

CREATE OR REPLACE FUNCTION public.conversion_ingest_secret_enforce_live_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    live_count integer;
BEGIN
    -- Key lifecycle takes the exclusive side of the tenant projection fence.
    -- Subscriber mutations take the shared side below, so unrelated subscriber
    -- writers retain concurrency while issuance/revocation cannot cross a
    -- subscriber commit invisibly. The lock is transaction-scoped and is also
    -- the serialization primitive for the live-key count.
    IF TG_OP = 'INSERT' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(NEW.tenant_id::text, 2017)
        );
    ELSIF OLD.revoked_at IS DISTINCT FROM NEW.revoked_at THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(NEW.tenant_id::text, 2017)
        );
    END IF;

    IF TG_OP = 'INSERT' AND NEW.revoked_at IS NULL THEN
        SELECT count(*) INTO live_count
          FROM public.conversion_ingest_secrets AS existing
         WHERE existing.tenant_id = NEW.tenant_id
           AND existing.revoked_at IS NULL;
        IF live_count >= 8 THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'tenant live conversion signing key limit reached',
                CONSTRAINT = 'conversion_ingest_secrets_live_tenant_limit';
        END IF;
    END IF;
    RETURN NEW;
END
$fn$;

CREATE TRIGGER conversion_ingest_secret_live_tenant_limit
    BEFORE INSERT OR UPDATE OF revoked_at
    ON public.conversion_ingest_secrets
    FOR EACH ROW
    EXECUTE FUNCTION public.conversion_ingest_secret_enforce_live_limit();

CREATE TABLE public.conversion_email_hmac_projection_states (
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key_id             text NOT NULL,
    status             text NOT NULL DEFAULT 'pending' CHECK (
                           status IN ('pending', 'ready', 'failed')
                       ),
    last_error_code    text CHECK (
                           last_error_code IS NULL OR last_error_code IN (
                               'secret_unavailable', 'projection_failed'
                           )
                       ),
    updated_at         timestamptz NOT NULL DEFAULT statement_timestamp(),
    last_ready_at      timestamptz,
    PRIMARY KEY (tenant_id, key_id),
    CONSTRAINT conversion_email_hmac_projection_state_key_fk
        FOREIGN KEY (tenant_id, key_id)
        REFERENCES public.conversion_ingest_secrets (tenant_id, key_id)
        ON DELETE CASCADE,
    CONSTRAINT conversion_email_hmac_projection_state_failure_shape CHECK (
        (status = 'failed' AND last_error_code IS NOT NULL)
        OR (status <> 'failed' AND last_error_code IS NULL)
    )
);

CREATE TABLE public.conversion_email_hmac_bindings (
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key_id          text NOT NULL,
    digest          text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    subscriber_id   uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at      timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (tenant_id, key_id, digest),
    CONSTRAINT conversion_email_hmac_binding_state_fk
        FOREIGN KEY (tenant_id, key_id)
        REFERENCES public.conversion_email_hmac_projection_states (tenant_id, key_id)
        ON DELETE CASCADE
);

-- Deliberately do not add a subscriber FK here. A projection worker owns the
-- task row before it publishes a derived binding, while an email mutation owns
-- the subscriber row before its trigger fences that task. FK validation would
-- take a subscriber KEY SHARE lock and invert that order, producing a real
-- task->subscriber / subscriber->task deadlock. The source-row triggers below
-- synchronously erase bindings and fence every in-flight writer instead.

-- One subscriber has exactly one normalized address under one exact key. This
-- also makes email changes a single delete+insert rather than an accumulating
-- history of stale digests.
CREATE UNIQUE INDEX conversion_email_hmac_bindings_subscriber_uniq
    ON public.conversion_email_hmac_bindings (subscriber_id, tenant_id, key_id);
-- Cover the public lookup's only selected binding column. Keeping subscriber_id
-- in INCLUDE makes a one-digest request index-only after visibility-map warmup;
-- unlike the maintenance index above, this index can never invite a scan of all
-- bindings for one tenant/key followed by a digest filter.
CREATE INDEX conversion_email_hmac_bindings_digest_lookup_idx
    ON public.conversion_email_hmac_bindings (tenant_id, key_id, digest)
    INCLUDE (subscriber_id);

CREATE TABLE public.conversion_email_hmac_projection_tasks (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key_id              text NOT NULL,
    task_kind           text NOT NULL CHECK (task_kind IN ('full', 'subscriber')),
    subscriber_id       uuid,
    cursor_subscriber_id uuid,
    target_revision     bigint NOT NULL DEFAULT 1 CHECK (target_revision > 0),
    state               text NOT NULL DEFAULT 'pending' CHECK (
                            state IN ('pending', 'leased', 'retry', 'failed')
                        ),
    attempt_count       integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    lease_token         uuid,
    lease_owner         text,
    lease_expires_at    timestamptz,
    retry_not_before    timestamptz,
    last_failure_code   text CHECK (
                            last_failure_code IS NULL OR last_failure_code IN (
                                'secret_unavailable', 'projection_failed'
                            )
                        ),
    created_at          timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at          timestamptz NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT conversion_email_hmac_projection_task_state_fk
        FOREIGN KEY (tenant_id, key_id)
        REFERENCES public.conversion_email_hmac_projection_states (tenant_id, key_id)
        ON DELETE CASCADE,
    CONSTRAINT conversion_email_hmac_projection_task_subscriber_fk
        FOREIGN KEY (tenant_id, subscriber_id)
        REFERENCES public.subscribers (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT conversion_email_hmac_projection_task_shape CHECK (
        (task_kind = 'full' AND subscriber_id IS NULL)
        OR (task_kind = 'subscriber' AND subscriber_id IS NOT NULL
            AND cursor_subscriber_id IS NULL)
    ),
    CONSTRAINT conversion_email_hmac_projection_task_lease_shape CHECK (
        (state = 'leased' AND lease_token IS NOT NULL
            AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (state <> 'leased' AND lease_token IS NULL
            AND lease_owner IS NULL AND lease_expires_at IS NULL)
    )
);

CREATE UNIQUE INDEX conversion_email_hmac_projection_full_task_uniq
    ON public.conversion_email_hmac_projection_tasks (tenant_id, key_id)
    WHERE task_kind = 'full';
CREATE UNIQUE INDEX conversion_email_hmac_projection_subscriber_task_uniq
    ON public.conversion_email_hmac_projection_tasks
       (tenant_id, key_id, subscriber_id)
    WHERE task_kind = 'subscriber';
-- Claim each priority class independently. The eligibility expression and
-- ordering here are byte-for-byte mirrored by the SECURITY DEFINER function,
-- so future retries and expired leases cannot force a queue-wide scan/sort.
CREATE INDEX conversion_email_hmac_projection_subscriber_claim_due_idx
    ON public.conversion_email_hmac_projection_tasks
       ((CASE
            WHEN state = 'leased' THEN lease_expires_at
            ELSE COALESCE(retry_not_before, '-infinity'::timestamptz)
         END), created_at, id)
    WHERE task_kind = 'subscriber'
      AND state IN ('pending', 'retry', 'leased');
CREATE INDEX conversion_email_hmac_projection_full_claim_due_idx
    ON public.conversion_email_hmac_projection_tasks
       ((CASE
            WHEN state = 'leased' THEN lease_expires_at
            ELSE COALESCE(retry_not_before, '-infinity'::timestamptz)
         END), created_at, id)
    WHERE task_kind = 'full'
      AND state IN ('pending', 'retry', 'leased');
CREATE INDEX conversion_email_hmac_projection_tasks_tenant_key_idx
    ON public.conversion_email_hmac_projection_tasks (tenant_id, key_id)
    INCLUDE (state, last_failure_code, attempt_count);
CREATE INDEX conversion_email_hmac_projection_failed_health_idx
    ON public.conversion_email_hmac_projection_tasks (updated_at)
    WHERE last_failure_code IS NOT NULL AND attempt_count >= 10;
CREATE INDEX conversion_email_hmac_projection_backlog_health_idx
    ON public.conversion_email_hmac_projection_tasks (updated_at)
    WHERE state IN ('pending', 'retry', 'leased');

COMMENT ON TABLE public.conversion_email_hmac_projection_states IS
    'Public readiness of the exact tenant/signing-key email-HMAC projection. Pending/failed must never be interpreted as an empty match set.';
COMMENT ON TABLE public.conversion_email_hmac_bindings IS
    'Derived HMAC only: indexed (tenant,key,digest) -> subscriber projection. Plaintext signing keys are forbidden from this table.';
COMMENT ON TABLE public.conversion_email_hmac_projection_tasks IS
    'Durable leased/fenced full-key and subscriber-mutation reconciliation. Full scans advance in bounded UUID pages.';

-- Existing legacy rows remain readable so customers can rotate without an
-- outage, but no writer (including direct postwave_app SQL) may persist a new
-- plaintext key or replace secret material outside the exact-KMS envelope
-- path. Revocation cryptoshreds in this BEFORE trigger so direct SQL cannot
-- accidentally retain ciphertext after setting revoked_at.
CREATE OR REPLACE FUNCTION public.conversion_ingest_secret_require_envelope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        -- Key identity, label, issuance time, and wrapping material are
        -- immutable. Rotation always issues a new key id; it never rewrites a
        -- one-time credential or its exact KMS provenance in place.
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
           OR NEW.key_id IS DISTINCT FROM OLD.key_id
           OR NEW.label IS DISTINCT FROM OLD.label
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'conversion signing key identity is immutable',
                CONSTRAINT = 'conversion_ingest_secret_identity_immutable';
        END IF;

        -- Revocation is permanent. The cryptoshredded row is an immutable
        -- lifecycle/destruction receipt and can never be revived or rewritten.
        IF OLD.revoked_at IS NOT NULL THEN
            IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
               OR NEW.secret IS DISTINCT FROM OLD.secret
               OR NEW.secret_envelope IS DISTINCT FROM OLD.secret_envelope
               OR NEW.secret_kms_key_arn IS DISTINCT FROM OLD.secret_kms_key_arn
               OR NEW.secret_destroyed_at IS DISTINCT FROM OLD.secret_destroyed_at THEN
                RAISE EXCEPTION USING
                    ERRCODE = '23514',
                    MESSAGE = 'revoked conversion signing keys are immutable',
                    CONSTRAINT = 'conversion_ingest_secret_revocation_permanent';
            END IF;
            RETURN NEW;
        END IF;

        IF NEW.revoked_at IS NULL THEN
            IF NEW.secret IS DISTINCT FROM OLD.secret
               OR NEW.secret_envelope IS DISTINCT FROM OLD.secret_envelope
               OR NEW.secret_kms_key_arn IS DISTINCT FROM OLD.secret_kms_key_arn
               OR NEW.secret_destroyed_at IS DISTINCT FROM OLD.secret_destroyed_at THEN
                RAISE EXCEPTION USING
                    ERRCODE = '23514',
                    MESSAGE = 'live conversion signing key material is immutable',
                    CONSTRAINT = 'conversion_ingest_secret_material_immutable';
            END IF;
        ELSE
            -- Normalize the sole live->revoked transition at the database
            -- boundary so callers cannot forge either lifecycle timestamp.
            NEW.revoked_at := statement_timestamp();
            NEW.secret := 'revoked:cryptoshredded';
            NEW.secret_envelope := NULL;
            NEW.secret_kms_key_arn := NULL;
            NEW.secret_destroyed_at := statement_timestamp();
            RETURN NEW;
        END IF;
    ELSIF NEW.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'new conversion signing keys must begin live',
            CONSTRAINT = 'conversion_ingest_secret_insert_live';
    END IF;

    IF NEW.secret_destroyed_at IS NOT NULL
       OR NEW.secret <> 'envelope:do-not-use'
       OR NEW.secret_envelope IS NULL
       OR pg_catalog.octet_length(NEW.secret_envelope) = 0
       OR pg_catalog.get_byte(NEW.secret_envelope, 0) <> 2
       OR NEW.secret_kms_key_arn IS NULL
       OR NEW.secret_kms_key_arn !~
          '^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]{1,128}$' THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'new conversion signing keys require exact-KMS envelope storage',
            CONSTRAINT = 'conversion_ingest_secret_envelope_required';
    END IF;
    RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS conversion_ingest_secret_require_envelope
    ON public.conversion_ingest_secrets;
CREATE TRIGGER conversion_ingest_secret_require_envelope
    BEFORE INSERT OR UPDATE
    ON public.conversion_ingest_secrets
    FOR EACH ROW
    EXECUTE FUNCTION public.conversion_ingest_secret_require_envelope();

-- Issuance and revocation are the authoritative key lifecycle. A new key is
-- pending in the same commit that discloses it. Revocation atomically removes
-- every derived binding/task, while retaining the historical state metadata
-- displayed alongside the revoked key.
CREATE OR REPLACE FUNCTION public.conversion_email_hmac_project_key_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.conversion_email_hmac_projection_states (
            tenant_id, key_id, status, last_error_code, updated_at
        ) VALUES (
            NEW.tenant_id, NEW.key_id, 'pending', NULL, statement_timestamp()
        )
        ON CONFLICT (tenant_id, key_id) DO UPDATE SET
            status = 'pending', last_error_code = NULL,
            updated_at = statement_timestamp();

        DELETE FROM public.conversion_email_hmac_bindings
         WHERE tenant_id = NEW.tenant_id AND key_id = NEW.key_id;

        INSERT INTO public.conversion_email_hmac_projection_tasks (
            tenant_id, key_id, task_kind, state
        ) VALUES (NEW.tenant_id, NEW.key_id, 'full', 'pending')
        ON CONFLICT (tenant_id, key_id) WHERE task_kind = 'full'
        DO UPDATE SET
            cursor_subscriber_id = NULL,
            target_revision = conversion_email_hmac_projection_tasks.target_revision + 1,
            state = 'pending', attempt_count = 0,
            lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
            retry_not_before = NULL, last_failure_code = NULL,
            updated_at = statement_timestamp();
    ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
        DELETE FROM public.conversion_email_hmac_projection_tasks
         WHERE tenant_id = NEW.tenant_id AND key_id = NEW.key_id;
        DELETE FROM public.conversion_email_hmac_bindings
         WHERE tenant_id = NEW.tenant_id AND key_id = NEW.key_id;
        UPDATE public.conversion_email_hmac_projection_states
           SET updated_at = statement_timestamp()
         WHERE tenant_id = NEW.tenant_id AND key_id = NEW.key_id;
        UPDATE public.conversions
           SET email_hmac_sha256 = NULL, email_hmac_key_id = NULL
         WHERE tenant_id = NEW.tenant_id
           AND email_hmac_key_id = NEW.key_id;
        UPDATE public.conversion_attribution_touches
           SET identity_kind = 'email_hmac_cryptoshredded',
               identity_value = 'revoked:cryptoshredded',
               identity_key_id = NULL,
               subscriber_id = NULL,
               is_winner = false
         WHERE tenant_id = NEW.tenant_id
           AND identity_kind = 'email_hmac_sha256'
           AND identity_key_id = NEW.key_id;
    END IF;
    RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS conversion_email_hmac_key_lifecycle
    ON public.conversion_ingest_secrets;
CREATE TRIGGER conversion_email_hmac_key_lifecycle
    AFTER INSERT OR UPDATE OF revoked_at
    ON public.conversion_ingest_secrets
    FOR EACH ROW
    EXECUTE FUNCTION public.conversion_email_hmac_project_key_lifecycle();

-- Every address mutation invalidates the affected subscriber for every live
-- key in one set-based statement. A task already in flight is fenced by a new
-- target_revision and loses its lease; its stale attempt can no longer commit.
CREATE OR REPLACE FUNCTION public.conversion_email_hmac_enqueue_subscriber()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    affected_tenant uuid;
    affected_subscriber uuid;
BEGIN
    affected_tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
    affected_subscriber := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;

    -- Subscriber writers share this transaction-scoped tenant fence; key
    -- lifecycle takes it exclusively in the BEFORE trigger above. If issuance
    -- wins, this wait completes before the SPI statements below take their
    -- READ COMMITTED snapshots, so the new key receives a subscriber task. If
    -- the subscriber wins, issuance cannot publish its full task until the
    -- committed subscriber is visible to that scan. This closes the only gap
    -- in which ready could otherwise omit a concurrently committed identity.
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtextextended(affected_tenant::text, 2017)
    );

    -- A full scan may already have read the pre-update email from its MVCC
    -- snapshot. Supersede and de-lease it before publishing the subscriber
    -- task; a stale worker then fails every revision/token predicate and its
    -- transaction cannot commit an old digest or mark the key ready. Preserve
    -- its durable cursor: the synchronous binding delete plus exact subscriber
    -- task reconciles a changed row on either side of that cursor, whereas
    -- resetting to UUID origin under sustained churn can starve the full scan.
    UPDATE public.conversion_email_hmac_projection_tasks AS task
       SET target_revision = task.target_revision + 1,
           state = 'pending', attempt_count = 0,
           lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
           retry_not_before = NULL, last_failure_code = NULL,
           updated_at = statement_timestamp()
      FROM public.conversion_ingest_secrets AS secret
     WHERE task.tenant_id = affected_tenant
       AND task.tenant_id = secret.tenant_id
       AND task.key_id = secret.key_id
       AND task.task_kind = 'full'
       AND secret.revoked_at IS NULL;

    -- Remove the old derived identity in the same transaction as the source
    -- address change (including privacy erasure). Pending state remains closed
    -- until the bounded subscriber task derives the replacement digest.
    DELETE FROM public.conversion_email_hmac_bindings
     WHERE tenant_id = affected_tenant
       AND subscriber_id = affected_subscriber;

    IF TG_OP <> 'DELETE' THEN
        INSERT INTO public.conversion_email_hmac_projection_tasks (
            tenant_id, key_id, task_kind, subscriber_id, state
        )
        SELECT secret.tenant_id, secret.key_id, 'subscriber', affected_subscriber, 'pending'
          FROM public.conversion_ingest_secrets AS secret
         WHERE secret.tenant_id = affected_tenant AND secret.revoked_at IS NULL
        ON CONFLICT (tenant_id, key_id, subscriber_id) WHERE task_kind = 'subscriber'
        DO UPDATE SET
            target_revision = conversion_email_hmac_projection_tasks.target_revision + 1,
            state = 'pending', attempt_count = 0,
            lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
            retry_not_before = NULL, last_failure_code = NULL,
            updated_at = statement_timestamp();
    END IF;

    IF TG_OP <> 'DELETE' THEN
        -- Task before state is the global lock order used by the worker too.
        -- An email UPDATE already owns the subscriber row; taking state then
        -- waiting on a worker-owned task would invert task->state.
        UPDATE public.conversion_email_hmac_projection_states AS projection
           SET status = 'pending', last_error_code = NULL,
               updated_at = statement_timestamp()
          FROM public.conversion_ingest_secrets AS secret
         WHERE projection.tenant_id = affected_tenant
           AND projection.tenant_id = secret.tenant_id
           AND projection.key_id = secret.key_id
           AND secret.revoked_at IS NULL;
    ELSE
        -- The subscriber-task FK cascade runs before this AFTER DELETE trigger.
        -- Recompute readiness after the synchronous binding erase: otherwise a
        -- create/update immediately followed by delete can remove its last task
        -- yet strand the key at pending forever. A remaining full task was
        -- fenced above, and a remaining terminal failure stays visible.
        UPDATE public.conversion_email_hmac_projection_states AS projection
           SET status = CASE
                   WHEN EXISTS (
                       SELECT 1
                         FROM public.conversion_email_hmac_projection_tasks AS task
                        WHERE task.tenant_id = projection.tenant_id
                          AND task.key_id = projection.key_id
                          AND task.last_failure_code IS NOT NULL
                          AND task.attempt_count >= 10
                   ) THEN 'failed'
                   WHEN EXISTS (
                       SELECT 1
                         FROM public.conversion_email_hmac_projection_tasks AS task
                        WHERE task.tenant_id = projection.tenant_id
                          AND task.key_id = projection.key_id
                   ) THEN 'pending'
                   ELSE 'ready'
               END,
               last_error_code = CASE
                   WHEN EXISTS (
                       SELECT 1
                         FROM public.conversion_email_hmac_projection_tasks AS task
                        WHERE task.tenant_id = projection.tenant_id
                          AND task.key_id = projection.key_id
                          AND task.last_failure_code = 'secret_unavailable'
                          AND task.attempt_count >= 10
                   ) THEN 'secret_unavailable'
                   WHEN EXISTS (
                       SELECT 1
                         FROM public.conversion_email_hmac_projection_tasks AS task
                        WHERE task.tenant_id = projection.tenant_id
                          AND task.key_id = projection.key_id
                          AND task.last_failure_code IS NOT NULL
                          AND task.attempt_count >= 10
                   ) THEN 'projection_failed'
                   ELSE NULL
               END,
               last_ready_at = CASE
                   WHEN NOT EXISTS (
                       SELECT 1
                         FROM public.conversion_email_hmac_projection_tasks AS task
                        WHERE task.tenant_id = projection.tenant_id
                          AND task.key_id = projection.key_id
                   ) THEN statement_timestamp()
                   ELSE projection.last_ready_at
               END,
               updated_at = statement_timestamp()
          FROM public.conversion_ingest_secrets AS secret
         WHERE projection.tenant_id = affected_tenant
           AND projection.tenant_id = secret.tenant_id
           AND projection.key_id = secret.key_id
           AND secret.revoked_at IS NULL;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS conversion_email_hmac_subscriber_insert
    ON public.subscribers;
CREATE TRIGGER conversion_email_hmac_subscriber_insert
    AFTER INSERT ON public.subscribers
    FOR EACH ROW
    EXECUTE FUNCTION public.conversion_email_hmac_enqueue_subscriber();

DROP TRIGGER IF EXISTS conversion_email_hmac_subscriber_email_update
    ON public.subscribers;
CREATE TRIGGER conversion_email_hmac_subscriber_email_update
    AFTER UPDATE OF email ON public.subscribers
    FOR EACH ROW
    WHEN (OLD.email IS DISTINCT FROM NEW.email)
    EXECUTE FUNCTION public.conversion_email_hmac_enqueue_subscriber();

DROP TRIGGER IF EXISTS conversion_email_hmac_subscriber_delete
    ON public.subscribers;
CREATE TRIGGER conversion_email_hmac_subscriber_delete
    AFTER DELETE ON public.subscribers
    FOR EACH ROW
    EXECUTE FUNCTION public.conversion_email_hmac_enqueue_subscriber();

-- Every historical key receives closed metadata so list reads cannot silently
-- omit pre-migration revoked credentials. Live keys enter pending and receive
-- one bounded full task. Historical revoked keys remain pending forever (and
-- unusable): there is no honest basis for claiming a projection was completed
-- before this migration, and no reason to decrypt a credential that cannot
-- authenticate.
INSERT INTO public.conversion_email_hmac_projection_states (
    tenant_id, key_id, status, updated_at
)
SELECT tenant_id, key_id, 'pending', statement_timestamp()
  FROM public.conversion_ingest_secrets
ON CONFLICT (tenant_id, key_id) DO NOTHING;

INSERT INTO public.conversion_email_hmac_projection_tasks (
    tenant_id, key_id, task_kind, state
)
SELECT tenant_id, key_id, 'full', 'pending'
  FROM public.conversion_ingest_secrets
 WHERE revoked_at IS NULL
ON CONFLICT (tenant_id, key_id) WHERE task_kind = 'full' DO NOTHING;

ALTER TABLE public.conversion_email_hmac_projection_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversion_email_hmac_projection_states FORCE ROW LEVEL SECURITY;
ALTER TABLE public.conversion_email_hmac_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversion_email_hmac_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.conversion_email_hmac_projection_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversion_email_hmac_projection_tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY conversion_email_hmac_projection_states_tenant_select
    ON public.conversion_email_hmac_projection_states
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY conversion_email_hmac_projection_states_tenant_insert
    ON public.conversion_email_hmac_projection_states
    FOR INSERT TO postwave_app
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY conversion_email_hmac_projection_states_tenant_update
    ON public.conversion_email_hmac_projection_states
    FOR UPDATE TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY conversion_email_hmac_bindings_tenant
    ON public.conversion_email_hmac_bindings
    FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY conversion_email_hmac_projection_tasks_tenant
    ON public.conversion_email_hmac_projection_tasks
    FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE
    ON public.conversion_email_hmac_projection_states TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON public.conversion_email_hmac_bindings TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON public.conversion_email_hmac_projection_tasks TO postwave_app;
GRANT UPDATE (email_hmac_sha256, email_hmac_key_id)
    ON public.conversions TO postwave_app;
-- A key row is the retained lifecycle/destruction receipt. Older migrations
-- granted table-wide UPDATE/DELETE for an internal-only table. Retain only the
-- one-way revoked_at transition: the BEFORE trigger owns cryptoshredding, and
-- callers cannot rewrite a live secret/provenance or cascade-delete state.
REVOKE UPDATE, DELETE, TRUNCATE ON public.conversion_ingest_secrets FROM postwave_app;
GRANT UPDATE (revoked_at) ON public.conversion_ingest_secrets TO postwave_app;
REVOKE TRUNCATE
    ON public.conversion_email_hmac_projection_states,
       public.conversion_email_hmac_bindings,
       public.conversion_email_hmac_projection_tasks
    FROM postwave_app;

-- Claiming is the sole cross-tenant operation. Put it behind a fixed-query
-- SECURITY DEFINER owned by a NOLOGIN/NOBYPASSRLS role with access to this task
-- table only. Callers receive task provenance, never an email or secret. One
-- due full task is reserved on every non-empty claim so sustained subscriber
-- churn cannot starve a newly issued key; all remaining capacity goes to the
-- latency-sensitive subscriber queue.
DO $role$
DECLARE
    projector pg_catalog.pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
         WHERE rolname = 'postwave_conversion_identity_projector'
    ) THEN
        CREATE ROLE postwave_conversion_identity_projector
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION NOBYPASSRLS;
    END IF;
    SELECT * INTO projector FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_conversion_identity_projector';
    IF projector.rolcanlogin OR projector.rolsuper OR projector.rolcreatedb OR
       projector.rolcreaterole OR projector.rolinherit OR
       projector.rolreplication OR projector.rolbypassrls THEN
        RAISE EXCEPTION 'postwave_conversion_identity_projector has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members
         WHERE member = projector.oid OR roleid = projector.oid
    ) THEN
        RAISE EXCEPTION 'postwave_conversion_identity_projector must have no memberships or members';
    END IF;
END
$role$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
    FROM postwave_conversion_identity_projector;
GRANT USAGE, CREATE ON SCHEMA public TO postwave_conversion_identity_projector;
GRANT SELECT, UPDATE ON public.conversion_email_hmac_projection_tasks
    TO postwave_conversion_identity_projector;
GRANT SELECT (tenant_id, key_id, revoked_at)
    ON public.conversion_ingest_secrets
    TO postwave_conversion_identity_projector;
GRANT SELECT (tenant_id, key_id)
    ON public.conversion_email_hmac_projection_states
    TO postwave_conversion_identity_projector;

CREATE POLICY conversion_email_hmac_projection_tasks_projector
    ON public.conversion_email_hmac_projection_tasks
    FOR ALL TO postwave_conversion_identity_projector
    USING (true) WITH CHECK (true);
CREATE POLICY conversion_email_hmac_projection_states_projector
    ON public.conversion_email_hmac_projection_states
    FOR SELECT TO postwave_conversion_identity_projector
    USING (true);
CREATE POLICY conversion_ingest_secrets_projection_catalog_projector
    ON public.conversion_ingest_secrets
    FOR SELECT TO postwave_conversion_identity_projector
    USING (true);

CREATE FUNCTION public.claim_conversion_email_hmac_projection_tasks(
    p_worker_id text,
    p_limit integer,
    p_lease_seconds integer
)
RETURNS TABLE (
    tenant_id uuid,
    task_id uuid,
    key_id text,
    task_kind text,
    subscriber_id uuid,
    cursor_subscriber_id uuid,
    target_revision bigint,
    attempt_count integer,
    lease_token uuid,
    lease_expires_at timestamptz
)
LANGUAGE sql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
ROWS 100
AS $function$
    WITH full_candidates AS MATERIALIZED (
        SELECT task.id
          FROM public.conversion_email_hmac_projection_tasks AS task
         WHERE task.task_kind = 'full'
           AND task.state IN ('pending', 'retry', 'leased')
           AND CASE
                   WHEN task.state = 'leased' THEN task.lease_expires_at
                   ELSE COALESCE(task.retry_not_before, '-infinity'::timestamptz)
               END <= statement_timestamp()
         ORDER BY CASE
                      WHEN task.state = 'leased' THEN task.lease_expires_at
                      ELSE COALESCE(task.retry_not_before, '-infinity'::timestamptz)
                  END,
                  task.created_at, task.id
         LIMIT 1
         FOR UPDATE SKIP LOCKED
    ), subscriber_candidates AS MATERIALIZED (
        SELECT task.id
          FROM public.conversion_email_hmac_projection_tasks AS task
         WHERE task.task_kind = 'subscriber'
           AND task.state IN ('pending', 'retry', 'leased')
           AND CASE
                   WHEN task.state = 'leased' THEN task.lease_expires_at
                   ELSE COALESCE(task.retry_not_before, '-infinity'::timestamptz)
               END <= statement_timestamp()
         ORDER BY CASE
                      WHEN task.state = 'leased' THEN task.lease_expires_at
                      ELSE COALESCE(task.retry_not_before, '-infinity'::timestamptz)
                  END,
                  task.created_at, task.id
         LIMIT GREATEST(
             LEAST(GREATEST(p_limit, 1), 100)
             - (SELECT count(*) FROM full_candidates),
             0
         )
         FOR UPDATE SKIP LOCKED
    ), candidates AS (
        SELECT id FROM full_candidates
        UNION ALL
        SELECT id FROM subscriber_candidates
    ), claimed AS (
        UPDATE public.conversion_email_hmac_projection_tasks AS task
           SET state = 'leased', attempt_count = task.attempt_count + 1,
               lease_token = gen_random_uuid(), lease_owner = left(p_worker_id, 200),
               lease_expires_at = statement_timestamp()
                    + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 10), 1800)),
               retry_not_before = NULL, last_failure_code = NULL,
               updated_at = statement_timestamp()
          FROM candidates
         WHERE task.id = candidates.id
        RETURNING task.*
    )
    SELECT claimed.tenant_id, claimed.id, claimed.key_id, claimed.task_kind,
           claimed.subscriber_id, claimed.cursor_subscriber_id,
           claimed.target_revision, claimed.attempt_count,
           claimed.lease_token, claimed.lease_expires_at
      FROM claimed
     ORDER BY claimed.created_at, claimed.id
$function$;

ALTER FUNCTION public.claim_conversion_email_hmac_projection_tasks(text, integer, integer)
    OWNER TO postwave_conversion_identity_projector;
REVOKE ALL ON FUNCTION public.claim_conversion_email_hmac_projection_tasks(text, integer, integer)
    FROM PUBLIC, postwave_public;
GRANT EXECUTE ON FUNCTION public.claim_conversion_email_hmac_projection_tasks(text, integer, integer)
    TO postwave_app;

-- A closed global boolean is enough for worker readiness; it exposes neither
-- tenant ids nor counts. The fixed definer reads only key provenance columns
-- and proves the state catalog is a one-for-one projection of authoritative
-- key rows in both directions.
CREATE FUNCTION public.conversion_email_hmac_projection_catalog_consistent()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
    SELECT NOT EXISTS (
               SELECT 1
                 FROM public.conversion_ingest_secrets AS secret
                 LEFT JOIN public.conversion_email_hmac_projection_states AS state
                   ON state.tenant_id = secret.tenant_id
                  AND state.key_id = secret.key_id
                WHERE state.key_id IS NULL
           )
       AND NOT EXISTS (
               SELECT 1
                 FROM public.conversion_email_hmac_projection_states AS state
                 LEFT JOIN public.conversion_ingest_secrets AS secret
                   ON secret.tenant_id = state.tenant_id
                  AND secret.key_id = state.key_id
                WHERE secret.key_id IS NULL
           )
$function$;

ALTER FUNCTION public.conversion_email_hmac_projection_catalog_consistent()
    OWNER TO postwave_conversion_identity_projector;
REVOKE ALL ON FUNCTION public.conversion_email_hmac_projection_catalog_consistent()
    FROM PUBLIC, postwave_public;
GRANT EXECUTE ON FUNCTION public.conversion_email_hmac_projection_catalog_consistent()
    TO postwave_app;

CREATE FUNCTION public.conversion_email_hmac_projection_health()
RETURNS TABLE (has_failed boolean, has_stale boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
    SELECT EXISTS (
               SELECT 1
                 FROM public.conversion_email_hmac_projection_tasks
                WHERE last_failure_code IS NOT NULL AND attempt_count >= 10
           ),
           EXISTS (
               SELECT 1
                 FROM public.conversion_email_hmac_projection_tasks
                WHERE state IN ('pending', 'retry', 'leased')
                  AND updated_at < statement_timestamp() - interval '15 minutes'
           )
$function$;

ALTER FUNCTION public.conversion_email_hmac_projection_health()
    OWNER TO postwave_conversion_identity_projector;
REVOKE ALL ON FUNCTION public.conversion_email_hmac_projection_health()
    FROM PUBLIC, postwave_public;
GRANT EXECUTE ON FUNCTION public.conversion_email_hmac_projection_health()
    TO postwave_app;
REVOKE CREATE ON SCHEMA public FROM postwave_conversion_identity_projector;

DO $audit$
DECLARE
    projector_oid oid;
BEGIN
    IF (
        SELECT count(*) <> 3
            OR NOT bool_and(relation.relrowsecurity)
            OR NOT bool_and(relation.relforcerowsecurity)
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname IN (
               'conversion_email_hmac_projection_states',
               'conversion_email_hmac_bindings',
               'conversion_email_hmac_projection_tasks'
           )
    ) THEN
        RAISE EXCEPTION 'conversion email-HMAC projection tables must force RLS';
    END IF;
    IF (
        SELECT count(*) <> 11
            OR NOT bool_and(index_catalog.indisvalid)
            OR NOT bool_and(index_catalog.indisready)
          FROM pg_catalog.pg_class index_relation
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = index_relation.relnamespace
          JOIN pg_catalog.pg_index index_catalog
            ON index_catalog.indexrelid = index_relation.oid
         WHERE namespace.nspname = 'public'
           AND index_relation.relname IN (
               'conversion_email_hmac_bindings_pkey',
               'conversion_email_hmac_bindings_subscriber_uniq',
               'conversion_email_hmac_bindings_digest_lookup_idx',
               'conversion_email_hmac_projection_tasks_pkey',
               'conversion_email_hmac_projection_full_task_uniq',
               'conversion_email_hmac_projection_subscriber_task_uniq',
               'conversion_email_hmac_projection_subscriber_claim_due_idx',
               'conversion_email_hmac_projection_full_claim_due_idx',
               'conversion_email_hmac_projection_tasks_tenant_key_idx',
               'conversion_email_hmac_projection_failed_health_idx',
               'conversion_email_hmac_projection_backlog_health_idx'
           )
    ) THEN
        RAISE EXCEPTION 'conversion email-HMAC projection indexes are incomplete or invalid';
    END IF;
    IF (
        SELECT count(*) <> 3
            OR NOT bool_and(index_catalog.indisvalid)
            OR NOT bool_and(index_catalog.indisready)
            OR NOT bool_and(index_catalog.indpred IS NOT NULL)
          FROM pg_catalog.pg_class index_relation
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid = index_relation.relnamespace
          JOIN pg_catalog.pg_index index_catalog
            ON index_catalog.indexrelid = index_relation.oid
         WHERE namespace.nspname = 'public'
           AND index_relation.relname IN (
               'conversion_ingest_secrets_live_tenant_idx',
               'conversion_attribution_touches_email_hmac_key_idx',
               'conversions_email_hmac_identity_idx'
           )
    ) THEN
        RAISE EXCEPTION 'conversion email-HMAC lifecycle indexes are incomplete or invalid';
    END IF;
    IF (
        SELECT count(*) <> 6 OR NOT bool_and(trigger.tgenabled = 'O')
          FROM pg_catalog.pg_trigger trigger
          JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND trigger.tgname IN (
               'conversion_ingest_secret_live_tenant_limit',
               'conversion_ingest_secret_require_envelope',
               'conversion_email_hmac_key_lifecycle',
               'conversion_email_hmac_subscriber_insert',
               'conversion_email_hmac_subscriber_email_update',
               'conversion_email_hmac_subscriber_delete'
           )
           AND NOT trigger.tgisinternal
    ) THEN
        RAISE EXCEPTION 'conversion email-HMAC projection lifecycle triggers are unavailable';
    END IF;
    IF (
        SELECT count(*) <> 8 OR NOT bool_and(
            CASE policyname
            WHEN 'conversion_email_hmac_projection_states_tenant_select'
                THEN tablename = 'conversion_email_hmac_projection_states'
                     AND cmd = 'SELECT' AND roles::text = '{postwave_app}'
            WHEN 'conversion_email_hmac_projection_states_tenant_insert'
                THEN tablename = 'conversion_email_hmac_projection_states'
                     AND cmd = 'INSERT' AND roles::text = '{postwave_app}'
            WHEN 'conversion_email_hmac_projection_states_tenant_update'
                THEN tablename = 'conversion_email_hmac_projection_states'
                     AND cmd = 'UPDATE' AND roles::text = '{postwave_app}'
            WHEN 'conversion_email_hmac_projection_states_projector'
                THEN tablename = 'conversion_email_hmac_projection_states'
                     AND cmd = 'SELECT'
                     AND roles::text = '{postwave_conversion_identity_projector}'
            WHEN 'conversion_email_hmac_bindings_tenant'
                THEN tablename = 'conversion_email_hmac_bindings'
                     AND cmd = 'ALL' AND roles::text = '{postwave_app}'
            WHEN 'conversion_email_hmac_projection_tasks_tenant'
                THEN tablename = 'conversion_email_hmac_projection_tasks'
                     AND cmd = 'ALL' AND roles::text = '{postwave_app}'
            WHEN 'conversion_email_hmac_projection_tasks_projector'
                THEN tablename = 'conversion_email_hmac_projection_tasks'
                     AND cmd = 'ALL'
                     AND roles::text = '{postwave_conversion_identity_projector}'
            WHEN 'conversion_ingest_secrets_projection_catalog_projector'
                THEN tablename = 'conversion_ingest_secrets'
                     AND cmd = 'SELECT'
                     AND roles::text = '{postwave_conversion_identity_projector}'
            ELSE false END
        )
          FROM pg_catalog.pg_policies
         WHERE schemaname = 'public'
           AND policyname IN (
               'conversion_email_hmac_projection_states_tenant_select',
               'conversion_email_hmac_projection_states_tenant_insert',
               'conversion_email_hmac_projection_states_tenant_update',
               'conversion_email_hmac_projection_states_projector',
               'conversion_email_hmac_bindings_tenant',
               'conversion_email_hmac_projection_tasks_tenant',
               'conversion_email_hmac_projection_tasks_projector',
               'conversion_ingest_secrets_projection_catalog_projector'
           )
    ) THEN
        RAISE EXCEPTION 'conversion email-HMAC projection RLS policy catalog is incomplete';
    END IF;
    IF NOT pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_email_hmac_projection_states', 'SELECT'
    ) OR NOT pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_email_hmac_projection_states', 'INSERT'
    ) OR NOT pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_email_hmac_projection_states', 'UPDATE'
    ) OR pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_email_hmac_projection_states', 'DELETE'
    ) OR pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_email_hmac_projection_states', 'TRUNCATE'
    ) THEN
        RAISE EXCEPTION 'conversion email-HMAC projection state grants are unsafe';
    END IF;
    IF NOT pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_email_hmac_bindings', 'SELECT'
    ) OR NOT pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_email_hmac_bindings', 'INSERT'
    ) OR NOT pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_email_hmac_bindings', 'UPDATE'
    ) OR NOT pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_email_hmac_bindings', 'DELETE'
    ) OR NOT pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_email_hmac_projection_tasks', 'SELECT'
    ) OR NOT pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_email_hmac_projection_tasks', 'INSERT'
    ) OR NOT pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_email_hmac_projection_tasks', 'UPDATE'
    ) OR NOT pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_email_hmac_projection_tasks', 'DELETE'
    ) OR pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_email_hmac_bindings', 'TRUNCATE'
    ) OR pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_email_hmac_projection_tasks', 'TRUNCATE'
    ) THEN
        RAISE EXCEPTION 'conversion email-HMAC binding/task grants are unsafe';
    END IF;
    IF pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_ingest_secrets', 'DELETE'
    ) OR pg_catalog.has_table_privilege(
        'postwave_app', 'public.conversion_ingest_secrets', 'TRUNCATE'
    ) OR NOT pg_catalog.has_column_privilege(
        'postwave_app', 'public.conversion_ingest_secrets', 'revoked_at', 'UPDATE'
    ) OR pg_catalog.has_column_privilege(
        'postwave_app', 'public.conversion_ingest_secrets', 'secret', 'UPDATE'
    ) OR pg_catalog.has_column_privilege(
        'postwave_app', 'public.conversion_ingest_secrets', 'secret_envelope', 'UPDATE'
    ) OR pg_catalog.has_column_privilege(
        'postwave_app', 'public.conversion_ingest_secrets', 'secret_kms_key_arn', 'UPDATE'
    ) OR pg_catalog.has_column_privilege(
        'postwave_app', 'public.conversion_ingest_secrets', 'secret_destroyed_at', 'UPDATE'
    ) OR pg_catalog.has_column_privilege(
        'postwave_app', 'public.conversion_ingest_secrets', 'label', 'UPDATE'
    ) THEN
        RAISE EXCEPTION 'conversion signing-key lifecycle grants are unsafe';
    END IF;
    IF NOT pg_catalog.has_table_privilege(
        'postwave_conversion_identity_projector',
        'public.conversion_email_hmac_projection_tasks', 'SELECT'
    ) OR NOT pg_catalog.has_table_privilege(
        'postwave_conversion_identity_projector',
        'public.conversion_email_hmac_projection_tasks', 'UPDATE'
    ) OR pg_catalog.has_table_privilege(
        'postwave_conversion_identity_projector',
        'public.conversion_email_hmac_projection_tasks', 'INSERT'
    ) OR pg_catalog.has_table_privilege(
        'postwave_conversion_identity_projector',
        'public.conversion_email_hmac_projection_tasks', 'DELETE'
    ) OR pg_catalog.has_table_privilege(
        'postwave_conversion_identity_projector',
        'public.conversion_email_hmac_projection_tasks', 'TRUNCATE'
    ) OR NOT pg_catalog.has_column_privilege(
        'postwave_conversion_identity_projector',
        'public.conversion_ingest_secrets', 'tenant_id', 'SELECT'
    ) OR NOT pg_catalog.has_column_privilege(
        'postwave_conversion_identity_projector',
        'public.conversion_ingest_secrets', 'key_id', 'SELECT'
    ) OR NOT pg_catalog.has_column_privilege(
        'postwave_conversion_identity_projector',
        'public.conversion_ingest_secrets', 'revoked_at', 'SELECT'
    ) OR pg_catalog.has_column_privilege(
        'postwave_conversion_identity_projector',
        'public.conversion_ingest_secrets', 'secret', 'SELECT'
    ) OR pg_catalog.has_column_privilege(
        'postwave_conversion_identity_projector',
        'public.conversion_ingest_secrets', 'secret_envelope', 'SELECT'
    ) OR pg_catalog.has_column_privilege(
        'postwave_conversion_identity_projector',
        'public.conversion_ingest_secrets', 'secret_kms_key_arn', 'SELECT'
    ) OR pg_catalog.has_column_privilege(
        'postwave_conversion_identity_projector',
        'public.conversion_ingest_secrets', 'secret_destroyed_at', 'SELECT'
    ) OR NOT pg_catalog.has_column_privilege(
        'postwave_conversion_identity_projector',
        'public.conversion_email_hmac_projection_states', 'tenant_id', 'SELECT'
    ) OR NOT pg_catalog.has_column_privilege(
        'postwave_conversion_identity_projector',
        'public.conversion_email_hmac_projection_states', 'key_id', 'SELECT'
    ) OR pg_catalog.has_column_privilege(
        'postwave_conversion_identity_projector',
        'public.conversion_email_hmac_projection_states', 'status', 'SELECT'
    ) THEN
        RAISE EXCEPTION 'conversion identity projector table grants are unsafe';
    END IF;
    SELECT oid INTO projector_oid FROM pg_catalog.pg_roles
     WHERE rolname = 'postwave_conversion_identity_projector';
    IF projector_oid IS NULL OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles
         WHERE oid = projector_oid
           AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole
                OR rolinherit OR rolreplication OR rolbypassrls)
    ) OR EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc procedure
         WHERE procedure.oid IN (
             'public.claim_conversion_email_hmac_projection_tasks(text,integer,integer)'::regprocedure,
             'public.conversion_email_hmac_projection_catalog_consistent()'::regprocedure,
             'public.conversion_email_hmac_projection_health()'::regprocedure
         )
           AND (procedure.proowner <> projector_oid OR NOT procedure.prosecdef)
    ) THEN
        RAISE EXCEPTION 'conversion identity projector provenance is unsafe';
    END IF;
    IF pg_catalog.has_schema_privilege(
        'postwave_conversion_identity_projector', 'public', 'CREATE'
    ) THEN
        RAISE EXCEPTION 'conversion identity projector retained schema CREATE';
    END IF;
    IF NOT pg_catalog.has_function_privilege(
        'postwave_app',
        'public.claim_conversion_email_hmac_projection_tasks(text,integer,integer)',
        'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
        'postwave_public',
        'public.claim_conversion_email_hmac_projection_tasks(text,integer,integer)',
        'EXECUTE'
    ) OR NOT pg_catalog.has_function_privilege(
        'postwave_app',
        'public.conversion_email_hmac_projection_catalog_consistent()',
        'EXECUTE'
    ) OR NOT pg_catalog.has_function_privilege(
        'postwave_app',
        'public.conversion_email_hmac_projection_health()',
        'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
        'postwave_public',
        'public.conversion_email_hmac_projection_health()',
        'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
        'postwave_public',
        'public.conversion_email_hmac_projection_catalog_consistent()',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'conversion identity projection claim grants are unsafe';
    END IF;
    IF NOT public.conversion_email_hmac_projection_catalog_consistent() THEN
        RAISE EXCEPTION 'conversion email-HMAC key/state catalog is inconsistent';
    END IF;
END
$audit$;

COMMIT;
