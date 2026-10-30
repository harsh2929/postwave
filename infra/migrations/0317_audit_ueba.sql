-- 0317_audit_ueba.sql
--
-- Per-actor UEBA baselines (impossible travel, off-hours, peer-group,
-- escalation chain). audit-2026 ueba-baselines (AI/Anomaly, P1).
--
-- Prior to this migration AuditRiskScore.ts was a 5-rule client-side
-- heuristic: destructive verb / >5k row export / unfamiliar /16 /
-- off-hours / failed auth. That is good triage but it has none of the
-- per-actor history a real UEBA model needs:
--
--   * impossible travel — geo-distance over time-delta between two
--     consecutive rows for the same actor, suppressed for known VPN
--     pools and carrier-NAT ranges. Vendor parity: Microsoft Sentinel
--     UEBA, Splunk UBA "Anomalous Travel", Okta Behavior Detection.
--   * off-hours — per-actor working-hours window vs row hour, scored
--     by deviation magnitude and action sensitivity. Vendor parity:
--     Okta ThreatInsight, Splunk UBA off-hour score.
--   * peer-group — k-means on action-frequency vectors per tenant
--     cohort; flag actors whose vector >2σ from their cluster
--     centroid. Vendor parity: Exabeam Smart Timelines, Vectra Cognito.
--   * escalation chain — graph-walk for role-assume → permission-
--     grant → resource-access within a short window. Vendor parity:
--     CrowdStrike Falcon Identity Protection, MITRE ATT&CK TA0004
--     Privilege Escalation.
--
-- This migration is purely additive — it does NOT mutate audit_log,
-- audit_alerts, or any existing UEBA-adjacent table. Two new tables
-- only:
--
--   1. audit_user_baselines — daily per-actor baseline snapshot.
--      Keyed (tenant_id, actor_label, actor_type, day). The worker
--      recomputes each tenant's actors once per UTC day; the most
--      recent row for a given (actor_label, actor_type) is the
--      baseline read at detection time. Day-keying preserves
--      historical baselines so a deviation can be measured against
--      a "stable" baseline from N days ago when today's baseline
--      already drifted under attack (Sybil resistance).
--
--   2. audit_anomaly_scores — per-audit detector output. One row per
--      audit_log row that any detector flagged. Composite score
--      [0..100] is what the alert worker uses for threshold rules;
--      reasons[] and mitre_techniques[] are what the "Why high risk?"
--      modal renders.
--
-- RLS posture matches the rest of the audit surface: every read goes
-- through the NULLIF-guarded tenant GUC; the worker carries a
-- secondary `app.audit_ueba_worker` GUC so it can write rows during
-- baseline computation without setting `app.tenant_id` (which would
-- shadow the tenant under which it computes per-tenant cohorts).

BEGIN;

-- 1) audit_user_baselines: daily per-actor baseline metrics snapshot.
CREATE TABLE IF NOT EXISTS audit_user_baselines (
    id                   bigserial PRIMARY KEY,
    tenant_id            uuid NOT NULL,
    actor_label          text NOT NULL,
    actor_type           text NOT NULL,
    -- UTC date of computation. Worker recomputes once per day; the
    -- "current" baseline is the row with the largest `day` for an
    -- (actor_label, actor_type) tuple.
    day                  date NOT NULL,

    -- typical_hours: hour-of-day histogram, {"0": 5, "1": 2, ..., "23": 14}.
    -- Detector reads this to derive the off-hours window per actor.
    typical_hours        jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- typical_ips: top-N /16 CIDR prefixes (e.g. ["10.0", "192.168"]).
    -- impossible_travel.go suppresses violations when both ends fall
    -- inside this set (carrier-NAT for the actor's home network).
    typical_ips          jsonb NOT NULL DEFAULT '[]'::jsonb,

    -- typical_actions: top-N actions by frequency, {"campaign.send": 42}.
    -- peer_group.go builds the per-actor frequency vector from this.
    typical_actions      jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- Rolling mean of actions/day across the lookback window. Used by
    -- the peer_group detector to detect activity-volume outliers
    -- before the more expensive k-means call.
    mean_actions_per_day numeric(10,2) NOT NULL DEFAULT 0,

    -- k-means cluster id assigned in the daily peer-group recompute.
    -- NULL until the first peer_group tick produces a cohort for this
    -- tenant.
    cluster_id           integer,

    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, actor_label, actor_type, day)
);

