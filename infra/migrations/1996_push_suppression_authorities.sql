-- Route43: independent, fail-closed customer push suppression authorities.
--
-- push_token_suppressions is a released one-row projection. Its historical
-- ON CONFLICT writer can replace `reason` without replacing provenance, so a
-- non-manual row cannot prove that it did not previously overwrite a manual
-- hold. The new table is the authoritative send gate: every active fact blocks
-- its exact (tenant, platform, SHA-256 token) tuple and independent facts may
-- coexist. Historical dashboard/manual rows are provably manual; every other
-- historical row is review-locked as legacy_unknown.
--
-- Operational prerequisite: drain or disable every provider-capable custom
-- pre-Route43 push sender before this migration and before any rollback. The
-- repository's released default composition has nil APNs/FCM providers and
-- cannot deliver, but a custom old sender cannot be retroactively made to hold
-- the new check/provider lease by database triggers alone.
--
-- Deployment order: this migration first, then the Route43 binary. An old
-- binary against this schema remains fail closed: INSERT/UPDATE on the legacy
-- table appends an authority fact and DELETE cannot remove a token carrying a
-- non-manual fact. The new sender against an old schema receives a query error
-- and makes no provider call. Roll an application binary back without removing
-- this table or its legacy triggers.
--
-- rollback-strategy: expand-contract
-- rollback-details: Leave the authority table and legacy synchronization/guard triggers installed when rolling the application back. Removing them would let a mixed-version writer erase an active hold. Contract only after every legacy_unknown fact has a reviewed disposition and every old writer is drained.

-- Hold one deployment barrier for the migration transaction. An old binary's
-- RowExclusive legacy write must not commit after the backfill snapshot but
-- before the synchronization trigger exists. Lock the parent first so tenant
-- lifecycle work cannot invert with the legacy table; tenant INSERTs are also
-- held until the registry-state seed trigger is installed. Reads remain live.
LOCK TABLE public.tenants IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.push_token_suppressions IN SHARE ROW EXCLUSIVE MODE;

