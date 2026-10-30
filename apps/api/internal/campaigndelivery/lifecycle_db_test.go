// SPDX-License-Identifier: AGPL-3.0-only

package campaigndelivery

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
	"github.com/postwave/postwave/apps/api/internal/campaigntransport"
	canonicalreplies "github.com/postwave/postwave/apps/api/internal/replies"
	"github.com/postwave/postwave/apps/api/internal/replycorrelation"
)

func campaignDeliveryDBPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("POSTWAVE_CAMPAIGN_DELIVERY_TEST_DATABASE_URL"))
	if url == "" {
		t.Skip("POSTWAVE_CAMPAIGN_DELIVERY_TEST_DATABASE_URL is required for raw-delivery DB proof")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect raw-delivery test database: %v", err)
	}
	t.Cleanup(pool.Close)
	var ready bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.campaign_assurance_runs') IS NOT NULL
   AND to_regclass('public.campaign_send_deliveries') IS NOT NULL
   AND to_regclass('public.campaign_send_delivery_events') IS NOT NULL
   AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'campaign_recipients'
          AND column_name = 'assurance_run_id'
   )
   AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'campaign_send_deliveries'
          AND column_name = 'gate_override_ids'
   )`).Scan(&ready); err != nil {
		t.Fatalf("inspect raw-delivery schema: %v", err)
	}
	if !ready {
		t.Fatal("configured database does not have migrations 1920 through 1924")
	}
	return pool
}

func deliverySQLState(err error) string {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError.Code
	}
	return ""
}

type deliveryDBFixture struct {
	tenantID, campaignID, revisionID, planID, artifactID string
	ownerID                                              string
	recipientID                                          int64
}

func seedDeliveryDBFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) deliveryDBFixture {
	t.Helper()
	fixture := deliveryDBFixture{
		tenantID: uuid.NewString(), campaignID: uuid.NewString(),
		revisionID: uuid.NewString(), planID: uuid.NewString(), artifactID: uuid.NewString(),
		ownerID: uuid.NewString(),
	}
	suffix := strings.ReplaceAll(fixture.tenantID, "-", "")[:16]
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin raw-delivery fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'studio')`, []any{
			fixture.tenantID, "raw-delivery-db-" + suffix, "Raw Delivery DB " + suffix,
		}},
		{`INSERT INTO users (id, tenant_id, external_user_id, email, role)
VALUES ($1::uuid, $2::uuid, $3, $4, 'owner')`, []any{
			fixture.ownerID, fixture.tenantID, "raw-delivery-owner-" + suffix,
			"raw-delivery-owner-" + suffix + "@example.test",
		}},
		{`INSERT INTO campaigns (id, tenant_id, name, subject, body_html)
VALUES ($1::uuid, $2::uuid, 'Raw delivery DB proof', 'Launch Friday', '<p>Launch Friday</p>')`, []any{
			fixture.campaignID, fixture.tenantID,
		}},
		{`INSERT INTO campaign_content_revisions (
    id, tenant_id, campaign_id, revision_no, source_mode,
    content_schema_version, subject, semantic_tree, legacy_html,
    fact_contract, variants, locales, source_hash
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, 1, 'legacy_html',
    1, 'Launch Friday', '[]'::jsonb, '<p>Launch Friday</p>',
    '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, repeat('1', 64)
)`, []any{fixture.revisionID, fixture.tenantID, fixture.campaignID}},
		{`INSERT INTO campaign_send_plans (
    id, tenant_id, campaign_id, content_revision_id, plan_no,
    request_id, request_hash, renderer_version, compiler_version,
    transform_manifest, coverage_manifest, fixture_set_version,
    policy_version, state
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1,
    gen_random_uuid(), repeat('2', 64), 'renderer-v1', 'compiler-v1',
    '{}'::jsonb, '{"scenarios":["base"]}'::jsonb,
    'fixtures-v1', 'plan-policy-v1', 'preparing'
)`, []any{fixture.planID, fixture.tenantID, fixture.campaignID, fixture.revisionID}},
		{`INSERT INTO campaign_render_artifacts (
    id, tenant_id, campaign_id, send_plan_id, scenario_id,
    locale, branch_key, fixture_id, source_hash, html_hash, text_hash,
    mime_structure_hash, outbound_mime_hash, compiler_receipt,
    representation_manifest
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'base',
    'en-US', 'default', 'fixture-base', repeat('1', 64), repeat('3', 64),
    repeat('4', 64), repeat('5', 64), repeat('6', 64), '{}'::jsonb, '{}'::jsonb
)`, []any{fixture.artifactID, fixture.tenantID, fixture.campaignID, fixture.planID}},
		{`UPDATE campaign_send_plans
   SET state = 'ready', plan_hash = repeat('b', 64), ready_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, []any{fixture.tenantID, fixture.planID}},
	}
	for index, statement := range statements {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatalf("seed raw-delivery fixture statement %d: %v", index+1, err)
		}
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO campaign_recipients (tenant_id, campaign_id, subscriber_email)
VALUES ($1::uuid, $2::uuid, $3) RETURNING id`, fixture.tenantID,
		fixture.campaignID, "recipient-"+suffix+"@example.test").Scan(&fixture.recipientID); err != nil {
		t.Fatalf("seed campaign recipient: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit raw-delivery fixture: %v", err)
	}
	return fixture
}

