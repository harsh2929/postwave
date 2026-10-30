-- 1853_campaign_template_aura_preview_provider.sql
--
-- Aura catalog thumbnails use the same asynchronous, sanitized hosted-preview
-- pipeline as Really Good Emails. Widen only the persisted provider enum; the
-- application still binds each provider to its own exact host and path prefix.
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: The widened CHECK is safe to retain when application code
-- rolls back. Restore the narrower CHECK only after every aura_build row has
-- been drained and no older publication row references one.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE campaign_template_preview_assets
    ADD CONSTRAINT campaign_preview_assets_provider_chk_v2
    CHECK (source_provider IN ('really_good_emails', 'aura_build'))
    NOT VALID;

ALTER TABLE campaign_template_preview_assets
    VALIDATE CONSTRAINT campaign_preview_assets_provider_chk_v2;

ALTER TABLE campaign_template_preview_assets
    DROP CONSTRAINT campaign_preview_assets_provider_chk;

ALTER TABLE campaign_template_preview_assets
    RENAME CONSTRAINT campaign_preview_assets_provider_chk_v2
    TO campaign_preview_assets_provider_chk;

COMMIT;
