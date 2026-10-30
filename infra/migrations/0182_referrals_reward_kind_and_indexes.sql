-- 0182_referrals_reward_kind_and_indexes.sql
--
-- Refined Referrals PR 1:
--
-- 1. milestones_v2 column on referral_programs — the v1 jsonb
--    encoded reward kind as a label prefix ("[swag] Hoodie"), which
--    is fragile string parsing. v2 stores {count, reward_label,
--    reward_kind} so the kind is structural. Existing rows are
--    backfilled by parsing the prefix; handler reads v2 when
--    present, falls back to v1 for unmigrated programs.
--
-- 2. (tenant_id, created_at DESC) index on referral_conversions —
--    PR 1's funnel + leaderboard queries scan recent conversions
--    per tenant; this index makes them an index-only scan instead
--    of a tenant-wide sort.

BEGIN;

ALTER TABLE referral_programs
    ADD COLUMN milestones_v2 jsonb NOT NULL DEFAULT '[]';

UPDATE referral_programs
SET milestones_v2 = COALESCE((
  SELECT jsonb_agg(
    jsonb_build_object(
      'count', (m->>'count')::int,
      'reward_label',
      CASE
        WHEN (m->>'reward_label') ~ '^\[[a-z]+\]\s*'
          THEN regexp_replace(m->>'reward_label', '^\[[a-z]+\]\s*', '')
        ELSE m->>'reward_label'
      END,
      'reward_kind',
      CASE
        WHEN (m->>'reward_label') ~ '^\[swag\]'   THEN 'swag'
        WHEN (m->>'reward_label') ~ '^\[free\]'   THEN 'free'
        WHEN (m->>'reward_label') ~ '^\[annual\]' THEN 'annual'
        ELSE 'custom'
      END
    )
  )
  FROM jsonb_array_elements(milestones) AS m
), '[]'::jsonb)
WHERE jsonb_array_length(milestones) > 0;

CREATE INDEX IF NOT EXISTS referral_conversions_tenant_created_idx
    ON referral_conversions (tenant_id, created_at DESC);

COMMIT;
