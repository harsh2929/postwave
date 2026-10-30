-- 1718_self_account_deletion.sql
--
-- A self-service user-account deletion request is deliberately distinct from
-- the existing tenant/workspace deletion workflow.  The request identifies a
-- single authenticated user, is fulfilled by a dedicated worker, and leaves
-- workspace-owned content in place.  The retained request row is an
-- email-free compliance certificate; subject_user_id is cleared by the FK
-- when the user row is deleted.

BEGIN;

ALTER TABLE privacy_requests
    DROP CONSTRAINT IF EXISTS privacy_requests_subject_type_check;

ALTER TABLE privacy_requests
    ADD CONSTRAINT privacy_requests_subject_type_check
    CHECK (subject_type IN ('tenant_admin', 'subscriber', 'consumer', 'account_user'));

ALTER TABLE privacy_requests
    DROP CONSTRAINT IF EXISTS privacy_requests_status_check;

ALTER TABLE privacy_requests
    ADD CONSTRAINT privacy_requests_status_check
    CHECK (status IN (
        'queued',
        'verifying',
        'in_progress',
        'blocked_legal_hold',
        'blocked_ownership',
        'fulfilled',
        'rejected',
        'cancelled',
        'appealed'
    ));

ALTER TABLE privacy_requests
    ADD COLUMN IF NOT EXISTS subject_user_id uuid
        REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reauthentication_method text,
    ADD COLUMN IF NOT EXISTS execute_after timestamptz,
    ADD COLUMN IF NOT EXISTS retention_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS idempotency_key_hash bytea;

ALTER TABLE privacy_requests
    DROP CONSTRAINT IF EXISTS privacy_requests_reauthentication_method_check,
    DROP CONSTRAINT IF EXISTS privacy_requests_idempotency_key_hash_check;

ALTER TABLE privacy_requests
    ADD CONSTRAINT privacy_requests_reauthentication_method_check
        CHECK (
            reauthentication_method IS NULL OR
            reauthentication_method IN ('password', 'google', 'microsoft', 'saml', 'magic_link')
        ),
    ADD CONSTRAINT privacy_requests_idempotency_key_hash_check
        CHECK (idempotency_key_hash IS NULL OR octet_length(idempotency_key_hash) = 32);

COMMIT;
