-- 2009_reply_imap_tenant_secret_and_tls_fence.sql
--
-- F05 security fence for tenant-managed reply mailboxes. The application now
-- accepts only tenant-namespaced deployment-issued references and implicit TLS
-- on port 993. This migration makes that contract durable at the storage
-- boundary while preserving, but permanently disabling, unsafe legacy rows so
-- an operator can inspect and replace them without silently losing metadata.
--
-- Host publicness remains a runtime/dial-time property because DNS answers are
-- mutable. The worker re-resolves every poll, rejects any private or mixed
-- answer, and dials the validated IP literal with TLS verification against the
-- original hostname.
--
-- migration-execution: transactional
-- rollback-strategy: no-op

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.reply_imap_mailboxes
    ADD COLUMN IF NOT EXISTS security_quarantined_at timestamptz,
    ADD COLUMN IF NOT EXISTS security_quarantine_reason text;

UPDATE public.reply_imap_mailboxes
   SET enabled = false,
       security_quarantined_at = COALESCE(security_quarantined_at, now()),
       security_quarantine_reason = 'legacy_insecure_transport_or_secret_reference',
       updated_at = now()
 WHERE NOT (
       use_tls IS TRUE
       AND port = 993
       AND username_secret_ref ~ (
           '^env:POSTWAVE_REPLY_IMAP_TENANT_' ||
           upper(replace(tenant_id::text, '-', '')) ||
           '_[A-Z0-9_]{1,128}$'
       )
       AND password_secret_ref ~ (
           '^env:POSTWAVE_REPLY_IMAP_TENANT_' ||
           upper(replace(tenant_id::text, '-', '')) ||
           '_[A-Z0-9_]{1,128}$'
       )
   );

ALTER TABLE public.reply_imap_mailboxes
    DROP CONSTRAINT IF EXISTS reply_imap_mailboxes_secure_transport_fence,
    ADD CONSTRAINT reply_imap_mailboxes_secure_transport_fence CHECK (
        (use_tls IS TRUE AND port = 993)
        OR (
            enabled IS FALSE
            AND security_quarantined_at IS NOT NULL
            AND security_quarantine_reason = 'legacy_insecure_transport_or_secret_reference'
        )
    ),
    DROP CONSTRAINT IF EXISTS reply_imap_mailboxes_tenant_secret_fence,
    ADD CONSTRAINT reply_imap_mailboxes_tenant_secret_fence CHECK (
        (
            username_secret_ref ~ (
                '^env:POSTWAVE_REPLY_IMAP_TENANT_' ||
                upper(replace(tenant_id::text, '-', '')) ||
                '_[A-Z0-9_]{1,128}$'
            )
            AND password_secret_ref ~ (
                '^env:POSTWAVE_REPLY_IMAP_TENANT_' ||
                upper(replace(tenant_id::text, '-', '')) ||
                '_[A-Z0-9_]{1,128}$'
            )
        )
        OR (
            enabled IS FALSE
            AND security_quarantined_at IS NOT NULL
            AND security_quarantine_reason = 'legacy_insecure_transport_or_secret_reference'
        )
    ),
    DROP CONSTRAINT IF EXISTS reply_imap_mailboxes_quarantine_disables_polling,
    ADD CONSTRAINT reply_imap_mailboxes_quarantine_disables_polling CHECK (
        security_quarantined_at IS NULL OR enabled IS FALSE
    ),
    DROP CONSTRAINT IF EXISTS reply_imap_mailboxes_quarantine_reason_shape,
    ADD CONSTRAINT reply_imap_mailboxes_quarantine_reason_shape CHECK (
        (security_quarantined_at IS NULL AND security_quarantine_reason IS NULL)
        OR (
            security_quarantined_at IS NOT NULL
            AND security_quarantine_reason = 'legacy_insecure_transport_or_secret_reference'
        )
    );

COMMENT ON COLUMN public.reply_imap_mailboxes.security_quarantined_at IS
    'Set by migration 2009 for a legacy mailbox whose transport or secret reference is unsafe; quarantined rows cannot be enabled.';
COMMENT ON COLUMN public.reply_imap_mailboxes.security_quarantine_reason IS
    'Stable non-secret code explaining why a legacy mailbox is permanently disabled pending replacement.';

COMMIT;
