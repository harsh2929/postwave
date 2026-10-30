-- 1954_email_health_grade.sql
--
-- Tenant-scoped, materialized recipient Email Health Grade snapshots.
--
-- The snapshot is a derived read model, not subscriber state.  In particular,
-- it deliberately does not add a grade to `subscribers` or
-- `subscriber_emails`: one resolver combines verification, consent,
-- suppression, and engagement evidence and can be recomputed as those inputs
-- change.  `hard_stop` records that consent or an active suppression is
-- authoritative even when another source contains positive evidence.
--
-- rollback-strategy: expand-contract.  Older binaries do not read this table;
-- dropping it loses only recomputable snapshots.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS email_health_snapshots (
    tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email                  text NOT NULL,
    grade                  char(1) NOT NULL,
    recommendation         text NOT NULL,
    hard_stop              boolean NOT NULL DEFAULT false,
    reason_codes           text[] NOT NULL DEFAULT '{}'::text[],
    -- Ordered, public-safe evidence objects.  Provider payloads, suppression
    -- metadata, reply bodies, IPs, and user agents never belong here.
    evidence               jsonb NOT NULL DEFAULT '[]'::jsonb,
    evidence_at            timestamptz,
    verification_status    text,
    verification_score     smallint,
    verification_provider  text,
    verification_checked_at timestamptz,
    model_version          text NOT NULL DEFAULT 'postwave-email-health-v1',
    computed_at            timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, email),
    CONSTRAINT email_health_snapshots_email_check CHECK (
        email = lower(btrim(email))
        AND length(email) BETWEEN 3 AND 320
        AND email !~ '[[:cntrl:]]'
    ),
    CONSTRAINT email_health_snapshots_grade_check
        CHECK (grade IN ('A', 'B', 'C', 'D', 'F', 'U')),
    CONSTRAINT email_health_snapshots_recommendation_check
        CHECK (recommendation IN ('send', 'caution', 'do_not_send', 'blocked')),
    CONSTRAINT email_health_snapshots_hard_stop_check
        CHECK (NOT hard_stop OR recommendation = 'blocked'),
    CONSTRAINT email_health_snapshots_reasons_check
        CHECK (cardinality(reason_codes) BETWEEN 1 AND 64),
    CONSTRAINT email_health_snapshots_evidence_check CHECK (
        jsonb_typeof(evidence) = 'array'
        AND octet_length(evidence::text) <= 65536
    ),
    CONSTRAINT email_health_snapshots_status_check CHECK (
        verification_status IS NULL OR verification_status IN (
            'valid', 'invalid', 'catch_all', 'spamtrap',
            'abuse', 'do_not_mail', 'unknown'
        )
    ),
    CONSTRAINT email_health_snapshots_score_check CHECK (
        verification_score IS NULL OR verification_score BETWEEN 0 AND 10
    ),
    CONSTRAINT email_health_snapshots_model_check CHECK (
        length(model_version) BETWEEN 1 AND 96
        AND model_version !~ '[[:cntrl:]]'
    )
);

CREATE INDEX IF NOT EXISTS email_health_snapshots_grade_idx
    ON email_health_snapshots (tenant_id, grade, computed_at DESC);

CREATE INDEX IF NOT EXISTS email_health_snapshots_stale_idx
    ON email_health_snapshots (tenant_id, computed_at);

-- campaign_replies previously indexed campaign/subscriber ids, but the health
-- resolver is deliberately address-scoped and accepts addresses not yet tied
-- to a subscriber. Keep the <=1000 batch read bounded within the tenant.
CREATE INDEX IF NOT EXISTS campaign_replies_email_health_idx
    ON campaign_replies (tenant_id, lower(recipient_email::text), received_at DESC)
    WHERE classification = 'human_reply';

COMMENT ON TABLE email_health_snapshots IS
    'Derived, tenant-scoped postwave-email-health-v1 recipient grade snapshots; consent and active suppression remain authoritative through hard_stop.';
COMMENT ON COLUMN email_health_snapshots.evidence IS
    'Public-safe normalized evidence only; never raw vendor or event payloads.';

GRANT SELECT, INSERT, UPDATE, DELETE ON email_health_snapshots TO postwave_app;

ALTER TABLE email_health_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_health_snapshots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON email_health_snapshots;
CREATE POLICY tenant_isolation ON email_health_snapshots
    FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Cross-tenant janitorial access is limited to snapshots past the fixed
-- address-evidence retention window. The worker cannot read or delete live
-- health rows through this policy.
DROP POLICY IF EXISTS email_health_snapshots_worker_retention_select ON email_health_snapshots;
CREATE POLICY email_health_snapshots_worker_retention_select ON email_health_snapshots
    FOR SELECT TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND computed_at <= now() - interval '365 days'
    );

DROP POLICY IF EXISTS email_health_snapshots_worker_retention_delete ON email_health_snapshots;
CREATE POLICY email_health_snapshots_worker_retention_delete ON email_health_snapshots
    FOR DELETE TO postwave_app
    USING (
        current_setting('app.outbox_worker', true) = 'true'
        AND computed_at <= now() - interval '365 days'
    );

COMMIT;
