-- 2033_machine_registry_v2_claim_boundary.sql
--
-- Migration 1976 published R_AI_SUMMARIZER_UA as an immutable row under the
-- append-only registry v1 name with an over-specific subtype/source note. Its
-- matcher mixes web crawlers and a user-triggered fetch token; a UA match
-- cannot establish inbox summarization, recipient-AI use, human absence, or
-- prevalence. Preserve the v1 rows as historical ledger evidence and publish
-- a corrected current registry instead of rewriting applied evidence. The
-- replacement omits matcher tokens absent
-- from current provider-documented HTTP request user agents; specifically,
-- Google documents Google-Extended as a robots control token without its own
-- HTTP User-Agent string.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Freeze the append-only source set while it is checked, copied, and verified.
-- Without this lock, a legacy writer could append after the precondition and
-- leave v1/v2 with different snapshot shapes just before COMMIT.
LOCK TABLE engagement_machine_registry_entries IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
    expected_v1_ids text[] := ARRAY[
        'R_AI_SUMMARIZER_UA',
        'R_APPLE_MPP_UA',
        'R_APPLE_RELAY_EGRESS_AKAMAI_A',
        'R_APPLE_RELAY_EGRESS_AKAMAI_B',
        'R_APPLE_RELAY_EGRESS_AKAMAI_C',
        'R_APPLE_RELAY_EGRESS_CF',
        'R_APPLE_RELAY_EGRESS_FASTLY_A',
        'R_APPLE_RELAY_EGRESS_FASTLY_B',
        'R_GMAIL_PROXY_UA',
        'R_KLAVIYO_APPLE_PRIVACY_OPEN',
        'R_LINK_CHECKER_UA',
        'R_MAILGUN_BOT_APPLE',
        'R_OUTLOOK_SAFELINKS_UA',
        'R_PROVIDER_MACHINE_FLAG',
        'R_PROVIDER_MACHINE_OPEN_ALT',
        'R_PROVIDER_MACHINE_OPEN_GENERIC',
        'R_PROVIDER_MPP_HEADER',
        'R_SEG_SCANNER_UA'
    ];
    actual_v1_ids text[];
BEGIN
    SELECT array_agg(entry_id ORDER BY entry_id COLLATE "C")
      INTO actual_v1_ids
      FROM engagement_machine_registry_entries
     WHERE registry_version = 'postwave.machine-source-registry.v1';

    IF actual_v1_ids IS DISTINCT FROM expected_v1_ids THEN
        RAISE EXCEPTION 'machine registry v1 shape drifted: expected %, found %',
            expected_v1_ids, actual_v1_ids;
    END IF;
    -- Migrations 1934/1976 rendered confidence through float8::text, whose
    -- bytes depend on the session's extra_float_digits GUC. Those stored v1
    -- digests remain immutable ledger evidence, but cannot honestly be called
    -- a canonical whole-snapshot identity. The v2 rows below are re-derived
    -- from the exact row values using deterministic numeric text, and migration
    -- 2035 pins their complete canonical snapshot.
    IF NOT EXISTS (
        SELECT 1
          FROM engagement_machine_registry_entries
         WHERE registry_version = 'postwave.machine-source-registry.v1'
           AND entry_id = 'R_AI_SUMMARIZER_UA'
           AND matcher_type = 'ua_regex'
           AND matcher_value = '(?i)(gptbot|oai-searchbot|chatgpt-user|perplexitybot|claudebot|anthropic-ai|google-extended)'
           AND machine_subtype = 'ai_summarizer'
           AND confidence = 0.9500
           AND source_note = 'Published assistant fetcher user agents; a summariser read is not a human read.'
           AND last_verified = DATE '2026-08-17'
    ) THEN
        RAISE EXCEPTION 'machine registry v1 historical overlabel is absent or drifted';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM engagement_machine_registry_entries
         WHERE registry_version = 'postwave.machine-source-registry.v2'
    ) THEN
        RAISE EXCEPTION 'machine registry v2 already exists; refusing a partial or ambiguous replay';
    END IF;
END
$$;