func createPassingAssuranceRun(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	fixture deliveryDBFixture,
) campaignassurance.Run {
	t.Helper()
	assuranceRepo := campaignassurance.NewRepo(pool)
	input := campaignassurance.CreateRunInput{
		CampaignID: fixture.campaignID, ContentRevisionID: fixture.revisionID,
		SendPlanID: fixture.planID, RequestID: uuid.NewString(),
		TriggerKind: campaignassurance.TriggerQueue, Profile: campaignassurance.ProfileFast,
		AnalyzerSuiteVersion: "delivery-proof-suite-v1", ModelSuiteVersion: "none-v1",
		PromptSuiteVersion: "none-v1", PromptSuiteHash: strings.Repeat("c", 64),
		NormalizationVersion: "normalization-v1", ScoringVersion: "score-v1",
		GatePolicyVersion: "gate-v1", MethodologyVersion: "methodology-v1",
		Configurations: []campaignassurance.ConfigurationInput{{
			ID: "deterministic.mime", SourceClass: campaignassurance.SourceDeterministic,
			Configuration: json.RawMessage(`{"checks":["mime"]}`),
		}},
		Targets: []campaignassurance.TargetInput{{
			ArtifactID: fixture.artifactID, ConfigurationID: "deterministic.mime",
		}},
	}
	run, err := assuranceRepo.CreateRun(ctx, fixture.tenantID, input)
	if err != nil {
		t.Fatalf("create passing assurance run: %v", err)
	}
	claim, err := assuranceRepo.ClaimRun(ctx, fixture.tenantID, run.ID,
		"raw-delivery-assurance-worker", time.Minute)
	if err != nil {
		t.Fatalf("claim passing assurance run: %v", err)
	}
	if len(claim.Targets) != 1 || claim.Run.ClaimToken == nil {
		t.Fatalf("unexpected assurance target receipt: %+v", claim)
	}
	target := claim.Targets[0]
	_, err = assuranceRepo.RecordExtraction(ctx, fixture.tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, campaignassurance.ExtractionInput{
			ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
			SourceClass: target.SourceClass, ConfigurationHash: target.ConfigurationHash,
			OutboundMIMEHash: target.OutboundMIMEHash, Status: campaignassurance.ExtractionComplete,
			NormalizedExtraction: json.RawMessage(`{"summary":"Launch Friday"}`),
			EvidenceManifest:     json.RawMessage(`{"representations":["mime"]}`),
			UnsupportedClaims:    json.RawMessage(`[]`), Ambiguities: json.RawMessage(`[]`),
			LatencyMS: 1,
		})
	if err != nil {
		t.Fatalf("record passing extraction: %v", err)
	}
	overall := 100.0
	agreement := 1.0
	completed, err := assuranceRepo.FinalizeRun(ctx, fixture.tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, campaignassurance.FinalizeInput{
			ComponentScores: json.RawMessage(`{"deterministic":100}`),
			OverallScore:    &overall, ScoreMin: &overall, ScoreMax: &overall,
			Agreement: &agreement, GateDecision: campaignassurance.GatePass,
		})
	if err != nil {
		t.Fatalf("finalize passing assurance run: %v", err)
	}
	return *completed
}

func createTwoBlockerRun(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	fixture deliveryDBFixture,
	secondOverridable bool,
) (campaignassurance.Run, campaignassurance.Finding, campaignassurance.Finding) {
	t.Helper()
	repo := campaignassurance.NewRepo(pool)
	input := campaignassurance.CreateRunInput{
		CampaignID: fixture.campaignID, ContentRevisionID: fixture.revisionID,
		SendPlanID: fixture.planID, RequestID: uuid.NewString(),
		TriggerKind: campaignassurance.TriggerQueue, Profile: campaignassurance.ProfileFast,
		AnalyzerSuiteVersion: "delivery-blocker-proof-suite-v1", ModelSuiteVersion: "none-v1",
		PromptSuiteVersion: "none-v1", PromptSuiteHash: strings.Repeat("d", 64),
		NormalizationVersion: "normalization-v1", ScoringVersion: "score-v1",
		GatePolicyVersion: "gate-v1", MethodologyVersion: "methodology-v1",
		Configurations: []campaignassurance.ConfigurationInput{{
			ID: "deterministic.mime", SourceClass: campaignassurance.SourceDeterministic,
			Configuration: json.RawMessage(`{"checks":["mime"]}`),
		}},
		Targets: []campaignassurance.TargetInput{{
			ArtifactID: fixture.artifactID, ConfigurationID: "deterministic.mime",
		}},
	}
	run, err := repo.CreateRun(ctx, fixture.tenantID, input)
	if err != nil {
		t.Fatalf("create blocked assurance run: %v", err)
	}
	claim, err := repo.ClaimRun(ctx, fixture.tenantID, run.ID,
		"raw-delivery-blocker-proof-worker", time.Minute)
	if err != nil || len(claim.Targets) != 1 || claim.Run.ClaimToken == nil {
		t.Fatalf("claim blocked assurance run: %+v err=%v", claim, err)
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
			LatencyMS: 1,
		})
	if err != nil {
		t.Fatalf("record blocked-run extraction: %v", err)
	}
	baseFinding := campaignassurance.FindingInput{
		ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
		ExtractionID: extraction.ID, SourceClass: target.SourceClass,
		Severity: "critical", Blocking: true, Overridable: true,
		Dimension: "primary_action", BlockReferences: json.RawMessage(`[]`),
		EvidenceReferences: json.RawMessage(`["mime"]`),
		Explanation:        "The primary action is not recoverable from the compiled message.",
		Remediation:        json.RawMessage(`{"kind":"add_action"}`),
		DetectorVersion:    "detector-v1", PolicyVersion: "gate-v1",
	}
	baseFinding.Code = "PRIMARY_ACTION_MISSING"
	waivedFinding, err := repo.RecordFinding(ctx, fixture.tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, baseFinding)
	if err != nil {
		t.Fatalf("record overridable blocker: %v", err)
	}
	unresolvedFinding := baseFinding
	unresolvedFinding.Code = "INVALID_MIME"
	unresolvedFinding.Overridable = secondOverridable
	unresolvedFinding.Dimension = "mime_structure"
	unresolvedFinding.Explanation = "The MIME structure is invalid and cannot be waived."
	secondFinding, err := repo.RecordFinding(ctx, fixture.tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, unresolvedFinding)
	if err != nil {
		t.Fatalf("record unresolved blocker: %v", err)
	}
	min, max, overall, agreement := 60.0, 80.0, 70.0, 0.75
	completed, err := repo.FinalizeRun(ctx, fixture.tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, campaignassurance.FinalizeInput{
			ComponentScores: json.RawMessage(`{"intent":70}`), OverallScore: &overall,
			ScoreMin: &min, ScoreMax: &max, Agreement: &agreement,
			GateDecision: campaignassurance.GateBlock,
		})
	if err != nil {
		t.Fatalf("finalize blocked assurance run: %v", err)
	}
	return *completed, *waivedFinding, *secondFinding
}