-- Public clients intentionally accept one bounded canonical timestamp window.
-- Refuse an anomalous legacy history before creating any Route43 object rather
-- than silently clamp/reorder authority evidence or deploy rows clients cannot
-- decode. The migration runner executes this file atomically.
DO $$
BEGIN
  IF EXISTS (
      SELECT 1
        FROM push_token_suppressions
       WHERE created_at < timestamptz '2000-01-01 00:00:00+00'
          OR created_at >= timestamptz '2100-01-01 00:00:00+00'
          OR created_at > clock_timestamp()
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'push suppression legacy timestamp is outside the supported [2000,2100) projection window',
      CONSTRAINT = 'push_suppression_authorities_legacy_time_preflight';
  END IF;
END
$$;

-- The registration table and authority API must share one exact-byte token
-- domain. Abort rather than leave an enabled historical endpoint that the
-- Route43 API cannot represent/suppress. PostgreSQL text is valid database
-- encoding; the application gate additionally applies Unicode White_Space and
-- control-category checks before both registration and send.
DO $$
BEGIN
  IF EXISTS (
      SELECT 1
        FROM push_devices
       WHERE octet_length(token) NOT BETWEEN 20 AND 4096
          OR token ~ '[[:space:][:cntrl:]]'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'push device token is outside the suppressible exact-byte identity domain',
      CONSTRAINT = 'push_devices_suppressible_token_preflight';
  END IF;
END
$$;

ALTER TABLE push_devices
    ADD CONSTRAINT push_devices_suppressible_token_check CHECK (
        octet_length(token) BETWEEN 20 AND 4096 AND
        token !~ '[[:space:][:cntrl:]]'
    );

-- One monotonic revision per tenant gives cursor pages a stable logical
-- membership boundary without depending on wall-clock resolution. Authority
-- mutations hold the tenant's exclusive advisory lease while advancing this
-- row; sends and lists hold the matching shared lease.
CREATE TABLE push_suppression_registry_state (
    tenant_id uuid   PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    revision  bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

INSERT INTO push_suppression_registry_state (tenant_id, revision)
SELECT id, 0 FROM tenants;

ALTER TABLE push_suppression_registry_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_suppression_registry_state FORCE ROW LEVEL SECURITY;

CREATE POLICY push_suppression_registry_state_tenant_isolation
    ON push_suppression_registry_state
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY push_suppression_registry_state_tenant_visible
    ON push_suppression_registry_state
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT ON push_suppression_registry_state TO postwave_app;

-- FORCE RLS requires a narrowly privileged definer for monotonic revision
-- advancement. The role cannot log in, inherit, create objects/roles/databases,
-- or join another role; its only table capabilities are the exact state write
-- and tenant existence read used by the two trigger functions below.
DO $role$
DECLARE
  definer pg_catalog.pg_roles%ROWTYPE;
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
       WHERE rolname = 'postwave_push_suppression_revision_definer'
  ) THEN
    CREATE ROLE postwave_push_suppression_revision_definer
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION BYPASSRLS;
  END IF;
  SELECT * INTO definer FROM pg_catalog.pg_roles
   WHERE rolname = 'postwave_push_suppression_revision_definer';
  IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
     definer.rolcreaterole OR definer.rolinherit OR
     definer.rolreplication OR NOT definer.rolbypassrls THEN
    RAISE EXCEPTION 'postwave_push_suppression_revision_definer has unsafe role attributes';
  END IF;
  IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members
       WHERE member = definer.oid OR roleid = definer.oid
  ) THEN
    RAISE EXCEPTION 'postwave_push_suppression_revision_definer must have no memberships';
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA public TO postwave_push_suppression_revision_definer;
GRANT SELECT (id) ON public.tenants TO postwave_push_suppression_revision_definer;
GRANT SELECT, INSERT, UPDATE ON public.push_suppression_registry_state
  TO postwave_push_suppression_revision_definer;
GRANT CREATE ON SCHEMA public TO postwave_push_suppression_revision_definer;

CREATE OR REPLACE FUNCTION public.push_suppression_registry_seed_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  INSERT INTO public.push_suppression_registry_state (tenant_id, revision)
  VALUES (NEW.id, 0)
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.push_suppression_registry_seed_tenant() FROM PUBLIC;
ALTER FUNCTION public.push_suppression_registry_seed_tenant()
  OWNER TO postwave_push_suppression_revision_definer;

CREATE TRIGGER push_suppression_registry_seed_tenant_trg
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION public.push_suppression_registry_seed_tenant();

CREATE TABLE push_suppression_authorities (
    id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    device_token_hash       bytea       NOT NULL,
    platform                text        NOT NULL,
    authority               text        NOT NULL,
    reason                  text        NOT NULL,
    source                  text        NOT NULL,
    source_event_id         text,
    legacy_suppression_id   uuid,
    created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
    version                 bigint      NOT NULL DEFAULT 1,
    -- Internal evidence timestamps. Public evidence timestamps may be
    -- historical (notably for mixed-version legacy writers), so only the
    -- monotonic registry_*_revision columns define cursor membership.
    registry_visible_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
    registry_hidden_at      timestamptz,
    registry_active_updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    registry_active_version bigint      NOT NULL DEFAULT 1,
    registry_visible_revision bigint    NOT NULL DEFAULT 0,
    registry_hidden_revision  bigint,
    revoked_at              timestamptz,

    CONSTRAINT push_suppression_authorities_id_v4_check CHECK (
        id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
    CONSTRAINT push_suppression_authorities_hash_check CHECK (
        octet_length(device_token_hash) = 32
    ),
    CONSTRAINT push_suppression_authorities_platform_check CHECK (
        platform IN ('apns', 'fcm', 'web')
    ),
    CONSTRAINT push_suppression_authorities_authority_check CHECK (
        authority IN ('manual', 'provider', 'user', 'complaint', 'legacy_unknown')
    ),
    CONSTRAINT push_suppression_authorities_reason_check CHECK (
        reason IN ('manual', 'unregistered', 'expired', 'complaint', 'user_opt_out')
    ),
    CONSTRAINT push_suppression_authorities_source_check CHECK (
        length(source) BETWEEN 1 AND 64 AND
        source ~ '^[A-Za-z0-9_.:-]+$'
    ),
    CONSTRAINT push_suppression_authorities_source_event_check CHECK (
        source_event_id IS NULL OR (
            length(source_event_id) BETWEEN 1 AND 256 AND
            source_event_id ~ '^[A-Za-z0-9_.:-]+$'
        )
    ),
    CONSTRAINT push_suppression_authorities_authority_reason_check CHECK (
        CASE authority
          WHEN 'manual' THEN reason = 'manual' AND source = 'dashboard'
          WHEN 'provider' THEN reason IN ('unregistered', 'expired')
          WHEN 'user' THEN reason = 'user_opt_out'
          WHEN 'complaint' THEN reason = 'complaint'
          WHEN 'legacy_unknown' THEN source = 'legacy'
          ELSE false
        END
    ),
    CONSTRAINT push_suppression_authorities_version_check CHECK (version >= 1),
    CONSTRAINT push_suppression_authorities_time_check CHECK (
        updated_at >= created_at AND
        (revoked_at IS NULL OR (
            revoked_at >= created_at AND
            updated_at >= revoked_at
        ))
    ),
    CONSTRAINT push_suppression_authorities_projection_time_check CHECK (
        created_at >= timestamptz '2000-01-01 00:00:00+00' AND
        created_at <  timestamptz '2100-01-01 00:00:00+00' AND
        updated_at >= timestamptz '2000-01-01 00:00:00+00' AND
        updated_at <  timestamptz '2100-01-01 00:00:00+00' AND
        (revoked_at IS NULL OR (
            revoked_at >= timestamptz '2000-01-01 00:00:00+00' AND
            revoked_at <  timestamptz '2100-01-01 00:00:00+00'
        ))
    ),
    CONSTRAINT push_suppression_authorities_registry_visibility_check CHECK (
        registry_visible_at >= timestamptz '2000-01-01 00:00:00+00' AND
        registry_visible_at <  timestamptz '2100-01-01 00:00:00+00' AND
        (registry_hidden_at IS NULL OR (
            registry_hidden_at >= registry_visible_at AND
            registry_hidden_at < timestamptz '2100-01-01 00:00:00+00'
        )) AND
        registry_active_updated_at >= created_at AND
        registry_active_updated_at <= registry_visible_at AND
        registry_active_updated_at < timestamptz '2100-01-01 00:00:00+00' AND
        registry_active_version >= 1 AND
        registry_visible_revision >= 0 AND
        (registry_hidden_revision IS NULL OR
            registry_hidden_revision > registry_visible_revision) AND
        ((revoked_at IS NULL) = (registry_hidden_at IS NULL))
        AND ((revoked_at IS NULL) = (registry_hidden_revision IS NULL))
    )
);

-- One active fact for one concrete authority tuple. Different authorities and
-- reasons intentionally coexist and every one participates in the send gate.
CREATE UNIQUE INDEX push_suppression_authorities_active_unique
    ON push_suppression_authorities
       (tenant_id, platform, device_token_hash, authority, reason, source)
    WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX push_suppression_authorities_source_event_unique
    ON push_suppression_authorities (tenant_id, source, source_event_id)
    WHERE source_event_id IS NOT NULL;

-- Browse indexes deliberately retain revoked rows. A cursor minted before a
-- concurrent manual reversal must still page the same active-at-snapshot set
-- in a later transaction (registry_hidden_revision > snapshot_revision)
-- without falling back to a tenant-wide scan. The exact send gate uses
-- active_unique above.
CREATE INDEX push_suppression_authorities_tenant_created_id_idx
    ON push_suppression_authorities (tenant_id, created_at DESC, id DESC);

CREATE INDEX push_suppression_authorities_tenant_platform_created_id_idx
    ON push_suppression_authorities
       (tenant_id, platform, created_at DESC, id DESC);

CREATE INDEX push_suppression_authorities_tenant_reason_created_id_idx
    ON push_suppression_authorities
       (tenant_id, reason, created_at DESC, id DESC);

CREATE INDEX push_suppression_authorities_tenant_hash_prefix_idx
    ON push_suppression_authorities
       (tenant_id, (encode(device_token_hash, 'hex')) text_pattern_ops,
        created_at DESC, id DESC);

-- Preserve only bounded authority facts. Arbitrary legacy metadata and source
-- event identifiers are deliberately not copied into the new private registry.
-- This backfill intentionally precedes FORCE RLS so migration correctness does
-- not depend on the runner role having BYPASSRLS.
INSERT INTO push_suppression_authorities (
    tenant_id, device_token_hash, platform, authority, reason, source,
    legacy_suppression_id, created_at, updated_at,
    registry_active_updated_at, registry_active_version,
    registry_visible_revision
)
SELECT tenant_id,
       device_token_hash,
       platform,
       CASE WHEN source = 'dashboard' AND reason = 'manual'
            THEN 'manual' ELSE 'legacy_unknown' END,
       reason,
       CASE WHEN source = 'dashboard' AND reason = 'manual'
            THEN 'dashboard' ELSE 'legacy' END,
       id,
       created_at,
       created_at,
       created_at,
       1,
       0
  FROM push_token_suppressions
ON CONFLICT (tenant_id, platform, device_token_hash, authority, reason, source)
    WHERE revoked_at IS NULL
DO NOTHING;

ALTER TABLE push_suppression_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_suppression_authorities FORCE ROW LEVEL SECURITY;

CREATE POLICY push_suppression_authorities_tenant_isolation
    ON push_suppression_authorities
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY push_suppression_authorities_tenant_visible
    ON push_suppression_authorities
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON push_suppression_authorities TO postwave_app;

-- Obtain the mutation lease before PostgreSQL takes row locks. This statement
-- trigger covers both the authoritative and mixed-version projection tables,
-- preventing cross-table row/advisory lock inversion. Tenant-scoped app work
-- shares one global coordination lease and takes the tenant lease exclusively.
-- A no-GUC administrative statement takes the global lease exclusively so it
-- cannot race tenant-scoped sends or mutations before row identity is known.
CREATE OR REPLACE FUNCTION public.push_suppression_mutation_statement_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE
  tenant_text text;
  tenant_uuid uuid;
BEGIN
  tenant_text := NULLIF(current_setting('app.tenant_id', true), '');
  IF tenant_text IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
        'push-suppression-authority-domain:v1', 0));
  ELSE
    tenant_uuid := tenant_text::uuid;
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(
        'push-suppression-authority-domain:v1', 0));
    PERFORM pg_advisory_xact_lock(hashtextextended(
        'push-suppression-registry:' || tenant_uuid::text, 0));
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.push_suppression_mutation_statement_lock() FROM PUBLIC;

