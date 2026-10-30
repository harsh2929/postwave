-- 0129_whitelabel_domain_index_tighten.sql
--
-- Tighten the whitelabel custom-domain partial index so it only
-- includes rows where whitelabel_enabled = true.
--
-- Why: 0127 created
--
--   CREATE INDEX idx_tenants_whitelabel_domain
--       ON tenants (whitelabel_custom_domain)
--       WHERE whitelabel_custom_domain IS NOT NULL;
--
-- If a tenant sets a custom_domain via PATCH /api/v1/agency/branding
-- but leaves whitelabel_enabled = false (or flips it back to false
-- later), the row is still indexed. Any future portal resolver doing
--
--   SELECT id FROM tenants WHERE whitelabel_custom_domain = $1
--
-- would then find the row and serve the branded portal even though
-- the operator hasn't enabled whitelabel yet — exactly the audit
-- concern flagged on 2026-05-22.
--
-- Tightening the index predicate is belt-and-suspenders: even if a
-- future resolver forgets the `AND whitelabel_enabled = true` filter,
-- a lookup against the index will see ONLY enabled rows, so the
-- not-yet-enabled case stays invisible.

BEGIN;

DROP INDEX IF EXISTS idx_tenants_whitelabel_domain;

CREATE INDEX IF NOT EXISTS idx_tenants_whitelabel_domain
    ON tenants (whitelabel_custom_domain)
    WHERE whitelabel_custom_domain IS NOT NULL
      AND whitelabel_enabled = true;

COMMIT;
