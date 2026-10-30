-- 0244_suppression_converger.sql
--
-- GAP-LS-001 / GAP-LS-027 / GAP-LS-028 / GAP-LS-029 / GAP-LS-095:
-- Read-side convergence of the THREE coexisting suppression tables
-- behind a single tenant-scoped VIEW so every downstream consumer
-- (send loop, admin UI, export, RFC 8058 one-click) can hit one
-- canonical relation. Writes still go to the individual tables — the
-- converger worker (lands later) dual-writes during the cutover window.
--
-- The three tables we unify:
--   1. `suppressions`            (0060) — legacy admin POST/CSV path
--   2. `subscriber_suppressions` (0081) — X1 deliverability table,
--      THE table consulted by sendloop.go today
--   3. `email_suppressions`      (0030) — Mailchimp-parity write path
--
-- Reason normalization: each source table has its own free-form or
-- mismatched CHECK constraint (legacy `suppressions.reason` is plain
-- text; `email_suppressions.reason` is `('hard_bounce','complaint',
-- 'unsubscribe','manual','imported')`; X1 has the canonical enum).
-- The view normalizes everything to the canonical enum used by X1
-- via a CASE expression so callers can filter on a single shape.
--
-- This migration also tightens `suppressions.reason` with the canonical
-- CHECK constraint after a one-time UPDATE that maps legacy free-text
-- to the canonical values. Pre-existing rows with values outside the
-- enum get rewritten to 'manual_unsubscribe' (the safe default for the
-- legacy admin-UI path that wrote them).
--
-- rollback-strategy: expand-contract — view + CHECK are additive on
-- read side. Rollback drops the view; the CHECK stays (it never
-- relaxes data, just enforces existing values).

BEGIN;

-- 1. Normalize legacy suppressions.reason values BEFORE constraining
--    them. The legacy column is free-form text — the converger spec
--    defines a deterministic map (per gap doc section 12).
UPDATE suppressions
   SET reason = CASE lower(coalesce(reason, ''))
       WHEN 'hard_bounce'        THEN 'hard_bounce'
       WHEN 'bounce'             THEN 'hard_bounce'
       WHEN 'hardbounce'         THEN 'hard_bounce'
       WHEN 'spam_complaint'     THEN 'spam_complaint'
       WHEN 'complaint'          THEN 'spam_complaint'
       WHEN 'spam'               THEN 'spam_complaint'
       WHEN 'manual_unsubscribe' THEN 'manual_unsubscribe'
       WHEN 'unsubscribe'        THEN 'manual_unsubscribe'
       WHEN 'one_click'          THEN 'manual_unsubscribe'
       WHEN 'list_manual'        THEN 'list_manual'
       WHEN 'global_unsubscribe' THEN 'global_unsubscribe'
       WHEN 'soft_bounce_threshold' THEN 'soft_bounce_threshold'
       WHEN 'dsar_deletion'      THEN 'dsar_deletion'
       WHEN 'role_address'       THEN 'role_address'
       WHEN 'invalid_email'      THEN 'invalid_email'
       WHEN 'blocklist_auto'     THEN 'blocklist_auto'
       WHEN 'imported'           THEN 'manual_unsubscribe'
       WHEN 'manual'             THEN 'manual_unsubscribe'
       WHEN ''                   THEN 'manual_unsubscribe'
       ELSE 'manual_unsubscribe'
   END
 WHERE reason IS NULL
    OR reason NOT IN (
       'hard_bounce','spam_complaint','manual_unsubscribe','list_manual',
       'global_unsubscribe','soft_bounce_threshold','dsar_deletion',
       'role_address','invalid_email','blocklist_auto'
   );

-- 2. Enforce the canonical enum on legacy suppressions.reason. NOT
--    NULL because the UPDATE above filled every row.
ALTER TABLE suppressions
    ALTER COLUMN reason SET NOT NULL;

ALTER TABLE suppressions
    DROP CONSTRAINT IF EXISTS suppressions_reason_check;
ALTER TABLE suppressions
    ADD CONSTRAINT suppressions_reason_check CHECK (reason IN (
        'hard_bounce',
        'spam_complaint',
        'manual_unsubscribe',
        'list_manual',
        'global_unsubscribe',
        'soft_bounce_threshold',
        'dsar_deletion',
        'role_address',
        'invalid_email',
        'blocklist_auto'
    ));

