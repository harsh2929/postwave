-- Polls and RSVP via unique per-(recipient, option) URL (PRD F14).
--
-- The critical design issue is stated in the PRD and it is not the schema: a
-- security gateway that fetches every link registers a vote for EVERY option,
-- silently corrupting the data. A poll whose results are quietly wrong is worse
-- than no poll, because somebody will make a decision from it.
--
-- All three mitigations are implemented rather than the cheapest one:
--
--   1. TWO-STEP CONFIRMATION. The mailed link is a GET that only PREVIEWS; the
--      response is recorded by a POST from that page. This is the same split
--      internal/actionticket already uses for exactly this reason, and it is the
--      only mitigation that eliminates the problem rather than detecting it.
--   2. CLASSIFICATION GATING. A recorded response carries the F01 classification
--      of the request that made it. Machine-classified responses are stored and
--      excluded from totals, reported separately — never deleted, because a
--      deleted row cannot be re-counted when the classifier improves.
--   3. MULTI-OPTION VOID. More than one option hit for the same recipient inside
--      a short window voids all of them and marks the recipient contaminated.
--      This is what catches the scanner the first two miss.
--
-- rollback-strategy: no-op

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE IF NOT EXISTS campaign_polls (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
    -- poll_key matches the semantic tree's PollContent.PollID, so responses
    -- collected before a content edit still belong to the same poll.
    poll_key    text NOT NULL,
    question    text NOT NULL,
    -- two_step_required is per poll, not global: the PRD reserves the extra
    -- interaction for high-stakes polls, and forcing it everywhere would cost
    -- response rate on a one-click RSVP where the void guard is sufficient.
    two_step_required boolean NOT NULL DEFAULT true,
    closes_at   timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_polls_key_uniq
    ON campaign_polls (tenant_id, poll_key);

CREATE TABLE IF NOT EXISTS campaign_poll_options (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    poll_id    uuid NOT NULL REFERENCES campaign_polls(id) ON DELETE CASCADE,
    option_key text NOT NULL,
    label      text NOT NULL,
    position   int  NOT NULL DEFAULT 0
);

-- Unique per poll: duplicate option keys would merge two choices into one tally
-- and produce a confident wrong answer rather than an error.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_poll_options_key_uniq
    ON campaign_poll_options (tenant_id, poll_id, option_key);

CREATE TABLE IF NOT EXISTS campaign_poll_responses (
    id           bigserial PRIMARY KEY,
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    poll_id      uuid NOT NULL REFERENCES campaign_polls(id) ON DELETE CASCADE,
    option_id    uuid NOT NULL REFERENCES campaign_poll_options(id) ON DELETE CASCADE,
    -- The recipient, hashed. A poll response is an opinion, and storing the
    -- address beside it makes every future export a disclosure decision.
    recipient_hash text NOT NULL,
    -- token_hash is the per-(recipient, option) token this response arrived
    -- under. Stored hashed so a database reader cannot mint a vote.
    token_hash   text NOT NULL,

    -- state carries the three mitigations' outcome.
    --
    --   previewed            — a GET happened; NOT a response
    --   counted              — confirmed, human-classified, uncontaminated
    --   machine_excluded     — confirmed but the request classified as machine
    --   voided_multi_option  — this recipient hit more than one option
    --
    -- Rows are never deleted, only re-stated: a deleted response cannot be
    -- re-counted when the classifier improves, and reclassification is a
    -- first-class operation in this system.
    state        text NOT NULL DEFAULT 'previewed'
                 CHECK (state IN ('previewed', 'counted', 'machine_excluded', 'voided_multi_option')),
    classification text CHECK (classification IN ('human', 'machine', 'unknown')),
    previewed_at timestamptz,
    confirmed_at timestamptz,
    user_agent   text,
    ip           inet,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per (recipient, option). A recipient changing their mind updates their
-- row; a scanner hitting three options creates three rows, which is exactly the
-- signal the void guard reads.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_poll_responses_recipient_option_uniq
    ON campaign_poll_responses (tenant_id, poll_id, recipient_hash, option_id);

CREATE INDEX IF NOT EXISTS campaign_poll_responses_tally_idx
    ON campaign_poll_responses (tenant_id, poll_id, state);

CREATE INDEX IF NOT EXISTS campaign_poll_responses_recipient_idx
    ON campaign_poll_responses (tenant_id, poll_id, recipient_hash);

-- Token lookup is the hot path on every click.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_poll_responses_token_uniq
    ON campaign_poll_responses (token_hash);

ALTER TABLE campaign_polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_poll_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_poll_responses ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    target text;
BEGIN
    FOREACH target IN ARRAY ARRAY['campaign_polls', 'campaign_poll_options', 'campaign_poll_responses']
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
             WHERE schemaname = 'public' AND tablename = target
               AND policyname = 'tenant_isolation'
        ) THEN
            EXECUTE format(
                'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
                target);
        END IF;
    END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_polls TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_poll_options TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_poll_responses TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE campaign_poll_responses_id_seq TO postwave_app;