func createPartiallyOverriddenBlockedRun(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	fixture deliveryDBFixture,
) (campaignassurance.Run, campaignassurance.Override) {
	t.Helper()
	run, waivedFinding, _ := createTwoBlockerRun(t, ctx, pool, fixture, false)
	repo := campaignassurance.NewRepo(pool)
	override, err := repo.CreateOverride(ctx, fixture.tenantID, run.ID, fixture.ownerID,
		campaignassurance.OverrideInput{
			FindingID: waivedFinding.ID, RequestID: uuid.NewString(), Decision: "allow_send",
			Reason: "Waive only the recoverable primary-action blocker for this proof.",
		})
	if err != nil {
		t.Fatalf("create partial blocker override: %v", err)
	}
	return run, *override
}

func deliveryAttemptFor(fixture deliveryDBFixture, run campaignassurance.Run) AttemptInput {
	input := AttemptInput{
		TenantID: fixture.tenantID, CampaignID: fixture.campaignID,
		CampaignRecipientID: fixture.recipientID, SendPlanID: fixture.planID,
		ArtifactID: fixture.artifactID, AssuranceRunID: run.ID,
		AssuranceAttemptCount: run.AttemptCount, ArtifactSetHash: run.ArtifactSetHash,
		GateDecision: GatePass, ScenarioID: "base", SourceHash: run.SourceHash,
		PlanHash: run.PlanHash, CompilerVersion: run.CompilerVersion,
		OutboundMIMEHash: strings.Repeat("6", 64),
		MessageID:        fmt.Sprintf("<%d.%s@example.test>", fixture.recipientID, fixture.planID),
		IdempotencyKey: fmt.Sprintf("campaign:%s:recipient:%d:plan:%s", fixture.campaignID,
			fixture.recipientID, fixture.planID),
		TransportName: "ses_raw_v2", TransportContract: campaigntransport.ContractVersion,
		CapabilitySnapshot: json.RawMessage(`{"contract_version":"postwave.campaign-transport.v2","provider_receipt":true,"raw_mime":true}`),
	}
	rebindDeliveryCorrelation(&input)
	return input
}

func rebindDeliveryCorrelation(input *AttemptInput) {
	deliveryID, err := DeriveDeliveryID(input.TenantID, input.CampaignID, input.CampaignRecipientID, input.SendPlanID)
	if err != nil {
		panic(err)
	}
	issuedAt := time.Now().UTC().Truncate(time.Second)
	service := deliveryReplyCorrelationService(issuedAt)
	correlation, err := service.Mint(replycorrelation.MintInput{
		TenantID: input.TenantID, CampaignID: input.CampaignID,
		DeliveryID: deliveryID, IssuedAt: issuedAt,
	})
	if err != nil {
		panic(err)
	}
	input.DeliveryID = deliveryID
	input.ReplyTo = correlation.Address
	input.ReplyCorrelationVersion = correlation.Version
	input.ReplyCorrelationKeyID = correlation.KeyID
	input.ReplyCorrelationExpiresAt = &correlation.ExpiresAt
	input.ReplyCorrelationTokenHash = correlation.TokenHash
}

func deliveryReplyCorrelationService(now time.Time) *replycorrelation.Service {
	service, err := replycorrelation.NewService("reply.example.test", replycorrelation.DefaultTTL, []replycorrelation.Key{{
		ID: "db-proof-k1", Secret: []byte(strings.Repeat("r", 32)),
		NotBefore: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:  time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC),
	}}, func() time.Time { return now })
	if err != nil {
		panic(err)
	}
	return service
}

// A finding-level override must never waive a different unresolved blocker.
// This is especially important for non-overridable deterministic failures.
func TestRawDeliveryRejectsPartiallyOverriddenBlockedRun_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool := campaignDeliveryDBPool(t, ctx)
	fixture := seedDeliveryDBFixture(t, ctx, pool)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, fixture.tenantID)
	})
	run, override := createPartiallyOverriddenBlockedRun(t, ctx, pool, fixture)
	input := deliveryAttemptFor(fixture, run)
	input.GateDecision = GateOverridden
	input.GateOverrideIDs = []string{override.ID}
	input.IdempotencyKey += ":partial-override-proof"
	input.MessageID = fmt.Sprintf("<partial-override.%s@example.test>", fixture.planID)

	if _, err := NewRepo(pool).Acquire(ctx, input, "partial-override-proof-worker", time.Minute); err == nil {
		t.Fatal("partially overridden blocked run acquired a real-recipient delivery")
	}
}

