-- 1997_verification_signup_attempt_fence.sql
--
-- A public form submission can cross a metered mailbox-verification boundary.
-- Browser/proxy retries therefore need a durable, privacy-preserving receipt:
-- an in-memory/idempotency cache cannot prove that a request was not already
-- dispatched after a replica crash.  The caller supplies an opaque attempt id;
-- application code stores only tenant-scoped identity and tenant/form-scoped
-- attempt/fingerprint SHA-256 digests.
--
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: Revert the signup gate to local-only full-mode behavior
-- before dropping verification_signup_attempts and
-- verification_signup_identities. Dropping the tables discards only bounded
-- retry/spend-fence receipts, not subscriber or long-lived verification
-- evidence.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- The original default predated the terminal-F contract.  Functional role
-- mailboxes no longer map to do_not_mail merely for being role based, so the
-- complete terminal set can be the safe default without excluding sales@ or
-- support@. Preserve bespoke policies; advance every row that still carries
-- the exact historical default, including off rows that may be enabled later.
ALTER TABLE verification_policy
    ALTER COLUMN forms_reject_statuses
    SET DEFAULT ARRAY['invalid', 'spamtrap', 'abuse', 'do_not_mail']::text[];

UPDATE verification_policy
   SET forms_reject_statuses = ARRAY['invalid', 'spamtrap', 'abuse', 'do_not_mail']::text[],
       updated_at = now()
 WHERE forms_reject_statuses = ARRAY['invalid', 'spamtrap']::text[];

-- A composite target makes it impossible to attach a receipt to a form owned
-- by another tenant even if an application bug supplied both UUIDs.
DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'forms'::regclass
           AND conname = 'forms_tenant_id_key'
    ) THEN
        ALTER TABLE forms
            ADD CONSTRAINT forms_tenant_id_key UNIQUE (tenant_id, id);
    END IF;
END;
$migration$;

-- One tenant-wide reservation per normalized address is the actual spend
-- fence. Distinct attempts on one or several published forms can race, so
-- attempt-id or form-local uniqueness is insufficient: each would otherwise
-- own a row and dispatch once. identity_hash is a tenant-scoped SHA-256 digest
-- of the canonical email.
CREATE TABLE verification_signup_identities (
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    identity_hash       bytea NOT NULL,
    -- Durable lease token for safe pre-dispatch recovery. This is itself the
    -- tenant/form-scoped attempt digest, never the caller's raw token.
    owner_attempt_hash  bytea NOT NULL,

    -- pending is durable before any paid request. dispatched_at commits in a
    -- separate transaction immediately before provider egress.
    state               text NOT NULL DEFAULT 'pending',
    dispatched_at       timestamptz,

    -- Identity evidence is policy-neutral. A new attempt reuses status and
    -- sub-status but recomputes allow/block under the tenant's current policy;
    -- an exact attempt replay still uses its attempt-specific decision below.
    checked             boolean,
    degraded            boolean,
    status              text,
    sub_status          text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),

    PRIMARY KEY (tenant_id, identity_hash),
    CONSTRAINT verification_signup_identity_hash_check
        CHECK (octet_length(identity_hash) = 32),
    CONSTRAINT verification_signup_identity_owner_hash_check
        CHECK (octet_length(owner_attempt_hash) = 32),
    CONSTRAINT verification_signup_identity_state_check
        CHECK (state IN ('pending', 'resolved', 'ambiguous')),
    CONSTRAINT verification_signup_identity_status_check
        CHECK (status IS NULL OR status IN (
            'valid', 'invalid', 'catch_all', 'spamtrap',
            'abuse', 'do_not_mail', 'unknown'
        )),
    CONSTRAINT verification_signup_identity_sub_status_check
        CHECK (
            sub_status IS NULL
            OR (
                octet_length(sub_status) <= 64
                AND sub_status !~ '[[:cntrl:]]'
            )
        ),
    CONSTRAINT verification_signup_identity_terminal_shape_check CHECK (
        (state = 'pending'
            AND checked IS NULL
            AND degraded IS NULL
            AND status IS NULL
            AND sub_status IS NULL)
        OR
        (state = 'resolved'
            AND checked = true
            AND degraded IS NOT NULL
            AND status IS NOT NULL
            AND sub_status IS NOT NULL)
        OR
        (state = 'ambiguous'
            AND checked = true
            AND degraded = true
            AND status = 'unknown'
            AND sub_status = 'provider_unavailable')
    ),
    CONSTRAINT verification_signup_identity_expiry_bound_check
        CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);

CREATE INDEX verification_signup_identities_expiry_idx
    ON verification_signup_identities (expires_at);

