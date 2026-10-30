-- 0108_inbox_reality_tests.sql
--
-- On-demand Inbox Reality tests. Two-table additive schema that sits
-- alongside the existing seedlist_outcomes table (0105) — that one is
-- keyed by (tenant_id, campaign_id, mailbox_id) and records placement
-- AFTER a real campaign send. This pair captures the customer-facing
-- "test this email NOW" workflow:
--
--   1. Customer POSTs the candidate message to
--      /api/v1/inbox-reality/tests. The handler mints a row in
--      inbox_reality_tests with a unique header_token.
--   2. The customer (or our own dispatcher) sends the email to the
--      seedlist's known mailboxes with X-Postwave-Test-ID: <token>
--      attached. That header is what the existing
--      services/deliverability/internal/seedlist poller already
--      filters on (see PostwaveTestHeader in seedlist/poller.go).
--   3. The poller's per-provider categorizer classifies each landed
--      message; a thin pivot writes one inbox_reality_test_results
--      row per (test_id, mailbox_id).
--   4. Customer polls /api/v1/inbox-reality/tests/{id}; the handler
--      rolls the per-result rows into a provider breakdown +
--      finalises status when every active seed has reported or the
--      expires_at is reached.
--
-- RLS: tests is tenant-scoped via app.tenant_id (same pattern as the
-- rest of the gateway). test_results inherits the tenant scope via a
-- correlated subquery — RLS policies on child tables follow the same
-- pattern as seedlist_outcomes.

BEGIN;

CREATE TABLE IF NOT EXISTS inbox_reality_tests (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  -- header_token is the X-Postwave-Test-ID value the customer attaches
  -- to the message. Random + 16 bytes hex; UNIQUE globally so the
  -- deliverability service's poller can find the owning test from a
  -- message header alone without scanning per tenant.
  header_token  text        NOT NULL UNIQUE,
  -- kind is the entry point that created the test. 'manual' = customer
  -- hit the editor preview. 'campaign_preview' = the campaign editor
  -- minted a test before scheduling a real send. 'mcp_tool' = the
  -- agent toolchain ran inbox_reality.start.
  kind          text        NOT NULL DEFAULT 'manual'
                              CHECK (kind IN ('manual','campaign_preview','mcp_tool','api')),
  subject       text,
  from_address  text,
  status        text        NOT NULL DEFAULT 'awaiting_delivery'
                              CHECK (status IN ('awaiting_delivery','classifying','complete','expired','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  -- expires_at is when the orchestrator gives up waiting for more
  -- results. Default 10 minutes is enough for every provider to
  -- classify (Gmail/Outlook within ~60s, Apple/Proton up to 5 min).
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  -- meta is for non-schema'd extras (campaign_id reference, A/B
  -- variant name, MCP tool input snapshot, etc.). Schema-light so we
  -- can extend without a migration.
  meta          jsonb       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS inbox_reality_tests_tenant_created_idx
  ON inbox_reality_tests (tenant_id, created_at DESC);

-- The header_token UNIQUE constraint already creates an index, but we
-- explicitly add a partial index on (status) for the orchestrator's
-- "find expired tests to finalise" sweep. WHERE clauses on partial
-- indexes win this lookup over the (tenant,created_at) index every time.
CREATE INDEX IF NOT EXISTS inbox_reality_tests_active_expiry_idx
  ON inbox_reality_tests (expires_at)
  WHERE status IN ('awaiting_delivery','classifying');

CREATE TABLE IF NOT EXISTS inbox_reality_test_results (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id        uuid        NOT NULL REFERENCES inbox_reality_tests(id) ON DELETE CASCADE,
  -- mailbox_id is the seed-mailbox identifier from the deliverability
  -- service's YAML (e.g. 'gmail-seed-01'). One row per (test, mailbox).
  mailbox_id     text        NOT NULL,
  provider       text        NOT NULL
                               CHECK (provider IN
                                 ('gmail','outlook_com','o365','icloud','yahoo','proton','gmx','mailru')),
  -- Placement mirrors services/deliverability/internal/domain.Placement
  -- exactly so the categorizer's output writes here without translation.
  placement      text        NOT NULL
                               CHECK (placement IN
                                 ('primary','promotions','updates','social','spam','blocked','missing')),
  -- folder_name is the raw IMAP folder the poller found the message
  -- in. Useful for the "we found it in Bulk Mail" copy on the
  -- dashboard; the canonical signal is placement above.
  folder_name    text,
  classified_at  timestamptz NOT NULL DEFAULT now(),
  -- raw_headers carries the selected RFC-822 headers (Authentication-
  -- Results, Received, X-Spam-Flag, etc.) that the categorizer used.
  -- The dashboard renders a few of them in a "why this verdict" panel.
  raw_headers    jsonb,
  UNIQUE (test_id, mailbox_id)
);

CREATE INDEX IF NOT EXISTS inbox_reality_test_results_test_idx
  ON inbox_reality_test_results (test_id);

-- RLS ---------------------------------------------------------------------

ALTER TABLE inbox_reality_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_reality_tests FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inbox_reality_tests_tenant_isolation ON inbox_reality_tests;
CREATE POLICY inbox_reality_tests_tenant_isolation
  ON inbox_reality_tests
  AS PERMISSIVE FOR ALL TO postwave_app
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE inbox_reality_test_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_reality_test_results FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inbox_reality_test_results_via_parent ON inbox_reality_test_results;
CREATE POLICY inbox_reality_test_results_via_parent
  ON inbox_reality_test_results
  AS PERMISSIVE FOR ALL TO postwave_app
  USING (EXISTS (
    SELECT 1 FROM inbox_reality_tests t
     WHERE t.id = inbox_reality_test_results.test_id
       AND t.tenant_id = current_setting('app.tenant_id', true)::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM inbox_reality_tests t
     WHERE t.id = inbox_reality_test_results.test_id
       AND t.tenant_id = current_setting('app.tenant_id', true)::uuid
  ));

-- updated_at trigger ------------------------------------------------------

CREATE OR REPLACE FUNCTION inbox_reality_tests_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inbox_reality_tests_set_updated_at_trg ON inbox_reality_tests;
CREATE TRIGGER inbox_reality_tests_set_updated_at_trg
  BEFORE UPDATE ON inbox_reality_tests
  FOR EACH ROW EXECUTE FUNCTION inbox_reality_tests_set_updated_at();

COMMIT;