// A later reject is a revocation, not merely another audit entry. Delivery
// must evaluate the newest exact finding decision and refuse an older allow.
func TestRawDeliveryRejectsRevokedOverride_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool := campaignDeliveryDBPool(t, ctx)
	fixture := seedDeliveryDBFixture(t, ctx, pool)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, fixture.tenantID)
	})
	run, first, second := createTwoBlockerRun(t, ctx, pool, fixture, true)
	repo := campaignassurance.NewRepo(pool)
	firstAllow, err := repo.CreateOverride(ctx, fixture.tenantID, run.ID, fixture.ownerID,
		campaignassurance.OverrideInput{FindingID: first.ID, RequestID: uuid.NewString(),
			Decision: "allow_send", Reason: "Temporary governed exception for regression proof."})
	if err != nil {
		t.Fatalf("create first allow: %v", err)
	}
	secondAllow, err := repo.CreateOverride(ctx, fixture.tenantID, run.ID, fixture.ownerID,
		campaignassurance.OverrideInput{FindingID: second.ID, RequestID: uuid.NewString(),
			Decision: "allow_send", Reason: "Temporary governed exception for regression proof."})
	if err != nil {
		t.Fatalf("create second allow: %v", err)
	}
	if _, err := repo.CreateOverride(ctx, fixture.tenantID, run.ID, fixture.ownerID,
		campaignassurance.OverrideInput{FindingID: first.ID, RequestID: uuid.NewString(),
			Decision: "reject", Reason: "Revoke the earlier exception before dispatch."}); err != nil {
		t.Fatalf("create revocation: %v", err)
	}
	input := deliveryAttemptFor(fixture, run)
	input.GateDecision = GateOverridden
	// Prove neither an older allow for the revoked finding nor a still-live
	// allow for the other finding can stand in for the revoked complete set.
	for index, overrideID := range []string{firstAllow.ID, secondAllow.ID} {
		input.GateOverrideIDs = []string{overrideID}
		input.IdempotencyKey = fmt.Sprintf("revoked-override-proof:%d", index)
		input.MessageID = fmt.Sprintf("<revoked-override-%d.%s@example.test>", index, fixture.planID)
		if _, err := NewRepo(pool).Acquire(ctx, input, "revoked-override-proof-worker", time.Minute); err == nil {
			t.Fatalf("revoked override acquired delivery using representative override %s", overrideID)
		}
	}
}

