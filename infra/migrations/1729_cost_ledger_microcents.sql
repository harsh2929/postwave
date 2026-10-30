-- 1729_cost_ledger_microcents.sql
--
-- The cost ledger recorded cents=0 for every entry, so /api/v1/costs reported
-- $0 for every tenant and dollar budgets could never trip. The blocker was
-- precision, not intent: SES is $0.10 per 1,000 emails = 0.01 cents/email, which
-- is 0 in the int `cents` column, and an LLM call of a few hundred tokens is
-- likewise sub-cent. So the only honest per-unit value to store was 0.
--
-- microcents (1 cent = 10,000 microcents) is the precise source of truth. The
-- existing `cents` column stays as a rounded display value; readers that need
-- accuracy (budget enforcement, per-tenant COGS) sum microcents.

ALTER TABLE cost_ledger
    ADD COLUMN IF NOT EXISTS microcents bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN cost_ledger.microcents IS
    'Precise cost in microcents (1 cent = 10,000). The int `cents` column is a rounded display value; microcents is the source of truth for billing and budget math.';
