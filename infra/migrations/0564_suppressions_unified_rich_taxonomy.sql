-- 0564_suppressions_unified_rich_taxonomy.sql
--
-- SUB-047: complete the v_suppressions_unified reason normalisation for
-- the Klaviyo-style rich taxonomy. The view (created in 0244) converges
-- the three suppression tables on read with a per-source CASE that maps
-- each table's reason vocabulary onto the canonical X1 enum. That CASE
-- predates the batch-3 taxonomy widening:
--
--   0512 — subscriber_suppressions.reason gained soft_bounce, complaint,
--          list_unsub_header, spamtrap, role_account, dns_failure,
--          invalid_address.
--   0513 — email_suppressions.reason gained the SAME rich taxonomy
--          (plus the X1 canonical labels for dual-write parity), on top
--          of its legacy short labels (hard_bounce/complaint/unsubscribe/
--          manual/imported).
--   0514 — subscriber_suppressions.bounce_category (durable raw signal).
--
-- The 0244 view's email_suppressions branch only recognised the FIVE
-- legacy short labels and folded EVERYTHING else (every new rich reason,
-- every dual-written X1 canonical reason) to 'manual_unsubscribe' via its
-- ELSE arm. So an address suppressed in email_suppressions as 'spamtrap'
-- or 'dns_failure' or 'list_unsub_header' surfaced through the unified
-- view as a plain manual unsubscribe — a real fidelity loss for the
-- deliverability dashboard and exports that read the view.
--
-- This migration is a PURE VIEW REPLACEMENT (CREATE OR REPLACE VIEW). No
-- data is touched; the base-table CHECK constraints already gate what can
-- be written. It rewrites the per-source CASE so every reason value from
-- every source table normalises into the unified rich taxonomy:
--
--   hard_bounce, spam_complaint, manual_unsubscribe, list_manual,
--   global_unsubscribe, soft_bounce_threshold, dsar_deletion,
--   role_address, invalid_email, blocklist_auto,
--   soft_bounce, complaint, list_unsub_header, spamtrap, role_account,
--   dns_failure, invalid_address
--
-- Normalisation rules per source:
--   * subscriber_suppressions (X1) — reason is already canonical (its
--     CHECK is the rich taxonomy as of 0512); pass through unchanged.
--   * suppressions (legacy 0060) — reason was rewritten to the 10 base
--     canonical reasons by 0244's one-time UPDATE + CHECK; pass through
--     unchanged.
--   * email_suppressions (0030 / 0513) — the only table whose stored
--     reason may use the legacy short labels OR the rich taxonomy. Map
--     the legacy-only short labels to their canonical equivalents and
--     pass the rich/canonical values through verbatim, preserving the
--     Klaviyo labels (complaint, soft_bounce, spamtrap, …) instead of
--     collapsing them. Unknown/NULL still degrades to manual_unsubscribe.
--
-- RLS: a VIEW is NOT given its own RLS — it inherits the base tables'
-- row-level security. The view is (and stays) security_invoker so the
-- caller's app.tenant_id GUC gates each underlying SELECT. We do NOT
-- ENABLE/FORCE RLS on the view.
--
-- rollback-strategy: expand-contract, read-side only. Rollback re-applies
-- the 0244 view body. No data migration to reverse.

BEGIN;

CREATE OR REPLACE VIEW v_suppressions_unified AS
    -- X1 (canonical). reason already conforms to the rich taxonomy
    -- (subscriber_suppressions_reason_check, 0512), so it passes through.
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
    -- legacy `suppressions` (0060). reason was normalised to the 10 base
    -- canonical reasons by 0244 (UPDATE + CHECK); pass through.
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
    -- Mailchimp-parity `email_suppressions` (0030 / 0513). Full CASE over
    -- BOTH the legacy short labels and the Klaviyo rich taxonomy widened
    -- in by 0513. Legacy-only short labels map to canonical; every rich /
    -- already-canonical value is preserved verbatim.
    SELECT
        es.tenant_id,
        es.email::text                AS email,
        NULL::char(64)                AS email_sha256,
        CASE es.reason
            -- legacy short labels (0030) → canonical
            WHEN 'unsubscribe'        THEN 'manual_unsubscribe'
            WHEN 'manual'             THEN 'manual_unsubscribe'
            WHEN 'imported'           THEN 'manual_unsubscribe'
            -- canonical / rich taxonomy values (0512/0513) → verbatim
            WHEN 'hard_bounce'        THEN 'hard_bounce'
            WHEN 'spam_complaint'     THEN 'spam_complaint'
            WHEN 'manual_unsubscribe' THEN 'manual_unsubscribe'
            WHEN 'list_manual'        THEN 'list_manual'
            WHEN 'global_unsubscribe' THEN 'global_unsubscribe'
            WHEN 'soft_bounce_threshold' THEN 'soft_bounce_threshold'
            WHEN 'dsar_deletion'      THEN 'dsar_deletion'
            WHEN 'role_address'       THEN 'role_address'
            WHEN 'invalid_email'      THEN 'invalid_email'
            WHEN 'blocklist_auto'     THEN 'blocklist_auto'
            WHEN 'soft_bounce'        THEN 'soft_bounce'
            WHEN 'complaint'          THEN 'complaint'
            WHEN 'list_unsub_header'  THEN 'list_unsub_header'
            WHEN 'spamtrap'           THEN 'spamtrap'
            WHEN 'role_account'       THEN 'role_account'
            WHEN 'dns_failure'        THEN 'dns_failure'
            WHEN 'invalid_address'    THEN 'invalid_address'
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
    'SUB-047 / GAP-LS-001 read-side convergence. UNION ALL of the three suppression tables, normalising every source reason vocabulary onto the unified Klaviyo-compatible rich taxonomy. RLS inherited from the base tables via security_invoker.';

GRANT SELECT ON v_suppressions_unified TO postwave_app;

-- Re-assert security_invoker (CREATE OR REPLACE preserves view options in
-- PG15+, but we set it explicitly so the inherited-RLS contract is robust
-- against any prior drop/recreate). NO RLS is enabled on the view itself —
-- views inherit base-table RLS.
ALTER VIEW v_suppressions_unified SET (security_invoker = true);

COMMIT;
