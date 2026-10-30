-- 1634_grant_missing_app_table_privileges.sql
--
-- Several feature tables were created without granting table privileges to the
-- application role `postwave_app`:
--
--   0188_dmarc_suggestion_acks   -> dmarc_suggestion_acks
--   0189_inbound_route_matches   -> inbound_route_matches
--   0191_sms_inbox_pr234         -> sms_conversation_tags, sms_quick_replies
--   0192_audit_pr234             -> audit_saved_views
--   0193_compliance_programs     -> compliance_programs, compliance_program_events
--   0231_asset_tags              -> asset_tags
--   0232_saved_blocks            -> saved_blocks
--   0233_export_retention        -> export_retention_policy
--
-- The API connects as `postwave_app` (non-superuser, RLS-enforced), so every
-- read/write to these tables failed with "permission denied for table X"
-- (SQLSTATE 42501) and the corresponding endpoints returned 500 — observed on
-- Assets (asset tags), Settings (export retention), Compliance, SMS Inbox,
-- Audit (saved views), Inbound routes, DMARC, and the saved-blocks surface.
--
-- This is a forward catch-up grant (idempotent) so existing and freshly
-- provisioned databases converge without editing the historical migrations
-- (which would trip checksum-drift detection). RLS already governs tenant
-- isolation on each of these tables; the grant only restores the DML the app
-- role was always meant to have.

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON
    asset_tags,
    audit_saved_views,
    compliance_program_events,
    compliance_programs,
    dmarc_suggestion_acks,
    export_retention_policy,
    inbound_route_matches,
    saved_blocks,
    sms_conversation_tags,
    sms_quick_replies
TO postwave_app;

COMMIT;