// The durable delivery receipt must preserve every finding-scoped waiver,
// not merely prove that some representative override existed at send time.
func TestRawDeliveryPersistsExactCompleteOverrideSet_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool := campaignDeliveryDBPool(t, ctx)
	fixture := seedDeliveryDBFixture(t, ctx, pool)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, fixture.tenantID)
	})
	run, first, second := createTwoBlockerRun(t, ctx, pool, fixture, true)
	repo := campaignassurance.NewRepo(pool)
	firstAllow, err := repo.CreateOverride(ctx, fixture.tenantID, run.ID, fixture.ownerID,
		campaignassurance.OverrideInput{FindingID: first.ID, RequestID: uuid.NewString(),
			Decision: "allow_send", Reason: "Governed exception for first regression blocker."})
	if err != nil {
		t.Fatalf("create first allow: %v", err)
	}
	secondAllow, err := repo.CreateOverride(ctx, fixture.tenantID, run.ID, fixture.ownerID,
		campaignassurance.OverrideInput{FindingID: second.ID, RequestID: uuid.NewString(),
			Decision: "allow_send", Reason: "Governed exception for second regression blocker."})
	if err != nil {
		t.Fatalf("create second allow: %v", err)
	}

	input := deliveryAttemptFor(fixture, run)
	input.GateDecision = GateOverridden
	// Deliberately reverse the caller order. The coordinator/repository must
	// canonicalize it before hashing and persistence.
	input.GateOverrideIDs = []string{secondAllow.ID, firstAllow.ID}
	input.IdempotencyKey += ":complete-override-set-proof"
	input.MessageID = fmt.Sprintf("<complete-override-set.%s@example.test>", fixture.planID)

	acquired, err := NewRepo(pool).Acquire(ctx, input, "complete-override-set-worker", time.Minute)
	if err != nil || !acquired.Acquired {
		t.Fatalf("acquire fully overridden delivery = %+v err=%v", acquired, err)
	}
	want := []string{firstAllow.ID, secondAllow.ID}
	slices.Sort(want)
	if fmt.Sprint(acquired.Attempt.GateOverrideIDs) != fmt.Sprint(want) {
		t.Fatalf("persisted override set = %v, want %v", acquired.Attempt.GateOverrideIDs, want)
	}
	mutationTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin override-set immutability proof: %v", err)
	}
	defer func() { _ = mutationTx.Rollback(ctx) }()
	if _, err := mutationTx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, fixture.tenantID); err != nil {
		t.Fatalf("bind override-set mutation tenant: %v", err)
	}
	if _, err := mutationTx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		t.Fatalf("bind override-set mutation worker: %v", err)
	}
	if _, err := mutationTx.Exec(ctx, `
UPDATE campaign_send_deliveries SET gate_override_ids = $3::uuid[]
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, fixture.tenantID,
		acquired.Attempt.ID, []string{want[0]}); err == nil || deliverySQLState(err) != "55000" {
		t.Fatalf("override-set mutation error=%v sqlstate=%q, want immutable 55000", err, deliverySQLState(err))
	}
	_ = mutationTx.Rollback(ctx)
}

func TestRecipientQueueAssuranceBindingIsExactAndImmutable_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool := campaignDeliveryDBPool(t, ctx)
	fixture := seedDeliveryDBFixture(t, ctx, pool)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, fixture.tenantID)
	})
	run := createPassingAssuranceRun(t, ctx, pool, fixture)
	var recipientID int64
	if err := pool.QueryRow(ctx, `
INSERT INTO campaign_recipients (
    tenant_id, campaign_id, subscriber_email, status,
    content_revision_id, send_plan_id, assurance_run_id,
    assurance_attempt_count, assurance_artifact_set_hash,
    assurance_source_hash, assurance_plan_hash, assurance_gate_decision,
    assurance_override_ids, assurance_bound_at
)
VALUES (
    $1::uuid, $2::uuid, $3, 'pending',
    $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10, 'pass',
    '{}'::uuid[], now()
)
RETURNING id`, fixture.tenantID, fixture.campaignID,
		"bound-"+strings.ReplaceAll(fixture.tenantID, "-", "")[:16]+"@example.test",
		fixture.revisionID, fixture.planID, run.ID, run.AttemptCount,
		run.ArtifactSetHash, run.SourceHash, run.PlanHash).Scan(&recipientID); err != nil {
		t.Fatalf("insert exact recipient assurance binding: %v", err)
	}
	if _, err := pool.Exec(ctx, `
UPDATE campaign_recipients SET status = 'sending' WHERE id = $1`, recipientID); err != nil {
		t.Fatalf("ordinary recipient lifecycle update rejected: %v", err)
	}
	if _, err := pool.Exec(ctx, `
UPDATE campaign_recipients SET assurance_run_id = NULL WHERE id = $1`, recipientID); err == nil || deliverySQLState(err) != "55000" {
		t.Fatalf("binding mutation error=%v sqlstate=%q, want immutable 55000", err, deliverySQLState(err))
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO campaign_recipients (
    tenant_id, campaign_id, subscriber_email, status,
    content_revision_id, send_plan_id, assurance_run_id,
    assurance_attempt_count, assurance_artifact_set_hash,
    assurance_source_hash, assurance_plan_hash, assurance_gate_decision,
    assurance_override_ids, assurance_bound_at
)
VALUES (
    $1::uuid, $2::uuid, $3, 'pending',
    $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10, 'pass',
    '{}'::uuid[], now()
)`, fixture.tenantID, fixture.campaignID,
		"drift-"+strings.ReplaceAll(fixture.tenantID, "-", "")[:16]+"@example.test",
		fixture.revisionID, fixture.planID, run.ID, run.AttemptCount,
		run.ArtifactSetHash, strings.Repeat("0", 64), run.PlanHash); err == nil {
		t.Fatal("recipient binding with a substituted source hash was accepted")
	}
}

func TestConcurrentCrossRecipientIdempotencyConflict_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool := campaignDeliveryDBPool(t, ctx)
	fixture := seedDeliveryDBFixture(t, ctx, pool)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, fixture.tenantID)
	})
	run := createPassingAssuranceRun(t, ctx, pool, fixture)
	recipientIDs := make([]int64, 2)
	for index := range recipientIDs {
		if err := pool.QueryRow(ctx, `
INSERT INTO campaign_recipients (tenant_id, campaign_id, subscriber_email)
VALUES ($1::uuid, $2::uuid, $3) RETURNING id`, fixture.tenantID, fixture.campaignID,
			fmt.Sprintf("idempotency-race-%d-%s@example.test", index,
				strings.ReplaceAll(fixture.tenantID, "-", "")[:16])).Scan(&recipientIDs[index]); err != nil {
			t.Fatalf("seed idempotency-race recipient %d: %v", index, err)
		}
	}

	start := make(chan struct{})
	type result struct {
		acquisition Acquisition
		err         error
	}
	results := make(chan result, 2)
	for index, recipientID := range recipientIDs {
		go func(index int, recipientID int64) {
			input := deliveryAttemptFor(fixture, run)
			input.CampaignRecipientID = recipientID
			rebindDeliveryCorrelation(&input)
			input.MessageID = fmt.Sprintf("<idempotency-race-%d.%s@example.test>", index, fixture.planID)
			input.IdempotencyKey = "shared-cross-recipient-idempotency-proof"
			<-start
			value, err := NewRepo(pool).Acquire(ctx, input,
				fmt.Sprintf("idempotency-race-worker-%d", index), time.Minute)
			results <- result{acquisition: value, err: err}
		}(index, recipientID)
	}
	close(start)
	winners, conflicts := 0, 0
	for range recipientIDs {
		result := <-results
		switch {
		case result.err == nil && result.acquisition.Acquired:
			winners++
		case errors.Is(result.err, ErrIdempotencyConflict):
			conflicts++
		default:
			t.Fatalf("unexpected cross-recipient idempotency result: %+v err=%v", result.acquisition, result.err)
		}
	}
	if winners != 1 || conflicts != 1 {
		t.Fatalf("cross-recipient idempotency winners/conflicts = %d/%d, want 1/1", winners, conflicts)
	}
}

