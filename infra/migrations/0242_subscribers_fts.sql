-- 0242_subscribers_fts.sql
--
-- Subscribers FTS + pg_trgm search backbone (SUB-039).
--
-- Replaces the per-row ILIKE-on-jsonb scan in repo.Search with an
-- index-backed combo:
--   * search_tsv GENERATED tsvector over email + tags + merge_fields/
--     custom_fields name-ish columns, GIN-indexed → drives free-text
--     and field-targeted queries (websearch_to_tsquery).
--   * pg_trgm GIN on email (lower) → drives the @domain prefix
--     operator and substring email matches without sequential scan.
--
-- The tsvector column is STORED-generated, so writes pay the cost
-- once and reads stay cheap. We weight email A / merge-name B / tags
-- C / catch-all D so ts_rank can later promote email hits if we wire
-- it; the current repo only filters on @@, but the weights cost
-- nothing extra to maintain and unlock ranking on day two.
--
-- Names are conventionally stored under merge_fields keys FNAME/LNAME
-- (Mailchimp merge-tag style) and sometimes under custom_fields keys
-- first_name / last_name (Klaviyo style). We extract whichever is
-- present via COALESCE on both jsonb blobs so both lineages index.
--
-- rollback-strategy: expand-contract — code path falls back to the
-- pre-FTS Search ILIKE branch via search_parser.UseFTS = false; the
-- column + index are additive and a future DROP can run after the
-- code change ships.
-- rollback-details: dropping the generated column requires the app
-- to stop referencing search_tsv first. The index can be dropped
-- standalone at any time.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- array_to_string is marked STABLE (its polymorphic signature can invoke an
-- element output function whose result depends on session state, e.g. a
-- timestamptz array under a session timezone). Postgres therefore rejects it
-- inside a STORED generated-column expression, which must be IMMUTABLE
-- (SQLSTATE 42P17). For a text[] joined on a constant separator the result is
-- in fact immutable, so we wrap it in an IMMUTABLE function — the standard
-- remedy, safe for the text[] `tags` column used below.
CREATE OR REPLACE FUNCTION immutable_array_to_string(arr text[], sep text)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
AS $$ SELECT array_to_string(arr, sep) $$;

ALTER TABLE subscribers
    ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(email::text, '')), 'A')
        ||
        setweight(
            to_tsvector('simple',
                coalesce(merge_fields ->> 'FNAME', '') || ' ' ||
                coalesce(merge_fields ->> 'LNAME', '') || ' ' ||
                coalesce(merge_fields ->> 'first_name', '') || ' ' ||
                coalesce(merge_fields ->> 'last_name', '') || ' ' ||
                coalesce(custom_fields ->> 'first_name', '') || ' ' ||
                coalesce(custom_fields ->> 'last_name', '') || ' ' ||
                coalesce(custom_fields ->> 'name', '')
            ),
            'B'
        )
        ||
        setweight(to_tsvector('simple', coalesce(immutable_array_to_string(tags, ' '), '')), 'C')
    ) STORED;

CREATE INDEX IF NOT EXISTS subscribers_search_tsv_gin
    ON subscribers USING GIN (search_tsv);

-- Trigram index on lower(email) so `@acme.com` substring + general
-- email substring queries skip the seq-scan. Partial-by-tenant would
-- shrink the index but block CONCURRENTLY-free DDL within this tx;
-- the global GIN is fine since trgm uses tenant_id from the parent
-- WHERE clause as a btree-style filter.
CREATE INDEX IF NOT EXISTS subscribers_email_trgm_idx
    ON subscribers USING GIN (lower(email::text) gin_trgm_ops);

COMMIT;
