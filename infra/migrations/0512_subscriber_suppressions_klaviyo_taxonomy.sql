-- 0512_subscriber_suppressions_klaviyo_taxonomy.sql
--
-- SUB-047 / SUB-048: consolidated suppression with a rich, Klaviyo-
-- compatible taxonomy. `subscriber_suppressions` is the X1 source-of-
-- truth table consulted by the send loop on every outbound dispatch;
-- the v_suppressions_unified view (0244) already converges the three
-- legacy tables on read. The only gap was the WRITE-side vocabulary:
-- the reason CHECK constraint (last widened by 0244) carried the
-- Postwave-internal enum but not the Klaviyo-parity categories every
-- 2026 ESP exposes on its suppression list:
--
--   soft_bounce        — transient delivery failure (vs the permanent
--                        soft_bounce_threshold auto-suppression)
--   complaint          — Klaviyo's short label for a spam/FBL complaint
--                        (we keep spam_complaint too for back-compat)
--   list_unsub_header  — RFC 8058 List-Unsubscribe one-click header
--   spamtrap           — recipient is a known spamtrap / honeypot
--   role_account       — role address (info@, sales@, abuse@, …)
--   dns_failure        — recipient domain has no deliverable MX / NXDOMAIN
--   invalid_address    — syntactically/semantically invalid mailbox
--
-- These complement (do not replace) the existing reasons. The bounce-
-- ingest receivers (apps/api/internal/webhooks/deliverability*.go) and
-- the spam_trap_guard package classify provider bounce codes into these
-- buckets and write through suppressions.Store.Add with the matching
-- reason. The frontend's reason badge renderer already handles arbitrary
-- reason strings, so no schema change is needed there.
--
-- DROP+ADD the named constraint (idempotent re-run safe) so this
-- migration is self-contained regardless of which prior migration last
-- defined subscriber_suppressions_reason_check (0239 → 0244 → here).

BEGIN;

ALTER TABLE subscriber_suppressions
    DROP CONSTRAINT IF EXISTS subscriber_suppressions_reason_check;
ALTER TABLE subscriber_suppressions
    ADD CONSTRAINT subscriber_suppressions_reason_check CHECK (reason IN (
        -- existing canonical reasons (0244)
        'hard_bounce',
        'spam_complaint',
        'manual_unsubscribe',
        'list_manual',
        'global_unsubscribe',
        'soft_bounce_threshold',
        'dsar_deletion',
        'role_address',
        'invalid_email',
        'blocklist_auto',
        -- SUB-047 / SUB-048: Klaviyo-compatible rich taxonomy
        'soft_bounce',
        'complaint',
        'list_unsub_header',
        'spamtrap',
        'role_account',
        'dns_failure',
        'invalid_address'
    ));

COMMIT;