CREATE TRIGGER push_suppression_authority_00_statement_lock_trg
BEFORE INSERT OR UPDATE OR DELETE ON push_suppression_authorities
FOR EACH STATEMENT EXECUTE FUNCTION public.push_suppression_mutation_statement_lock();

CREATE TRIGGER push_suppression_legacy_00_statement_lock_trg
BEFORE INSERT OR UPDATE OR DELETE ON push_token_suppressions
FOR EACH STATEMENT EXECUTE FUNCTION public.push_suppression_mutation_statement_lock();

-- Device eligibility is part of the same linearizable send boundary. Taking
-- this lease before any device row lock prevents device-row -> authority-lease
-- inversion against a send that already holds the shared lease.
CREATE TRIGGER push_suppression_device_00_statement_lock_trg
BEFORE INSERT OR UPDATE OR DELETE ON push_devices
FOR EACH STATEMENT EXECUTE FUNCTION public.push_suppression_mutation_statement_lock();

-- Subscriber deletion cascades into push_devices. Lock at the parent statement
-- boundary, before PostgreSQL acquires a subscriber row, so the cascade cannot
-- invert with UpsertDevice (tenant lease -> subscriber FK/row).
CREATE TRIGGER push_suppression_subscriber_delete_00_statement_lock_trg
BEFORE DELETE ON subscribers
FOR EACH STATEMENT EXECUTE FUNCTION public.push_suppression_mutation_statement_lock();

