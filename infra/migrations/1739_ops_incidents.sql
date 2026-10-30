-- 1739_ops_incidents.sql
-- Operator incident timeline for the ops console (Health & Incidents section).
--
-- These are PLATFORM tables, not tenant tables: they record the platform team's
-- own incidents (a Stripe outage, a deliverability event, a bad deploy), have no
-- tenant_id, and are deliberately NOT RLS-protected — same class as
-- ops_check_results (1700). postwave_ops gets direct DML here (unlike base
-- tables): these rows ARE the operator's data, so there is nothing to hide
-- behind a SECURITY DEFINER aggregate.
--
-- An incident is a header row plus an append-only stream of updates. status
-- transitions may move between open and monitoring, then to terminal resolved;
-- resolved_at and all header timestamps are stamped by the database, never by
-- the ops caller. The updates are never edited or deleted — the timeline is the
-- record.
--
-- rollback-strategy: no-op - additive platform tables and grants; drop them and
-- redeploy the previous image.

BEGIN;

-- Trigger code needs to update the server-owned incident state even though the
-- ops caller itself must have no UPDATE grant. Use a purpose-built, no-login
-- owner with exact column privileges instead of the migration superuser.
DO $$
DECLARE
    definer pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postwave_ops_incidents_definer') THEN
        CREATE ROLE postwave_ops_incidents_definer
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION NOBYPASSRLS;
    END IF;

    SELECT * INTO definer FROM pg_roles WHERE rolname = 'postwave_ops_incidents_definer';
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR definer.rolreplication OR
       definer.rolbypassrls THEN
        RAISE EXCEPTION
            'postwave_ops_incidents_definer has unsafe role attributes; reconcile it before applying 1739';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_auth_members
         WHERE member = definer.oid OR roleid = definer.oid
    ) THEN
        RAISE EXCEPTION
            'postwave_ops_incidents_definer must have no role memberships or members';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_default_acl AS d
          LEFT JOIN LATERAL aclexplode(d.defaclacl) AS acl ON true
         WHERE d.defaclrole = definer.oid OR acl.grantee = definer.oid
    ) THEN
        RAISE EXCEPTION
            'postwave_ops_incidents_definer must not own or receive altered default privileges';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_class AS c
          JOIN pg_namespace AS n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relowner = definer.oid
    ) OR EXISTS (
        SELECT 1
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proowner = definer.oid
    ) OR EXISTS (
        SELECT 1
          FROM pg_namespace AS n
         WHERE n.nspowner = definer.oid
    ) THEN
        RAISE EXCEPTION
            'postwave_ops_incidents_definer already owns database objects; audit them before applying 1739';
    END IF;
    IF has_schema_privilege('postwave_ops', 'public', 'CREATE') OR
       has_schema_privilege('postwave_ops_incidents_definer', 'public', 'CREATE') THEN
        RAISE EXCEPTION 'ops incident roles must not have CREATE on schema public';
    END IF;
END;
$$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
    FROM postwave_ops_incidents_definer;
GRANT USAGE, CREATE ON SCHEMA public TO postwave_ops_incidents_definer;

-- These are new objects. Deliberately omit IF NOT EXISTS so an out-of-band
-- object (and its unknown owner, ACL, constraints, or columns) stops the
-- migration instead of being adopted as the operator write boundary.
CREATE TABLE public.ops_incidents (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key uuid NOT NULL,
    title       text NOT NULL,
    severity    text NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3')),
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'monitoring', 'resolved')),
    opened_by   text NOT NULL,
    opened_at   timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    update_count integer NOT NULL DEFAULT 0,
    CONSTRAINT ops_incidents_title_bounds CHECK (
      char_length(btrim(title)) BETWEEN 1 AND 256 AND
      octet_length(title) <= 1024
    ),
    CONSTRAINT ops_incidents_opened_by_bounds CHECK (
      char_length(btrim(opened_by)) BETWEEN 1 AND 320 AND
      octet_length(opened_by) <= 320
    ),
    CONSTRAINT ops_incidents_resolution_state CHECK (
      (status = 'resolved') = (resolved_at IS NOT NULL)
    ),
    CONSTRAINT ops_incidents_update_count_bounds CHECK (
      update_count BETWEEN 0 AND 10000
    ),
    CONSTRAINT ops_incidents_idempotency_key_unique UNIQUE (idempotency_key)
);

CREATE INDEX ops_incidents_status_opened_idx
    ON public.ops_incidents (status, opened_at DESC);

