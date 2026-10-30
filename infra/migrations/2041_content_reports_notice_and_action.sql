-- 2041_content_reports_notice_and_action.sql
--
-- Notice and action for hosted and displayed content.
--
-- WHY. Postwave stores information supplied by recipients of the service —
-- hosted signup forms, landing pages, the public campaign archive and archive
-- comments — which makes it a hosting service under DSA Art. 3(g)(iii), and the
-- archive plus its comments disseminate that information to the public, which
-- additionally makes it an online platform under Art. 3(i). Art. 16 requires a
-- mechanism allowing ANY person to notify us of specific items of allegedly
-- illegal content; Art. 17 requires a statement of reasons to the affected
-- recipient whenever we act; Art. 6 makes the hosting liability exemption
-- conditional on acting expeditiously once we have actual knowledge.
--
-- Nothing of the kind existed. The 2026-09 compliance audit recorded it as
-- DSA-05/06/10, and the same missing control is what fails Apple Guideline 1.2
-- (report and block affordances for user-generated content), Google Play's UGC
-- policy, and Play's generative-AI policy (an in-app way to flag offensive
-- model output). One table, four regimes.
--
-- TENANCY. A DSA notice is addressed to Postwave, not to the customer, and the
-- notifier is a member of the public with no tenant context. So tenant_id is
-- NULLABLE and set only once the reported URL resolves to a tenant's asset.
-- Rows are written through a SECURITY DEFINER function rather than by a
-- tenant-scoped INSERT, because the anonymous path has no app.tenant_id to
-- satisfy a policy with. The customer's SELECT is tenant-fenced as usual, so a
-- customer sees notices about their own content and nothing else; unattributed
-- notices are visible only to the operator plane.
--
-- WHAT actual_knowledge_at IS FOR. Art. 6(1)(b) turns on acting expeditiously
-- "upon obtaining actual knowledge". The instant a notice sufficiently precise
-- and adequately substantiated arrives is the instant the clock starts, and it
-- is set by the database at insert rather than by the application, so it cannot
-- be back-dated by a later write.
--
-- migration-execution: transactional
-- rollback-strategy: no-op
-- rollback-details: The tables and function are additive. An application
-- rollback leaves them unused; do not drop them, because a notice already
-- received is evidence of the date we obtained knowledge.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- content_reports — the Art. 16 notice, and the in-app report that reuses it
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_reports (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Human-quotable receipt. Given to the notifier so they can check the
    -- outcome without an account, which is what makes Art. 16(5) notification
    -- possible for an anonymous reporter.
    reference           text NOT NULL UNIQUE
                        CHECK (reference ~ '^PWR-[0-9A-HJ-NP-Z]{10}$'),

    -- NULL until the reported location resolves to a tenant asset. An
    -- unattributed notice is still a notice and still starts the clock.
    tenant_id           uuid REFERENCES tenants(id) ON DELETE SET NULL,

    -- Where the notice came from. 'public_notice' is the DSA Art. 16 channel;
    -- the others are the in-app affordances the store policies require, and
    -- they are kept in the same table so one moderation queue sees everything.
    origin              text NOT NULL CHECK (origin IN (
                            'public_notice', 'in_app_ugc', 'in_app_ai_output'
                        )),

    -- What is being reported. Deliberately coarse: the operator needs to find
    -- the item, not to classify it before reading it.
    subject_kind        text NOT NULL CHECK (subject_kind IN (
                            'hosted_form', 'landing_page', 'archive_post',
                            'archive_comment', 'inbound_message',
                            'ai_output', 'other'
                        )),
    -- Art. 16(2)(b): the exact electronic location. Stored verbatim so the
    -- operator sees what the notifier saw.
    subject_url         text NOT NULL CHECK (
                            length(subject_url) BETWEEN 1 AND 2048
                        ),
    -- Set for in-app reports where the client knows the row it is reporting.
    subject_ref         text CHECK (subject_ref IS NULL OR length(subject_ref) <= 200),

    -- Art. 16(2)(a): a sufficiently substantiated explanation of why the
    -- content is illegal or objectionable. A minimum length is a CHECK rather
    -- than a client-side hint because "sufficiently substantiated" is the
    -- condition on which actual knowledge turns.
    reason_category     text NOT NULL CHECK (reason_category IN (
                            'illegal_content', 'intellectual_property',
                            'privacy_violation', 'harassment_or_hate',
                            'csam_or_child_safety', 'fraud_or_scam',
                            'spam_or_unsolicited', 'ai_output_harmful', 'other'
                        )),
    explanation         text NOT NULL CHECK (
                            length(btrim(explanation)) BETWEEN 20 AND 10000
                        ),

    -- Art. 16(2)(c): the notifier's name and email, EXCEPT for notices
    -- concerning offences under Articles 3-7 of Directive 2011/93/EU, where the
    -- Regulation expressly does not require them. The CHECK encodes that
    -- exception rather than leaving it to the handler, so a CSAM report can
    -- never be rejected for missing identity.
    notifier_name       text CHECK (notifier_name IS NULL OR length(notifier_name) <= 200),
    notifier_email      text CHECK (notifier_email IS NULL OR length(notifier_email) <= 320),
    CONSTRAINT content_reports_notifier_identity CHECK (
        reason_category = 'csam_or_child_safety'
        OR origin <> 'public_notice'
        OR (notifier_email IS NOT NULL AND length(btrim(notifier_email)) > 0)
    ),

    -- Art. 16(2)(d): the good-faith statement. Recorded as a boolean because
    -- the handler must refuse a notice without it, and a stored NULL would let
    -- a future writer forget.
    good_faith_declared boolean NOT NULL,
    CONSTRAINT content_reports_good_faith CHECK (
        origin <> 'public_notice' OR good_faith_declared
    ),

    -- The reporting user, for in-app reports. NULL for public notices.
    reported_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

    status              text NOT NULL DEFAULT 'received' CHECK (status IN (
                            'received', 'under_review', 'action_taken',
                            'no_action', 'forwarded_to_authority', 'withdrawn'
                        )),

    -- Art. 6(1)(b): when we obtained actual knowledge. Set by the default at
    -- insert; never updated. The expeditiousness of any later action is
    -- measured from here.
    actual_knowledge_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    created_at          timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at          timestamptz NOT NULL DEFAULT statement_timestamp()
);