CREATE TRIGGER push_suppression_tenant_delete_00_statement_lock_trg
BEFORE DELETE ON tenants
FOR EACH STATEMENT EXECUTE FUNCTION public.push_suppression_mutation_statement_lock();

-- TRUNCATE bypasses row and DML statement triggers. It is never an admissible
-- authority, revision, legacy-compatibility, or device lifecycle operation;
-- reject it even for maintenance roles. A superuser can still explicitly
-- disable triggers, which remains an out-of-band destructive operation.
CREATE OR REPLACE FUNCTION public.push_suppression_reject_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '0A000',
    MESSAGE = 'push suppression authority domain cannot be truncated';
END
$$;

REVOKE ALL ON FUNCTION public.push_suppression_reject_truncate() FROM PUBLIC;

CREATE TRIGGER push_suppression_authority_reject_truncate_trg
BEFORE TRUNCATE ON push_suppression_authorities
FOR EACH STATEMENT EXECUTE FUNCTION public.push_suppression_reject_truncate();

CREATE TRIGGER push_suppression_legacy_reject_truncate_trg
BEFORE TRUNCATE ON push_token_suppressions
FOR EACH STATEMENT EXECUTE FUNCTION public.push_suppression_reject_truncate();

CREATE TRIGGER push_suppression_state_reject_truncate_trg
BEFORE TRUNCATE ON push_suppression_registry_state
FOR EACH STATEMENT EXECUTE FUNCTION public.push_suppression_reject_truncate();

