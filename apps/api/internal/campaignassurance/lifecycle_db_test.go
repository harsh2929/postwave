// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurance

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func assuranceDBPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("POSTWAVE_ASSURANCE_TEST_DATABASE_URL"))
	if url == "" {
		t.Skip("POSTWAVE_ASSURANCE_TEST_DATABASE_URL is required for Campaign Assurance DB proof")
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect assurance test database: %v", err)
	}
	t.Cleanup(pool.Close)
	var ready bool
	if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.campaign_assurance_run_targets') IS NOT NULL
   AND to_regclass('public.campaign_assurance_overrides') IS NOT NULL`).Scan(&ready); err != nil {
		t.Fatalf("inspect assurance schema: %v", err)
	}
	if !ready {
		t.Fatal("configured database does not have migrations 1920 and 1921")
	}
	return pool
}

func sqlState(err error) string {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError.Code
	}
	return ""
}

type assuranceFixture struct {
	tenantID, campaignID, revisionID, planID string
	artifactOne, artifactTwo                 string
	ownerID, editorID                        string
	foreignTenantID, foreignOwnerID          string
}

func seedAssuranceFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) assuranceFixture {
	t.Helper()
	fixture := assuranceFixture{
		tenantID: uuid.NewString(), campaignID: uuid.NewString(),
		revisionID: uuid.NewString(), planID: uuid.NewString(),
		artifactOne: uuid.NewString(), artifactTwo: uuid.NewString(),
		ownerID: uuid.NewString(), editorID: uuid.NewString(),
		foreignTenantID: uuid.NewString(), foreignOwnerID: uuid.NewString(),
	}
	suffix := strings.ReplaceAll(fixture.tenantID, "-", "")[:16]
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin assurance fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'studio')`, []any{
			fixture.tenantID, "assurance-db-" + suffix, "Assurance DB " + suffix,
		}},
		{`INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'studio')`, []any{
			fixture.foreignTenantID, "assurance-foreign-" + suffix, "Assurance Foreign " + suffix,
		}},
		{`INSERT INTO users (id, tenant_id, external_user_id, email, role)
VALUES
    ($1::uuid, $2::uuid, $3, $4, 'owner'),
    ($5::uuid, $2::uuid, $6, $7, 'editor'),
    ($8::uuid, $9::uuid, $10, $11, 'owner')`, []any{
			fixture.ownerID, fixture.tenantID, "assurance-owner-" + suffix, "owner-" + suffix + "@example.test",
			fixture.editorID, "assurance-editor-" + suffix, "editor-" + suffix + "@example.test",
			fixture.foreignOwnerID, fixture.foreignTenantID, "assurance-foreign-owner-" + suffix,
			"foreign-owner-" + suffix + "@example.test",
		}},
		{`INSERT INTO campaigns (id, tenant_id, name, subject, body_html)
VALUES ($1::uuid, $2::uuid, 'Assurance DB proof', 'Launch Friday', '<p>Launch Friday</p>')`, []any{
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
    '{}'::jsonb, '{"scenarios":["base","locale-hi"]}'::jsonb,
    'fixtures-v1', 'plan-policy-v1', 'preparing'
)`, []any{fixture.planID, fixture.tenantID, fixture.campaignID, fixture.revisionID}},
		{`INSERT INTO campaign_render_artifacts (
    id, tenant_id, campaign_id, send_plan_id, scenario_id,
    locale, branch_key, fixture_id, source_hash, html_hash, text_hash,
    mime_structure_hash, outbound_mime_hash, compiler_receipt,
    representation_manifest
)
VALUES
    ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'base',
     'en-US', 'default', 'fixture-base', repeat('1', 64), repeat('3', 64),
     repeat('4', 64), repeat('5', 64), repeat('6', 64), '{}'::jsonb, '{}'::jsonb),
    ($5::uuid, $2::uuid, $3::uuid, $4::uuid, 'locale-hi',
     'hi-IN', 'default', 'fixture-hi', repeat('1', 64), repeat('7', 64),
     repeat('8', 64), repeat('9', 64), repeat('a', 64), '{}'::jsonb, '{}'::jsonb)`, []any{
			fixture.artifactOne, fixture.tenantID, fixture.campaignID,
			fixture.planID, fixture.artifactTwo,
		}},
		{`UPDATE campaign_send_plans
   SET state = 'ready', plan_hash = repeat('b', 64), ready_at = now()
	 WHERE tenant_id = $1::uuid AND id = $2::uuid`, []any{fixture.tenantID, fixture.planID}},
	}
	for index, statement := range statements {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatalf("seed assurance fixture statement %d: %v", index+1, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit assurance fixture: %v", err)
	}
	return fixture
}

func dbCreateInput(fixture assuranceFixture) CreateRunInput {
	input := validCreateInput()
	input.CampaignID = fixture.campaignID
	input.ContentRevisionID = fixture.revisionID
	input.SendPlanID = fixture.planID
	input.CreatedBy = fixture.ownerID
	input.Targets = []TargetInput{
		{ArtifactID: fixture.artifactOne, ConfigurationID: "deterministic.mime"},
		{ArtifactID: fixture.artifactOne, ConfigurationID: "model.primary"},
		{ArtifactID: fixture.artifactTwo, ConfigurationID: "deterministic.mime"},
	}
	return input
}

func extractionForTarget(target RunTarget) ExtractionInput {
	input := validModeledExtraction()
	input.ArtifactID = target.ArtifactID
	input.ConfigurationID = target.ConfigurationID
	input.SourceClass = target.SourceClass
	input.ConfigurationHash = target.ConfigurationHash
	input.OutboundMIMEHash = target.OutboundMIMEHash
	if target.SourceClass != SourceModeled {
		input.ModelProvider = ""
		input.ModelID = ""
		input.ModelVersion = ""
		input.PromptVersion = ""
		input.PromptHash = ""
	}
	return input
}

// TestDurableAssuranceLifecycle_DB exercises the actual schema and repository:
// exact snapshot freeze, sparse targets, active-run idempotency, fenced leases,
// first-write receipts, complete/incomplete derivation, override governance,
// stale historical truth, append-only guards, RLS, and tenant cascade cleanup.
func TestDurableAssuranceLifecycle_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool := assuranceDBPool(t, ctx)
	repo := NewRepo(pool)
	fixture := seedAssuranceFixture(t, ctx, pool)
	deleted := false
	t.Cleanup(func() {
		if deleted {
			return
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, fixture.tenantID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, fixture.foreignTenantID)
	})

	lateArtifact := uuid.NewString()
	_, err := pool.Exec(ctx, `
