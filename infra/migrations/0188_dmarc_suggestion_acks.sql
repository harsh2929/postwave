-- 0188_dmarc_suggestion_acks.sql
--
-- Refined DMARC PR 2: persisted suggestion acknowledgements so the
-- in-app banner stops nagging once an operator has read + agreed with
-- a suggestion.
--
-- Why a separate table (not a column on dmarc_aggregate_reports):
-- suggestions are computed in Go from the rollup; there's no row to
-- attach a flag to. Keying by a stable `code` (e.g. "alignment_low",
-- "blocked_volume") rather than the rendered Action text means the
-- ack survives small wording tweaks to the suggestion in the future.
--
-- (tenant_id, code) is the natural key. We also store the acker's
-- user_id + a free-text note so audits can answer "who decided this
-- was fine and why". `acked_at` is just a convenience timestamp;
-- the row's existence is the ack signal.
--
-- Unack is a hard delete (DELETE WHERE ...) — once an operator
-- changes their mind, we want the suggestion back immediately without
-- needing a `deleted_at` predicate everywhere the table is read.

CREATE TABLE IF NOT EXISTS dmarc_suggestion_acks (
  tenant_id  uuid        NOT NULL,
  code       text        NOT NULL,
  acked_by   uuid        NULL,
  note       text        NOT NULL DEFAULT '',
  acked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, code)
);

-- RLS lives in the API layer (db.WithTenant sets the session's
-- app.tenant_id GUC); no row policy here — match the rest of the
-- DMARC tables which rely on tenant scoping at the handler level.