CREATE TRIGGER push_suppression_device_reject_truncate_trg
BEFORE TRUNCATE ON push_devices
FOR EACH STATEMENT EXECUTE FUNCTION public.push_suppression_reject_truncate();

-- Row-level defense in depth supplies the concrete tenant key for cascades and
-- stamps the monotonic visibility revision. Trigger coverage includes direct
-- SQL and nested legacy synchronization rather than trusting Route43 handlers.
CREATE OR REPLACE FUNCTION public.push_suppression_authority_visibility_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE
  row_tenant uuid;
  caller_tenant text;
  visibility_now timestamptz;
  visibility_revision bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_tenant := OLD.tenant_id;
  ELSE
    row_tenant := NEW.tenant_id;
  END IF;

  caller_tenant := NULLIF(current_setting('app.tenant_id', true), '');
  IF caller_tenant IS NOT NULL AND row_tenant <> caller_tenant::uuid THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'push suppression authority tenant does not match transaction tenant';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
      'push-suppression-authority-domain:v1', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
      'push-suppression-registry:' || row_tenant::text, 0));
  visibility_now := clock_timestamp();

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'push suppression authority facts cannot be deleted',
        CONSTRAINT = 'push_suppression_authority_delete_guard';
    END IF;
    RETURN OLD;
  END IF;

  INSERT INTO public.push_suppression_registry_state (tenant_id, revision)
  VALUES (row_tenant, 1)
  ON CONFLICT (tenant_id) DO UPDATE
     SET revision = public.push_suppression_registry_state.revision + 1
  RETURNING revision INTO visibility_revision;

  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.version <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'push suppression authority must be inserted active at version 1',
        CONSTRAINT = 'push_suppression_authority_active_insert_guard';
    END IF;
    IF NEW.created_at > visibility_now OR NEW.updated_at > visibility_now THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'push suppression authority evidence cannot be future-dated',
        CONSTRAINT = 'push_suppression_authorities_projection_time_check';
    END IF;
    NEW.registry_visible_at := visibility_now;
    NEW.registry_active_updated_at := NEW.updated_at;
    NEW.registry_active_version := NEW.version;
    NEW.registry_visible_revision := visibility_revision;
    NEW.registry_hidden_at := NULL;
    NEW.registry_hidden_revision := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.registry_visible_at := OLD.registry_visible_at;
    NEW.registry_active_updated_at := OLD.registry_active_updated_at;
    NEW.registry_active_version := OLD.registry_active_version;
    NEW.registry_visible_revision := OLD.registry_visible_revision;
    IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
      -- Wall time can move backward after the fact was created. Revisions are
      -- the ordering authority; clamp evidence/visibility timestamps only as
      -- far as needed to retain their monotonic public invariants.
      IF NEW.revoked_at < timestamptz '2000-01-01 00:00:00+00' OR
         NEW.revoked_at >= timestamptz '2100-01-01 00:00:00+00' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'push suppression revocation is outside the supported [2000,2100) projection window',
          CONSTRAINT = 'push_suppression_authorities_projection_time_check';
      END IF;
      IF NEW.revoked_at > GREATEST(
          visibility_now, OLD.created_at, OLD.updated_at) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'push suppression revocation evidence cannot be future-dated',
          CONSTRAINT = 'push_suppression_authorities_time_check';
      END IF;
      NEW.revoked_at := GREATEST(
          visibility_now, OLD.created_at, OLD.updated_at);
      NEW.registry_hidden_at := GREATEST(
          visibility_now, OLD.registry_visible_at);
      NEW.registry_hidden_revision := visibility_revision;
    ELSE
      NEW.registry_hidden_at := OLD.registry_hidden_at;
      NEW.registry_hidden_revision := OLD.registry_hidden_revision;
    END IF;
    RETURN NEW;
  END IF;

  RETURN OLD;
