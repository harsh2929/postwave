// SPDX-License-Identifier: AGPL-3.0-only

package intelligent_retry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
	"github.com/postwave/postwave/apps/api/internal/db"
)

type retryAssuranceFixture struct {
	tenantID, campaignID, revisionID, planID, artifactID, ownerID string
}

type retryRecipientBinding struct {
	contentRevisionID, sendPlanID, runID            string
	attempt                                         int
	artifactSetHash, sourceHash, planHash, decision string
	overrideIDs                                     []string
	boundAt                                         time.Time
}

func retrySQLState(err error) string {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError.Code
	}
	return ""
}

func retryAssurancePools(t *testing.T, ctx context.Context) (*pgxpool.Pool, *db.Pool) {
	t.Helper()
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_TEST_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_APP_TEST_DATABASE_URL"))
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_ASSURANCE_TEST_DATABASE_URL and POSTWAVE_ASSURANCE_APP_TEST_DATABASE_URL are required")
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect intelligent-retry admin database: %v", err)
	}
	t.Cleanup(admin.Close)
	app, err := db.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect intelligent-retry application database: %v", err)
	}
	t.Cleanup(app.Close)
	var role string
	if err := app.QueryRow(ctx, `SELECT current_user`).Scan(&role); err != nil {
		t.Fatalf("read intelligent-retry application role: %v", err)
	}
	if role != "postwave_app" {
		t.Fatalf("application proof role = %q, want postwave_app", role)
	}
	var ready bool
	if err := admin.QueryRow(ctx, `
SELECT to_regclass('public.intelligent_retry_events') IS NOT NULL
   AND to_regclass('public.campaign_assurance_runs') IS NOT NULL
   AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'campaign_recipients'
          AND column_name = 'assurance_override_ids'
   )
   AND (SELECT relforcerowsecurity
          FROM pg_class
         WHERE oid = 'public.intelligent_retry_events'::regclass)
   AND EXISTS (
       SELECT 1 FROM pg_policy
        WHERE polrelid = 'public.intelligent_retry_events'::regclass
          AND polname = 'intelligent_retry_worker_select' AND polpermissive
          AND polcmd = 'r'
   )
	   AND EXISTS (
	       SELECT 1 FROM pg_policy
	        WHERE polrelid = 'public.intelligent_retry_events'::regclass
	          AND polname = 'intelligent_retry_worker_update' AND polpermissive
	          AND polcmd = 'w'
	   )
	   AND EXISTS (
	       SELECT 1 FROM pg_policy
	        WHERE polrelid = 'public.intelligent_retry_events'::regclass
	          AND polname = 'tenant_visible' AND polpermissive
	          AND polcmd = '*'
	   )`).Scan(&ready); err != nil {
		t.Fatalf("inspect intelligent-retry assurance schema: %v", err)
	}
	if !ready {
		t.Fatal("configured database does not have migrations 1920-1924 and 1939")
	}
	return admin, app
}