CREATE INDEX IF NOT EXISTS idx_audit_user_baselines_tenant_actor
    ON audit_user_baselines (tenant_id, actor_label, actor_type, day DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_user_baselines TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE audit_user_baselines_id_seq TO postwave_app;

ALTER TABLE audit_user_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_user_baselines FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_visible ON audit_user_baselines
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Worker-role escape hatch. The UEBA worker iterates every tenant in
-- one process; instead of opening a per-tenant tx per actor (slow at
-- 1k+ actors / tenant) it carries `app.audit_ueba_worker='true'` so
-- it can write baselines under the tenant_id passed in the row.
CREATE POLICY audit_ueba_worker_all ON audit_user_baselines
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (current_setting('app.audit_ueba_worker', true) = 'true')
    WITH CHECK (current_setting('app.audit_ueba_worker', true) = 'true');

-- 2) audit_anomaly_scores: per-audit detector output.
CREATE TABLE IF NOT EXISTS audit_anomaly_scores (
    id                bigserial PRIMARY KEY,
    tenant_id         uuid NOT NULL,
    audit_id          bigint NOT NULL,

    -- Aggregated score [0..100]. The alert worker fires on
    -- score >= threshold (default 60). 100 = certain anomaly.
    score             numeric(5,2) NOT NULL DEFAULT 0,

    -- Per-detector results, each item:
    --   {"type":"impossible_travel","reason":"...","confidence":0.95,
    --    "mitre":["T1078"]}
    reasons           jsonb NOT NULL DEFAULT '[]'::jsonb,

    -- Flattened MITRE ATT&CK technique IDs across all detectors,
    -- e.g. {"T1078","T1098","T1134"}. text[] (not jsonb) so the
    -- "Why high risk?" modal can render a stable list with one
    -- index scan.
    mitre_techniques  text[] NOT NULL DEFAULT '{}',

    -- Raw detector internals for deep-dive debugging. Optional; a
    -- detector that doesn't emit detail leaves this NULL.
    detector_detail   jsonb,

    created_at        timestamptz NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, audit_id)
);

-- Index for the alert worker: "give me the top-N scoring rows in the
-- last hour for tenant X" is the hot path; (tenant_id, score DESC,
-- created_at DESC) covers it without a sort.
CREATE INDEX IF NOT EXISTS idx_audit_anomaly_scores_tenant_score
    ON audit_anomaly_scores (tenant_id, score DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_anomaly_scores_tenant_created
    ON audit_anomaly_scores (tenant_id, created_at DESC);

-- Partial index for the alert-dispatch worker: only "high risk" rows
-- (score >= 50). Keeps the index slim on busy tenants.
CREATE INDEX IF NOT EXISTS idx_audit_anomaly_scores_high_risk
    ON audit_anomaly_scores (tenant_id, created_at DESC)
    WHERE score >= 50;

GRANT SELECT, INSERT, UPDATE ON audit_anomaly_scores TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE audit_anomaly_scores_id_seq TO postwave_app;

ALTER TABLE audit_anomaly_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_anomaly_scores FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_visible ON audit_anomaly_scores
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY audit_ueba_worker_all ON audit_anomaly_scores
    AS PERMISSIVE FOR ALL
    TO postwave_app
    USING (current_setting('app.audit_ueba_worker', true) = 'true')
    WITH CHECK (current_setting('app.audit_ueba_worker', true) = 'true');

COMMIT;
