-- 0293_cross_surface_tag_indexes.sql
--
-- Tags refinement 4/12 — cross-surface cascade indexes.
--
-- Feature 4 extends tags.Delete and tag_taxonomy.{Merge,Rename} to
-- rewrite every other surface that stores tag labels so the taxonomy
-- stays consistent platform-wide. The mutations target:
--
--   * commerce_customers.tags  (text[])
--   * campaign_templates.tags  (text[])
--   * inbound_emails.tags      (text[]) — index already exists (0221)
--   * sms_conversation_tags    (per-row tag text) — tenant_tag idx exists
--   * asset_tags               (per-row tag text) — tenant_tag idx exists
--
-- Without GIN coverage on the text[] surfaces the WHERE
-- `$from = ANY(tags)` clause falls back to a sequential scan, which
-- turns the merge/rename/delete into a multi-second hold on the tx
-- against the entire customer / template / inbound mail table.

BEGIN;

CREATE INDEX IF NOT EXISTS commerce_customers_tags_gin_idx
    ON commerce_customers USING gin (tags);

CREATE INDEX IF NOT EXISTS campaign_templates_tags_gin_idx
    ON campaign_templates USING gin (tags);

-- inbound_emails_tags_gin_idx was created in 0221; declare IF NOT EXISTS
-- here too so a fresh DB without 0221 still gets indexed (idempotent).
CREATE INDEX IF NOT EXISTS inbound_emails_tags_gin_idx
    ON inbound_emails USING gin (tags);

COMMIT;