WITH next_entries AS (
    SELECT
        entry_id,
        matcher_type,
        matcher_value,
        machine_subtype,
        confidence,
        source_note,
        last_verified
      FROM engagement_machine_registry_entries
     WHERE registry_version = 'postwave.machine-source-registry.v1'
       AND entry_id <> 'R_AI_SUMMARIZER_UA'

    UNION ALL

    SELECT
        'R_SELF_DECLARED_AGENT_UA'::text,
        'ua_regex'::text,
        '(?i)(gptbot|oai-searchbot|chatgpt-user|perplexitybot|claudebot)'::text,
        'unknown_bot'::text,
        0.9500::numeric,
        'Self-declared crawler or user-triggered fetch UA token; machine-like request evidence only; does not establish inbox summarization, recipient-AI use, human absence, or prevalence.'::text,
        DATE '2026-08-30'
)
INSERT INTO engagement_machine_registry_entries (
    registry_version,
    entry_id,
    matcher_type,
    matcher_value,
    machine_subtype,
    confidence,
    source_note,
    last_verified,
    entry_fingerprint
)
SELECT
    'postwave.machine-source-registry.v2',
    entry_id,
    matcher_type,
    matcher_value,
    machine_subtype,
    confidence,
    source_note,
    last_verified,
    encode(digest(convert_to(concat_ws(E'\x1f',
        'postwave.machine-source-registry.v2',
        entry_id,
        matcher_type,
        matcher_value,
        machine_subtype,
        trim(trailing '.' from trim(trailing '0' from confidence::numeric(5,4)::text)),
        source_note,
        to_char(last_verified, 'YYYY-MM-DD')
    ), 'UTF8'), 'sha256'), 'hex')
FROM next_entries
;

DO $$
DECLARE
    expected_v2_ids text[] := ARRAY[
        'R_APPLE_MPP_UA',
        'R_APPLE_RELAY_EGRESS_AKAMAI_A',
        'R_APPLE_RELAY_EGRESS_AKAMAI_B',
        'R_APPLE_RELAY_EGRESS_AKAMAI_C',
        'R_APPLE_RELAY_EGRESS_CF',
        'R_APPLE_RELAY_EGRESS_FASTLY_A',
        'R_APPLE_RELAY_EGRESS_FASTLY_B',
        'R_GMAIL_PROXY_UA',
        'R_KLAVIYO_APPLE_PRIVACY_OPEN',
        'R_LINK_CHECKER_UA',
        'R_MAILGUN_BOT_APPLE',
        'R_OUTLOOK_SAFELINKS_UA',
        'R_PROVIDER_MACHINE_FLAG',
        'R_PROVIDER_MACHINE_OPEN_ALT',
        'R_PROVIDER_MACHINE_OPEN_GENERIC',
        'R_PROVIDER_MPP_HEADER',
        'R_SEG_SCANNER_UA',
        'R_SELF_DECLARED_AGENT_UA'
    ];
    actual_v2_ids text[];
    actual_v2_snapshot text;
