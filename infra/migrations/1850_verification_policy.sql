-- 1850_verification_policy.sql
--
-- Per-tenant policy for WHERE the verification connector (migration 1839,
-- apps/api/internal/verification) is enforced, as opposed to merely available.
--
-- Two enforcement points:
--
--   forms_mode   the public signup gate. Runs at form-submit time.
--   import_mode  the subscriber-import preflight projection.
--
-- Three things about the defaults are deliberate and load-bearing:
--
--  1. Both default to 'off'. Turning on verification changes who is allowed to
--     sign up; that must never happen as a side effect of deploying a
--     migration. An operator opts in explicitly.
--
--  2. 'local' is the recommended first step and is FREE — syntax, DNS/MX,
--     disposable and role checks only, no vendor call, no credit, no added
--     signup latency. 'full' escalates to the configured vendor and spends one
--     credit per signup.
--
--  3. forms_reject_statuses defaults to invalid + spamtrap ONLY. Those two are
--     unambiguous: the address cannot receive mail, or mailing it actively
--     damages sender reputation. do_not_mail (role accounts, disposable
--     domains) is deliberately NOT rejected by default, because plenty of
--     legitimate businesses sign up as info@ or sales@ and silently dropping
--     them is a revenue decision the operator should make consciously.
--
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: New additive table. Absent rows mean "policy off", which is
-- exactly the behaviour of code that predates it, so dropping the table
-- restores prior behaviour with no data migration.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS verification_policy (
    tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,

    -- off | local | full
    forms_mode  text NOT NULL DEFAULT 'off',
    -- Canonical Status values that cause a signup to be refused.
    forms_reject_statuses text[] NOT NULL DEFAULT ARRAY['invalid', 'spamtrap']::text[],
    -- Return a did_you_mean correction to the visitor on a typo'd domain
    -- instead of a bare rejection.
    forms_suggest_typos boolean NOT NULL DEFAULT true,

    -- off | local | full
    import_mode text NOT NULL DEFAULT 'off',

    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT verification_policy_forms_mode_check
        CHECK (forms_mode IN ('off', 'local', 'full')),
    CONSTRAINT verification_policy_import_mode_check
        CHECK (import_mode IN ('off', 'local', 'full')),
    -- Every entry must be a member of the canonical Status set. Without this a
    -- typo'd status would silently never match and the gate would look
    -- configured while enforcing nothing.
    CONSTRAINT verification_policy_reject_statuses_check
        CHECK (forms_reject_statuses <@ ARRAY[
            'valid', 'invalid', 'catch_all', 'spamtrap',
            'abuse', 'do_not_mail', 'unknown'
        ]::text[])
);

GRANT SELECT, INSERT, UPDATE, DELETE ON verification_policy TO postwave_app;

ALTER TABLE verification_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_policy FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON verification_policy;
CREATE POLICY tenant_isolation ON verification_policy
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMIT;
