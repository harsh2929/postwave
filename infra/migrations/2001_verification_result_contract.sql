-- 2001_verification_result_contract.sql
--
-- Enforce the canonical boundary for paid email-verification evidence. The
-- application already normalizes and validates these values, but cache rows and
-- durable job items are security/cost controls: malformed legacy or direct SQL
-- writes must not create duplicate identities, forge operator-visible text, or
-- turn contradictory provider fields into a sendable result.
--
-- Constraints are added NOT VALID so this rollout does not take a long table
-- scan or fail deployment because of historical rows. PostgreSQL still enforces
-- every constraint for new/updated rows. Runtime reads independently reject
-- malformed legacy cache/job evidence; a later maintenance migration may scrub
-- and VALIDATE these constraints without reopening the paid-dispatch boundary.
--
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Reverting application-side result validation first is not
-- safe. The constraints themselves can be dropped without data loss only after
-- all writers/readers have moved to an equivalent canonical contract.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.verification_contract_text_valid(
    p_value text,
    p_max_bytes integer,
    p_allow_empty boolean,
    p_require_trim boolean
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
DECLARE
    i integer;
    cp integer;
    ch text;
    is_space boolean;
    visible boolean := false;
BEGIN
    IF octet_length(p_value) > p_max_bytes THEN
        RETURN false;
    END IF;
    FOR i IN 1..char_length(p_value) LOOP
        ch := substr(p_value, i, 1);
        cp := ascii(ch);
        -- Match the Go boundary's Cc/Cf/Co/Zl/Zp rejection. PostgreSQL UTF-8
        -- text cannot contain surrogate code points or invalid byte sequences.
        IF cp <= 31 OR (cp BETWEEN 127 AND 159) OR
           cp IN (173,1564,1807,6158,65279) OR
           (cp BETWEEN 1536 AND 1541) OR cp = 1757 OR
           (cp BETWEEN 2192 AND 2193) OR cp = 2274 OR
           (cp BETWEEN 8203 AND 8207) OR (cp BETWEEN 8234 AND 8238) OR
           (cp BETWEEN 8288 AND 8292) OR (cp BETWEEN 8294 AND 8303) OR
           (cp BETWEEN 65529 AND 65531) OR cp IN (69821,69837) OR
           (cp BETWEEN 78896 AND 78911) OR
           (cp BETWEEN 113824 AND 113827) OR
           (cp BETWEEN 119155 AND 119162) OR cp = 917505 OR
           (cp BETWEEN 917536 AND 917631) OR
           (cp BETWEEN 57344 AND 63743) OR
           (cp BETWEEN 983040 AND 1048573) OR
           (cp BETWEEN 1048576 AND 1114109) OR
           cp IN (8232,8233) THEN
            RETURN false;
        END IF;
        is_space := cp IN (9,10,11,12,13,32,133,160,5760,8232,8233,8239,8287,12288)
            OR (cp BETWEEN 8192 AND 8202);
        IF p_require_trim AND is_space AND (i = 1 OR i = char_length(p_value)) THEN
            RETURN false;
        END IF;
        visible := visible OR NOT is_space;
    END LOOP;
    RETURN p_allow_empty OR visible;
END
$$;

ALTER TABLE verification_cache
    ADD CONSTRAINT verification_cache_email_contract_check CHECK (
        public.verification_contract_text_valid(email, 320, false, true)
        AND email = lower(btrim(email))
    ) NOT VALID,
    ADD CONSTRAINT verification_cache_provider_contract_check CHECK (
        provider IN ('local', 'zerobounce', 'kickbox')
    ) NOT VALID,
    ADD CONSTRAINT verification_cache_sub_status_contract_check CHECK (
        sub_status IN (
            '', 'failed_syntax_check', 'no_dns_entries', 'possible_typo',
            'disposable', 'role_based', 'toxic', 'alias_address',
            'alternate', 'gold', 'ai_agent_mailbox',
            'mailbox_not_found', 'mailbox_quota_exceeded',
            'global_suppression', 'possible_trap', 'role_based_catch_all',
            'role_based_accept_all', 'mx_forward',
            'does_not_accept_mail', 'unroutable_ip_address', 'accept_all',
            'antispam_system', 'greylisted', 'mail_server_temporary_error',
            'mail_server_did_not_respond', 'forcible_disconnect',
            'timeout_exceeded', 'failed_smtp_connection',
            'exception_occurred', 'no_mailbox_probe', 'provider_unavailable'
        )
    ) NOT VALID,
    ADD CONSTRAINT verification_cache_projection_text_contract_check CHECK (
        public.verification_contract_text_valid(domain, 253, true, true)
        AND domain = lower(btrim(domain))
        AND public.verification_contract_text_valid(mx_record, 253, true, true)
        AND public.verification_contract_text_valid(did_you_mean, 254, true, true)
        AND did_you_mean = lower(btrim(did_you_mean))
        AND public.verification_contract_text_valid(first_name, 256, true, true)
        AND public.verification_contract_text_valid(last_name, 256, true, true)
        AND public.verification_contract_text_valid(gender, 64, true, true)
        AND public.verification_contract_text_valid(country, 128, true, true)
        AND public.verification_contract_text_valid(city, 256, true, true)
    ) NOT VALID,
    ADD CONSTRAINT verification_cache_semantics_contract_check CHECK (
        (status <> 'valid' OR (
            NOT disposable
            AND sub_status IN (
                '', 'role_based', 'alias_address', 'alternate', 'gold',
                'ai_agent_mailbox'
            )
        ))
        AND (status <> 'catch_all' OR (
            NOT disposable
            AND sub_status IN (
                '', 'accept_all', 'role_based', 'role_based_catch_all',
                'role_based_accept_all', 'ai_agent_mailbox'
            )
        ))
        AND (status <> 'unknown' OR (
            (provider = 'local' AND disposable AND sub_status = 'disposable')
            OR (
                NOT disposable
                AND sub_status IN (
                    '', 'role_based', 'alias_address', 'antispam_system',
                    'greylisted', 'mail_server_temporary_error',
                    'mail_server_did_not_respond', 'forcible_disconnect',
                    'timeout_exceeded', 'failed_smtp_connection',
                    'exception_occurred', 'mailbox_quota_exceeded',
                    'no_mailbox_probe', 'provider_unavailable'
                )
            )
        ))
        AND (status NOT IN ('invalid', 'spamtrap', 'abuse')
             OR sub_status NOT IN (
                'accept_all', 'role_based_catch_all', 'role_based_accept_all',
                'alternate', 'gold', 'ai_agent_mailbox', 'alias_address'
             ))
        AND (status <> 'do_not_mail' OR sub_status IN (
            '', 'disposable', 'toxic', 'role_based', 'role_based_catch_all',
            'global_suppression', 'possible_trap', 'mx_forward'
        ))
        AND (provider <> 'local' OR status IN (
            'invalid', 'abuse', 'do_not_mail', 'unknown'
        ))
    ) NOT VALID;

ALTER TABLE verification_jobs
    ADD CONSTRAINT verification_jobs_provider_contract_check CHECK (
        provider IN ('', 'local', 'zerobounce', 'kickbox')
    ) NOT VALID,
    ADD CONSTRAINT verification_jobs_complete_counts_check CHECK (
        total >= 0
        AND processed BETWEEN 0 AND total
        AND cache_hits >= 0
        AND local_filtered >= 0
        AND vendor_verified >= 0
        AND credits_spent >= 0
        AND duplicates >= 0
        AND ambiguous >= 0
        AND attempts >= 0
        AND processed + ambiguous <= total
        AND cache_hits + local_filtered + vendor_verified <= processed
        AND credits_spent <= vendor_verified
        AND total <= 250000
        AND (status <> 'completed' OR (processed = total AND ambiguous = 0))
    ) NOT VALID,
    ADD CONSTRAINT verification_jobs_operator_text_contract_check CHECK (
        public.verification_contract_text_valid(source_ref, 512, true, true)
        AND public.verification_contract_text_valid(failure_code, 128, true, true)
        AND public.verification_contract_text_valid(error, 512, true, true)
        AND public.verification_contract_text_valid(idempotency_key, 255, true, true)
        AND public.verification_contract_text_valid(COALESCE(lease_owner, ''), 256, true, true)
    ) NOT VALID;

ALTER TABLE verification_job_items
    ADD CONSTRAINT verification_job_items_email_contract_check CHECK (
        public.verification_contract_text_valid(email, 320, false, true)
        AND email = lower(btrim(email))
    ) NOT VALID,
    ADD CONSTRAINT verification_job_items_provider_contract_check CHECK (
        provider IN ('', 'local', 'zerobounce', 'kickbox')
    ) NOT VALID,
    ADD CONSTRAINT verification_job_items_sub_status_contract_check CHECK (
        sub_status IN (
            '', 'failed_syntax_check', 'no_dns_entries', 'possible_typo',
            'disposable', 'role_based', 'toxic', 'alias_address',
            'alternate', 'gold', 'ai_agent_mailbox',
            'mailbox_not_found', 'mailbox_quota_exceeded',
            'global_suppression', 'possible_trap', 'role_based_catch_all',
            'role_based_accept_all', 'mx_forward',
            'does_not_accept_mail', 'unroutable_ip_address', 'accept_all',
            'antispam_system', 'greylisted', 'mail_server_temporary_error',
            'mail_server_did_not_respond', 'forcible_disconnect',
            'timeout_exceeded', 'failed_smtp_connection',
            'exception_occurred', 'no_mailbox_probe', 'provider_unavailable',
            -- Internal durable receipt, never a provider vocabulary value.
            'provider_response_ambiguous'
        )
    ) NOT VALID,
    ADD CONSTRAINT verification_job_items_projection_contract_check CHECK (
        public.verification_contract_text_valid(did_you_mean, 254, true, true)
        AND did_you_mean = lower(btrim(did_you_mean))
        AND NOT (billable AND cached)
        AND (
            (attempt_state IN ('pending', 'leased')
                AND NOT processed
                AND status = 'unknown'
                AND sub_status = ''
                AND score IS NULL
                AND provider = ''
                AND NOT billable
                AND NOT cached
                AND did_you_mean = ''
                AND checked_at IS NULL)
            OR
            (attempt_state = 'ambiguous'
                AND NOT processed
                AND status = 'unknown'
                AND sub_status = 'provider_response_ambiguous'
                AND score IS NULL
                AND provider = ''
                AND NOT billable
                AND NOT cached
                AND did_you_mean = ''
                AND checked_at IS NULL)
            OR
            (attempt_state = 'succeeded'
                AND processed
                AND provider IN ('local', 'zerobounce', 'kickbox')
                AND checked_at IS NOT NULL
                AND (status <> 'valid' OR sub_status IN (
                    '', 'role_based', 'alias_address', 'alternate', 'gold',
                    'ai_agent_mailbox'
                ))
                AND (status <> 'catch_all' OR sub_status IN (
                    '', 'accept_all', 'role_based', 'role_based_catch_all',
                    'role_based_accept_all', 'ai_agent_mailbox'
                ))
                AND (status <> 'unknown' OR (
                    (provider = 'local' AND sub_status = 'disposable')
                    OR sub_status IN (
                        '', 'role_based', 'alias_address', 'antispam_system',
                        'greylisted', 'mail_server_temporary_error',
                        'mail_server_did_not_respond', 'forcible_disconnect',
                        'timeout_exceeded', 'failed_smtp_connection',
                        'exception_occurred', 'mailbox_quota_exceeded',
                        'no_mailbox_probe', 'provider_unavailable'
                    )
                ))
                AND (status NOT IN ('invalid', 'spamtrap', 'abuse')
                     OR sub_status NOT IN (
                        'accept_all', 'role_based_catch_all',
                        'role_based_accept_all', 'alternate', 'gold',
                        'ai_agent_mailbox', 'alias_address'
                     ))
                AND (status <> 'do_not_mail' OR sub_status IN (
                    '', 'disposable', 'toxic', 'role_based',
                    'role_based_catch_all', 'global_suppression',
                    'possible_trap', 'mx_forward'
                ))
                AND (provider <> 'local' OR status IN (
                    'invalid', 'abuse', 'do_not_mail', 'unknown'
                ))
            )
        )
    ) NOT VALID;

COMMENT ON CONSTRAINT verification_cache_email_contract_check ON verification_cache IS
    'New cache identities must exactly match the bounded lowercase/trimmed application key; legacy rows are rejected by runtime reads until scrubbed.';
COMMENT ON CONSTRAINT verification_job_items_email_contract_check ON verification_job_items IS
    'New durable job identities must exactly match the bounded lowercase/trimmed application key; provider_response_ambiguous remains an explicit internal receipt.';

COMMIT;