COMMENT ON TABLE content_reports IS
    'DSA Art. 16 notice-and-action reports plus the in-app UGC/AI reports required by Apple Guideline 1.2 and Google Play UGC and generative-AI policies. tenant_id is NULL until the reported location resolves to a tenant asset.';
COMMENT ON COLUMN content_reports.actual_knowledge_at IS
    'DSA Art. 6(1)(b) clock start. Database-set at insert and never updated: the expeditiousness of a takedown is measured from it, so it must not be writable after the fact.';

CREATE INDEX IF NOT EXISTS content_reports_open_queue_idx
    ON content_reports (status, actual_knowledge_at)
    WHERE status IN ('received', 'under_review');
CREATE INDEX IF NOT EXISTS content_reports_tenant_idx
    ON content_reports (tenant_id, created_at DESC)
    WHERE tenant_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- content_report_decisions — the Art. 17 statement of reasons
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS content_report_decisions (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id             uuid NOT NULL REFERENCES content_reports(id) ON DELETE CASCADE,
    tenant_id             uuid REFERENCES tenants(id) ON DELETE SET NULL,

    -- Art. 17(1): the restriction imposed.
    action                text NOT NULL CHECK (action IN (
                              'content_removed', 'content_disabled',
                              'visibility_restricted', 'account_suspended',
                              'account_terminated', 'no_action'
                          )),
    -- Art. 17(3)(d): the legal ground or the contractual ground relied on.
    ground                text NOT NULL CHECK (ground IN (
                              'illegal_content', 'terms_violation'
                          )),
    -- Art. 17(3)(e): the facts and circumstances relied on.
    reasoning             text NOT NULL CHECK (
                              length(btrim(reasoning)) BETWEEN 20 AND 10000
                          ),
    -- Art. 17(3)(c): whether automated means were used, disclosed to the
    -- recipient. Defaulting to false would let an automated decision go out
    -- undisclosed, so it is NOT NULL with no default.
    automated_means_used  boolean NOT NULL,

    decided_by_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_at            timestamptz NOT NULL DEFAULT statement_timestamp(),

    -- Art. 17(1) requires the statement to reach the affected RECIPIENT (the
    -- customer whose content it was), and Art. 16(5) requires the outcome to
    -- reach the NOTIFIER. Recorded separately because they are two duties and
    -- discharging one is not discharging the other.
    recipient_notified_at timestamptz,
    notifier_notified_at  timestamptz,

    CONSTRAINT content_report_decisions_one_per_report UNIQUE (report_id)
);

COMMENT ON TABLE content_report_decisions IS
    'DSA Art. 17 statements of reasons. One per report; automated_means_used is NOT NULL with no default so an automated decision cannot ship undisclosed.';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE content_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE content_report_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_report_decisions FORCE ROW LEVEL SECURITY;

-- A customer sees notices about their own content. Unattributed notices
-- (tenant_id IS NULL) are deliberately NOT visible to any tenant: before the
-- URL resolves we do not know whose content it is, and showing an unresolved
-- notice to a guess would leak a third party's complaint.
DROP POLICY IF EXISTS content_reports_tenant_select ON content_reports;
CREATE POLICY content_reports_tenant_select
    ON content_reports
    FOR SELECT TO postwave_app
    USING (
        tenant_id IS NOT NULL
        AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

-- An authenticated in-app report is written under the reporter's tenant.
-- Public notices do not travel this path; they go through the definer function
-- below, which is the only way a row with a NULL tenant_id can be created.
DROP POLICY IF EXISTS content_reports_tenant_insert ON content_reports;
CREATE POLICY content_reports_tenant_insert
    ON content_reports
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id IS NOT NULL
        AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND origin IN ('in_app_ugc', 'in_app_ai_output')
    );