CREATE TABLE public.ops_incident_updates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id uuid NOT NULL REFERENCES public.ops_incidents (id) ON DELETE CASCADE,
    idempotency_key uuid NOT NULL,
    body        text NOT NULL,
    author      text NOT NULL,
    requested_status text CHECK (
      requested_status IS NULL OR requested_status IN ('open', 'monitoring', 'resolved')
    ),
    created_at  timestamptz NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT ops_incident_updates_body_bounds CHECK (
      char_length(btrim(body)) BETWEEN 1 AND 4096 AND
      octet_length(body) <= 16384
    ),
    CONSTRAINT ops_incident_updates_author_bounds CHECK (
      char_length(btrim(author)) BETWEEN 1 AND 320 AND
      octet_length(author) <= 320
    ),
    CONSTRAINT ops_incident_updates_idempotency_key_unique UNIQUE (idempotency_key)
);

CREATE INDEX ops_incident_updates_incident_idx
    ON public.ops_incident_updates (incident_id, created_at);

-- Callers submit only a status. This trigger owns every timestamp and makes
-- resolved terminal, preventing a direct postwave_ops query from reopening an
-- incident with a stale resolved_at or forging the chronology.
CREATE FUNCTION public.ops_incidents_enforce_server_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    -- Timeline inserts share this definer so they can take the parent row lock
    -- before receiving a timestamp. This serializes direct-role callers as well
    -- as the API and prevents a statement that waited on another writer from
    -- acquiring an earlier created_at. It changes no durable state, so an exact
    -- ON CONFLICT replay remains a true no-op.
    IF TG_TABLE_NAME = 'ops_incident_updates' THEN
        PERFORM i.id
          FROM public.ops_incidents AS i
         WHERE i.id = NEW.incident_id
         FOR UPDATE;
        NEW.created_at := clock_timestamp();
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.status := 'open';
        NEW.opened_at := statement_timestamp();
        NEW.updated_at := NEW.opened_at;
        NEW.resolved_at := NULL;
        RETURN NEW;
    END IF;

    IF OLD.status = 'resolved' AND NEW.status <> 'resolved' THEN
        RAISE EXCEPTION 'resolved incidents are terminal'
            USING ERRCODE = '23514';
    END IF;

    NEW.opened_at := OLD.opened_at;
    NEW.updated_at := clock_timestamp();
    IF NEW.status = 'resolved' THEN
        NEW.resolved_at := COALESCE(OLD.resolved_at, NEW.updated_at);
    ELSE
        NEW.resolved_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER ops_incidents_server_state
BEFORE INSERT OR UPDATE ON public.ops_incidents
FOR EACH ROW EXECUTE FUNCTION public.ops_incidents_enforce_server_state();

CREATE TRIGGER ops_incident_updates_created_at
BEFORE INSERT ON public.ops_incident_updates
FOR EACH ROW EXECUTE FUNCTION public.ops_incidents_enforce_server_state();

-- Bound an individual incident's durable timeline as well as each row. This is
-- an AFTER trigger deliberately: INSERT ... ON CONFLICT DO NOTHING must not
-- touch the header on an idempotent replay. The atomic guarded counter update
-- serializes distinct concurrent inserts without a stale-snapshot count race.
-- Once resolved, every distinct insert is rejected; an exact idempotency replay
-- still remains a no-op because it never reaches this AFTER trigger.
-- Ten thousand entries is an operational ceiling, not a page size; the API
-- independently returns a much smaller recent window.
CREATE FUNCTION public.ops_incident_updates_enforce_server_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
    UPDATE public.ops_incidents
       SET status = COALESCE(NEW.requested_status, status),
           update_count = update_count + 1
     WHERE id = NEW.incident_id
       AND status <> 'resolved'
       AND update_count < 10000;
    IF NOT FOUND THEN
        IF EXISTS (
            SELECT 1
              FROM public.ops_incidents
             WHERE id = NEW.incident_id
               AND status = 'resolved'
        ) THEN
            RAISE EXCEPTION 'resolved incidents are terminal'
                USING ERRCODE = '23514';
        END IF;
        RAISE EXCEPTION 'incident timeline cannot exceed 10000 updates'
            USING ERRCODE = '54000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER ops_incident_updates_server_state
AFTER INSERT ON public.ops_incident_updates
FOR EACH ROW EXECUTE FUNCTION public.ops_incident_updates_enforce_server_state();

ALTER FUNCTION public.ops_incidents_enforce_server_state()
    OWNER TO postwave_ops_incidents_definer;