INSERT INTO campaign_render_artifacts (
    id, tenant_id, campaign_id, send_plan_id, scenario_id,
    locale, branch_key, fixture_id, source_hash, html_hash, text_hash,
    mime_structure_hash, outbound_mime_hash, compiler_receipt,
    representation_manifest
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'late',
    'en-US', 'default', 'late', repeat('1',64), repeat('2',64), repeat('3',64),
    repeat('4',64), repeat('5',64), '{}'::jsonb, '{}'::jsonb
)`, lateArtifact, fixture.tenantID, fixture.campaignID, fixture.planID)
	if sqlState(err) != "55000" {
		t.Fatalf("late ready-plan artifact error = %v state=%q, want 55000", err, sqlState(err))
	}

	input := dbCreateInput(fixture)
	run, err := repo.CreateRun(ctx, fixture.tenantID, input)
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if run.SnapshotFrozenAt == nil || !hashPattern.MatchString(run.ArtifactSetHash) ||
		!hashPattern.MatchString(run.ConfigurationManifestHash) ||
		!hashPattern.MatchString(run.TargetManifestHash) || run.RequiredExtractionCount != 3 {
		t.Fatalf("run snapshot not frozen exactly: %+v", run)
	}
	replay, err := repo.CreateRun(ctx, fixture.tenantID, input)
	if err != nil || replay.ID != run.ID {
		t.Fatalf("idempotent create = %+v err=%v, want run %s", replay, err, run.ID)
	}
	conflicting := input
	conflicting.ScoringVersion = "score-v2"
	if _, err := repo.CreateRun(ctx, fixture.tenantID, conflicting); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("same request different input error = %v", err)
	}
	activeDuplicate := input
	activeDuplicate.RequestID = uuid.NewString()
	if _, err := repo.CreateRun(ctx, fixture.tenantID, activeDuplicate); !errors.Is(err, ErrRunInFlight) {
		t.Fatalf("duplicate active run error = %v", err)
	}

	type claimOutcome struct {
		claim *ClaimedRun
		err   error
	}
	startClaims := make(chan struct{})
	claimOutcomes := make(chan claimOutcome, 2)
	for index := 0; index < 2; index++ {
		go func(index int) {
			<-startClaims
			claim, err := repo.ClaimRun(ctx, fixture.tenantID, run.ID,
				fmt.Sprintf("assurance-db-worker-%d", index), time.Minute)
			claimOutcomes <- claimOutcome{claim: claim, err: err}
		}(index)
	}
	close(startClaims)
	var claim *ClaimedRun
	losers := 0
	for index := 0; index < 2; index++ {
		outcome := <-claimOutcomes
		if outcome.err == nil {
			if claim != nil {
				t.Fatal("concurrent claims produced two winners")
			}
			claim = outcome.claim
		} else if errors.Is(outcome.err, ErrNotFound) {
			losers++
		} else {
			t.Fatalf("concurrent claim error: %v", outcome.err)
		}
	}
	if claim == nil || losers != 1 {
		t.Fatalf("concurrent claim outcome: winner=%+v losers=%d", claim, losers)
	}
	if claim.Run.AttemptCount != 1 || claim.Run.ClaimToken == nil || len(claim.Targets) != 3 {
		t.Fatalf("invalid claim receipt: %+v", claim)
	}
	if _, err := repo.ClaimRun(ctx, fixture.tenantID, run.ID, "second-worker", time.Minute); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second claim error = %v", err)
	}

	var firstExtraction *Extraction
	for index, target := range claim.Targets {
		receipt, err := repo.RecordExtraction(ctx, fixture.tenantID, run.ID,
			*claim.Run.ClaimToken, claim.Run.AttemptCount, extractionForTarget(target))
		if err != nil {
			t.Fatalf("record target %d extraction: %v", index, err)
		}
		if index == 0 {
			firstExtraction = receipt
			replayed, err := repo.RecordExtraction(ctx, fixture.tenantID, run.ID,
				*claim.Run.ClaimToken, claim.Run.AttemptCount, extractionForTarget(target))
			if err != nil || replayed.ID != receipt.ID {
				t.Fatalf("idempotent extraction = %+v err=%v", replayed, err)
			}
			changed := extractionForTarget(target)
			changed.NormalizedExtraction = []byte(`{"summary":"different"}`)
			if _, err := repo.RecordExtraction(ctx, fixture.tenantID, run.ID,
				*claim.Run.ClaimToken, claim.Run.AttemptCount, changed); !errors.Is(err, ErrIdempotencyConflict) {
				t.Fatalf("different first-write receipt error = %v", err)
			}
		}
	}
	findingInput := FindingInput{
		ArtifactID: claim.Targets[0].ArtifactID, ConfigurationID: claim.Targets[0].ConfigurationID,
		ExtractionID: firstExtraction.ID, Code: "PRIMARY_ACTION_MISSING",
		SourceClass: claim.Targets[0].SourceClass, Severity: "critical",
		Blocking: true, Overridable: true, Dimension: "primary_action",
		BlockReferences: []byte(`[]`), EvidenceReferences: []byte(`["html"]`),
		Explanation:     "The final representation does not expose the declared primary action.",
		Remediation:     []byte(`{"kind":"add_action"}`),
		DetectorVersion: "detector-v1", PolicyVersion: "gate-v1",
	}
	finding, err := repo.RecordFinding(ctx, fixture.tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, findingInput)
	if err != nil {
		t.Fatalf("record finding: %v", err)
	}
	nonOverridableInput := findingInput
	nonOverridableInput.Code = "INVALID_MIME"
	nonOverridableInput.Overridable = false
	nonOverridableInput.Explanation = "The MIME structure is invalid and cannot be waived by an administrator."
	nonOverridable, err := repo.RecordFinding(ctx, fixture.tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, nonOverridableInput)
	if err != nil {
		t.Fatalf("record non-overridable finding: %v", err)
	}
	min, max, overall, agreement := 60.0, 80.0, 70.0, 0.75
	if _, err := repo.FinalizeRun(ctx, fixture.tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, FinalizeInput{
			ComponentScores: []byte(`{"intent":70}`), OverallScore: &overall,
			ScoreMin: &min, ScoreMax: &max, Agreement: &agreement, GateDecision: GatePass,
		}); !errors.Is(err, ErrInvalidReceipt) {
		t.Fatalf("pass gate with persisted blockers error = %v, want ErrInvalidReceipt", err)
	}
	forgedGateTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin blocker gate-forgery proof: %v", err)
	}
	if _, err := forgedGateTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		t.Fatalf("set app role for blocker gate-forgery proof: %v", err)
	}
	if _, err := forgedGateTx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, fixture.tenantID); err != nil {
		t.Fatalf("bind gate-forgery tenant: %v", err)
	}
	if _, err := forgedGateTx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		t.Fatalf("bind gate-forgery worker: %v", err)
	}
	_, err = forgedGateTx.Exec(ctx, `
