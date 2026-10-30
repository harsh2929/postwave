-- 1936_campaign_revision_tracking_identity.sql
--
-- Link tracking and UTM settings alter the compiled HTML and final RFC MIME.
-- They therefore belong to the immutable revision identity used by Campaign
-- Assurance and the queue gate. Historical revisions retain an empty value:
-- their send plans already froze their transform manifest, while the next
-- freeze of a campaign with non-empty settings creates a new source hash.
--
-- rollback-strategy: no-op. Removing this column would make historical source
-- identities unable to explain the transform input that was certified.

BEGIN;

ALTER TABLE campaign_content_revisions
    ADD COLUMN IF NOT EXISTS tracking_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE campaign_content_revisions
    DROP CONSTRAINT IF EXISTS campaign_content_revisions_tracking_settings_object_check,
    ADD CONSTRAINT campaign_content_revisions_tracking_settings_object_check
        CHECK (jsonb_typeof(tracking_settings) = 'object');

COMMENT ON COLUMN campaign_content_revisions.tracking_settings IS
    'Canonical tracking/UTM transform input included in every new revision source hash.';

COMMIT;