ALTER FUNCTION public.ops_incident_updates_enforce_server_state()
    OWNER TO postwave_ops_incidents_definer;
REVOKE CREATE ON SCHEMA public FROM postwave_ops_incidents_definer;

REVOKE ALL PRIVILEGES ON TABLE
    public.ops_incidents, public.ops_incident_updates
FROM postwave_ops_incidents_definer;
GRANT SELECT (id, status, update_count), UPDATE (status, update_count)
    ON public.ops_incidents TO postwave_ops_incidents_definer;

REVOKE ALL ON FUNCTION public.ops_incidents_enforce_server_state()
    FROM PUBLIC, postwave_ops;
REVOKE ALL ON FUNCTION public.ops_incident_updates_enforce_server_state()
    FROM PUBLIC, postwave_ops;

-- Start from a deterministic ACL. The ops principal can read both platform
-- tables and create only application-supplied fields. It has no UPDATE grant:
-- the timeline trigger applies requested_status through its exact definer
-- privilege, so every transition has a durable entry. The role cannot rewrite
-- incident identity/provenance/timestamps or edit/delete timeline entries.
REVOKE ALL PRIVILEGES ON TABLE
    public.ops_incidents, public.ops_incident_updates
FROM PUBLIC, postwave_ops;

GRANT SELECT ON TABLE public.ops_incidents TO postwave_ops;
GRANT INSERT (idempotency_key, title, severity, opened_by)
    ON public.ops_incidents TO postwave_ops;

GRANT SELECT ON TABLE public.ops_incident_updates TO postwave_ops;
GRANT INSERT (incident_id, idempotency_key, body, author, requested_status)
    ON public.ops_incident_updates TO postwave_ops;

-- Platform classification and privilege assertions. These tables deliberately
-- have no tenant_id and no RLS; introducing either changes the isolation model
-- and requires a new reviewed migration. postwave_ops must remain unable to
-- create shadow objects in public.
DO $$
DECLARE
    definer_oid oid;
    ops_oid oid;
    definer pg_roles%ROWTYPE;