UPDATE campaign_assurance_runs
   SET state = 'complete', claim_token = NULL, lease_owner = NULL,
       lease_expires_at = NULL, heartbeat_at = NULL,
       terminal_extraction_count = required_extraction_count,
       successful_extraction_count = required_extraction_count,
       extraction_error_count = 0, finding_count = 2,
       blocking_finding_count = 2, gate_decision = 'pass', completed_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, fixture.tenantID, run.ID)
	if sqlState(err) != "55000" {
		t.Fatalf("database blocker gate forgery error = %v state=%q, want 55000", err, sqlState(err))
	}
	_ = forgedGateTx.Rollback(ctx)
	completed, err := repo.FinalizeRun(ctx, fixture.tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, FinalizeInput{
			ComponentScores: []byte(`{"intent":70}`), OverallScore: &overall,
			ScoreMin: &min, ScoreMax: &max, Agreement: &agreement, GateDecision: GateBlock,
		})
	if err != nil {
		t.Fatalf("finalize complete run: %v", err)
	}
	if completed.State != StateComplete || completed.GateDecision != GateBlock ||
		completed.TerminalExtractionCount != 3 || completed.FindingCount != 2 {
		t.Fatalf("invalid terminal receipt: %+v", completed)
	}
	if _, err := repo.RenewLease(ctx, fixture.tenantID, run.ID,
		*claim.Run.ClaimToken, claim.Run.AttemptCount, time.Minute); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("terminal token renewed: %v", err)
	}

	overrideInput := OverrideInput{
		FindingID: finding.ID, RequestID: uuid.NewString(), Decision: "allow_send",
		Reason: "Reviewed against the exact artifact and accepted for this one send.",
	}
	override, err := repo.CreateOverride(ctx, fixture.tenantID, run.ID, fixture.ownerID, overrideInput)
	if err != nil || override.FindingReceiptHash != finding.ReceiptHash {
		t.Fatalf("create governed override = %+v err=%v", override, err)
	}
	overrideReplay, err := repo.CreateOverride(ctx, fixture.tenantID, run.ID, fixture.ownerID, overrideInput)
	if err != nil || overrideReplay.ID != override.ID {
		t.Fatalf("idempotent override = %+v err=%v, want %s", overrideReplay, err, override.ID)
	}
	if _, err := repo.CreateOverride(ctx, fixture.tenantID, run.ID, fixture.ownerID, OverrideInput{
		FindingID: nonOverridable.ID, RequestID: uuid.NewString(), Decision: "allow_send",
		Reason: "This non-overridable failure must remain blocked despite review.",
	}); !errors.Is(err, ErrOverrideNotAllowed) {
		t.Fatalf("non-overridable finding waiver error = %v, want ErrOverrideNotAllowed", err)
	}
	if _, err := repo.CreateOverride(ctx, fixture.tenantID, run.ID, fixture.editorID, OverrideInput{
		FindingID: finding.ID, RequestID: uuid.NewString(), Decision: "allow_send",
		Reason: "An editor must not be able to forge an administrative assurance waiver.",
	}); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("editor override error = %v, want ErrUnauthorized", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE users SET role = 'editor' WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		fixture.tenantID, fixture.ownerID); err != nil {
		t.Fatalf("demote assurance owner: %v", err)
	}
	if _, err := repo.CreateOverride(ctx, fixture.tenantID, run.ID, fixture.ownerID, OverrideInput{
		FindingID: finding.ID, RequestID: uuid.NewString(), Decision: "allow_send",
		Reason: "A demoted former owner must not retain authority through stale request data.",
	}); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("demoted owner override error = %v, want ErrUnauthorized", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE users SET role = 'owner' WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		fixture.tenantID, fixture.ownerID); err != nil {
		t.Fatalf("restore assurance owner for remaining proof: %v", err)
	}
	if _, err := repo.CreateOverride(ctx, fixture.tenantID, run.ID, fixture.foreignOwnerID, OverrideInput{
		FindingID: finding.ID, RequestID: uuid.NewString(), Decision: "allow_send",
		Reason: "An owner from another tenant must never authorize this campaign.",
	}); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("cross-tenant owner override error = %v, want ErrUnauthorized", err)
	}
	stale, err := repo.MarkStale(ctx, fixture.tenantID, run.ID)
	if err != nil || stale.State != StateStale || stale.GateDecision != GateBlock {
		t.Fatalf("stale transition destroyed evaluated gate: %+v err=%v", stale, err)
	}

	concurrentInput := dbCreateInput(fixture)
	concurrentInput.RequestID = uuid.NewString()
	concurrentStart := make(chan struct{})
	concurrentResults := make(chan struct {
		run *Run
		err error
	}, 6)
	for index := 0; index < 6; index++ {
		go func() {
			<-concurrentStart
			created, err := repo.CreateRun(ctx, fixture.tenantID, concurrentInput)
			concurrentResults <- struct {
				run *Run
				err error
			}{run: created, err: err}
		}()
	}
	close(concurrentStart)
	var concurrentRun *Run
	for index := 0; index < 6; index++ {
		result := <-concurrentResults
		if result.err != nil {
			t.Fatalf("concurrent idempotent create %d: %v", index, result.err)
		}
		if concurrentRun == nil {
			concurrentRun = result.run
		} else if result.run.ID != concurrentRun.ID {
			t.Fatalf("concurrent idempotent create returned %s and %s", concurrentRun.ID, result.run.ID)
		}
	}
	if _, err := repo.CancelRun(ctx, fixture.tenantID, concurrentRun.ID); err != nil {
		t.Fatalf("cancel concurrent-create proof run: %v", err)
	}

	secondInput := dbCreateInput(fixture)
	secondInput.RequestID = uuid.NewString()
	second, err := repo.CreateRun(ctx, fixture.tenantID, secondInput)
	if err != nil {
		t.Fatalf("create second run: %v", err)
	}
	shortClaim, err := repo.ClaimRun(ctx, fixture.tenantID, second.ID, "short-lease-worker", 5*time.Millisecond)
	if err != nil {
		t.Fatalf("claim short run: %v", err)
	}
	time.Sleep(15 * time.Millisecond)
	if _, err := repo.RenewLease(ctx, fixture.tenantID, second.ID,
		*shortClaim.Run.ClaimToken, shortClaim.Run.AttemptCount, time.Minute); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("expired worker renewed lease: %v", err)
	}
	if _, err := repo.RecordExtraction(ctx, fixture.tenantID, second.ID,
		*shortClaim.Run.ClaimToken, shortClaim.Run.AttemptCount,
		extractionForTarget(shortClaim.Targets[0])); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("expired worker wrote evidence: %v", err)
	}
	if _, err := repo.FinalizeRun(ctx, fixture.tenantID, second.ID,
		*shortClaim.Run.ClaimToken, shortClaim.Run.AttemptCount,
		FinalizeInput{GateDecision: GatePass}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("expired worker finalized run: %v", err)
	}
	requeued, err := repo.RecoverExpiredRun(ctx, fixture.tenantID, second.ID, time.Now())
	if err != nil || requeued.State != StateQueued {
		t.Fatalf("recover expired run = %+v err=%v", requeued, err)
	}
	secondClaim, err := repo.ClaimRun(ctx, fixture.tenantID, second.ID, "retry-worker", time.Minute)
	if err != nil || secondClaim.Run.AttemptCount != 2 {
		t.Fatalf("claim retry = %+v err=%v", secondClaim, err)
	}
	secondFindingInput := findingInput
	secondFindingInput.ExtractionID = ""
	secondFindingInput.ArtifactID = secondClaim.Targets[0].ArtifactID
	secondFindingInput.ConfigurationID = secondClaim.Targets[0].ConfigurationID
	secondFindingInput.SourceClass = secondClaim.Targets[0].SourceClass
	secondFinding, err := repo.RecordFinding(ctx, fixture.tenantID, second.ID,
		*secondClaim.Run.ClaimToken, secondClaim.Run.AttemptCount, secondFindingInput)
	if err != nil {
		t.Fatalf("record incomplete-run finding: %v", err)
	}
	incomplete, err := repo.FinalizeRun(ctx, fixture.tenantID, second.ID,
		*secondClaim.Run.ClaimToken, secondClaim.Run.AttemptCount, FinalizeInput{GateDecision: GatePass})
	if err != nil || incomplete.State != StateIncomplete || incomplete.GateDecision != GateUnavailable ||
		incomplete.OverallScore != nil {
		t.Fatalf("incomplete finalization = %+v err=%v", incomplete, err)
	}
	if _, err := repo.CreateOverride(ctx, fixture.tenantID, second.ID, fixture.ownerID, OverrideInput{
		FindingID: secondFinding.ID, RequestID: uuid.NewString(), Decision: "allow_send",
		Reason: "This incomplete evidence must not be eligible for an allow-send waiver.",
	}); !errors.Is(err, ErrOverrideNotAllowed) {
		t.Fatalf("incomplete run override error = %v, want ErrOverrideNotAllowed", err)
	}

	loadedRun, err := repo.GetRun(ctx, fixture.tenantID, run.ID)
	if err != nil || loadedRun.State != StateStale || loadedRun.GateDecision != GateBlock {
		t.Fatalf("load exact run = %+v err=%v", loadedRun, err)
	}
	manifest, err := repo.GetRunManifest(ctx, fixture.tenantID, run.ID)
	if err != nil || manifest.Run.ID != run.ID || len(manifest.Artifacts) != 2 ||
		len(manifest.Configurations) != 2 || len(manifest.Targets) != 3 {
		t.Fatalf("load frozen manifest = %+v err=%v", manifest, err)
	}
	extractions, err := repo.ListExtractions(ctx, fixture.tenantID, run.ID)
	if err != nil || len(extractions) != 3 {
		t.Fatalf("list immutable extractions = %+v err=%v", extractions, err)
	}
	findings, err := repo.ListFindings(ctx, fixture.tenantID, run.ID)
	if err != nil || len(findings) != 2 {
		t.Fatalf("list immutable findings = %+v err=%v", findings, err)
	}
	overrides, err := repo.ListOverrides(ctx, fixture.tenantID, run.ID)
	if err != nil || len(overrides) != 1 || overrides[0].ID != override.ID {
		t.Fatalf("list immutable overrides = %+v err=%v", overrides, err)
	}

	thirdInput := dbCreateInput(fixture)
	thirdInput.RequestID = uuid.NewString()
	third, err := repo.CreateRun(ctx, fixture.tenantID, thirdInput)
	if err != nil {
		t.Fatalf("create retry/failure run: %v", err)
	}
	thirdClaim, err := repo.ClaimRun(ctx, fixture.tenantID, third.ID, "retry-control-worker", time.Minute)
	if err != nil {
		t.Fatalf("claim retry/failure run: %v", err)
	}
	retryQueued, err := repo.RetryRun(ctx, fixture.tenantID, third.ID,
		*thirdClaim.Run.ClaimToken, thirdClaim.Run.AttemptCount, time.Now(), RunFailure{
			Code: "temporary_analyzer_error", Message: "the analyzer dependency was temporarily unavailable",
		})
	if err != nil || retryQueued.State != StateQueued {
		t.Fatalf("explicit retry = %+v err=%v", retryQueued, err)
	}
	thirdRetryClaim, err := repo.ClaimRun(ctx, fixture.tenantID, third.ID, "terminal-failure-worker", time.Minute)
	if err != nil || thirdRetryClaim.Run.AttemptCount != 2 {
		t.Fatalf("claim explicit retry = %+v err=%v", thirdRetryClaim, err)
	}
	failed, err := repo.FailRun(ctx, fixture.tenantID, third.ID,
		*thirdRetryClaim.Run.ClaimToken, thirdRetryClaim.Run.AttemptCount, RunFailure{
			Code: "analyzer_failed", Message: "the analyzer could not produce a trustworthy result",
		})
	if err != nil || failed.State != StateFailed || failed.GateDecision != GateUnavailable {
		t.Fatalf("terminal failure = %+v err=%v", failed, err)
	}

	fourthInput := dbCreateInput(fixture)
	fourthInput.RequestID = uuid.NewString()
	fourth, err := repo.CreateRun(ctx, fixture.tenantID, fourthInput)
	if err != nil {
		t.Fatalf("create cancellable run: %v", err)
	}
	forgedClaimTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin tenant-only claim forgery proof: %v", err)
	}
	if _, err := forgedClaimTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		t.Fatalf("set app role for tenant-only claim proof: %v", err)
	}
	if _, err := forgedClaimTx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, fixture.tenantID); err != nil {
		t.Fatalf("bind tenant-only claim tenant: %v", err)
	}
	_, err = forgedClaimTx.Exec(ctx, `
UPDATE campaign_assurance_runs
   SET state = 'running', claim_token = gen_random_uuid(), lease_owner = 'forged-tenant',
       lease_expires_at = now() + interval '1 minute', heartbeat_at = now(),
       attempt_count = attempt_count + 1, started_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, fixture.tenantID, fourth.ID)
	if sqlState(err) != "42501" {
		t.Fatalf("tenant-only claim forgery error = %v state=%q, want 42501", err, sqlState(err))
	}
	_ = forgedClaimTx.Rollback(ctx)
	fourthClaim, err := repo.ClaimRun(ctx, fixture.tenantID, fourth.ID, "aggregate-forgery-worker", time.Minute)
	if err != nil {
		t.Fatalf("claim aggregate-forgery run: %v", err)
	}
	forgedAggregateTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin aggregate-forgery proof: %v", err)
	}
	if _, err := forgedAggregateTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		t.Fatalf("set app role for aggregate-forgery proof: %v", err)
	}
	if _, err := forgedAggregateTx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, fixture.tenantID); err != nil {
		t.Fatalf("bind aggregate-forgery tenant: %v", err)
	}
	if _, err := forgedAggregateTx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		t.Fatalf("bind aggregate-forgery worker: %v", err)
	}
	_, err = forgedAggregateTx.Exec(ctx, `
UPDATE campaign_assurance_runs
   SET state = 'complete', claim_token = NULL, lease_owner = NULL,
       lease_expires_at = NULL, heartbeat_at = NULL,
       terminal_extraction_count = required_extraction_count,
       successful_extraction_count = required_extraction_count,
       extraction_error_count = 0, gate_decision = 'pass', completed_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND claim_token = $3::uuid AND attempt_count = $4`, fixture.tenantID, fourth.ID,
		*fourthClaim.Run.ClaimToken, fourthClaim.Run.AttemptCount)
	if sqlState(err) != "55000" {
		t.Fatalf("zero-evidence aggregate forgery error = %v state=%q, want 55000", err, sqlState(err))
	}
	_ = forgedAggregateTx.Rollback(ctx)
	cancelled, err := repo.CancelRun(ctx, fixture.tenantID, fourth.ID)
	if err != nil || cancelled.State != StateCancelled || cancelled.GateDecision != GateUnavailable {
		t.Fatalf("cancel queued run = %+v err=%v", cancelled, err)
	}

	fifthInput := dbCreateInput(fixture)
	fifthInput.RequestID = uuid.NewString()
	fifth, err := repo.CreateRun(ctx, fixture.tenantID, fifthInput)
	if err != nil {
		t.Fatalf("create no-blocker gate run: %v", err)
	}
	fifthClaim, err := repo.ClaimRun(ctx, fixture.tenantID, fifth.ID, "no-blocker-worker", time.Minute)
	if err != nil {
		t.Fatalf("claim no-blocker gate run: %v", err)
	}
	for index, target := range fifthClaim.Targets {
		if _, err := repo.RecordExtraction(ctx, fixture.tenantID, fifth.ID,
			*fifthClaim.Run.ClaimToken, fifthClaim.Run.AttemptCount, extractionForTarget(target)); err != nil {
			t.Fatalf("record no-blocker target %d: %v", index, err)
		}
	}
	if _, err := repo.FinalizeRun(ctx, fixture.tenantID, fifth.ID,
		*fifthClaim.Run.ClaimToken, fifthClaim.Run.AttemptCount,
		FinalizeInput{GateDecision: GateBlock}); !errors.Is(err, ErrInvalidReceipt) {
		t.Fatalf("block gate without persisted blocker error = %v, want ErrInvalidReceipt", err)
	}
	passed, err := repo.FinalizeRun(ctx, fixture.tenantID, fifth.ID,
		*fifthClaim.Run.ClaimToken, fifthClaim.Run.AttemptCount,
		FinalizeInput{GateDecision: GatePass})
	if err != nil || passed.State != StateComplete || passed.GateDecision != GatePass {
		t.Fatalf("no-blocker pass gate = %+v err=%v", passed, err)
	}
	runs, err := repo.ListRuns(ctx, fixture.tenantID, fixture.campaignID, 100)
	if err != nil || len(runs) != 6 {
		t.Fatalf("list campaign runs = %+v err=%v, want six", runs, err)
	}

	auditRows, err := pool.Query(ctx, `
SELECT action, actor_type, COALESCE(user_id::text, ''), metadata::text
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND resource_type = 'campaign_assurance_run'
 ORDER BY id`, fixture.tenantID)
	if err != nil {
		t.Fatalf("read Campaign Assurance audit events: %v", err)
	}
	auditCounts := map[string]int{}
	for auditRows.Next() {
		var action, actorType, userID, metadata string
		if err := auditRows.Scan(&action, &actorType, &userID, &metadata); err != nil {
			auditRows.Close()
			t.Fatalf("scan Campaign Assurance audit event: %v", err)
		}
		auditCounts[action]++
		if action == auditAssuranceOverridden || action == auditAssuranceStarted {
			if actorType != "human" || userID != fixture.ownerID {
				t.Errorf("principal audit %q actor type=%q user=%q", action, actorType, userID)
			}
		} else if actorType != "system" || userID != "" {
			t.Errorf("lifecycle audit %q actor type=%q user=%q", action, actorType, userID)
		}
		lower := strings.ToLower(metadata)
		for _, forbidden := range []string{
			"subject", "body_html", "body_text", "normalized_extraction",
			"raw_output", "prompt", "provider_payload", "recipient", "mailbox",
			"error_message", "override_reason", strings.ToLower(overrideInput.Reason),
		} {
			if strings.Contains(lower, forbidden) {
				t.Errorf("audit action %q leaked %q: %s", action, forbidden, metadata)
			}
		}
	}
	if err := auditRows.Err(); err != nil {
		auditRows.Close()
		t.Fatalf("iterate Campaign Assurance audit events: %v", err)
	}
	auditRows.Close()
	wantAuditCounts := map[string]int{
		auditAssuranceStarted:    6,
		auditAssuranceCompleted:  2,
		auditAssuranceIncomplete: 2,
		auditAssuranceBlocked:    1,
		auditAssuranceOverridden: 1,
		auditAssuranceStale:      1,
	}
	if len(auditCounts) != len(wantAuditCounts) {
		t.Fatalf("Campaign Assurance audit action set = %#v, want %#v", auditCounts, wantAuditCounts)
	}
	for action, want := range wantAuditCounts {
		if got := auditCounts[action]; got != want {
			t.Errorf("Campaign Assurance audit %q count=%d, want %d", action, got, want)
		}
	}

	if _, err := pool.Exec(ctx, `
UPDATE campaign_assurance_findings SET explanation = 'rewritten'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, fixture.tenantID, finding.ID); sqlState(err) != "55000" {
		t.Fatalf("finding rewrite error = %v state=%q, want 55000", err, sqlState(err))
	}
	if _, err := pool.Exec(ctx, `
UPDATE campaign_assurance_extractions SET latency_ms = latency_ms + 1
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, fixture.tenantID, firstExtraction.ID); sqlState(err) != "55000" {
		t.Fatalf("extraction rewrite error = %v state=%q, want 55000", err, sqlState(err))
	}
	if _, err := pool.Exec(ctx, `
UPDATE campaign_assurance_overrides SET reason = reason || ' rewritten'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, fixture.tenantID, override.ID); sqlState(err) != "55000" {
		t.Fatalf("override rewrite error = %v state=%q, want 55000", err, sqlState(err))
	}

	var appRoleExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postwave_app')`).Scan(&appRoleExists); err != nil {
		t.Fatalf("inspect app role: %v", err)
	}
	if appRoleExists {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin RLS proof: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
			t.Fatalf("set app role: %v", err)
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*)::integer FROM campaign_assurance_runs`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("bare app-role rows=%d err=%v, want zero", count, err)
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, fixture.tenantID); err != nil {
			t.Fatalf("bind RLS tenant: %v", err)
		}
		if err := tx.QueryRow(ctx, `SELECT count(*)::integer FROM campaign_assurance_runs`).Scan(&count); err != nil || count != 6 {
			t.Fatalf("tenant app-role rows=%d err=%v, want six", count, err)
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, uuid.NewString()); err != nil {
			t.Fatalf("bind other tenant: %v", err)
		}
		if err := tx.QueryRow(ctx, `SELECT count(*)::integer FROM campaign_assurance_runs`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("cross-tenant app-role rows=%d err=%v, want zero", count, err)
		}
		if err := tx.Rollback(ctx); err != nil {
			t.Fatalf("finish RLS proof: %v", err)
		}
	}

	if _, err := pool.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, fixture.tenantID); err != nil {
		t.Fatalf("tenant cascade cleanup: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, fixture.foreignTenantID); err != nil {
		t.Fatalf("foreign tenant cleanup: %v", err)
	}
	deleted = true
	var remaining int
	if err := pool.QueryRow(ctx, `
SELECT count(*)::integer FROM campaign_assurance_runs WHERE tenant_id = $1::uuid`,
		fixture.tenantID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("cascade left %d assurance runs, err=%v", remaining, err)
	}

	t.Logf("verified durable assurance lifecycle for tenant %s", fixture.tenantID)
}
