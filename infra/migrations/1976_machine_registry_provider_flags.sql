-- 1976_machine_registry_provider_flags.sql
--
-- Extends the F01 machine-source registry with the provider flags and proxy
-- egress ranges that migration 1934 did not carry.
--
-- 1934 seeded six entries, all User-Agent based except SendGrid's
-- sg_machine_open. That leaves the classifier blind in two ways.
--
-- FIRST: every other major ESP publishes its own machine-open flag under a
-- different key, and an explicit provider flag is the strongest signal
-- available — the provider saw the fetch, we only see its report. Mailgun
-- reports client-info.bot ("apple" for MPP), Klaviyo exposes an Apple Privacy
-- Open boolean, and several adapters normalise to machine_open /
-- is_machine_open. Missing them means treating a provider's own machine
-- verdict as unknown.
--
-- SECOND: Apple MPP does not reliably announce itself in the User-Agent.
-- Apple Mail sends a bare "Mozilla/5.0" with no platform token whether MPP is
-- ON or OFF, so that string identifies Apple Mail rather than the proxy. It is
-- deliberately NOT added here: matching it would discard the most engaged
-- Apple Mail humans from every engaged segment and sunset flow, which is the
-- expensive direction to be wrong in. What can be matched is the relay egress,
-- and Apple publishes that list for iCloud Private Relay at
-- mask-api.icloud.com/egress-ip-ranges.csv — roughly 42,000 IPv4 CIDRs sitting
-- inside six CDN /16s (Cloudflare, Fastly, Akamai).
--
-- Those six /16s are added at LOW confidence as a corroborating signal only.
-- They are commodity CDN blocks: between 30% and 95% of each /16 carries
-- unrelated third-party traffic, so a match is evidence, never a verdict. The
-- classifier's weighted aggregation is what makes that safe — a low-confidence
-- range plus a prefetch-latency tell reaches the machine threshold, while the
-- range alone does not. Ingesting the exact CIDR list is the follow-up that
-- turns this from a hint into an identification.
--
-- rollback-strategy: no-op. Registry rows are additive and a rollback simply
-- returns the classifier to the 1934 entry set; classifications already
-- recorded carry their own registry version.

BEGIN;

SET LOCAL lock_timeout = '5s';

WITH new_entries(entry_id, matcher_type, matcher_value, machine_subtype, confidence, source_note) AS (
    VALUES
    -- Provider flags. Highest confidence in the registry: the provider
    -- observed the fetch directly and is reporting its own verdict.
    ('R_PROVIDER_MACHINE_OPEN_GENERIC', 'provider_flag', 'machine_open',
     'unknown_bot', 0.9950::numeric,
     'Normalised machine-open flag used by Mailgun and Postmark adapters; provider-reported.'),
    ('R_PROVIDER_MACHINE_OPEN_ALT', 'provider_flag', 'is_machine_open',
     'unknown_bot', 0.9950::numeric,
     'Alternate phrasing of the normalised machine-open flag used by some ESP adapters.'),
    ('R_MAILGUN_BOT_APPLE', 'provider_flag', 'client_info_bot=apple',
     'apple_mpp', 0.9800::numeric,
     'Mailgun open/click events expose client-info.bot; the apple value is its MPP verdict.'),
    ('R_KLAVIYO_APPLE_PRIVACY_OPEN', 'provider_flag', 'apple_privacy_open',
     'apple_mpp', 0.9800::numeric,
     'Klaviyo Apple Privacy Open boolean on Opened Email events; provider-reported MPP.'),
    ('R_PROVIDER_MPP_HEADER', 'provider_flag', 'x_mailer_mpp',
     'apple_mpp', 0.9500::numeric,
     'MPP header surfaced by some ESPs; provider-reported rather than inferred.'),

    -- AI assistant fetchers. A summariser retrieving a message is a machine
    -- read even though a human asked for it, and it is a growing share of
    -- opens that no UA rule in 1934 covers.
    ('R_AI_SUMMARIZER_UA', 'ua_regex',
     '(?i)(gptbot|oai-searchbot|chatgpt-user|perplexitybot|claudebot|anthropic-ai|google-extended)',
     'ai_summarizer', 0.9500::numeric,
     'Published assistant fetcher user agents; a summariser read is not a human read.'),

    -- Apple relay egress /16 supersets. LOW confidence and corroborating only:
    -- these are shared CDN blocks, so a match narrows but never decides.
    ('R_APPLE_RELAY_EGRESS_CF', 'cidr', '104.28.0.0/16',
     'apple_mpp', 0.3000::numeric,
     'Cloudflare block containing part of Apple relay egress; shared range, corroborating only.'),
    ('R_APPLE_RELAY_EGRESS_FASTLY_A', 'cidr', '146.75.0.0/16',
     'apple_mpp', 0.3000::numeric,
     'Fastly block containing part of Apple relay egress; shared range, corroborating only.'),
    ('R_APPLE_RELAY_EGRESS_FASTLY_B', 'cidr', '140.248.0.0/16',
     'apple_mpp', 0.2500::numeric,
     'Fastly block with a small Apple relay share; shared range, corroborating only.'),
    ('R_APPLE_RELAY_EGRESS_AKAMAI_A', 'cidr', '172.224.0.0/16',
     'apple_mpp', 0.2500::numeric,
     'Akamai block with a small Apple relay share; shared range, corroborating only.'),
    ('R_APPLE_RELAY_EGRESS_AKAMAI_B', 'cidr', '172.225.0.0/16',
     'apple_mpp', 0.3500::numeric,
     'Akamai block majority-used by Apple relay egress; shared range, corroborating only.'),
    ('R_APPLE_RELAY_EGRESS_AKAMAI_C', 'cidr', '172.226.0.0/16',
     'apple_mpp', 0.3000::numeric,
     'Akamai block partly used by Apple relay egress; shared range, corroborating only.')
)
INSERT INTO engagement_machine_registry_entries (
    registry_version, entry_id, matcher_type, matcher_value,
    machine_subtype, confidence, source_note, last_verified,
    entry_fingerprint
)
SELECT
    'postwave.machine-source-registry.v1', entry_id, matcher_type,
    matcher_value, machine_subtype, confidence, source_note,
    DATE '2026-08-17',
    encode(digest(convert_to(concat_ws(E'\x1f',
        'postwave.machine-source-registry.v1', entry_id, matcher_type,
        matcher_value, machine_subtype, confidence::float8::text, source_note,
        '2026-08-17'
    ), 'UTF8'), 'sha256'), 'hex')
FROM new_entries
ON CONFLICT (registry_version, entry_id) DO NOTHING;

COMMIT;
