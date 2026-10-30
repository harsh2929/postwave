-- Vanity campaign paths — /go/{slug} (PRD F04, second half).
--
-- WHY THIS EXISTS
--
-- F04's acceptance criterion is "a conversion with no preceding click still
-- attributes to the campaign". Migration 1947 closed one half of it: a
-- per-recipient code, which is per-PERSON evidence, because nothing else ever
-- issued that string to that address. The other half is the recipient who reads
-- the message, clicks nothing, and navigates to a campaign-specific path
-- themselves. Nothing in the schema could record that path, so that visit was
-- attributable to nobody and the campaign that caused it got no credit.
--
-- THE EVIDENCE IS WEAKER, AND THE SCHEMA SAYS SO
--
-- This is the trap in the feature and the reason for most of what follows.
-- A vanity path is PUBLIC and SHARED: every recipient of the campaign receives
-- the same URL, and anyone can repost it. So a visit through /go/spring-sale is
-- evidence that THE CAMPAIGN caused a visit. It is NOT evidence about WHICH
-- PERSON visited — unlike a per-recipient code, which only one address ever
-- held.
--
-- Two structural consequences, both enforced here rather than by convention:
--
--   1. campaign_vanity_visits has NO subscriber column at all. Not "nullable",
--      not "usually empty" — absent, so a later writer cannot add per-person
--      certainty to a row that never had it. The visit's scope is the campaign.
--
--   2. conversions gains the provenance value `campaign_vanity_path`, distinct
--      from `code_redemption`, and a CHECK forbids attaching any person
--      identity to a conversion carrying it. Reusing `code_redemption` would
--      merge weak campaign-level evidence into the column a report reads to say
--      "this campaign converted this person", and no query could separate them
--      again. The two values are different claims about different evidence and
--      the vocabulary has to be able to say which.
--
-- THE PATH IS ATTACKER-REACHABLE AND UNAUTHENTICATED
--
--   * Slug resolution runs BEFORE any tenant is known, so it cannot be governed
--     by a caller-settable GUC policy — any postwave_app session can set a GUC,
--     which would make the policy a cross-tenant read capability rather than a
--     resolver boundary. It uses the migration-1951 shape instead: a
--     NOLOGIN/NOBYPASSRLS role owning one fixed-query SECURITY DEFINER function
--     with exact column grants. The function returns a tenant id and nothing
--     else.
--
--   * The destination is NOT a URL. It is a host the tenant proved control of
--     (composite FK into custom_domains) plus a path constrained to a single
--     leading slash, no backslash, no control characters and no fragment. The
--     redirect target is then CONSTRUCTED as https://host + path, so pointing a
--     vanity path at an arbitrary host is not one validation away — it is
--     unrepresentable. A stored free-form URL would make /go/<something
--     trustworthy-looking> on our own domain a working phishing redirector.
--
--   * The slug is globally unique and never reassigned. /go/{slug} carries no
--     tenant, so two tenants owning one slug would make attribution depend on
--     which row PostgreSQL returned first — the exact defect migration 1951 was
--     written to remove. Uniqueness is unconditional rather than
--     active-paths-only because a sent email is immortal: a freed slug re-pointed
--     at another tenant would silently start crediting a different campaign for
--     links already printed in messages that have shipped.
--
-- migration-execution: single transaction
-- rollback-strategy: expand-contract
-- rollback-details: The two new tables and the resolver can be dropped once no
-- API binary serves /go/{slug}. The conversions vocabulary entry must NOT be
-- narrowed while any `campaign_vanity_path` row exists — VALIDATE would fail and
-- the rows are revenue attribution, not derivable state.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Composite target so a vanity path's destination host can be bound to the
-- tenant that owns it by a foreign key rather than by a query everyone must
-- remember to write. custom_domains.domain is already globally unique, so this
-- constraint adds an index and no new restriction.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
         WHERE conname = 'custom_domains_tenant_domain_key'
           AND conrelid = 'public.custom_domains'::regclass
    ) THEN
        ALTER TABLE public.custom_domains
            ADD CONSTRAINT custom_domains_tenant_domain_key UNIQUE (tenant_id, domain);
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.campaign_vanity_paths (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

    -- The public slug. citext because a recipient typing a URL from a printed
    -- message will not preserve case, and /go/Spring-Sale resolving to nothing
    -- would look like a broken campaign.
    slug       citext NOT NULL,

    campaign_id uuid NOT NULL,

    -- Host + path, never a URL. See the header comment: this is what makes an
    -- open redirect unrepresentable rather than merely rejected.
    destination_host citext NOT NULL,
    destination_path text NOT NULL DEFAULT '/',

    -- A retired path is disabled, never deleted. Deleting it frees the slug,
    -- and the slug is printed in messages that have already been delivered.
    status     text NOT NULL DEFAULT 'active',

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT campaign_vanity_paths_slug_uniq UNIQUE (slug),
    CONSTRAINT campaign_vanity_paths_tenant_id_key UNIQUE (tenant_id, id),
    CONSTRAINT campaign_vanity_paths_status_check
        CHECK (status = ANY (ARRAY['active'::text, 'disabled'::text])),

    -- Slug shape. Restricted to what survives being read aloud, typed from a
    -- printed page and pasted into a chat client: no dots (which would let a
    -- slug read as a hostname), no percent-encoding, no leading/trailing dash.
    CONSTRAINT campaign_vanity_paths_slug_shape_check
        CHECK (slug::text ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),

    -- A bare hostname: letters, digits, dashes and dots only. This is what
    -- guarantees the constructed URL has exactly one authority — a host
    -- containing '@', '/', ':' or whitespace could otherwise re-point
    -- https://<host><path> somewhere else entirely.
    CONSTRAINT campaign_vanity_paths_destination_host_check
        CHECK (destination_host::text ~
               '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),

    -- The open-redirect guard, in the database.
    --
    -- '//evil.example' is a protocol-relative URL, not a path: appended to
    -- 'https://host' it yields 'https://host//evil.example', but browsers and
    -- proxies have historically disagreed, and a single leading slash costs
    -- nothing to require. A backslash is rejected for the same reason — several
    -- URL parsers normalise '\' to '/'. '#' is rejected so the visit reference
    -- can be appended as a query parameter without landing inside a fragment.
    CONSTRAINT campaign_vanity_paths_destination_path_check
        CHECK (
            destination_path = btrim(destination_path)
            AND destination_path ~ '^/([^/].*)?$'
            AND destination_path !~ '[[:cntrl:][:space:]]'
            AND strpos(destination_path, E'\\') = 0
            AND strpos(destination_path, '#') = 0
            AND length(destination_path) <= 512
        ),

    CONSTRAINT campaign_vanity_paths_campaign_fkey
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES public.campaigns (tenant_id, id) ON DELETE CASCADE,

    -- Tenancy of the destination host, structurally. A tenant cannot point a
    -- vanity path at a host it has not registered, and cannot point it at
    -- another tenant's host either.
    CONSTRAINT campaign_vanity_paths_destination_fkey
        FOREIGN KEY (tenant_id, destination_host)
        REFERENCES public.custom_domains (tenant_id, domain) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS campaign_vanity_paths_campaign_idx
    ON public.campaign_vanity_paths (tenant_id, campaign_id);

-- A visit through a vanity path.
--
-- THERE IS DELIBERATELY NO SUBSCRIBER COLUMN. A shared public URL cannot say
-- who walked through it, and the cheapest way to stop this row from ever
-- claiming otherwise is to give it nowhere to put the claim. attribution_scope
-- is pinned to 'campaign' so the row states its own evidence strength to any
-- reader who joins to it without having read this comment.
CREATE TABLE IF NOT EXISTS public.campaign_vanity_visits (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    path_id     uuid NOT NULL,
    campaign_id uuid NOT NULL,

    attribution_scope text NOT NULL DEFAULT 'campaign',

    -- The conversion this visit was later credited with, if one was reported.
    -- Nullable and settable once: a visit that never converts is still the
    -- attribution evidence the campaign report needs.
    conversion_id bigint REFERENCES public.conversions(id) ON DELETE SET NULL,

    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT campaign_vanity_visits_tenant_id_key UNIQUE (tenant_id, id),
    CONSTRAINT campaign_vanity_visits_scope_check
        CHECK (attribution_scope = 'campaign'),
    CONSTRAINT campaign_vanity_visits_path_fkey
        FOREIGN KEY (tenant_id, path_id)
        REFERENCES public.campaign_vanity_paths (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT campaign_vanity_visits_campaign_fkey
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES public.campaigns (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS campaign_vanity_visits_campaign_idx
    ON public.campaign_vanity_visits (tenant_id, campaign_id, occurred_at DESC);

ALTER TABLE public.campaign_vanity_paths  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_vanity_paths  FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.campaign_vanity_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_vanity_visits FORCE  ROW LEVEL SECURITY;

-- RLS FILTERS, IT DOES NOT REFUSE. Both tables take INSERT/UPDATE/DELETE as well
-- as SELECT: a policy that covered only SELECT would let an unscoped UPDATE
-- match zero rows and report success.
DO $$
DECLARE
    target text;
BEGIN
    FOREACH target IN ARRAY ARRAY['campaign_vanity_paths', 'campaign_vanity_visits']
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_policies
             WHERE schemaname = 'public' AND tablename = target
               AND policyname = 'tenant_isolation'
        ) THEN
            EXECUTE format(
                'CREATE POLICY tenant_isolation ON public.%I FOR ALL '
                'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
                'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
                target);
        END IF;
    END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_vanity_paths  TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_vanity_visits TO postwave_app;

-- ---------------------------------------------------------------------------
-- Slug -> tenant, before any tenant is known.
-- ---------------------------------------------------------------------------
--
-- The migration-1951 shape. A caller-settable GUC policy would have been a
-- cross-tenant read capability for every postwave_app session, because any
-- session can SET a custom GUC.
DO $$
DECLARE
    resolver pg_catalog.pg_roles%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'postwave_vanity_path_resolver'
    ) THEN
        CREATE ROLE postwave_vanity_path_resolver
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION NOBYPASSRLS;
    END IF;

    SELECT * INTO resolver
      FROM pg_catalog.pg_roles WHERE rolname = 'postwave_vanity_path_resolver';

    IF resolver.rolcanlogin OR resolver.rolsuper OR resolver.rolcreatedb OR
       resolver.rolcreaterole OR resolver.rolinherit OR
       resolver.rolreplication OR resolver.rolbypassrls THEN
        RAISE EXCEPTION 'postwave_vanity_path_resolver has unsafe role attributes';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members
         WHERE member = resolver.oid OR roleid = resolver.oid
    ) THEN
        RAISE EXCEPTION 'postwave_vanity_path_resolver must have no memberships or members';
    END IF;
END
$$;

REVOKE ALL PRIVILEGES ON public.campaign_vanity_paths  FROM postwave_vanity_path_resolver;
REVOKE ALL PRIVILEGES ON public.campaign_vanity_visits FROM postwave_vanity_path_resolver;

-- Three columns. Not destination_host, not destination_path, not campaign_id:
-- the definer's whole job is to name a tenant, and everything else is read back
-- inside a normal tenant-bound transaction where RLS applies.
GRANT SELECT (id, tenant_id, slug) ON public.campaign_vanity_paths
    TO postwave_vanity_path_resolver;

DROP POLICY IF EXISTS campaign_vanity_paths_fixed_resolver_select
    ON public.campaign_vanity_paths;
CREATE POLICY campaign_vanity_paths_fixed_resolver_select
    ON public.campaign_vanity_paths
    FOR SELECT TO postwave_vanity_path_resolver
    USING (true);

GRANT USAGE, CREATE ON SCHEMA public TO postwave_vanity_path_resolver;

DROP FUNCTION IF EXISTS public.resolve_campaign_vanity_path(text);

-- Deliberately NOT filtered on status.
--
-- A miss has more causes than "no such row": the path may be disabled, or its
-- destination host may have lost verification — and the second cannot be
-- decided here without granting this role a second table. Every miss has to
-- collapse to one indistinguishable outcome, and splitting that collapse
-- between SQL and Go is how the two halves drift until one of them starts
-- answering a question the other refuses.
CREATE FUNCTION public.resolve_campaign_vanity_path(p_slug pg_catalog.text)
RETURNS pg_catalog.uuid
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
    SELECT stored.tenant_id
      FROM public.campaign_vanity_paths AS stored
     WHERE stored.slug = p_slug::public.citext
$function$;

ALTER FUNCTION public.resolve_campaign_vanity_path(text)
    OWNER TO postwave_vanity_path_resolver;
REVOKE CREATE ON SCHEMA public FROM postwave_vanity_path_resolver;

-- EXECUTE defaults to PUBLIC, so revoke before admitting only the API role.
REVOKE ALL ON FUNCTION public.resolve_campaign_vanity_path(text)
    FROM PUBLIC, postwave_vanity_path_resolver;
GRANT EXECUTE ON FUNCTION public.resolve_campaign_vanity_path(text) TO postwave_app;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'postwave_public') THEN
        EXECUTE 'REVOKE ALL ON FUNCTION public.resolve_campaign_vanity_path(text) FROM postwave_public';
    END IF;
END
$$;

COMMENT ON FUNCTION public.resolve_campaign_vanity_path(text) IS
    'Resolves a globally-unique /go/{slug} vanity path to its tenant. Owned by a '
    'NOLOGIN/NOBYPASSRLS role holding SELECT on exactly (id, tenant_id, slug); '
    'postwave_app receives EXECUTE only. Returns a tenant id and nothing else — '
    'campaign, destination host and destination path are read back under RLS.';

-- ---------------------------------------------------------------------------
-- Attribution vocabulary.
-- ---------------------------------------------------------------------------
--
-- Extended, not rewritten. Another migration may have added a provenance value
-- since 1947, and replacing the whole ARRAY literal would delete it silently
-- while every application test stayed green. The shape is asserted first so an
-- unexpected constraint definition fails loudly instead of being patched by a
-- regex that no longer means what it meant.
DO $$
DECLARE
    definition text;
BEGIN
    SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO definition
      FROM pg_catalog.pg_constraint AS c
     WHERE c.conname = 'conversions_attributed_via_check'
       AND c.conrelid = 'public.conversions'::regclass;

    IF definition IS NULL THEN
        RAISE EXCEPTION
            'conversions_attributed_via_check is missing; refusing to guess the attribution vocabulary';
    END IF;

    IF pg_catalog.strpos(definition, 'campaign_vanity_path') > 0 THEN
        RETURN;
    END IF;

    IF definition !~ '^CHECK \(\(attributed_via = ANY \(ARRAY\[.*\]\)\)\)$' THEN
        RAISE EXCEPTION
            'conversions_attributed_via_check has an unexpected shape (%); extend it by hand',
            definition;
    END IF;

    ALTER TABLE public.conversions DROP CONSTRAINT conversions_attributed_via_check;
    EXECUTE 'ALTER TABLE public.conversions ADD CONSTRAINT conversions_attributed_via_check '
         || pg_catalog.regexp_replace(
                definition, '\]\)\)\)$',
                ', ''campaign_vanity_path''::text])))');
END
$$;

-- A vanity-path conversion may never carry a person.
--
-- This is the whole evidence distinction, made unforgeable. `code_redemption`
-- names the subscriber because the code named them first. A shared URL names
-- nobody, so a conversion attributed through one must not populate any identity
-- column — otherwise a per-subscriber report would count campaign-level
-- evidence as person-level proof, and no later query could tell the two apart.
ALTER TABLE public.conversions
    DROP CONSTRAINT IF EXISTS conversions_vanity_path_scope_check;
ALTER TABLE public.conversions
    ADD CONSTRAINT conversions_vanity_path_scope_check CHECK (
        attributed_via IS DISTINCT FROM 'campaign_vanity_path'
        OR (subscriber_email IS NULL
            AND email_sha256 IS NULL
            AND external_id IS NULL
            AND referrer_subscriber_id IS NULL)
    ) NOT VALID;
ALTER TABLE public.conversions VALIDATE CONSTRAINT conversions_vanity_path_scope_check;

-- Self-audit. A later edit that broadens the resolver's authority while leaving
-- the happy-path tests green fails here instead.
DO $$
BEGIN
    IF pg_catalog.has_schema_privilege('postwave_vanity_path_resolver', 'public', 'CREATE') THEN
        RAISE EXCEPTION 'vanity path resolver retained schema CREATE';
    END IF;
    IF pg_catalog.has_table_privilege('postwave_vanity_path_resolver', 'public.campaign_vanity_paths', 'INSERT')
       OR pg_catalog.has_table_privilege('postwave_vanity_path_resolver', 'public.campaign_vanity_paths', 'UPDATE')
       OR pg_catalog.has_table_privilege('postwave_vanity_path_resolver', 'public.campaign_vanity_paths', 'DELETE')
       OR pg_catalog.has_table_privilege('postwave_vanity_path_resolver', 'public.campaign_vanity_visits', 'SELECT') THEN
        RAISE EXCEPTION 'vanity path resolver holds privileges beyond slug resolution';
    END IF;
    IF pg_catalog.has_column_privilege('postwave_vanity_path_resolver',
           'public.campaign_vanity_paths', 'destination_host', 'SELECT')
       OR pg_catalog.has_column_privilege('postwave_vanity_path_resolver',
           'public.campaign_vanity_paths', 'campaign_id', 'SELECT') THEN
        RAISE EXCEPTION 'vanity path resolver can read path content, not just the tenant';
    END IF;
    IF NOT pg_catalog.has_function_privilege('postwave_app',
           'public.resolve_campaign_vanity_path(text)', 'EXECUTE')
       OR pg_catalog.has_function_privilege('public',
           'public.resolve_campaign_vanity_path(text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'vanity path resolver EXECUTE grants are unsafe';
    END IF;
END
$$;

COMMIT;