DROP POLICY IF EXISTS content_reports_tenant_update ON content_reports;
CREATE POLICY content_reports_tenant_update
    ON content_reports
    FOR UPDATE TO postwave_app
    USING (
        tenant_id IS NOT NULL
        AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id IS NOT NULL
        AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

DROP POLICY IF EXISTS content_report_decisions_tenant_select ON content_report_decisions;
CREATE POLICY content_report_decisions_tenant_select
    ON content_report_decisions
    FOR SELECT TO postwave_app
    USING (
        tenant_id IS NOT NULL
        AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

DROP POLICY IF EXISTS content_report_decisions_tenant_insert ON content_report_decisions;
CREATE POLICY content_report_decisions_tenant_insert
    ON content_report_decisions
    FOR INSERT TO postwave_app
    WITH CHECK (
        tenant_id IS NOT NULL
        AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

-- DELETE is deliberately withheld from postwave_app on both tables. A received
-- notice is the evidence of WHEN we obtained actual knowledge, and the Art. 6
-- liability exemption turns on the interval between that instant and our
-- response; an application path that could delete it could destroy the record
-- of its own lateness. A statement of reasons is a communication already sent.
--
-- OPEN FOLLOW-UP (recorded rather than half-built): a notice carries the
-- notifier's name and email, so GDPR Art. 5(1)(e) storage limitation applies to
-- it. The right answer is a retention sweep in internal/retention that redacts
-- the notifier identity after a defined window while keeping the notice, its
-- timestamps and its decision — the same shape as the reply-identity erasure in
-- migration 1974. Until that exists these rows are retained indefinitely, which
-- is why this is written down here instead of being left for someone to notice.
REVOKE ALL ON content_reports FROM PUBLIC, postwave_app;
GRANT SELECT, INSERT, UPDATE ON content_reports TO postwave_app;
REVOKE ALL ON content_report_decisions FROM PUBLIC, postwave_app;
GRANT SELECT, INSERT ON content_report_decisions TO postwave_app;

-- ---------------------------------------------------------------------------
-- record_public_content_report — the anonymous Art. 16 intake
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER because the caller is a member of the public with no tenant
-- context, so no RLS policy can admit their INSERT. The function is the whole
-- of the widened privilege: it accepts only origin='public_notice', it cannot
-- read any existing row, and it returns nothing but the receipt reference.
--
-- pg_temp is LAST in search_path. Omitting it lets a caller create a temporary
-- object that shadows an unqualified name inside the definer's identity, which
-- is an privilege-escalation route rather than a style preference (see
-- migration 1915 and the live-catalogue guard test).
CREATE OR REPLACE FUNCTION public.record_public_content_report(
    p_reference           text,
    p_tenant_id           uuid,
    p_subject_kind        text,
    p_subject_url         text,
    p_reason_category     text,
    p_explanation         text,
    p_notifier_name       text,
    p_notifier_email      text,
    p_good_faith_declared boolean
) RETURNS TABLE (reference text, actual_knowledge_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    INSERT INTO public.content_reports (
        reference, tenant_id, origin, subject_kind, subject_url,
        reason_category, explanation, notifier_name, notifier_email,
        good_faith_declared
    ) VALUES (
        p_reference, p_tenant_id, 'public_notice', p_subject_kind, p_subject_url,
        p_reason_category, p_explanation,
        NULLIF(btrim(p_notifier_name), ''), NULLIF(btrim(p_notifier_email), ''),
        p_good_faith_declared
    )
    RETURNING content_reports.reference, content_reports.actual_knowledge_at;
$$;

REVOKE ALL ON FUNCTION public.record_public_content_report(
    text, uuid, text, text, text, text, text, text, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_public_content_report(
    text, uuid, text, text, text, text, text, text, boolean
) TO postwave_app;

-- ---------------------------------------------------------------------------
-- public_content_report_status — the anonymous outcome lookup (Art. 16(5))
-- ---------------------------------------------------------------------------

-- Returns only what the notifier is entitled to: their own receipt's status and
-- the reasoning behind any decision. Never the tenant, never the URL of a
-- different report, never another notifier's identity. Definer again because
-- the notifier has no tenant context; narrow because a receipt reference is a
-- capability and capabilities leak.
CREATE OR REPLACE FUNCTION public.public_content_report_status(p_reference text)
RETURNS TABLE (
    status              text,
    actual_knowledge_at timestamptz,
    decision_action     text,
    decision_reasoning  text,
    decided_at          timestamptz,
    automated_means_used boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT r.status,
           r.actual_knowledge_at,
           d.action,
           d.reasoning,
           d.decided_at,
           d.automated_means_used
      FROM public.content_reports r
      LEFT JOIN public.content_report_decisions d ON d.report_id = r.id
     WHERE r.reference = p_reference;
$$;

REVOKE ALL ON FUNCTION public.public_content_report_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_content_report_status(text) TO postwave_app;

COMMIT;
