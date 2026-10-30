-- Bind immutable migration archive rows to the exact canonical source payload.
-- Legacy rows remain NULL and therefore fail closed on a migration retry until
-- they are explicitly re-imported or reviewed.

BEGIN;

ALTER TABLE campaign_archive
    ADD COLUMN IF NOT EXISTS content_fingerprint text;

COMMENT ON COLUMN campaign_archive.content_fingerprint IS
    'SHA-256 of the complete canonical campaign archive payload, including report and warnings; migration retries must match exactly.';

COMMIT;