END
$$;

REVOKE ALL ON FUNCTION public.push_suppression_authority_visibility_lock() FROM PUBLIC;
ALTER FUNCTION public.push_suppression_authority_visibility_lock()
  OWNER TO postwave_push_suppression_revision_definer;
REVOKE CREATE ON SCHEMA public FROM postwave_push_suppression_revision_definer;

CREATE TRIGGER push_suppression_authority_01_visibility_lock_trg
BEFORE INSERT OR UPDATE OR DELETE ON push_suppression_authorities
FOR EACH ROW EXECUTE FUNCTION public.push_suppression_authority_visibility_lock();

CREATE OR REPLACE FUNCTION public.push_suppression_authority_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.id <> OLD.id OR
     NEW.tenant_id <> OLD.tenant_id OR
     NEW.device_token_hash <> OLD.device_token_hash OR
     NEW.platform <> OLD.platform OR
     NEW.authority <> OLD.authority OR
     NEW.reason <> OLD.reason OR
     NEW.source <> OLD.source OR
     NEW.source_event_id IS DISTINCT FROM OLD.source_event_id OR
     NEW.legacy_suppression_id IS DISTINCT FROM OLD.legacy_suppression_id OR
     NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'push suppression authority identity is immutable',
      CONSTRAINT = 'push_suppression_authority_immutable_guard';
  END IF;

  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'revoked push suppression authority is immutable',
      CONSTRAINT = 'push_suppression_authority_immutable_guard';
  END IF;
  IF OLD.authority <> 'manual' OR OLD.source <> 'dashboard' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'non-manual push suppression authority requires reviewed system reconciliation',
      CONSTRAINT = 'push_suppression_authority_immutable_guard';
  END IF;
  IF NEW.revoked_at IS NULL OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'manual push suppression revocation requires one monotonic version transition',
      CONSTRAINT = 'push_suppression_authority_immutable_guard';
  END IF;

  NEW.updated_at := GREATEST(
      clock_timestamp(), OLD.updated_at + interval '1 microsecond', NEW.revoked_at);
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.push_suppression_authority_immutable_guard() FROM PUBLIC;