// TestDurableRawDeliveryLifecycle_DB proves the actual 1920-1922 chain from a
// completed assurance receipt to a fenced exact-byte provider receipt. It also
// verifies tenant-only callers cannot mutate the worker ledger and that event
// history is generated and remains append-only.
func TestDurableRawDeliveryLifecycle_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool := campaignDeliveryDBPool(t, ctx)
	fixture := seedDeliveryDBFixture(t, ctx, pool)
	deleted := false
	t.Cleanup(func() {
		if deleted {
			return
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, fixture.tenantID)
	})
	run := createPassingAssuranceRun(t, ctx, pool, fixture)
	repo := NewRepo(pool)
	input := deliveryAttemptFor(fixture, run)

	acquired, err := repo.Acquire(ctx, input, "raw-delivery-worker", time.Minute)
	if err != nil || !acquired.Acquired || acquired.Attempt.State != StatePrepared {
		t.Fatalf("acquire delivery = %+v err=%v", acquired, err)
	}
	attempt := acquired.Attempt

	var appRoleExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'postwave_app'
)`).Scan(&appRoleExists); err != nil {
		t.Fatalf("inspect postwave_app role: %v", err)
	}
	if appRoleExists {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin tenant-only mutation proof: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
			t.Fatalf("set postwave_app role: %v", err)
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, fixture.tenantID); err != nil {
			t.Fatalf("bind app tenant: %v", err)
		}
		tag, err := tx.Exec(ctx, `
UPDATE campaign_send_deliveries
   SET state = 'dispatching', dispatch_started_at = clock_timestamp(),
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, fixture.tenantID, attempt.ID)
		if err != nil && deliverySQLState(err) != "42501" {
			t.Fatalf("tenant-only delivery mutation error = %v state=%q", err, deliverySQLState(err))
		}
		if err == nil && tag.RowsAffected() != 0 {
			t.Fatalf("tenant-only caller mutated %d delivery rows", tag.RowsAffected())
		}
		if err := tx.Rollback(ctx); err != nil {
			t.Fatalf("finish tenant-only mutation proof: %v", err)
		}
	}

	if err := repo.MarkDispatching(ctx, fixture.tenantID, attempt.ID, attempt.ClaimToken); err != nil {
		t.Fatalf("mark dispatching: %v", err)
	}
	receipt := campaigntransport.Receipt{
		ContractVersion: campaigntransport.ContractVersion, ArtifactID: fixture.artifactID,
		ScenarioID: "base", CampaignID: fixture.campaignID,
		OutboundMIMEHash: input.OutboundMIMEHash, ProviderMessageID: "provider-delivery-proof-1",
		IdempotencyKey: input.IdempotencyKey, IdempotencyMode: campaigntransport.LedgerIdempotencyMode,
	}
	accepted, err := repo.MarkAccepted(ctx, TerminalInput{
		TenantID: fixture.tenantID, AttemptID: attempt.ID, ClaimToken: attempt.ClaimToken,
		Receipt: receipt,
	})
	if err != nil || accepted.State != StateAccepted || accepted.ProviderMessageID != receipt.ProviderMessageID {
		t.Fatalf("accept delivery = %+v err=%v", accepted, err)
	}
	if accepted.ID != input.DeliveryID || accepted.ReplyTo != input.ReplyTo ||
		accepted.ReplyCorrelationTokenHash != input.ReplyCorrelationTokenHash ||
		accepted.ReplyCorrelationExpiresAt == nil || !accepted.ReplyCorrelationExpiresAt.Equal(*input.ReplyCorrelationExpiresAt) {
		t.Fatalf("accepted reply-correlation receipt drifted: %+v", accepted)
	}
	replay, err := repo.Acquire(ctx, input, "raw-delivery-replay-worker", time.Minute)
	if err != nil || replay.Acquired || replay.Attempt.ID != attempt.ID || replay.Attempt.State != StateAccepted {
		t.Fatalf("accepted replay = %+v err=%v", replay, err)
	}
	if appRoleExists {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin pre-tenant resolver proof: %v", err)
		}
		if _, err := tx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
			t.Fatalf("set resolver app role: %v", err)
		}
		var resolved, missed *string
		if err := tx.QueryRow(ctx, `SELECT public.resolve_campaign_reply_correlation_tenant($1)::text`, input.ReplyCorrelationTokenHash).Scan(&resolved); err != nil {
			t.Fatalf("resolve exact token commitment: %v", err)
		}
		if err := tx.QueryRow(ctx, `SELECT public.resolve_campaign_reply_correlation_tenant($1)::text`, strings.Repeat("f", 64)).Scan(&missed); err != nil {
			t.Fatalf("resolve unknown token commitment: %v", err)
		}
		if resolved == nil || *resolved != fixture.tenantID || missed != nil {
			t.Fatalf("resolver exact/miss = %v/%v", resolved, missed)
		}
		_ = tx.Rollback(ctx)
	}
	matcher := &canonicalreplies.Matcher{
		Store:            &canonicalreplies.Store{Pool: pool},
		ReplyCorrelation: deliveryReplyCorrelationService(time.Now().UTC()),
	}
	matched, err := matcher.Resolve(ctx, fixture.tenantID, canonicalreplies.Reply{
		EnvelopeRecipient: input.ReplyTo,
		RecipientEmail:    "agent-relay@example.test",
	})
	if err != nil || matched.Method != canonicalreplies.MatchVERP || matched.CampaignID != fixture.campaignID {
		t.Fatalf("tenant-scoped opaque reply match = %+v err=%v", matched, err)
	}
	foreign, err := matcher.Resolve(ctx, uuid.NewString(), canonicalreplies.Reply{EnvelopeRecipient: input.ReplyTo})
	if err != nil || foreign.Method != canonicalreplies.MatchNone || foreign.CampaignID != "" {
		t.Fatalf("cross-tenant opaque reply match = %+v err=%v", foreign, err)
	}
	correlationTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin reply-correlation immutability proof: %v", err)
	}
	if _, err := correlationTx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true), set_config('app.outbox_worker', 'true', true)`, fixture.tenantID); err != nil {
		t.Fatalf("bind reply-correlation worker: %v", err)
	}
	_, err = correlationTx.Exec(ctx, `
