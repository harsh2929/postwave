-- 0400_agent_routine_runs_trust.sql
--
-- Trust record for agent-routine runs (0387). When the platform agent
-- autonomously drafts a campaign/sequence, an approver needs to see —
-- before approving — what the agent was told, the model's own reasoning,
-- and exactly what it produced. These columns persist that honest record:
--
--   prompt_used   the brief/prompt the runner sent to the model
--   context_used  the resolved audience context (human-readable)
--   reasoning     the model's OWN rationale (never synthesized; NULL when
--                 the model returned none — honestly absent, not faked)
--   draft_preview a compact JSON snapshot of the draft AT RUN TIME, so the
--                 reviewer sees what the agent wrote even if a human later
--                 edits the underlying draft
--
-- All nullable + additive: existing runs (and any run that failed before
-- producing a draft) simply carry NULLs.
--
-- rollback-strategy: no-op - additive nullable columns; prior releases
-- never read them, so leaving them in place during a rollback is safe.

BEGIN;

ALTER TABLE agent_routine_runs
    ADD COLUMN IF NOT EXISTS prompt_used   text,
    ADD COLUMN IF NOT EXISTS context_used  text,
    ADD COLUMN IF NOT EXISTS reasoning     text,
    ADD COLUMN IF NOT EXISTS draft_preview jsonb;

-- Index the approval back-reference so the Approvals surface can fetch a
-- run's trust record by approval id without scanning. Partial: only runs
-- that actually opened an approval carry one.
CREATE INDEX IF NOT EXISTS agent_routine_runs_approval_idx
    ON agent_routine_runs (tenant_id, approval_id)
    WHERE approval_id IS NOT NULL;

COMMIT;