BEGIN
    SELECT array_agg(entry_id ORDER BY entry_id COLLATE "C")
      INTO actual_v2_ids
      FROM engagement_machine_registry_entries
     WHERE registry_version = 'postwave.machine-source-registry.v2';

    IF actual_v2_ids IS DISTINCT FROM expected_v2_ids THEN
        RAISE EXCEPTION 'machine registry v2 shape drifted: expected %, found %',
            expected_v2_ids, actual_v2_ids;
    END IF;
    SELECT encode(digest(convert_to(concat_ws(E'\x1f',
               'postwave.machine-source-registry-snapshot.v1',
               'postwave.machine-source-registry.v2',
               count(*)::text,
               string_agg(
                   entry_id || E'\x1f' || entry_fingerprint,
                   E'\x1e'
                   ORDER BY entry_id COLLATE "C"
               )
           ), 'UTF8'), 'sha256'), 'hex')
      INTO actual_v2_snapshot
      FROM engagement_machine_registry_entries
     WHERE registry_version = 'postwave.machine-source-registry.v2';
    IF actual_v2_snapshot <>
       '91cfb8bdc5a837e4fa90809b84ab0e125b8410930dae0b631dcf01566567db1b' THEN
        RAISE EXCEPTION 'machine registry v2 canonical whole-snapshot fingerprint drifted: %',
            actual_v2_snapshot;
    END IF;
    IF EXISTS (
        SELECT 1
          FROM engagement_machine_registry_entries
         WHERE registry_version = 'postwave.machine-source-registry.v2'
           AND entry_fingerprint <> encode(digest(convert_to(concat_ws(E'\x1f',
                registry_version,
                entry_id,
                matcher_type,
                matcher_value,
                machine_subtype,
                trim(trailing '.' from trim(trailing '0' from confidence::numeric(5,4)::text)),
                source_note,
                to_char(last_verified, 'YYYY-MM-DD')
           ), 'UTF8'), 'sha256'), 'hex')
    ) THEN
        RAISE EXCEPTION 'machine registry v2 contains a row with invalid provenance fingerprint';
    END IF;
    IF EXISTS (
        SELECT entry_id, matcher_type, matcher_value, machine_subtype,
               confidence, source_note, last_verified
          FROM engagement_machine_registry_entries
         WHERE registry_version = 'postwave.machine-source-registry.v1'
           AND entry_id <> 'R_AI_SUMMARIZER_UA'
        EXCEPT
        SELECT entry_id, matcher_type, matcher_value, machine_subtype,
               confidence, source_note, last_verified
          FROM engagement_machine_registry_entries
         WHERE registry_version = 'postwave.machine-source-registry.v2'
           AND entry_id <> 'R_SELF_DECLARED_AGENT_UA'
    ) OR EXISTS (
        SELECT entry_id, matcher_type, matcher_value, machine_subtype,
               confidence, source_note, last_verified
          FROM engagement_machine_registry_entries
         WHERE registry_version = 'postwave.machine-source-registry.v2'
           AND entry_id <> 'R_SELF_DECLARED_AGENT_UA'
        EXCEPT
        SELECT entry_id, matcher_type, matcher_value, machine_subtype,
               confidence, source_note, last_verified
          FROM engagement_machine_registry_entries
         WHERE registry_version = 'postwave.machine-source-registry.v1'
           AND entry_id <> 'R_AI_SUMMARIZER_UA'
    ) THEN
        RAISE EXCEPTION 'machine registry v2 changed a row outside the claim-boundary correction';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM engagement_machine_registry_entries
         WHERE registry_version = 'postwave.machine-source-registry.v2'
           AND (entry_id = 'R_AI_SUMMARIZER_UA'
                OR machine_subtype = 'ai_summarizer')
    ) THEN
        RAISE EXCEPTION 'machine registry v2 retained the summarization overlabel';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM engagement_machine_registry_entries
         WHERE registry_version = 'postwave.machine-source-registry.v2'
           AND entry_id = 'R_SELF_DECLARED_AGENT_UA'
           AND matcher_type = 'ua_regex'
           AND machine_subtype = 'unknown_bot'
           AND confidence = 0.9500
           AND matcher_value = '(?i)(gptbot|oai-searchbot|chatgpt-user|perplexitybot|claudebot)'
           AND source_note = 'Self-declared crawler or user-triggered fetch UA token; machine-like request evidence only; does not establish inbox summarization, recipient-AI use, human absence, or prevalence.'
           AND last_verified = DATE '2026-08-30'
    ) THEN
        RAISE EXCEPTION 'machine registry v2 corrected agent rule is absent or drifted';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM engagement_machine_registry_entries
         WHERE registry_version = 'postwave.machine-source-registry.v2'
           AND matcher_value ~* '(anthropic-ai|google-extended)'
    ) THEN
        RAISE EXCEPTION 'machine registry v2 retained non-current-documented matcher tokens';
    END IF;
END
$$;

-- Close the legacy row-at-a-time writer while the source/canonical table lock
-- is still held. Leaving this until 2035 creates a transaction boundary where
-- an old application can append after v2's canonical check has committed and
-- poison the immutable version before its whole-snapshot manifest is installed.
DROP POLICY IF EXISTS engagement_machine_registry_worker_insert
    ON engagement_machine_registry_entries;
REVOKE INSERT ON engagement_machine_registry_entries FROM postwave_app;

COMMIT;