func seedRetryAssuranceFixture(t *testing.T, ctx context.Context, admin *pgxpool.Pool) retryAssuranceFixture {
	t.Helper()
	fixture := retryAssuranceFixture{
		tenantID: uuid.NewString(), campaignID: uuid.NewString(), revisionID: uuid.NewString(),
		planID: uuid.NewString(), artifactID: uuid.NewString(), ownerID: uuid.NewString(),
	}
	suffix := strings.ReplaceAll(fixture.tenantID, "-", "")[:16]
	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatalf("begin intelligent-retry assurance fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'studio')`, []any{
			fixture.tenantID, "retry-assurance-" + suffix, "Retry Assurance " + suffix,
		}},
		{`INSERT INTO users (id, tenant_id, external_user_id, email, role)
VALUES ($1::uuid, $2::uuid, $3, $4, 'owner')`, []any{
			fixture.ownerID, fixture.tenantID, "retry-owner-" + suffix,
			"retry-owner-" + suffix + "@example.test",
		}},
		{`INSERT INTO campaigns (id, tenant_id, name, subject, body_html, status)
VALUES ($1::uuid, $2::uuid, 'Retry assurance proof', 'Launch Friday',
        '<p>Launch Friday</p>', 'sending')`, []any{fixture.campaignID, fixture.tenantID}},
		{`INSERT INTO campaign_content_revisions (
    id, tenant_id, campaign_id, revision_no, source_mode,
    content_schema_version, subject, semantic_tree, legacy_html,
    fact_contract, variants, locales, tracking_settings, source_hash
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, 1, 'legacy_html',
    1, 'Launch Friday', '[]'::jsonb, '<p>Launch Friday</p>',
    '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, repeat('1', 64)
)`, []any{fixture.revisionID, fixture.tenantID, fixture.campaignID}},
		{`INSERT INTO campaign_send_plans (
    id, tenant_id, campaign_id, content_revision_id, plan_no,
    request_id, request_hash, renderer_version, compiler_version,
    transform_manifest, coverage_manifest, fixture_set_version,
    policy_version, state
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1,
    gen_random_uuid(), repeat('2', 64), 'retry-renderer-v1', 'retry-compiler-v1',
    '{}'::jsonb, '{"scenarios":["base"]}'::jsonb,
    'retry-fixtures-v1', 'retry-plan-policy-v1', 'preparing'
)`, []any{fixture.planID, fixture.tenantID, fixture.campaignID, fixture.revisionID}},
		{`INSERT INTO campaign_render_artifacts (
    id, tenant_id, campaign_id, send_plan_id, scenario_id,
    locale, branch_key, fixture_id, source_hash, html_hash, text_hash,
    mime_structure_hash, outbound_mime_hash, compiler_receipt,
    representation_manifest
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'base',
    'en-US', 'default', 'retry-base', repeat('1', 64), repeat('3', 64),
    repeat('4', 64), repeat('5', 64), repeat('6', 64), '{}'::jsonb, '{}'::jsonb
)`, []any{fixture.artifactID, fixture.tenantID, fixture.campaignID, fixture.planID}},
		{`UPDATE campaign_send_plans
   SET state = 'ready', plan_hash = repeat('b', 64), ready_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, []any{fixture.tenantID, fixture.planID}},
	}
	for index, statement := range statements {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatalf("seed intelligent-retry assurance fixture statement %d: %v", index+1, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit intelligent-retry assurance fixture: %v", err)
	}
	return fixture
}

func createRetryOverrideReceipt(
	t *testing.T,
	ctx context.Context,
	admin *pgxpool.Pool,
	fixture retryAssuranceFixture,
) campaignassurancegate.Receipt {
	t.Helper()
	repo := campaignassurance.NewRepo(admin)
	run, err := repo.CreateRun(ctx, fixture.tenantID, campaignassurance.CreateRunInput{
		CampaignID: fixture.campaignID, ContentRevisionID: fixture.revisionID,
		SendPlanID: fixture.planID, RequestID: uuid.NewString(),
		TriggerKind: campaignassurance.TriggerQueue, Profile: campaignassurance.ProfileFast,
		AnalyzerSuiteVersion: "retry-proof-suite-v1", ModelSuiteVersion: "none-v1",
		PromptSuiteVersion: "none-v1", PromptSuiteHash: strings.Repeat("c", 64),
		NormalizationVersion: "retry-normalization-v1", ScoringVersion: "retry-score-v1",
		GatePolicyVersion: "retry-gate-v1", MethodologyVersion: "retry-methodology-v1",
		Configurations: []campaignassurance.ConfigurationInput{{
			ID: "deterministic.retry", SourceClass: campaignassurance.SourceDeterministic,
			Configuration: json.RawMessage(`{"checks":["primary_action","deadline"]}`),
		}},
		Targets: []campaignassurance.TargetInput{{
			ArtifactID: fixture.artifactID, ConfigurationID: "deterministic.retry",
		}},
	})
	if err != nil {
		t.Fatalf("create intelligent-retry assurance run: %v", err)
	}
	claim, err := repo.ClaimRun(ctx, fixture.tenantID, run.ID, "retry-proof-worker", time.Minute)
	if err != nil || claim.Run.ClaimToken == nil || len(claim.Targets) != 1 {
		t.Fatalf("claim intelligent-retry assurance run: %+v err=%v", claim, err)
	}
	target := claim.Targets[0]
	extraction, err := repo.RecordExtraction(ctx, fixture.tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, campaignassurance.ExtractionInput{
			ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
			SourceClass: target.SourceClass, ConfigurationHash: target.ConfigurationHash,
			OutboundMIMEHash: target.OutboundMIMEHash, Status: campaignassurance.ExtractionComplete,
			NormalizedExtraction: json.RawMessage(`{"summary":"Launch Friday"}`),
			EvidenceManifest:     json.RawMessage(`{"representations":["mime"]}`),
			UnsupportedClaims:    json.RawMessage(`[]`), Ambiguities: json.RawMessage(`[]`),
		})
	if err != nil {
		t.Fatalf("record intelligent-retry assurance extraction: %v", err)
	}
	base := campaignassurance.FindingInput{
		ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
		ExtractionID: extraction.ID, SourceClass: campaignassurance.SourceDeterministic,
		Severity: "critical", Blocking: true, Overridable: true,
		BlockReferences: json.RawMessage(`[]`), EvidenceReferences: json.RawMessage(`["mime"]`),
		Explanation:     "The compiled message requires a governed exception.",
		Remediation:     json.RawMessage(`{"kind":"edit_campaign"}`),
		DetectorVersion: "retry-detector-v1", PolicyVersion: "retry-gate-v1",
	}
	base.Code, base.Dimension = "PRIMARY_ACTION_MISSING", "primary_action"
	first, err := repo.RecordFinding(ctx, fixture.tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, base)
	if err != nil {
		t.Fatalf("record first intelligent-retry blocker: %v", err)
	}
	base.Code, base.Dimension = "DEADLINE_AMBIGUOUS", "deadline"
	second, err := repo.RecordFinding(ctx, fixture.tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, base)
	if err != nil {
		t.Fatalf("record second intelligent-retry blocker: %v", err)
	}
	if _, err := repo.FinalizeRun(ctx, fixture.tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount,
		campaignassurance.FinalizeInput{GateDecision: campaignassurance.GateBlock}); err != nil {
		t.Fatalf("finalize intelligent-retry blocked run: %v", err)
	}
	for _, finding := range []*campaignassurance.Finding{first, second} {
		if _, err := repo.CreateOverride(ctx, fixture.tenantID, run.ID, fixture.ownerID,
			campaignassurance.OverrideInput{
				FindingID: finding.ID, RequestID: uuid.NewString(), Decision: "allow_send",
				Reason: "Governed exception for intelligent-retry binding propagation proof.",
			}); err != nil {
			t.Fatalf("create intelligent-retry blocker override: %v", err)
		}
	}
	receipt, err := (&campaignassurancegate.Gate{Store: repo}).Authorize(ctx,
		campaignassurancegate.Request{
			TenantID: fixture.tenantID, CampaignID: fixture.campaignID,
			ContentRevisionID: fixture.revisionID, SourceHash: strings.Repeat("1", 64),
		})
	if err != nil {
		t.Fatalf("authorize intelligent-retry complete waiver set: %v", err)
	}
	if receipt.Decision != "overridden" || len(receipt.OverrideIDs) != 2 ||
		!slices.IsSorted(receipt.OverrideIDs) {
		t.Fatalf("intelligent-retry receipt = %+v, want sorted complete two-waiver set", receipt)
	}
	return receipt
}

func scanRetryRecipientBinding(row interface{ Scan(...any) error }) (retryRecipientBinding, error) {
	var binding retryRecipientBinding
	err := row.Scan(
		&binding.contentRevisionID, &binding.sendPlanID, &binding.runID, &binding.attempt,
		&binding.artifactSetHash, &binding.sourceHash, &binding.planHash, &binding.decision,
		&binding.overrideIDs, &binding.boundAt,
	)
	return binding, err
}

func TestPromoteDuePreservesExactCompleteAssuranceBindingRestrictedRole_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	admin, app := retryAssurancePools(t, ctx)
	fixture := seedRetryAssuranceFixture(t, ctx, admin)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, fixture.tenantID)
	})
	receipt := createRetryOverrideReceipt(t, ctx, admin, fixture)

	sourceEmail := "retry-source-" + strings.ReplaceAll(fixture.tenantID, "-", "")[:12] + "@example.test"
	retryEmail := "retry-destination-" + strings.ReplaceAll(fixture.tenantID, "-", "")[:12] + "@example.test"
	if _, err := admin.Exec(ctx, `
INSERT INTO subscribers (
    tenant_id, email, status, consent_source, frequency_preference
)
VALUES ($1::uuid, $2, 'enabled', 'single_optin', 'default')
ON CONFLICT (tenant_id, email) DO UPDATE
   SET frequency_preference = 'default', paused_until = NULL`,
		fixture.tenantID, retryEmail); err != nil {
		t.Fatalf("insert retry subscriber preference authority: %v", err)
	}
	if _, err := admin.Exec(ctx, `
INSERT INTO campaign_recipients (
    campaign_id, tenant_id, subscriber_email, status,
    content_revision_id, send_plan_id, assurance_run_id,
    assurance_attempt_count, assurance_artifact_set_hash,
    assurance_source_hash, assurance_plan_hash, assurance_gate_decision,
    assurance_override_ids, assurance_bound_at
)
VALUES (
    $1::uuid, $2::uuid, $3, 'pending',
    $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10, $11,
    $12::uuid[], $13
)`, fixture.campaignID, fixture.tenantID, sourceEmail,
		receipt.ContentRevisionID, receipt.SendPlanID, receipt.RunID, receipt.RunAttempt,
		receipt.ArtifactSetHash, receipt.SourceHash, receipt.PlanHash, receipt.Decision,
		receipt.OverrideIDs, receipt.AuthorizedAt); err != nil {
		t.Fatalf("insert canonical retry source binding: %v", err)
	}

	queue := &Queue{
		Pool: app,
		Frequency: func(_ context.Context, _, _ string, candidates []string) ([]string, error) {
			return candidates, nil
		},
		SubscriberPreference: func(_ context.Context, _ string, candidates []string) ([]string, error) {
			return candidates, nil
		},
	}
	if err := queue.EnqueueFrequencySkipped(ctx, fixture.tenantID, fixture.campaignID,
		[]string{retryEmail}, []Breakdown{{RuleID: "frequency_cap", Skipped: 1}},
		time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("enqueue restricted-role intelligent retry: %v", err)
	}
	var eventID string
	if err := admin.QueryRow(ctx, `
SELECT id::text FROM intelligent_retry_events
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND subscriber_email = $3::citext`, fixture.tenantID, fixture.campaignID, retryEmail).Scan(&eventID); err != nil {
		t.Fatalf("read intelligent-retry event identity: %v", err)
	}

	// Neither an unscoped connection nor a different tenant scope may discover
	// the event. The only cross-tenant window is the transaction-local worker
	// claim below.
	var visible int
	if err := app.QueryRow(ctx, `
SELECT count(*) FROM intelligent_retry_events WHERE id = $1::uuid`, eventID).Scan(&visible); err != nil {
		t.Fatalf("read unscoped intelligent-retry visibility: %v", err)
	}
	if visible != 0 {
		t.Fatalf("unscoped postwave_app saw %d intelligent-retry rows, want 0", visible)
	}
	foreignTx, err := db.WithTenant(ctx, app, uuid.NewString())
	if err != nil {
		t.Fatalf("begin foreign intelligent-retry tenant scope: %v", err)
	}
	if err := foreignTx.QueryRow(ctx, `
SELECT count(*) FROM intelligent_retry_events WHERE id = $1::uuid`, eventID).Scan(&visible); err != nil {
		_ = foreignTx.Rollback(ctx)
		t.Fatalf("read foreign intelligent-retry visibility: %v", err)
	}
	_ = foreignTx.Rollback(ctx)
	if visible != 0 {
		t.Fatalf("foreign tenant saw %d intelligent-retry rows, want 0", visible)
	}

	// The generic outbox capability is deliberately insufficient. Only the
	// intelligent-retry claim path sets the second, dedicated capability.
	genericWorkerTx, err := db.WithWorkerScope(ctx, app)
	if err != nil {
		t.Fatalf("begin generic worker isolation proof: %v", err)
	}
	if err := genericWorkerTx.QueryRow(ctx, `
SELECT count(*) FROM intelligent_retry_events WHERE id = $1::uuid`, eventID).Scan(&visible); err != nil {
		_ = genericWorkerTx.Rollback(ctx)
		t.Fatalf("read generic worker intelligent-retry visibility: %v", err)
	}
	if visible != 0 {
		_ = genericWorkerTx.Rollback(ctx)
		t.Fatalf("generic outbox worker saw %d intelligent-retry rows, want 0", visible)
	}
	genericUpdate, err := genericWorkerTx.Exec(ctx, `
UPDATE intelligent_retry_events SET updated_at = now() WHERE id = $1::uuid`, eventID)
	if err != nil {
		_ = genericWorkerTx.Rollback(ctx)
		t.Fatalf("generic worker intelligent-retry update proof: %v", err)
	}
	_ = genericWorkerTx.Rollback(ctx)
	if genericUpdate.RowsAffected() != 0 {
		t.Fatalf("generic outbox worker updated %d intelligent-retry rows, want 0",
			genericUpdate.RowsAffected())
	}

	// Migration 1939 grants the dedicated worker SELECT/UPDATE only. Even with
	// both capabilities it must not become a cross-tenant INSERT or DELETE
	// capability.
	insertTx, err := db.WithWorkerScope(ctx, app)
	if err != nil {
		t.Fatalf("begin intelligent-retry worker insert proof: %v", err)
	}
	if _, err := insertTx.Exec(ctx,
		`SELECT set_config('app.intelligent_retry_worker', 'true', true)`); err != nil {
		_ = insertTx.Rollback(ctx)
		t.Fatalf("set dedicated intelligent-retry worker insert scope: %v", err)
	}
	_, insertErr := insertTx.Exec(ctx, `
INSERT INTO intelligent_retry_events (tenant_id, campaign_id, subscriber_email, retry_after)
VALUES ($1::uuid, $2::uuid, $3, now())`, fixture.tenantID, fixture.campaignID,
		"worker-insert-denied-"+strings.ReplaceAll(fixture.tenantID, "-", "")[:12]+"@example.test")
	_ = insertTx.Rollback(ctx)
	if insertErr == nil || retrySQLState(insertErr) != "42501" {
		t.Fatalf("worker-only insert error=%v sqlstate=%q, want RLS 42501", insertErr, retrySQLState(insertErr))
	}
	deleteTx, err := db.WithWorkerScope(ctx, app)
	if err != nil {
		t.Fatalf("begin intelligent-retry worker delete proof: %v", err)
	}
	if _, err := deleteTx.Exec(ctx,
		`SELECT set_config('app.intelligent_retry_worker', 'true', true)`); err != nil {
		_ = deleteTx.Rollback(ctx)
		t.Fatalf("set dedicated intelligent-retry worker delete scope: %v", err)
	}
	result, err := deleteTx.Exec(ctx, `
DELETE FROM intelligent_retry_events WHERE id = $1::uuid`, eventID)
	if err != nil {
		_ = deleteTx.Rollback(ctx)
		t.Fatalf("worker-only delete proof: %v", err)
	}
	_ = deleteTx.Rollback(ctx)
	if result.RowsAffected() != 0 {
		t.Fatalf("worker-only delete affected %d rows, want 0", result.RowsAffected())
	}

	promoted, err := queue.PromoteDue(ctx, 1)
	if err != nil || promoted != 1 {
		t.Fatalf("restricted-role intelligent-retry promotion=%d err=%v, want 1", promoted, err)
	}
	const bindingQuery = `
SELECT content_revision_id::text, send_plan_id::text, assurance_run_id::text,
       assurance_attempt_count, assurance_artifact_set_hash,
       assurance_source_hash, assurance_plan_hash, assurance_gate_decision,
       assurance_override_ids::text[], assurance_bound_at
  FROM campaign_recipients
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND subscriber_email = $3::citext`
	source, err := scanRetryRecipientBinding(admin.QueryRow(ctx, bindingQuery,
		fixture.tenantID, fixture.campaignID, sourceEmail))
	if err != nil {
		t.Fatalf("read canonical retry source binding: %v", err)
	}
	destination, err := scanRetryRecipientBinding(admin.QueryRow(ctx, bindingQuery,
		fixture.tenantID, fixture.campaignID, retryEmail))
	if err != nil {
		t.Fatalf("read promoted retry destination binding: %v", err)
	}
	if fmt.Sprintf("%+v", destination) != fmt.Sprintf("%+v", source) {
		t.Fatalf("promoted assurance binding = %+v, want exact source %+v", destination, source)
	}
	if destination.runID != receipt.RunID || destination.decision != "overridden" ||
		!slices.Equal(destination.overrideIDs, receipt.OverrideIDs) {
		t.Fatalf("promoted receipt = %+v, want run=%s overrides=%v",
			destination, receipt.RunID, receipt.OverrideIDs)
	}
	var ledgerRows int
	if err := admin.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_send_log
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid
   AND subscriber_email = $3::citext AND channel = 'email'`,
		fixture.tenantID, fixture.campaignID, retryEmail).Scan(&ledgerRows); err != nil {
		t.Fatalf("read promoted retry frequency ledger: %v", err)
	}
	if ledgerRows != 1 {
		t.Fatalf("promoted retry frequency ledger rows=%d, want 1", ledgerRows)
	}
	var status string
	var attempts int
	if err := admin.QueryRow(ctx, `
SELECT status, attempts FROM intelligent_retry_events WHERE id = $1::uuid`, eventID).Scan(&status, &attempts); err != nil {
		t.Fatalf("read promoted intelligent-retry lifecycle: %v", err)
	}
	if status != "retried" || attempts != 1 {
		t.Fatalf("intelligent-retry event status=%s attempts=%d, want retried/1", status, attempts)
	}
}