CREATE TRIGGER push_suppression_authority_immutable_guard_trg
BEFORE UPDATE ON push_suppression_authorities
FOR EACH ROW EXECUTE FUNCTION public.push_suppression_authority_immutable_guard();

-- Every mixed-version INSERT/UPDATE can only append authority. It never revokes
-- or rewrites a fact, so a legacy reason collision remains blocked.
CREATE OR REPLACE FUNCTION public.push_suppression_sync_legacy_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE
  fact_authority text;
  fact_source text;
BEGIN
  IF NEW.source = 'dashboard' AND NEW.reason = 'manual' THEN
    fact_authority := 'manual';
    fact_source := 'dashboard';
  ELSE
    fact_authority := 'legacy_unknown';
    fact_source := 'legacy';
  END IF;

  INSERT INTO public.push_suppression_authorities (
      tenant_id, device_token_hash, platform, authority, reason, source,
      legacy_suppression_id, created_at, updated_at
  ) VALUES (
      NEW.tenant_id, NEW.device_token_hash, NEW.platform, fact_authority,
      NEW.reason, fact_source, NEW.id, NEW.created_at, NEW.created_at
  )
  ON CONFLICT (tenant_id, platform, device_token_hash, authority, reason, source)
      WHERE revoked_at IS NULL
  DO NOTHING;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.push_suppression_sync_legacy_authority() FROM PUBLIC;

CREATE TRIGGER push_suppression_sync_legacy_authority_trg
AFTER INSERT OR UPDATE ON push_token_suppressions
FOR EACH ROW EXECUTE FUNCTION public.push_suppression_sync_legacy_authority();

-- A legacy DELETE can release only an active dashboard/manual fact, and only
-- when no stronger authority remains. Tenant FK cascades remain available even
-- to a control connection without app.tenant_id, but an unrelated nested
-- trigger cannot use depth alone to bypass the guard while the parent exists.
CREATE OR REPLACE FUNCTION public.push_suppression_guard_legacy_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  IF pg_trigger_depth() > 1 AND NOT EXISTS (
      SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
      SELECT 1
        FROM public.push_suppression_authorities a
       WHERE a.tenant_id = OLD.tenant_id
         AND a.platform = OLD.platform
         AND a.device_token_hash = OLD.device_token_hash
         AND a.revoked_at IS NULL
         AND NOT (a.authority = 'manual' AND a.source = 'dashboard')
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE public.push_suppression_authorities
     SET revoked_at = clock_timestamp(), version = version + 1
   WHERE tenant_id = OLD.tenant_id
     AND platform = OLD.platform
     AND device_token_hash = OLD.device_token_hash
     AND authority = 'manual'
     AND source = 'dashboard'
     AND revoked_at IS NULL;
  RETURN OLD;
END
$$;

REVOKE ALL ON FUNCTION public.push_suppression_guard_legacy_delete() FROM PUBLIC;

CREATE TRIGGER push_suppression_guard_legacy_delete_trg
BEFORE DELETE ON push_token_suppressions
FOR EACH ROW EXECUTE FUNCTION public.push_suppression_guard_legacy_delete();

COMMENT ON TABLE push_suppression_authorities IS
  'Route43 independent active authority facts. Any unrevoked fact blocks the exact tenant/platform/SHA-256 token tuple; legacy_unknown is review-locked.';
COMMENT ON COLUMN push_suppression_authorities.device_token_hash IS
  'Exact SHA-256 of the raw customer device token bytes. API projections expose only a bounded hexadecimal fingerprint.';
