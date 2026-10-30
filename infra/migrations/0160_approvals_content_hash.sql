-- 0160_approvals_content_hash.sql
--
-- Forward-fix for D7 (PRODUCTION_READINESS.md, security-adjacent):
-- EnsureCampaignSendApproved accepts ANY Approved row for the
-- resource, regardless of whether the campaign has been edited
-- since the approval was granted. An editor can:
--   1. Request approval on benign content
--   2. Wait for approval
--   3. Swap in spammy/malicious content via campaigns UPDATE
--   4. Trigger /queue
--   5. Campaign sends with the post-approval (unapproved) content
--
-- Fix: fingerprint (subject + body_html + segment_id) at approval-
-- request time into approvals.content_hash. At queue time, recompute
-- and compare. Mismatch → reject; operator must re-request approval.
--
-- The column is nullable so existing in-flight approvals (granted
-- before this migration) don't break — they go through the legacy
-- "accept any Approved" path. New approvals populate it and the
-- gate enforces.

BEGIN;

ALTER TABLE approvals
    ADD COLUMN IF NOT EXISTS content_hash text;

-- Also add a consumed_at marker so D11 (one-shot approval
-- consumption) can be enforced without a new migration. Nullable;
-- the gate flips it to now() after a successful queue-fill.
ALTER TABLE approvals
    ADD COLUMN IF NOT EXISTS consumed_at timestamptz;

COMMIT;
