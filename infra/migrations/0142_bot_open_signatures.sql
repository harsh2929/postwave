-- 0142_bot_open_signatures.sql
--
-- Bot-open signature registry.
--
-- Apple Mail Privacy Protection (MPP), Gmail image proxies,
-- Microsoft SafeLinks scanners, and various security appliances
-- pre-fetch tracking pixels which inflates "opens" by 25-40%.
-- Treating these as real engagement signals breaks
-- engagement-based pruning, send-time optimisation, and the EQ
-- score.
--
-- The classifier is regex-based and operates at query time:
--   bot_open_signatures rows hold patterns; ingest never has to
--   stamp a "is_bot" flag on subscriber_events. This avoids a
--   schema change on the hot-write path and lets us evolve the
--   patterns without backfilling.
--
-- Rows with tenant_id IS NULL are platform-wide defaults visible
-- to every tenant. Tenant-owned rows extend or override.

BEGIN;

CREATE TABLE IF NOT EXISTS bot_open_signatures (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid REFERENCES tenants(id) ON DELETE CASCADE,
    label       text NOT NULL,
    pattern     text NOT NULL,
    kind        text NOT NULL CHECK (kind IN ('mpp','proxy','scanner','prefetcher','custom')),
    enabled     boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_open_signatures_tenant_enabled
    ON bot_open_signatures (tenant_id, enabled) WHERE enabled;

GRANT SELECT, INSERT, UPDATE, DELETE ON bot_open_signatures TO postwave_app;

ALTER TABLE bot_open_signatures ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_visible ON bot_open_signatures AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id IS NULL
           OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
           OR current_setting('app.outbox_worker', true) = 'true')
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
                OR current_setting('app.outbox_worker', true) = 'true');

-- Platform-wide defaults. tenant_id IS NULL → visible to all
-- tenants. Each tenant can disable (UPDATE enabled=false on a
-- copy) or override locally.
INSERT INTO bot_open_signatures (tenant_id, label, pattern, kind) VALUES
    (NULL, 'Apple Mail Privacy Protection',  'Mozilla/5\.0 \(Macintosh;.*Mac OS X.*\) AppleWebKit.*\(KHTML, like Gecko\)$', 'mpp'),
    (NULL, 'Apple Mail iOS Privacy Proxy',   'iPhone.*Mobile.*AppleWebKit.*Mail',                                          'mpp'),
    (NULL, 'Google Image Proxy',             'GoogleImageProxy',                                                           'proxy'),
    (NULL, 'Gmail (no UA)',                  '^$',                                                                          'proxy'),
    (NULL, 'Outlook SafeLinks',              'Microsoft Office.*SafeLinks',                                                'scanner'),
    (NULL, 'Outlook.com link checker',       'Mozilla.*outlook\.live\.com',                                                'scanner'),
    (NULL, 'Yahoo Mail Proxy',               'YahooMailProxy',                                                             'proxy'),
    (NULL, 'curl link scanner',              '^curl/',                                                                     'scanner'),
    (NULL, 'wget link scanner',              '^Wget/',                                                                     'scanner'),
    (NULL, 'Symantec / Broadcom scanner',    'Symantec',                                                                   'scanner'),
    (NULL, 'Mimecast',                       'Mimecast',                                                                   'scanner'),
    (NULL, 'Barracuda',                      'Barracuda',                                                                  'scanner'),
    (NULL, 'Proofpoint URL Defense',         'Proofpoint',                                                                 'scanner'),
    (NULL, 'Slackbot link preview',          'Slackbot-LinkExpanding',                                                     'prefetcher'),
    (NULL, 'Facebook External Hit',          'facebookexternalhit',                                                        'prefetcher'),
    (NULL, 'Twitterbot',                     'Twitterbot',                                                                 'prefetcher'),
    (NULL, 'LinkedInBot',                    'LinkedInBot',                                                                'prefetcher'),
    (NULL, 'Discord link preview',           'Discordbot',                                                                 'prefetcher')
ON CONFLICT DO NOTHING;

COMMIT;