BEGIN
    SELECT * INTO definer
      FROM pg_roles
     WHERE rolname = 'postwave_ops_incidents_definer';
    definer_oid := definer.oid;
    SELECT oid INTO ops_oid FROM pg_roles WHERE rolname = 'postwave_ops';

    IF definer_oid IS NULL OR ops_oid IS NULL THEN
        RAISE EXCEPTION 'required ops incident roles are missing';
    END IF;
    IF definer.rolcanlogin OR definer.rolsuper OR definer.rolcreatedb OR
       definer.rolcreaterole OR definer.rolinherit OR definer.rolreplication OR
       definer.rolbypassrls THEN
        RAISE EXCEPTION 'postwave_ops_incidents_definer role attributes drifted during 1739';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_auth_members
         WHERE member = definer_oid OR roleid = definer_oid
    ) THEN
        RAISE EXCEPTION 'postwave_ops_incidents_definer must have no role memberships or members';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_default_acl AS d
          CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
         WHERE d.defaclrole = definer_oid OR acl.grantee = definer_oid
    ) THEN
        RAISE EXCEPTION 'default privileges must not expand postwave_ops_incidents_definer access';
    END IF;
    IF NOT has_schema_privilege('postwave_ops_incidents_definer', 'public', 'USAGE') OR
       has_schema_privilege('postwave_ops_incidents_definer', 'public', 'CREATE') OR
       has_schema_privilege('postwave_ops', 'public', 'CREATE') THEN
        RAISE EXCEPTION 'ops incident schema privileges are outside the reviewed boundary';
    END IF;
    IF to_regprocedure('public.ops_incidents_enforce_server_state()') IS NULL OR
       to_regprocedure('public.ops_incident_updates_enforce_server_state()') IS NULL OR
       (
         SELECT count(*)
           FROM pg_proc AS p
           JOIN pg_namespace AS n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname IN (
              'ops_incidents_enforce_server_state',
              'ops_incident_updates_enforce_server_state'
            )
       ) <> 2 OR
       EXISTS (
         SELECT 1
           FROM pg_proc AS p
           JOIN pg_namespace AS n ON n.oid = p.pronamespace
           JOIN pg_language AS l ON l.oid = p.prolang
          WHERE n.nspname = 'public'
            AND p.proname IN (
              'ops_incidents_enforce_server_state',
              'ops_incident_updates_enforce_server_state'
            )
            AND (
              p.proowner <> definer_oid OR
              NOT p.prosecdef OR
              l.lanname <> 'plpgsql' OR
              p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
            )
       ) OR NOT EXISTS (
         SELECT 1
           FROM pg_trigger AS t
           JOIN pg_class AS c ON c.oid = t.tgrelid
           JOIN pg_namespace AS n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = 'ops_incidents'
            AND t.tgname = 'ops_incidents_server_state'
            AND NOT t.tgisinternal
            AND t.tgenabled = 'O'
            AND t.tgtype = 23
            AND t.tgfoid = to_regprocedure('public.ops_incidents_enforce_server_state()')
       ) OR NOT EXISTS (
         SELECT 1
           FROM pg_trigger AS t
           JOIN pg_class AS c ON c.oid = t.tgrelid
           JOIN pg_namespace AS n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = 'ops_incident_updates'
            AND t.tgname = 'ops_incident_updates_created_at'
            AND NOT t.tgisinternal
            AND t.tgenabled = 'O'
            AND t.tgtype = 7
            AND t.tgfoid = to_regprocedure('public.ops_incidents_enforce_server_state()')
       ) OR NOT EXISTS (
         SELECT 1
           FROM pg_trigger AS t
           JOIN pg_class AS c ON c.oid = t.tgrelid
           JOIN pg_namespace AS n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = 'ops_incident_updates'
            AND t.tgname = 'ops_incident_updates_server_state'
            AND NOT t.tgisinternal
            AND t.tgenabled = 'O'
            AND t.tgtype = 5
            AND t.tgfoid = to_regprocedure('public.ops_incident_updates_enforce_server_state()')
       ) THEN
        RAISE EXCEPTION 'ops incident server-state trigger is missing or unsafe';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(
            COALESCE(p.proacl, acldefault('f', p.proowner))
          ) AS acl
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'ops_incidents_enforce_server_state',
             'ops_incident_updates_enforce_server_state'
           )
           AND (
             acl.privilege_type <> 'EXECUTE' OR
             acl.grantee <> definer_oid
           )
    ) THEN
        RAISE EXCEPTION 'ops incident trigger function ACL is outside the reviewed boundary';
    END IF;
    IF (
        SELECT count(*)
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(
            COALESCE(p.proacl, acldefault('f', p.proowner))
          ) AS acl
         WHERE n.nspname = 'public'
           AND p.proname IN (
             'ops_incidents_enforce_server_state',
             'ops_incident_updates_enforce_server_state'
           )
           AND acl.grantee = definer_oid
           AND acl.privilege_type = 'EXECUTE'
    ) <> 2 THEN
        RAISE EXCEPTION 'ops incident trigger functions lack the exact owner EXECUTE ACL';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_class AS c
          JOIN pg_namespace AS n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname IN ('ops_incidents', 'ops_incident_updates')
           AND (c.relrowsecurity OR c.relforcerowsecurity)
    ) OR EXISTS (
        SELECT 1
          FROM pg_policy AS p
          JOIN pg_class AS c ON c.oid = p.polrelid
          JOIN pg_namespace AS n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname IN ('ops_incidents', 'ops_incident_updates')
    ) OR EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('ops_incidents', 'ops_incident_updates')
           AND column_name = 'tenant_id'
    ) THEN
        RAISE EXCEPTION 'ops incident tables no longer match the reviewed platform-table model';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_class AS c
          JOIN pg_namespace AS n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(
            COALESCE(c.relacl, acldefault('r', c.relowner))
          ) AS acl
         WHERE n.nspname = 'public'
           AND c.relname IN ('ops_incidents', 'ops_incident_updates')
           AND (
             acl.grantee = 0 OR
             (acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'postwave_ops') AND
              acl.privilege_type <> 'SELECT') OR
             acl.grantee NOT IN (
               c.relowner,
               (SELECT oid FROM pg_roles WHERE rolname = 'postwave_ops')
             )
           )
    ) THEN
        RAISE EXCEPTION 'ops incident table ACL contains an unexpected grantee or privilege';
    END IF;

    IF NOT has_table_privilege('postwave_ops', 'public.ops_incidents', 'SELECT') OR
       NOT has_table_privilege('postwave_ops', 'public.ops_incident_updates', 'SELECT') OR
       has_table_privilege(
         'postwave_ops', 'public.ops_incidents',
         'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       ) OR
       has_table_privilege(
         'postwave_ops', 'public.ops_incident_updates',
         'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       ) THEN
        RAISE EXCEPTION 'ops incident table-level ACL is outside the reviewed boundary';
    END IF;
    IF NOT has_column_privilege('postwave_ops', 'public.ops_incidents', 'idempotency_key', 'INSERT') OR
       NOT has_column_privilege('postwave_ops', 'public.ops_incidents', 'title', 'INSERT') OR
       NOT has_column_privilege('postwave_ops', 'public.ops_incidents', 'severity', 'INSERT') OR
       NOT has_column_privilege('postwave_ops', 'public.ops_incidents', 'opened_by', 'INSERT') OR
       NOT has_column_privilege('postwave_ops', 'public.ops_incident_updates', 'incident_id', 'INSERT') OR
       NOT has_column_privilege('postwave_ops', 'public.ops_incident_updates', 'idempotency_key', 'INSERT') OR
       NOT has_column_privilege('postwave_ops', 'public.ops_incident_updates', 'body', 'INSERT') OR
       NOT has_column_privilege('postwave_ops', 'public.ops_incident_updates', 'author', 'INSERT') OR
       NOT has_column_privilege('postwave_ops', 'public.ops_incident_updates', 'requested_status', 'INSERT') THEN
        RAISE EXCEPTION 'ops incident column ACL is missing a required privilege';
    END IF;
    IF EXISTS (
        WITH expected(table_name, column_name, privilege_type) AS (
            VALUES
              ('ops_incidents', 'idempotency_key', 'INSERT'),
              ('ops_incidents', 'title', 'INSERT'),
              ('ops_incidents', 'severity', 'INSERT'),
              ('ops_incidents', 'opened_by', 'INSERT'),
              ('ops_incident_updates', 'incident_id', 'INSERT'),
              ('ops_incident_updates', 'idempotency_key', 'INSERT'),
              ('ops_incident_updates', 'body', 'INSERT'),
              ('ops_incident_updates', 'author', 'INSERT'),
              ('ops_incident_updates', 'requested_status', 'INSERT')
        )
        SELECT 1
          FROM information_schema.column_privileges AS cp
         WHERE cp.table_schema = 'public'
           AND cp.table_name IN ('ops_incidents', 'ops_incident_updates')
           AND cp.grantee = 'postwave_ops'
           AND cp.privilege_type <> 'SELECT'
           AND NOT EXISTS (
             SELECT 1
               FROM expected AS e
              WHERE e.table_name = cp.table_name
                AND e.column_name = cp.column_name
                AND e.privilege_type = cp.privilege_type
           )
    ) THEN
        RAISE EXCEPTION 'postwave_ops has an unexpected incident column privilege';
    END IF;

    IF has_table_privilege(
         'postwave_ops_incidents_definer', 'public.ops_incidents',
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       ) OR has_table_privilege(
         'postwave_ops_incidents_definer', 'public.ops_incident_updates',
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       ) OR
       NOT has_column_privilege(
         'postwave_ops_incidents_definer', 'public.ops_incidents', 'id', 'SELECT'
       ) OR
       NOT has_column_privilege(
         'postwave_ops_incidents_definer', 'public.ops_incidents', 'status', 'SELECT'
       ) OR
       NOT has_column_privilege(
         'postwave_ops_incidents_definer', 'public.ops_incidents', 'update_count', 'SELECT'
       ) OR
       NOT has_column_privilege(
         'postwave_ops_incidents_definer', 'public.ops_incidents', 'status', 'UPDATE'
       ) OR
       NOT has_column_privilege(
         'postwave_ops_incidents_definer', 'public.ops_incidents', 'update_count', 'UPDATE'
       ) THEN
        RAISE EXCEPTION 'ops incident definer lacks its exact column privileges';
    END IF;
    IF EXISTS (
        WITH expected(table_name, column_name, privilege_type) AS (
            VALUES
              ('ops_incidents', 'id', 'SELECT'),
              ('ops_incidents', 'status', 'SELECT'),
              ('ops_incidents', 'update_count', 'SELECT'),
              ('ops_incidents', 'status', 'UPDATE'),
              ('ops_incidents', 'update_count', 'UPDATE')
        )
        SELECT 1
          FROM information_schema.column_privileges AS cp
         WHERE cp.table_schema = 'public'
           AND cp.grantee = 'postwave_ops_incidents_definer'
           AND NOT EXISTS (
             SELECT 1
               FROM expected AS e
              WHERE e.table_name = cp.table_name
                AND e.column_name = cp.column_name
                AND e.privilege_type = cp.privilege_type
           )
    ) THEN
        RAISE EXCEPTION 'ops incident definer has an unexpected column privilege';
    END IF;
END;
$$;

COMMIT;