COMMENT ON TABLE verification_signup_identities IS
    '24-hour tenant-wide normalized-email digest reservations that fence paid public-form verification across distinct attempts and forms; no raw PII or provider errors.';

GRANT SELECT, INSERT, UPDATE, DELETE ON verification_signup_identities TO postwave_app;

ALTER TABLE verification_signup_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_signup_identities FORCE ROW LEVEL SECURITY;

CREATE POLICY verification_signup_identities_tenant
    ON verification_signup_identities
    FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY verification_signup_identities_worker_expired_select
    ON verification_signup_identities
    FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND expires_at <= now()
    );

CREATE POLICY verification_signup_identities_worker_expired_delete
    ON verification_signup_identities
    FOR DELETE TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND expires_at <= now()
    );

-- Every caller attempt remains separately fingerprint-bound so exact retries
-- replay and same-token/different-intent reuse is rejected, even when several
-- attempts share one address reservation.
CREATE TABLE verification_signup_attempts (
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    form_id             uuid NOT NULL,
    attempt_hash        bytea NOT NULL,
    identity_hash       bytea NOT NULL,
    request_fingerprint bytea NOT NULL,
    state               text NOT NULL DEFAULT 'pending',
    dispatched_at       timestamptz,
    allow               boolean,
    checked             boolean,
    degraded            boolean,
    status              text,
    sub_status          text,
    suggest_typos       boolean,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL,

    PRIMARY KEY (tenant_id, form_id, attempt_hash),
    CONSTRAINT verification_signup_attempts_form_fkey
        FOREIGN KEY (tenant_id, form_id)
        REFERENCES forms (tenant_id, id)
        ON DELETE CASCADE,
    CONSTRAINT verification_signup_attempts_identity_fkey
        FOREIGN KEY (tenant_id, identity_hash)
        REFERENCES verification_signup_identities (tenant_id, identity_hash)
        ON DELETE CASCADE,
    CONSTRAINT verification_signup_attempt_hash_check
        CHECK (octet_length(attempt_hash) = 32),
    CONSTRAINT verification_signup_attempt_identity_hash_check
        CHECK (octet_length(identity_hash) = 32),
    CONSTRAINT verification_signup_request_fingerprint_check
        CHECK (octet_length(request_fingerprint) = 32),
    CONSTRAINT verification_signup_state_check
        CHECK (state IN ('pending', 'allowed', 'blocked', 'ambiguous')),
    CONSTRAINT verification_signup_status_check
        CHECK (status IS NULL OR status IN (
            'valid', 'invalid', 'catch_all', 'spamtrap',
            'abuse', 'do_not_mail', 'unknown'
        )),
    CONSTRAINT verification_signup_sub_status_check
        CHECK (
            sub_status IS NULL
            OR (
                octet_length(sub_status) <= 64
                AND sub_status !~ '[[:cntrl:]]'
            )
        ),
    CONSTRAINT verification_signup_terminal_shape_check CHECK (
        (state = 'pending'
            AND allow IS NULL
            AND checked IS NULL
            AND degraded IS NULL
            AND status IS NULL
            AND sub_status IS NULL
            AND suggest_typos IS NULL)
        OR
        (state IN ('allowed', 'blocked')
            AND allow = (state = 'allowed')
            AND checked IS NOT NULL
            AND degraded IS NOT NULL
            AND status IS NOT NULL
            AND sub_status IS NOT NULL
            AND suggest_typos IS NOT NULL)
        OR
        (state = 'ambiguous'
            AND allow = true
            AND checked = true
            AND degraded = true
            AND status = 'unknown'
            AND sub_status = 'provider_unavailable'
            AND suggest_typos IS NOT NULL)
    ),
    CONSTRAINT verification_signup_attempt_expiry_bound_check
        CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);

CREATE INDEX verification_signup_attempts_expiry_idx
    ON verification_signup_attempts (expires_at);

COMMENT ON TABLE verification_signup_attempts IS
    'Tenant/form-scoped hashed exact-attempt retry receipts linked to a bounded normalized-email reservation; contains no raw attempt token, email, request body, or provider error.';

GRANT SELECT, INSERT, UPDATE, DELETE ON verification_signup_attempts TO postwave_app;

ALTER TABLE verification_signup_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_signup_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY verification_signup_attempts_tenant
    ON verification_signup_attempts
    FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Cross-tenant janitorial access is restricted to already-expired receipts.
-- The maintenance worker cannot enumerate live attempts or their outcomes.
CREATE POLICY verification_signup_attempts_worker_expired_select
    ON verification_signup_attempts
    FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND expires_at <= now()
    );

CREATE POLICY verification_signup_attempts_worker_expired_delete
    ON verification_signup_attempts
    FOR DELETE TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND expires_at <= now()
    );

COMMIT;