UPDATE campaign_send_deliveries
   SET reply_to = $3, updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, fixture.tenantID, attempt.ID,
		"reply+rewritten@reply.example.test")
	if deliverySQLState(err) != "55000" {
		t.Fatalf("reply-correlation rewrite error = %v state=%q, want 55000", err, deliverySQLState(err))
	}
	_ = correlationTx.Rollback(ctx)

	// Two worker replicas racing the same recipient/request must converge on
	// one durable row. A raw serialization error here would be operationally
	// unsafe because callers could mistake it for a reason to retry delivery.
	var concurrentRecipientID int64
	if err := pool.QueryRow(ctx, `
INSERT INTO campaign_recipients (tenant_id, campaign_id, subscriber_email)
VALUES ($1::uuid, $2::uuid, $3) RETURNING id`, fixture.tenantID,
		fixture.campaignID, "concurrent-"+strings.ReplaceAll(fixture.tenantID, "-", "")[:16]+"@example.test").
		Scan(&concurrentRecipientID); err != nil {
		t.Fatalf("seed concurrent recipient: %v", err)
	}
	concurrentInput := input
	concurrentInput.CampaignRecipientID = concurrentRecipientID
	rebindDeliveryCorrelation(&concurrentInput)
	concurrentInput.MessageID = fmt.Sprintf("<%d.%s@example.test>", concurrentRecipientID, fixture.planID)
	concurrentInput.IdempotencyKey = fmt.Sprintf("campaign:%s:recipient:%d:plan:%s",
		fixture.campaignID, concurrentRecipientID, fixture.planID)
	type acquireResult struct {
		value Acquisition
		err   error
	}
	startAcquire := make(chan struct{})
	results := make(chan acquireResult, 2)
	for index := 0; index < 2; index++ {
		go func(index int) {
			<-startAcquire
			value, err := repo.Acquire(ctx, concurrentInput,
				fmt.Sprintf("raw-delivery-concurrent-%d", index), time.Minute)
			results <- acquireResult{value: value, err: err}
		}(index)
	}
	close(startAcquire)
	acquiredCount := 0
	concurrentAttemptID := ""
	for index := 0; index < 2; index++ {
		result := <-results
		if result.err != nil {
			t.Fatalf("concurrent acquire %d: %v (state=%q)", index, result.err,
				deliverySQLState(result.err))
		}
		if result.value.Acquired {
			acquiredCount++
		}
		if concurrentAttemptID == "" {
			concurrentAttemptID = result.value.Attempt.ID
		} else if result.value.Attempt.ID != concurrentAttemptID {
			t.Fatalf("concurrent acquire produced different rows: %s and %s",
				concurrentAttemptID, result.value.Attempt.ID)
		}
	}
	if acquiredCount != 1 {
		t.Fatalf("concurrent acquire winners = %d, want 1", acquiredCount)
	}

	// Prepared leases are safe to reclaim because no provider call has begun.
	// Dispatching leases are not: expiry must become indeterminate, after which
	// only provider evidence may reconcile the receipt.
	var recoveryRecipientID int64
	if err := pool.QueryRow(ctx, `
INSERT INTO campaign_recipients (tenant_id, campaign_id, subscriber_email)
VALUES ($1::uuid, $2::uuid, $3) RETURNING id`, fixture.tenantID,
		fixture.campaignID, "recovery-"+strings.ReplaceAll(fixture.tenantID, "-", "")[:16]+"@example.test").
		Scan(&recoveryRecipientID); err != nil {
		t.Fatalf("seed recovery recipient: %v", err)
	}
	recoveryInput := input
	recoveryInput.CampaignRecipientID = recoveryRecipientID
	rebindDeliveryCorrelation(&recoveryInput)
	recoveryInput.MessageID = fmt.Sprintf("<%d.%s@example.test>", recoveryRecipientID, fixture.planID)
	recoveryInput.IdempotencyKey = fmt.Sprintf("campaign:%s:recipient:%d:plan:%s",
		fixture.campaignID, recoveryRecipientID, fixture.planID)
	prepared, err := repo.Acquire(ctx, recoveryInput, "raw-delivery-crashed-before-dispatch", time.Second)
	if err != nil || !prepared.Acquired {
		t.Fatalf("acquire reclaimable delivery = %+v err=%v", prepared, err)
	}
	time.Sleep(1100 * time.Millisecond)
	reclaimed, err := repo.Acquire(ctx, recoveryInput, "raw-delivery-reclaimer", time.Second)
	if err != nil || !reclaimed.Acquired || reclaimed.Attempt.ID != prepared.Attempt.ID ||
		reclaimed.Attempt.ClaimToken == prepared.Attempt.ClaimToken {
		t.Fatalf("reclaim expired prepared delivery = %+v err=%v", reclaimed, err)
	}
	if err := repo.MarkDispatching(ctx, fixture.tenantID, reclaimed.Attempt.ID,
		reclaimed.Attempt.ClaimToken); err != nil {
		t.Fatalf("dispatch reclaimed delivery: %v", err)
	}
	time.Sleep(1100 * time.Millisecond)
	swept, err := repo.SweepExpiredDispatching(ctx, fixture.tenantID, 10)
	if err != nil || len(swept) != 1 || swept[0].ID != reclaimed.Attempt.ID ||
		swept[0].State != StateIndeterminate {
		t.Fatalf("sweep ambiguous dispatch = %+v err=%v", swept, err)
	}
	recoveryReceipt := receipt
	recoveryReceipt.ProviderMessageID = "provider-delivery-proof-reconciled"
	recoveryReceipt.IdempotencyKey = recoveryInput.IdempotencyKey
	reconciled, err := repo.ReconcileAccepted(ctx, ReconcileInput{
		TenantID: fixture.tenantID, AttemptID: reclaimed.Attempt.ID,
		Source: "ses_event_v1", Receipt: recoveryReceipt,
	})
	if err != nil || reconciled.State != StateAccepted || reconciled.IndeterminateAt == nil ||
		reconciled.ProviderReconciledAt == nil || reconciled.ReconciliationSource != "ses_event_v1" {
		t.Fatalf("reconcile ambiguous delivery = %+v err=%v", reconciled, err)
	}
	var recoveryStates []string
	recoveryRows, err := pool.Query(ctx, `
SELECT to_state FROM campaign_send_delivery_events
 WHERE tenant_id = $1::uuid AND delivery_id = $2::uuid ORDER BY event_no`,
		fixture.tenantID, reclaimed.Attempt.ID)
	if err != nil {
		t.Fatalf("load recovery events: %v", err)
	}
	for recoveryRows.Next() {
		var state string
		if err := recoveryRows.Scan(&state); err != nil {
			recoveryRows.Close()
			t.Fatalf("scan recovery event: %v", err)
		}
		recoveryStates = append(recoveryStates, state)
	}
	if err := recoveryRows.Err(); err != nil {
		recoveryRows.Close()
		t.Fatalf("iterate recovery events: %v", err)
	}
	recoveryRows.Close()
	wantRecoveryStates := []string{"prepared", "prepared", "dispatching", "indeterminate", "accepted"}
	if fmt.Sprint(recoveryStates) != fmt.Sprint(wantRecoveryStates) {
		t.Fatalf("recovery event states = %v, want %v", recoveryStates, wantRecoveryStates)
	}

	rows, err := pool.Query(ctx, `
SELECT from_state, to_state, event_source
  FROM campaign_send_delivery_events
 WHERE tenant_id = $1::uuid AND delivery_id = $2::uuid
 ORDER BY event_no`, fixture.tenantID, attempt.ID)
	if err != nil {
		t.Fatalf("load delivery events: %v", err)
	}
	defer rows.Close()
	wantStates := []string{"prepared", "dispatching", "accepted"}
	index := 0
	for rows.Next() {
		var from *string
		var to, source string
		if err := rows.Scan(&from, &to, &source); err != nil {
			t.Fatalf("scan delivery event: %v", err)
		}
		if index >= len(wantStates) || to != wantStates[index] || source != "delivery_coordinator" {
			t.Fatalf("event %d = from=%v to=%q source=%q", index+1, from, to, source)
		}
		index++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate delivery events: %v", err)
	}
	if index != len(wantStates) {
		t.Fatalf("delivery event count = %d, want %d", index, len(wantStates))
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin append-only proof: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, fixture.tenantID); err != nil {
		t.Fatalf("bind append-only tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		t.Fatalf("bind append-only worker: %v", err)
	}
	_, err = tx.Exec(ctx, `
UPDATE campaign_send_deliveries SET failure_code = 'REWRITE'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, fixture.tenantID, attempt.ID)
	if deliverySQLState(err) != "55000" {
		t.Fatalf("delivery rewrite error = %v state=%q, want 55000", err, deliverySQLState(err))
	}
	_ = tx.Rollback(ctx)

	if appRoleExists {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin event privilege proof: %v", err)
		}
		if _, err := tx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
			t.Fatalf("set event app role: %v", err)
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, fixture.tenantID); err != nil {
			t.Fatalf("bind event tenant: %v", err)
		}
		_, err = tx.Exec(ctx, `
INSERT INTO campaign_send_delivery_events (
    tenant_id, campaign_id, delivery_id, event_no, to_state,
    claim_token, event_source
) VALUES ($1::uuid, $2::uuid, $3::uuid, 99, 'accepted', $4::uuid, 'forged')`,
			fixture.tenantID, fixture.campaignID, attempt.ID, attempt.ClaimToken)
		if deliverySQLState(err) != "42501" {
			t.Fatalf("direct event insert error = %v state=%q, want 42501", err, deliverySQLState(err))
		}
		_ = tx.Rollback(ctx)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, fixture.tenantID); err != nil {
		t.Fatalf("tenant cascade cleanup: %v", err)
	}
	deleted = true
	var remaining int
	if err := pool.QueryRow(ctx, `
SELECT count(*)::integer FROM campaign_send_delivery_events
 WHERE tenant_id = $1::uuid`, fixture.tenantID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("tenant cascade left %d delivery events, err=%v", remaining, err)
	}

	t.Logf("verified exact-byte delivery lifecycle for tenant %s", fixture.tenantID)
}