-- 3. Extend the X1 CHECK with the three operator-driven categories
--    (role_address / invalid_email / blocklist_auto) so the converger
--    can collapse legacy admin entries that used them. The existing
--    subscriber_suppressions_reason_check (set up by 0239) only had
--    the seven base reasons + dsar_deletion.
ALTER TABLE subscriber_suppressions
    DROP CONSTRAINT IF EXISTS subscriber_suppressions_reason_check;
ALTER TABLE subscriber_suppressions
    ADD CONSTRAINT subscriber_suppressions_reason_check CHECK (reason IN (
        'hard_bounce',
        'spam_complaint',
        'manual_unsubscribe',
        'list_manual',
        'global_unsubscribe',
        'soft_bounce_threshold',
        'dsar_deletion',
        'role_address',
        'invalid_email',
        'blocklist_auto'
    ));

-- 4. The unified read-only view. UNION ALL preserves the row-per-source
--    semantics the audit trail wants (one address can be suppressed
--    from multiple sources e.g. a hard bounce AND a manual op-add).
--    Callers needing dedup MUST GROUP BY (tenant_id, email) themselves.
--
--    Normalized columns (matching the X1 shape):
--      tenant_id, email, email_sha256, reason, source, source_event_id,
--      created_at, expires_at, metadata, source_table.
--    `source_table` lets the audit UI render where the row came from.
--
--    Reason mapping uses the same deterministic map as the UPDATE above
--    so reads stay consistent until the converger backfill removes the
--    legacy rows.
DROP VIEW IF EXISTS v_suppressions_unified;
CREATE VIEW v_suppressions_unified AS
    -- X1 (canonical)
    SELECT
        ss.tenant_id,
        ss.email::text                AS email,
        ss.email_sha256,
        ss.reason,
        ss.source,
        ss.source_event_id,
        ss.created_at,
        ss.expires_at,
        ss.metadata,
        'subscriber_suppressions'::text AS source_table
      FROM subscriber_suppressions ss
    UNION ALL
    -- legacy `suppressions` (0060). Reason already normalized above.
    SELECT
        s.tenant_id,
        s.email::text                 AS email,
        s.email_sha256,
        s.reason,
        'manual'::text                AS source,
        NULL::text                    AS source_event_id,
        s.created_at,
        NULL::timestamptz             AS expires_at,
        '{}'::jsonb                   AS metadata,
        'suppressions'::text          AS source_table
      FROM suppressions s
    UNION ALL
    -- Mailchimp-parity `email_suppressions` (0030). Reason mapped on
    -- read because the source table's CHECK has the older enum shape.
    SELECT
        es.tenant_id,
        es.email::text                AS email,
        NULL::char(64)                AS email_sha256,
        CASE es.reason
            WHEN 'hard_bounce' THEN 'hard_bounce'
            WHEN 'complaint'   THEN 'spam_complaint'
            WHEN 'unsubscribe' THEN 'manual_unsubscribe'
            WHEN 'manual'      THEN 'manual_unsubscribe'
            WHEN 'imported'    THEN 'manual_unsubscribe'
            ELSE 'manual_unsubscribe'
        END                           AS reason,
        es.source,
        es.provider_event_id          AS source_event_id,
        es.suppressed_at              AS created_at,
        es.expires_at,
        es.metadata,
        'email_suppressions'::text    AS source_table
      FROM email_suppressions es;

COMMENT ON VIEW v_suppressions_unified IS
    'GAP-LS-001 read-side convergence. UNION ALL of the three suppression tables with normalized reason values. RLS is inherited from the underlying tables via row-level security cascade.';

GRANT SELECT ON v_suppressions_unified TO postwave_app;

-- NOTE: RLS on a VIEW is inherited from the base tables when the view
-- is defined as security_invoker (Postgres 15+). The underlying tables
-- all enforce tenant isolation via NULLIF(current_setting(...))::uuid
-- so SELECTs against the view automatically see only the caller's
-- tenant rows. We mark the view security_invoker explicitly so this
-- behaviour is robust against future Postgres default changes.
ALTER VIEW v_suppressions_unified SET (security_invoker = true);

COMMIT;
