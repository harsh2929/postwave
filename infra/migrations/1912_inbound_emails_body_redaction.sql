-- 1912_inbound_emails_body_redaction.sql
--
-- Inbound email bodies were never redacted.
--
-- `retention.Sweeper.sweepInboundEmails` does not delete these rows — it
-- REDACTS them, keeping the envelope and clearing the content:
--
--     UPDATE inbound_emails SET body_text = '', body_html = '' WHERE id IN (...)
--
-- It runs on the application pool as `postwave_app`, which holds INSERT and
-- SELECT and no UPDATE on this table, so every sweep raised `permission denied
-- for table inbound_emails`. Verified by attempting exactly that update as the
-- app role.
--
-- The retained data is message CONTENT: the text and HTML of mail people sent
-- in. A redaction window that never fires is the difference between "we keep
-- the fact that a message arrived" and "we keep the message".
--
-- A COLUMN-LEVEL GRANT, not a table-level one. The sweep touches exactly two
-- columns, and `tenant_visible` is PERMISSIVE FOR ALL — a table-wide UPDATE
-- grant would let any ordinary tenant-scoped request rewrite an inbound email's
-- sender, subject, headers or received time, which is evidence about what
-- arrived. Granting only `body_text` and `body_html` makes redaction possible
-- and rewriting impossible, with no policy needed to claw the difference back.
--
-- This is the pattern `audit_log` already uses: column-level UPDATE on exactly
-- `legal_hold`, `retention_override_days`, `prev_hash` and `row_hash`, which is
-- how that table stays immutable while remaining administrable. Note that
-- `has_table_privilege(..., 'UPDATE')` reports FALSE for such a table —
-- `has_any_column_privilege` is the question to ask.

BEGIN;

GRANT UPDATE (body_text, body_html) ON inbound_emails TO postwave_app;

COMMIT;
