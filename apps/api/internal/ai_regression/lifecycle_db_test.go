// SPDX-License-Identifier: AGPL-3.0-only

package ai_regression

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func durableLifecyclePools(t *testing.T, ctx context.Context) (*pgxpool.Pool, *pgxpool.Pool) {
	t.Helper()
	appURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if appURL == "" || adminURL == "" {
		t.Skip("DATABASE_URL (postwave_app) and POSTWAVE_TEST_ADMIN_DATABASE_URL are required for durable lifecycle DB proof")
	}
	appPool, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect application database: %v", err)
	}
	t.Cleanup(appPool.Close)
	adminPool, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect administrative database: %v", err)
	}
	t.Cleanup(adminPool.Close)

	var appUser string
	var bypassesRLS bool
	if err := appPool.QueryRow(ctx, `
SELECT current_user,
       COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false)
`).Scan(&appUser, &bypassesRLS); err != nil {
		t.Fatalf("inspect application role: %v", err)
	}
	if appUser != "postwave_app" || bypassesRLS {
		t.Skipf("DATABASE_URL must use non-bypass postwave_app; got user=%q bypassrls=%v", appUser, bypassesRLS)
	}
	var lifecycleReady bool
	if err := adminPool.QueryRow(ctx, `
SELECT to_regclass('public.ai_regression_run_examples') IS NOT NULL
   AND EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ai_regression_runs'
          AND column_name = 'retry_not_before'
   )
   AND EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ai_regression_results'
          AND column_name = 'attempt_count'
   )
   AND EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'ai_regression_results'
          AND column_name = 'durable_receipt'
   )`).Scan(&lifecycleReady); err != nil {
		t.Fatalf("inspect durable lifecycle schema: %v", err)
	}
	if !lifecycleReady {
		t.Fatal("database is configured but migration 1918 durable lifecycle schema is not applied")
	}
	return appPool, adminPool
}

func seedLifecycleTenant(t *testing.T, ctx context.Context, adminPool *pgxpool.Pool, tenantID, suffix string) {
	t.Helper()
	if _, err := adminPool.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, $2, $3, 'studio')`,
		tenantID, "AI regression lifecycle "+suffix,
		"ai-regression-lifecycle-"+suffix); err != nil {
		t.Fatalf("seed lifecycle tenant %s: %v", suffix, err)
	}
}

func stringPointer(value string) *string { return &value }

func lifecycleBreakdown(score float64) map[string]any {
	return map[string]any{
		"embedding_similarity": 0.9,
		"stylistic_distance":   0.2,
		"vocabulary_overlap":   0.8,
		"structural_match":     0.85,
		"combined":             score,
	}
}

func lifecycleSQLState(err error) string {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError.Code
	}
	return ""
}

type createRunOutcome struct {
	run *RegressionRun
	err error
}

func concurrentCreates(
	ctx context.Context,
	repo *Repo,
	tenantID string,
	input TriggerRunInput,
) [2]createRunOutcome {
	start := make(chan struct{})
	var outcomes [2]createRunOutcome
	var group sync.WaitGroup
	group.Add(len(outcomes))
	for index := range outcomes {
		go func(index int) {
			defer group.Done()
			<-start
			outcomes[index].run, outcomes[index].err = repo.CreateRun(ctx, tenantID, input)
		}(index)
	}
	close(start)
	group.Wait()
	return outcomes
}

type claimRunOutcome struct {
	claim *ClaimedRegressionRun
	err   error
}

func concurrentClaims(ctx context.Context, repo *Repo) [2]claimRunOutcome {
	start := make(chan struct{})
	var outcomes [2]claimRunOutcome
	var group sync.WaitGroup
	group.Add(len(outcomes))
	for index := range outcomes {
		go func(index int) {
			defer group.Done()
			<-start
			outcomes[index].claim, outcomes[index].err = repo.ClaimRun(
				ctx,
				fmt.Sprintf("lifecycle-worker-%d", index),
				30*time.Second,
			)
		}(index)
	}
	close(start)
	group.Wait()
	return outcomes
}

// TestDurableLifecycle_DB proves the lifecycle under the real non-bypass
// application role: forced RLS, manual/manual and worker/worker races,
// immutable attempt snapshots, retry backoff/exhaustion, stale repair,
// idempotent receipts, fail-closed completion, and terminal CAS fencing.
func TestDurableLifecycle_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	appPool, adminPool := durableLifecyclePools(t, ctx)
	repo := &Repo{Pool: appPool}

	tenantA := uuid.NewString()
	tenantB := uuid.NewString()
	suffixA := strings.ReplaceAll(tenantA, "-", "")[:16]
	suffixB := strings.ReplaceAll(tenantB, "-", "")[:16]
	seedLifecycleTenant(t, ctx, adminPool, tenantA, suffixA)
	seedLifecycleTenant(t, ctx, adminPool, tenantB, suffixB)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_, _ = adminPool.Exec(cleanupCtx, `
DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, tenantA, tenantB)
	})

	var forcedTables int
	if err := adminPool.QueryRow(ctx, `
SELECT count(*)::integer
  FROM pg_class
 WHERE oid IN (
       'ai_regression_runs'::regclass,
       'ai_regression_results'::regclass,
       'ai_regression_run_examples'::regclass
   )
   AND relrowsecurity
   AND relforcerowsecurity`).Scan(&forcedTables); err != nil {
		t.Fatalf("inspect lifecycle RLS flags: %v", err)
	}
	if forcedTables != 3 {
		t.Fatalf("forced-RLS lifecycle tables = %d, want 3", forcedTables)
	}
	var bareRows int
	if err := appPool.QueryRow(ctx, `SELECT count(*)::integer FROM ai_regression_runs`).Scan(&bareRows); err != nil {
		t.Fatalf("bare application-role run read: %v", err)
	}
	if bareRows != 0 {
		t.Fatalf("bare application-role run rows = %d, want zero", bareRows)
	}

	approvalID := uuid.NewString()
	agentRunID := uuid.NewString()
	if _, err := adminPool.Exec(ctx, `
INSERT INTO approvals (
    id, tenant_id, resource_type, resource_id, status, requested_at, expires_at
)
VALUES ($1::uuid, $2::uuid, 'campaign', gen_random_uuid(), 'approved', now(), now() + interval '1 day')`,
		approvalID, tenantA); err != nil {
		t.Fatalf("seed provenance approval: %v", err)
	}
	goldenA1, err := repo.InsertGolden(ctx, tenantA, CaptureGoldenInput{
		SurfaceKind:         SurfaceCampaignDraft,
		Brief:               "Write the frozen campaign draft",
		ApprovedOutput:      "Approved campaign draft",
		ModelID:             "source-model-a",
		ApprovalID:          approvalID,
		AgentRunID:          agentRunID,
		VoiceProfileVersion: "voice-profile-42",
	})
	if err != nil {
		t.Fatalf("seed tenant A golden one: %v", err)
	}
	manualCaptureRequestID := uuid.NewString()
	manualCapture := CaptureGoldenInput{
		SurfaceKind:    SurfaceSubjectLine,
		Brief:          "Write the frozen subject line",
		ApprovedOutput: "Approved subject line",
		ModelID:        "source-model-a",
		RequestID:      manualCaptureRequestID,
	}
	goldenA2, err := repo.InsertGolden(ctx, tenantA, manualCapture)
	if err != nil {
		t.Fatalf("seed tenant A golden two: %v", err)
	}
	replayedGoldenA2, err := repo.InsertGolden(ctx, tenantA, manualCapture)
	if err != nil {
		t.Fatalf("replay idempotent golden capture: %v", err)
	}
	if replayedGoldenA2.ID != goldenA2.ID || replayedGoldenA2.RequestID == nil || *replayedGoldenA2.RequestID != manualCaptureRequestID {
		t.Fatalf("idempotent capture receipt = %+v, want original %+v", replayedGoldenA2, goldenA2)
	}
	if count, err := repo.CountGolden(ctx, tenantA); err != nil || count != 2 {
		t.Fatalf("golden count after idempotent replay = %d, err=%v; want 2", count, err)
	}
	if _, err := adminPool.Exec(ctx, `
UPDATE ai_golden_examples
   SET brief = 'attempted evidence rewrite'
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`, tenantA, goldenA1.ID); lifecycleSQLState(err) != "55000" {
		t.Fatalf("golden evidence mutation error = %v (state %s), want SQLSTATE 55000", err, lifecycleSQLState(err))
	}
	if _, err := appPool.Exec(ctx, `
DELETE FROM ai_golden_examples
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`, tenantA, goldenA1.ID); lifecycleSQLState(err) != "42501" {
		t.Fatalf("application-role golden delete error = %v (state %s), want SQLSTATE 42501", err, lifecycleSQLState(err))
	}
	if _, err := repo.InsertGolden(ctx, tenantB, CaptureGoldenInput{
		SurfaceKind:    SurfaceReplyIntent,
		Brief:          "Classify the frozen reply",
		ApprovedOutput: "interested",
		ModelID:        "source-model-b",
	}); err != nil {
		t.Fatalf("seed tenant B golden: %v", err)
	}
	if _, err := repo.PutSettings(ctx, tenantA, RegressionSettings{
		WarnThreshold:      90,
		HardGateEnabled:    true,
		HardGateThreshold:  70,
		MinExamplesForGate: 1,
	}); err != nil {
		t.Fatalf("seed tenant A gate settings: %v", err)
	}

	createOutcomes := concurrentCreates(ctx, repo, tenantA, TriggerRunInput{
		RuntimeProvider:  "google",
		ModelID:          "gemini-3-flash",
		ModelVersionTag:  "gemini-3-flash@release-a",
		PromptVersionTag: "prompt-policy-v7",
	})
	var runA *RegressionRun
	var createSuccesses, createConflicts int
	for _, outcome := range createOutcomes {
		switch {
		case outcome.err == nil:
			createSuccesses++
			runA = outcome.run
		case errors.Is(outcome.err, ErrRunInFlight):
			createConflicts++
		default:
			t.Fatalf("concurrent manual create returned unexpected error: %v", outcome.err)
		}
	}
	if createSuccesses != 1 || createConflicts != 1 || runA == nil {
		t.Fatalf("manual/manual outcomes success=%d conflict=%d run=%+v", createSuccesses, createConflicts, runA)
	}
	if runA.RuntimeProvider != "google" || runA.ModelID != "gemini-3-flash" || runA.MaxAttempts != DefaultRunMaxAttempts {
		t.Fatalf("run runtime/retry snapshot = %+v", runA)
	}
	if _, err := repo.GetRun(ctx, tenantB, runA.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("tenant B read tenant A run: %v, want ErrNotFound", err)
	}

	// A golden added after creation must not leak into the frozen membership.
	if _, err := repo.InsertGolden(ctx, tenantA, CaptureGoldenInput{
		SurfaceKind:    SurfaceCampaignSummary,
		Brief:          "A later campaign summary",
		ApprovedOutput: "A later approved summary",
		ModelID:        "source-model-later",
	}); err != nil {
		t.Fatalf("add post-snapshot golden: %v", err)
	}
	if _, err := adminPool.Exec(ctx, `
UPDATE ai_regression_run_examples
   SET brief = 'a forbidden snapshot mutation'
 WHERE run_id = $1::uuid`, runA.ID); lifecycleSQLState(err) != "55000" {
		t.Fatalf("snapshot mutation error = %v (state %s), want SQLSTATE 55000", err, lifecycleSQLState(err))
	}

	claimOutcomes := concurrentClaims(ctx, repo)
	var claimedA *ClaimedRegressionRun
	var claimSuccesses, emptyClaims int
	for _, outcome := range claimOutcomes {
		switch {
		case outcome.err == nil:
			claimSuccesses++
			claimedA = outcome.claim
		case errors.Is(outcome.err, ErrNotFound):
			emptyClaims++
		default:
			t.Fatalf("worker/worker claim returned unexpected error: %v", outcome.err)
		}
	}
	if claimSuccesses != 1 || emptyClaims != 1 || claimedA == nil {
		t.Fatalf("worker/worker outcomes success=%d empty=%d claim=%+v", claimSuccesses, emptyClaims, claimedA)
	}
	if len(claimedA.Examples) != 2 || claimedA.Run.AttemptCount != 1 {
		t.Fatalf("frozen claim membership/attempt = (%d,%d), want (2,1)", len(claimedA.Examples), claimedA.Run.AttemptCount)
	}

	firstAttemptResult, err := repo.UpsertResult(
		ctx, tenantA, runA.ID, *claimedA.Run.ClaimToken, claimedA.Run.AttemptCount,
		UpsertRegressionResultInput{
			ExampleID:      claimedA.Examples[0].ExampleID,
			ReplayedOutput: stringPointer("superseded attempt output"),
			FidelityScore:  func() *float64 { value := 5.0; return &value }(),
			Breakdown:      lifecycleBreakdown(5),
			Severity:       "critical",
		},
	)
	if err != nil {
		t.Fatalf("persist first-attempt result: %v", err)
	}
	if firstAttemptResult.AttemptCount != 1 {
		t.Fatalf("first result attempt = %d, want 1", firstAttemptResult.AttemptCount)
	}

	retryAt := time.Now().Add(time.Hour)
	retried, err := repo.RetryRun(
		ctx, tenantA, runA.ID, *claimedA.Run.ClaimToken, claimedA.Run.AttemptCount,
		retryAt, RunFailure{Code: "voice_unavailable", Message: "the voice scorer is temporarily unavailable"},
	)
	if err != nil {
		t.Fatalf("schedule transient retry: %v", err)
	}
	if retried.Status != RunStatusPending || retried.RetryNotBefore == nil {
		t.Fatalf("retry state = %+v, want pending with retry_not_before", retried)
	}
	if _, err := repo.ClaimRun(ctx, "backoff-probe", 30*time.Second); !errors.Is(err, ErrNotFound) {
		t.Fatalf("future-backoff claim = %v, want ErrNotFound", err)
	}
	if _, err := adminPool.Exec(ctx, `
UPDATE ai_regression_runs
   SET retry_not_before = now() - interval '1 second'
 WHERE id = $1::uuid`, runA.ID); err != nil {
		t.Fatalf("make retry due: %v", err)
	}
	claimedA, err = repo.ClaimRun(ctx, "retry-worker", 30*time.Second)
	if err != nil {
		t.Fatalf("claim due retry: %v", err)
	}
	if claimedA.Run.ID != runA.ID || claimedA.Run.AttemptCount != 2 {
		t.Fatalf("retry claim = (%s,%d), want (%s,2)", claimedA.Run.ID, claimedA.Run.AttemptCount, runA.ID)
	}
	if currentResults, err := repo.ListResults(ctx, tenantA, runA.ID); err != nil || len(currentResults) != 0 {
		t.Fatalf("new attempt results = %d err=%v, want zero (old attempt retained but excluded)", len(currentResults), err)
	}
	runningReceipt, err := repo.GetRun(ctx, tenantA, runA.ID)
	if err != nil {
		t.Fatalf("read newly claimed run: %v", err)
	}
	if len(runningReceipt.BySurface) != 2 {
		t.Fatalf("running surface receipt = %+v, want two frozen surfaces", runningReceipt.BySurface)
	}
	for surface, receipt := range runningReceipt.BySurface {
		if receipt.Total != 1 || receipt.Scored != 0 || receipt.Errors != 0 ||
			receipt.MeanScore != nil || receipt.GateResult != GateAdvisory {
			t.Fatalf("unprocessed surface %s was misreported as an error: %+v", surface, receipt)
		}
	}
	if _, err := adminPool.Exec(ctx, `
INSERT INTO ai_regression_results (
    tenant_id, run_id, example_id, attempt_count, surface_kind,
    replayed_output, fidelity_score, severity
)
VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'subject_line', 'late old attempt', 50, 'warn')`,
		tenantA, runA.ID, goldenA2.ID); lifecycleSQLState(err) != "55000" {
		t.Fatalf("cross-attempt result insert error = %v (state %s), want SQLSTATE 55000", err, lifecycleSQLState(err))
	}

	resultInput := UpsertRegressionResultInput{
		ExampleID:      goldenA1.ID,
		ReplayedOutput: stringPointer("current attempt campaign output"),
		FidelityScore:  func() *float64 { value := 85.0; return &value }(),
		Breakdown:      lifecycleBreakdown(85),
		Severity:       "ok",
	}
	firstWrite, err := repo.UpsertResult(
		ctx, tenantA, runA.ID, *claimedA.Run.ClaimToken, claimedA.Run.AttemptCount, resultInput,
	)
	if err != nil {
		t.Fatalf("persist current-attempt result: %v", err)
	}
	changedScore := 10.0
	resultInput.FidelityScore = &changedScore
	resultInput.Breakdown = lifecycleBreakdown(changedScore)
	resultInput.ReplayedOutput = stringPointer("duplicate replay must not replace the first receipt")
	duplicateWrite, err := repo.UpsertResult(
		ctx, tenantA, runA.ID, *claimedA.Run.ClaimToken, claimedA.Run.AttemptCount, resultInput,
	)
	if err != nil {
		t.Fatalf("idempotent duplicate result: %v", err)
	}
	if duplicateWrite.ID != firstWrite.ID || duplicateWrite.FidelityScore == nil || *duplicateWrite.FidelityScore != 85 {
		t.Fatalf("duplicate result replaced first write: first=%+v duplicate=%+v", firstWrite, duplicateWrite)
	}
	var durableReceipt bool
	if err := adminPool.QueryRow(ctx, `
SELECT durable_receipt
  FROM ai_regression_results
 WHERE id = $1::uuid`, firstWrite.ID).Scan(&durableReceipt); err != nil {
		t.Fatalf("inspect lifecycle receipt classification: %v", err)
	}
	if !durableReceipt {
		t.Fatal("new lifecycle result was not classified as a durable receipt")
	}
	if _, err := adminPool.Exec(ctx, `
INSERT INTO ai_regression_results (
    tenant_id, run_id, example_id, attempt_count, surface_kind,
    replayed_output, fidelity_score, breakdown, severity, durable_receipt
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, 'campaign_draft',
    'attempted non-durable receipt', 85,
    '{"embedding_similarity":0.9,"stylistic_distance":0.2,"vocabulary_overlap":0.8,"structural_match":0.85,"combined":85}'::jsonb,
    'ok', false
)`, tenantA, runA.ID, goldenA1.ID, claimedA.Run.AttemptCount); lifecycleSQLState(err) != "55000" {
		t.Fatalf("non-durable lifecycle insert error = %v (state %s), want SQLSTATE 55000", err, lifecycleSQLState(err))
	}
	if _, err := adminPool.Exec(ctx, `
INSERT INTO ai_regression_results (
    tenant_id, run_id, example_id, attempt_count, surface_kind,
    replayed_output, fidelity_score, breakdown, severity
)
VALUES (
    $1::uuid, $2::uuid, NULL, $3, 'campaign_draft',
    'orphaned durable receipt', 85,
    '{"embedding_similarity":0.9,"stylistic_distance":0.2,"vocabulary_overlap":0.8,"structural_match":0.85,"combined":85}'::jsonb,
    'ok'
)`, tenantA, runA.ID, claimedA.Run.AttemptCount); lifecycleSQLState(err) != "55000" {
		t.Fatalf("snapshot-less lifecycle insert error = %v (state %s), want SQLSTATE 55000", err, lifecycleSQLState(err))
	}
	if _, err := adminPool.Exec(ctx, `
INSERT INTO ai_regression_results (
    tenant_id, run_id, example_id, attempt_count, surface_kind,
    replayed_output, fidelity_score, breakdown, severity
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, 'subject_line',
    'surface-mismatched durable receipt', 85,
    '{"embedding_similarity":0.9,"stylistic_distance":0.2,"vocabulary_overlap":0.8,"structural_match":0.85,"combined":85}'::jsonb,
    'ok'
)`, tenantA, runA.ID, goldenA1.ID, claimedA.Run.AttemptCount); lifecycleSQLState(err) != "55000" {
		t.Fatalf("surface-mismatched lifecycle insert error = %v (state %s), want SQLSTATE 55000", err, lifecycleSQLState(err))
	}
	if _, err := adminPool.Exec(ctx, `
INSERT INTO ai_regression_results (
    tenant_id, run_id, example_id, attempt_count, surface_kind,
    replayed_output, fidelity_score, breakdown, severity
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, 'subject_line',
    'receipt with a null severity', NULL, NULL, NULL
)`, tenantA, runA.ID, goldenA2.ID, claimedA.Run.AttemptCount); lifecycleSQLState(err) != "23514" {
		t.Fatalf("null-shaped lifecycle receipt error = %v (state %s), want SQLSTATE 23514", err, lifecycleSQLState(err))
	}
	if _, err := adminPool.Exec(ctx, `
UPDATE ai_regression_results
   SET fidelity_score = 1
 WHERE id = $1::uuid`, firstWrite.ID); lifecycleSQLState(err) != "55000" {
		t.Fatalf("result mutation error = %v (state %s), want SQLSTATE 55000", err, lifecycleSQLState(err))
	}
	if _, err := repo.FinalizeRun(ctx, tenantA, runA.ID, *claimedA.Run.ClaimToken, claimedA.Run.AttemptCount); !errors.Is(err, ErrSnapshotIncomplete) {
		t.Fatalf("incomplete finalization = %v, want ErrSnapshotIncomplete", err)
	}
	resultErrorCode := "generation_failed"
	resultErrorMessage := "the replay could not be generated"
	if _, err := repo.UpsertResult(
		ctx, tenantA, runA.ID, *claimedA.Run.ClaimToken, claimedA.Run.AttemptCount,
		UpsertRegressionResultInput{
			ExampleID:    goldenA2.ID,
			Severity:     "error",
			ErrorCode:    &resultErrorCode,
			ErrorMessage: &resultErrorMessage,
		},
	); err != nil {
		t.Fatalf("persist error receipt for complete coverage: %v", err)
	}
	completedA, err := repo.FinalizeRun(
		ctx, tenantA, runA.ID, *claimedA.Run.ClaimToken, claimedA.Run.AttemptCount,
	)
	if err != nil {
		t.Fatalf("finalize complete attempt: %v", err)
	}
	if completedA.Status != RunStatusCompleted || completedA.PassedExamples != 0 ||
		completedA.ScoredExamples != 1 || completedA.ErrorExamples != 1 ||
		completedA.FidelityScoreMean == nil || math.Abs(*completedA.FidelityScoreMean-85) > 0.001 ||
		completedA.GateResult == nil || *completedA.GateResult != GateAdvisory || len(completedA.BySurface) != 2 {
		t.Fatalf("authoritative completed aggregate = %+v", completedA)
	}
	campaignSurface := completedA.BySurface[SurfaceCampaignDraft]
	errorSurface := completedA.BySurface[SurfaceSubjectLine]
	if campaignSurface.Total != 1 || campaignSurface.Scored != 1 || campaignSurface.Errors != 0 ||
		campaignSurface.Passed != 0 || campaignSurface.MeanScore == nil ||
		math.Abs(*campaignSurface.MeanScore-85) > 0.001 || campaignSurface.GateResult != GatePass ||
		errorSurface.Total != 1 || errorSurface.Scored != 0 || errorSurface.Errors != 1 ||
		errorSurface.MeanScore != nil || errorSurface.GateResult != GateAdvisory {
		t.Fatalf("truthful per-surface receipts campaign=%+v error=%+v", campaignSurface, errorSurface)
	}
	if _, err := repo.FailRun(
		ctx, tenantA, runA.ID, *claimedA.Run.ClaimToken, claimedA.Run.AttemptCount,
		RunFailure{Code: "late_failure", Message: "a late worker must lose its terminal compare and swap"},
	); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("late terminal write = %v, want ErrLeaseLost", err)
	}
	if _, err := adminPool.Exec(ctx, `
UPDATE ai_regression_runs
   SET error_message = 'a forbidden terminal mutation'
 WHERE id = $1::uuid`, runA.ID); lifecycleSQLState(err) != "55000" {
		t.Fatalf("terminal mutation error = %v (state %s), want SQLSTATE 55000", err, lifecycleSQLState(err))
	}
	currentResults, err := repo.ListResults(ctx, tenantA, runA.ID)
	if err != nil {
		t.Fatalf("list current attempt evidence: %v", err)
	}
	if len(currentResults) != 2 || currentResults[0].AttemptCount != 2 {
		t.Fatalf("current attempt evidence = %+v, want two attempt-2 rows", currentResults)
	}
	for _, result := range currentResults {
		if result.Brief == nil || result.ApprovedOutput == nil || result.SourceModelID == nil {
			t.Fatalf("result is missing immutable side-by-side snapshot fields: %+v", result)
		}
	}
	var campaignSnapshot *RunExampleSnapshot
	for index := range claimedA.Examples {
		if claimedA.Examples[index].ExampleID == goldenA1.ID {
			campaignSnapshot = &claimedA.Examples[index]
			break
		}
	}
	var campaignResult *RegressionResult
	for index := range currentResults {
		if currentResults[index].ExampleID != nil && *currentResults[index].ExampleID == goldenA1.ID {
			campaignResult = &currentResults[index]
			break
		}
	}
	if campaignSnapshot == nil || campaignResult == nil || campaignResult.ApprovalID == nil ||
		*campaignResult.ApprovalID != approvalID || campaignResult.AgentRunID == nil ||
		*campaignResult.AgentRunID != agentRunID || campaignResult.VoiceProfileVersion == nil ||
		*campaignResult.VoiceProfileVersion != "voice-profile-42" ||
		campaignResult.SourceCreatedAt == nil ||
		!campaignResult.SourceCreatedAt.Equal(campaignSnapshot.SourceCreatedAt) ||
		campaignResult.SnapshottedAt == nil ||
		!campaignResult.SnapshottedAt.Equal(campaignSnapshot.SnapshottedAt) ||
		campaignResult.SnapshotOrdinal == nil ||
		*campaignResult.SnapshotOrdinal != campaignSnapshot.Ordinal {
		t.Fatalf("immutable result provenance result=%+v snapshot=%+v", campaignResult, campaignSnapshot)
	}
	if crossTenantResults, err := repo.ListResults(ctx, tenantB, runA.ID); err != nil || len(crossTenantResults) != 0 {
		t.Fatalf("tenant B result read count=%d err=%v, want zero", len(crossTenantResults), err)
	}
	var storedAttempts, currentAttemptRows int
	if err := adminPool.QueryRow(ctx, `
SELECT count(DISTINCT attempt_count)::integer,
       count(*) FILTER (WHERE attempt_count = 2)::integer
  FROM ai_regression_results
 WHERE tenant_id = $1::uuid
   AND run_id = $2::uuid`, tenantA, runA.ID).Scan(&storedAttempts, &currentAttemptRows); err != nil {
		t.Fatalf("inspect attempt-scoped receipts: %v", err)
	}
	if storedAttempts != 2 || currentAttemptRows != 2 {
		t.Fatalf("stored attempt coverage = (%d attempts,%d current rows), want (2,2)", storedAttempts, currentAttemptRows)
	}

	// A newly abandoned run is repaired back to pending, retaining its frozen
	// inputs while monotonically advancing the next claim attempt.
	staleRun, err := repo.CreateRun(ctx, tenantA, TriggerRunInput{
		RuntimeProvider:  "google",
		ModelID:          "gemini-3-flash",
		ModelVersionTag:  "stale-repair-release",
		PromptVersionTag: "prompt-policy-v7",
	})
	if err != nil {
		t.Fatalf("create stale-repair run: %v", err)
	}
	staleClaim, err := repo.ClaimRun(ctx, "stale-worker", 30*time.Second)
	if err != nil || staleClaim.Run.ID != staleRun.ID {
		t.Fatalf("claim stale-repair run = %+v err=%v", staleClaim, err)
	}
	if _, err := adminPool.Exec(ctx, `
UPDATE ai_regression_runs
   SET lease_expires_at = now() - interval '2 seconds',
       heartbeat_at = now() - interval '2 minutes'
 WHERE id = $1::uuid`, staleRun.ID); err != nil {
		t.Fatalf("expire worker lease: %v", err)
	}
	repaired, err := repo.RequeueStaleRuns(ctx, time.Now().Add(-time.Minute), 10)
	if err != nil || repaired != 1 {
		t.Fatalf("stale repair count=%d err=%v, want one", repaired, err)
	}
	staleState, err := repo.GetRun(ctx, tenantA, staleRun.ID)
	if err != nil || staleState.Status != RunStatusPending || staleState.StaleAt == nil {
		t.Fatalf("stale repair state=%+v err=%v", staleState, err)
	}
	staleClaim, err = repo.ClaimRun(ctx, "stale-retry-worker", 30*time.Second)
	if err != nil || staleClaim.Run.AttemptCount != 2 {
		t.Fatalf("post-stale claim=%+v err=%v, want attempt 2", staleClaim, err)
	}
	partialFailureScore := 92.0
	if _, err := repo.UpsertResult(
		ctx, tenantA, staleRun.ID, *staleClaim.Run.ClaimToken, staleClaim.Run.AttemptCount,
		UpsertRegressionResultInput{
			ExampleID:      staleClaim.Examples[0].ExampleID,
			ReplayedOutput: stringPointer("partial evidence persisted before terminal failure"),
			FidelityScore:  &partialFailureScore,
			Breakdown:      lifecycleBreakdown(partialFailureScore),
			Severity:       "ok",
		},
	); err != nil {
		t.Fatalf("persist partial explicit-failure receipt: %v", err)
	}
	failedPartial, err := repo.FailRun(
		ctx, tenantA, staleRun.ID, *staleClaim.Run.ClaimToken, staleClaim.Run.AttemptCount,
		RunFailure{Code: "test_cleanup", Message: "the stale-repair proof is complete"},
	)
	if err != nil {
		t.Fatalf("finish stale-repair run: %v", err)
	}
	if failedPartial.Status != RunStatusFailed || failedPartial.ScoredExamples != 1 ||
		failedPartial.ErrorExamples != 0 || failedPartial.PassedExamples != 1 ||
		failedPartial.FidelityScoreMean == nil ||
		math.Abs(*failedPartial.FidelityScoreMean-partialFailureScore) > 0.001 ||
		failedPartial.FidelityScoreP25 == nil ||
		math.Abs(*failedPartial.FidelityScoreP25-partialFailureScore) > 0.001 ||
		failedPartial.GateResult != nil {
		t.Fatalf("explicit failed-attempt receipt=%+v, want one scored and one unprocessed", failedPartial)
	}
	failedPartial, err = repo.GetRun(ctx, tenantA, staleRun.ID)
	if err != nil {
		t.Fatalf("read explicit failed-attempt surfaces: %v", err)
	}
	var failedSurfaceTotal, failedSurfaceScored, failedSurfaceErrors int
	for _, surface := range failedPartial.BySurface {
		failedSurfaceTotal += surface.Total
		failedSurfaceScored += surface.Scored
		failedSurfaceErrors += surface.Errors
	}
	if failedSurfaceTotal != len(staleClaim.Examples) || failedSurfaceScored != 1 || failedSurfaceErrors != 0 {
		t.Fatalf("failed surface receipts=%+v, want one scored and %d unprocessed without fabricated errors",
			failedPartial.BySurface, len(staleClaim.Examples)-1)
	}

	// Explicit retries respect not-before and become terminal at the frozen
	// attempt budget instead of relying on stale repair.
	retryRun, err := repo.CreateRun(ctx, tenantB, TriggerRunInput{
		RuntimeProvider:  "google",
		ModelID:          "gemini-3-flash",
		ModelVersionTag:  "retry-exhaustion-release",
		PromptVersionTag: "prompt-policy-v7",
	})
	if err != nil {
		t.Fatalf("create retry-exhaustion run: %v", err)
	}
	retryClaim, err := repo.ClaimRun(ctx, "retry-exhaustion-1", 30*time.Second)
	if err != nil || retryClaim.Run.ID != retryRun.ID {
		t.Fatalf("claim retry-exhaustion attempt one=%+v err=%v", retryClaim, err)
	}
	retryState, err := repo.RetryRun(
		ctx, tenantB, retryRun.ID, *retryClaim.Run.ClaimToken, 1,
		time.Now().Add(-time.Second), RunFailure{Code: "voice_timeout", Message: "the voice request timed out"},
	)
	if err != nil || retryState.Status != RunStatusPending {
		t.Fatalf("retry attempt one state=%+v err=%v", retryState, err)
	}
	retryClaim, err = repo.ClaimRun(ctx, "retry-exhaustion-2", 30*time.Second)
	if err != nil || retryClaim.Run.AttemptCount != 2 {
		t.Fatalf("claim retry attempt two=%+v err=%v", retryClaim, err)
	}
	if _, err := repo.RetryRun(
		ctx, tenantB, retryRun.ID, *retryClaim.Run.ClaimToken, 2,
		time.Now().Add(-time.Second), RunFailure{Code: "voice_timeout", Message: "the voice request timed out again"},
	); err != nil {
		t.Fatalf("retry attempt two: %v", err)
	}
	retryClaim, err = repo.ClaimRun(ctx, "retry-exhaustion-3", 30*time.Second)
	if err != nil || retryClaim.Run.AttemptCount != 3 {
		t.Fatalf("claim retry attempt three=%+v err=%v", retryClaim, err)
	}
	retryErrorCode := "generation_unavailable"
	retryErrorMessage := "the final replay attempt could not generate an output"
	if _, err := repo.UpsertResult(
		ctx, tenantB, retryRun.ID, *retryClaim.Run.ClaimToken, retryClaim.Run.AttemptCount,
		UpsertRegressionResultInput{
			ExampleID:    retryClaim.Examples[0].ExampleID,
			Severity:     "error",
			ErrorCode:    &retryErrorCode,
			ErrorMessage: &retryErrorMessage,
		},
	); err != nil {
		t.Fatalf("persist retry-exhaustion error receipt: %v", err)
	}
	retryState, err = repo.RetryRun(
		ctx, tenantB, retryRun.ID, *retryClaim.Run.ClaimToken, 3,
		time.Now().Add(time.Hour), RunFailure{Code: "voice_timeout", Message: "the voice request exhausted its retries"},
	)
	if err != nil || retryState.Status != RunStatusFailed || retryState.CompletedAt == nil || retryState.RetryNotBefore != nil ||
		retryState.ScoredExamples != 0 || retryState.ErrorExamples != 1 || retryState.PassedExamples != 0 ||
		retryState.FidelityScoreMean != nil || retryState.FidelityScoreP25 != nil || retryState.GateResult != nil {
		t.Fatalf("exhausted retry state=%+v err=%v", retryState, err)
	}

	// Stale repair's max-attempt branch must preserve the exact same failed
	// receipt truth as explicit failure and retry exhaustion. Two abandoned
	// attempts are requeued; the third persists one score and then expires.
	staleExhaustedRun, err := repo.CreateRun(ctx, tenantA, TriggerRunInput{
		RuntimeProvider:  "google",
		ModelID:          "gemini-3-flash",
		ModelVersionTag:  "stale-exhaustion-release",
		PromptVersionTag: "prompt-policy-v7",
	})
	if err != nil {
		t.Fatalf("create stale-exhaustion run: %v", err)
	}
	var staleExhaustedClaim *ClaimedRegressionRun
	for attempt := 1; attempt <= 3; attempt++ {
		staleExhaustedClaim, err = repo.ClaimRun(ctx, fmt.Sprintf("stale-exhaustion-%d", attempt), 30*time.Second)
		if err != nil || staleExhaustedClaim.Run.ID != staleExhaustedRun.ID ||
			staleExhaustedClaim.Run.AttemptCount != attempt {
			t.Fatalf("claim stale-exhaustion attempt %d=%+v err=%v", attempt, staleExhaustedClaim, err)
		}
		if attempt == 3 {
			staleFailureScore := 33.0
			if _, err := repo.UpsertResult(
				ctx, tenantA, staleExhaustedRun.ID, *staleExhaustedClaim.Run.ClaimToken,
				staleExhaustedClaim.Run.AttemptCount,
				UpsertRegressionResultInput{
					ExampleID:      staleExhaustedClaim.Examples[0].ExampleID,
					ReplayedOutput: stringPointer("partial evidence before stale exhaustion"),
					FidelityScore:  &staleFailureScore,
					Breakdown:      lifecycleBreakdown(staleFailureScore),
					Severity:       "critical",
				},
			); err != nil {
				t.Fatalf("persist stale-exhaustion partial receipt: %v", err)
			}
		}
		if _, err := adminPool.Exec(ctx, `
UPDATE ai_regression_runs
   SET lease_expires_at = now() - interval '2 seconds',
       heartbeat_at = now() - interval '2 minutes'
 WHERE id = $1::uuid`, staleExhaustedRun.ID); err != nil {
			t.Fatalf("expire stale-exhaustion attempt %d: %v", attempt, err)
		}
		repaired, err := repo.RequeueStaleRuns(ctx, time.Now().Add(-time.Minute), 10)
		if err != nil || repaired != 1 {
			t.Fatalf("repair stale-exhaustion attempt %d count=%d err=%v", attempt, repaired, err)
		}
		state, err := repo.GetRun(ctx, tenantA, staleExhaustedRun.ID)
		if err != nil {
			t.Fatalf("read stale-exhaustion attempt %d: %v", attempt, err)
		}
		if attempt < 3 && state.Status != RunStatusPending {
			t.Fatalf("stale-exhaustion attempt %d state=%+v, want pending", attempt, state)
		}
		if attempt == 3 && (state.Status != RunStatusFailed || state.ScoredExamples != 1 ||
			state.ErrorExamples != 0 || state.PassedExamples != 0 || state.FidelityScoreMean == nil ||
			math.Abs(*state.FidelityScoreMean-33) > 0.001 || state.FidelityScoreP25 == nil ||
			math.Abs(*state.FidelityScoreP25-33) > 0.001 || state.GateResult != nil) {
			t.Fatalf("stale-exhaustion terminal receipt=%+v, want one scored and one unprocessed", state)
		}
	}

	// Finalize and Fail racing the same token/attempt have one winner. The
	// loser observes ErrLeaseLost and cannot mutate the terminal outcome.
	terminalRun, err := repo.CreateRun(ctx, tenantB, TriggerRunInput{
		RuntimeProvider:  "google",
		ModelID:          "gemini-3-flash",
		ModelVersionTag:  "terminal-cas-release",
		PromptVersionTag: "prompt-policy-v7",
	})
	if err != nil {
		t.Fatalf("create terminal-CAS run: %v", err)
	}
	terminalClaim, err := repo.ClaimRun(ctx, "terminal-cas-worker", 30*time.Second)
	if err != nil || terminalClaim.Run.ID != terminalRun.ID {
		t.Fatalf("claim terminal-CAS run=%+v err=%v", terminalClaim, err)
	}
	terminalScore := 91.0
	if _, err := repo.UpsertResult(
		ctx, tenantB, terminalRun.ID, *terminalClaim.Run.ClaimToken, terminalClaim.Run.AttemptCount,
		UpsertRegressionResultInput{
			ExampleID:      terminalClaim.Examples[0].ExampleID,
			ReplayedOutput: stringPointer("terminal CAS replay"),
			FidelityScore:  &terminalScore,
			Breakdown:      lifecycleBreakdown(terminalScore),
			Severity:       "ok",
		},
	); err != nil {
		t.Fatalf("persist terminal-CAS result: %v", err)
	}
	startTerminal := make(chan struct{})
	terminalErrors := make(chan error, 2)
	go func() {
		<-startTerminal
		_, finalizeErr := repo.FinalizeRun(
			ctx, tenantB, terminalRun.ID, *terminalClaim.Run.ClaimToken, terminalClaim.Run.AttemptCount,
		)
		terminalErrors <- finalizeErr
	}()
	go func() {
		<-startTerminal
		_, failErr := repo.FailRun(
			ctx, tenantB, terminalRun.ID, *terminalClaim.Run.ClaimToken, terminalClaim.Run.AttemptCount,
			RunFailure{Code: "terminal_race", Message: "only one terminal compare and swap may succeed"},
		)
		terminalErrors <- failErr
	}()
	close(startTerminal)
	var terminalSuccesses, terminalLeaseLosses int
	for range 2 {
		terminalErr := <-terminalErrors
		switch {
		case terminalErr == nil:
			terminalSuccesses++
		case errors.Is(terminalErr, ErrLeaseLost):
			terminalLeaseLosses++
		default:
			t.Fatalf("terminal race returned unexpected error: %v", terminalErr)
		}
	}
	if terminalSuccesses != 1 || terminalLeaseLosses != 1 {
		t.Fatalf("terminal race success=%d lease_loss=%d, want one each", terminalSuccesses, terminalLeaseLosses)
	}
	terminalState, err := repo.GetRun(ctx, tenantB, terminalRun.ID)
	if err != nil || (terminalState.Status != RunStatusCompleted && terminalState.Status != RunStatusFailed) {
		t.Fatalf("terminal race state=%+v err=%v", terminalState, err)
	}

	// The Voice contract defines p25 as nearest-rank. With two scores the
	// first ordered score is the 25th percentile; interpolation would fabricate
	// a value between observations.
	if _, err := repo.InsertGolden(ctx, tenantB, CaptureGoldenInput{
		SurfaceKind:    SurfaceCampaignDraft,
		Brief:          "A second reference for nearest-rank p25",
		ApprovedOutput: "A second approved reference",
		ModelID:        "source-model-b",
	}); err != nil {
		t.Fatalf("seed nearest-rank golden: %v", err)
	}
	p25Run, err := repo.CreateRun(ctx, tenantB, TriggerRunInput{
		RuntimeProvider:  "google",
		ModelID:          "gemini-3-flash",
		ModelVersionTag:  "nearest-rank-release",
		PromptVersionTag: "prompt-policy-v7",
	})
	if err != nil {
		t.Fatalf("create nearest-rank run: %v", err)
	}
	p25Claim, err := repo.ClaimRun(ctx, "nearest-rank-worker", 30*time.Second)
	if err != nil || p25Claim.Run.ID != p25Run.ID || len(p25Claim.Examples) != 2 {
		t.Fatalf("claim nearest-rank run=%+v err=%v", p25Claim, err)
	}
	for index, example := range p25Claim.Examples {
		score := []float64{20, 80}[index]
		if _, err := repo.UpsertResult(
			ctx, tenantB, p25Run.ID, *p25Claim.Run.ClaimToken, p25Claim.Run.AttemptCount,
			UpsertRegressionResultInput{
				ExampleID:      example.ExampleID,
				ReplayedOutput: stringPointer("nearest-rank replay"),
				FidelityScore:  &score,
				Breakdown:      lifecycleBreakdown(score),
				Severity:       "ok",
			},
		); err != nil {
			t.Fatalf("persist nearest-rank result %d: %v", index, err)
		}
	}
	p25Completed, err := repo.FinalizeRun(
		ctx, tenantB, p25Run.ID, *p25Claim.Run.ClaimToken, p25Claim.Run.AttemptCount,
	)
	if err != nil || p25Completed.FidelityScoreP25 == nil ||
		math.Abs(*p25Completed.FidelityScoreP25-20) > 0.001 ||
		p25Completed.PassedExamples != 1 || p25Completed.ScoredExamples != 2 ||
		p25Completed.ErrorExamples != 0 {
		t.Fatalf("nearest-rank completion=%+v err=%v", p25Completed, err)
	}

	countBeforeArchive, err := repo.CountGolden(ctx, tenantA)
	if err != nil {
		t.Fatalf("count golden references before archive: %v", err)
	}
	if err := repo.ArchiveGolden(ctx, tenantA, goldenA2.ID); err != nil {
		t.Fatalf("archive golden reference: %v", err)
	}
	if err := repo.ArchiveGolden(ctx, tenantA, goldenA2.ID); err != nil {
		t.Fatalf("retry committed golden archive: %v", err)
	}
	if count, err := repo.CountGolden(ctx, tenantA); err != nil || count != countBeforeArchive-1 {
		t.Fatalf("golden count after idempotent archive = %d, err=%v; want %d", count, err, countBeforeArchive-1)
	}
}
