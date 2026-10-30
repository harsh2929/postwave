// SPDX-License-Identifier: AGPL-3.0-only

package agent_routines

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// This source-level invariant complements the optional pg-backed race test.
// It runs in every CI environment, including jobs without DATABASE_URL, and
// makes a future scan-only scheduler downgrade conspicuous.
func TestSchedulerProductionClaimContract(t *testing.T) {
	repoSource, err := os.ReadFile("repo.go")
	if err != nil {
		t.Fatalf("read repo.go: %v", err)
	}
	repoBlock := string(repoSource)
	requiredRepoMarkers := []string{
		"func (r *Repo) ClaimDue(",
		"func (r *Repo) scanDueCandidates(",
		"func (r *Repo) claimDueRoutine(",
		"UPDATE agent_routines",
		"last_run_at <= now()",
		"INSERT INTO agent_routine_runs",
		"SET last_run_at = now()",
		"func (r *Repo) FailStaleRuns(",
		"func (r *Repo) scanStaleRuns(",
		"func (r *Repo) failStaleRun(",
		"status = 'running' AND started_at <",
		"AND status = 'running'",
		"FOR UPDATE",
		"routineHasActiveRun",
		"ErrRoutineActive",
		"isRoutineActiveViolation",
	}
	for _, marker := range requiredRepoMarkers {
		if !strings.Contains(repoBlock, marker) {
			t.Fatalf("repo production claim contract missing %q", marker)
		}
	}

	schedulerSource, err := os.ReadFile("scheduler.go")
	if err != nil {
		t.Fatalf("read scheduler.go: %v", err)
	}
	schedulerBlock := string(schedulerSource)
	for _, marker := range []string{
		"s.Repo.FailStaleRuns(",
		"s.Repo.ClaimDue(",
		"s.Runner.ExecuteSafely(",
	} {
		if !strings.Contains(schedulerBlock, marker) {
			t.Fatalf("scheduler production execution contract missing %q", marker)
		}
	}
	if strings.Contains(schedulerBlock, "s.Runner.Start(") {
		t.Fatal("scheduler must execute the run receipt created by ClaimDue, not insert a second receipt")
	}

	migration, err := os.ReadFile("../../../../infra/migrations/1917_agent_routine_active_run_guard.sql")
	if err != nil {
		t.Fatalf("read active-run migration: %v", err)
	}
	migrationBlock := string(migration)
	for _, marker := range []string{
		"agent_routine_runs_one_active_idx",
		"CREATE UNIQUE INDEX CONCURRENTLY",
		"agent_routine_runs_one_active_guard",
		"WHERE status = 'running'",
		"agent_routines_active_run_guard",
		"BEFORE UPDATE OR DELETE ON agent_routines",
		"routine execution was interrupted before completion",
	} {
		if !strings.Contains(migrationBlock, marker) {
			t.Fatalf("active-run database contract missing %q", marker)
		}
	}
}

func TestAgentRoutineOpenAPIActiveRunContract(t *testing.T) {
	canonicalYAML, err := os.ReadFile("../../../../packages/openapi/openapi.yaml")
	if err != nil {
		t.Fatalf("read canonical OpenAPI YAML: %v", err)
	}
	yamlBlock := string(canonicalYAML)
	for _, marker := range []string{
		"- has_active_run",
		"has_active_run:",
		"409 routine_active",
		"before a model request is made",
		"cannot be started again, patched, or",
	} {
		if !strings.Contains(yamlBlock, marker) {
			t.Fatalf("agent-routine OpenAPI contract missing %q", marker)
		}
	}

	canonicalJSON, err := os.ReadFile("../../../../packages/openapi/openapi.json")
	if err != nil {
		t.Fatalf("read canonical OpenAPI JSON: %v", err)
	}
	embeddedJSON, err := os.ReadFile("../apidocs/openapi.json")
	if err != nil {
		t.Fatalf("read embedded API docs JSON: %v", err)
	}
	if !bytes.Equal(canonicalJSON, embeddedJSON) {
		t.Fatal("embedded API docs JSON is not the generated canonical OpenAPI JSON")
	}
	jsonBlock := string(canonicalJSON)
	for _, marker := range []string{
		`"has_active_run"`,
		`409 routine_active`,
		`before a model request is made`,
	} {
		if !strings.Contains(jsonBlock, marker) {
			t.Fatalf("generated agent-routine OpenAPI contract missing %q", marker)
		}
	}
}

func TestRepoConcurrentManualStartsAndActiveMutationGuard_DB(t *testing.T) {
	fixture := newTargetSegmentDBFixture(t)
	repo := &Repo{Pool: fixture.pool}
	routine, err := repo.CreateRoutine(fixture.context, fixture.tenantID, CreateInput{
		Name:     "manual-active-race-" + time.Now().UTC().Format("150405.000000000"),
		Prompt:   "Draft once with a stable configuration.",
		Kind:     KindDraftCampaign,
		Schedule: ScheduleManual,
	}, "db-test@example.test")
	if err != nil {
		t.Fatalf("create routine: %v", err)
	}
	indexTx, err := db.WithTenant(fixture.context, fixture.pool, fixture.tenantID)
	if err != nil {
		t.Fatalf("open index inspection: %v", err)
	}
	var activeIndex string
	if err := indexTx.QueryRow(fixture.context, `
SELECT COALESCE(to_regclass('agent_routine_runs_one_active_idx')::text, '')`).Scan(&activeIndex); err != nil {
		_ = indexTx.Rollback(fixture.context)
		t.Fatalf("inspect active-run index: %v", err)
	}
	if err := indexTx.Commit(fixture.context); err != nil {
		t.Fatalf("commit index inspection: %v", err)
	}
	if activeIndex == "" {
		t.Fatal("agent_routine_runs_one_active_idx is missing")
	}

	start := make(chan struct{})
	type startResult struct {
		id  string
		err error
	}
	results := make(chan startResult, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for range 2 {
		go func() {
			ready.Done()
			<-start
			runID, startErr := repo.InsertRun(fixture.context, fixture.tenantID, routine.ID)
			results <- startResult{id: runID, err: startErr}
		}()
	}
	ready.Wait()
	close(start)

	runID := ""
	succeeded := 0
	conflicted := 0
	for range 2 {
		result := <-results
		switch {
		case result.err == nil:
			succeeded++
			runID = result.id
			cleanupRunID := result.id
			t.Cleanup(func() {
				_ = repo.FinishRun(context.Background(), fixture.tenantID, cleanupRunID,
					FinishRunInput{Status: RunStatusFailed, ErrMsg: "test cleanup"})
			})
		case errors.Is(result.err, ErrRoutineActive):
			conflicted++
		default:
			t.Fatalf("InsertRun error = %v", result.err)
		}
	}
	if succeeded != 1 || conflicted != 1 || strings.TrimSpace(runID) == "" {
		t.Fatalf("starts: succeeded=%d conflicted=%d runID=%q", succeeded, conflicted, runID)
	}

	active, err := repo.GetRoutine(fixture.context, fixture.tenantID, routine.ID)
	if err != nil {
		t.Fatalf("get active routine: %v", err)
	}
	if !active.HasActiveRun {
		t.Fatal("routine response did not expose the running receipt")
	}
	changedName := "must not change while active"
	if _, err := repo.UpdateRoutine(fixture.context, fixture.tenantID, routine.ID,
		UpdateInput{Name: &changedName}); !errors.Is(err, ErrRoutineActive) {
		t.Fatalf("active update error = %v, want ErrRoutineActive", err)
	}
	if err := repo.DeleteRoutine(fixture.context, fixture.tenantID, routine.ID); !errors.Is(err, ErrRoutineActive) {
		t.Fatalf("active delete error = %v, want ErrRoutineActive", err)
	}
	directDelete, err := db.WithTenant(fixture.context, fixture.pool, fixture.tenantID)
	if err != nil {
		t.Fatalf("open direct delete transaction: %v", err)
	}
	_, directErr := directDelete.Exec(fixture.context, `
DELETE FROM agent_routines
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, fixture.tenantID, routine.ID)
	_ = directDelete.Rollback(fixture.context)
	if !isRoutineActiveViolation(directErr) {
		t.Fatalf("direct active delete error = %v, want database active-run guard", directErr)
	}
	runs, err := repo.ListRuns(fixture.context, fixture.tenantID, routine.ID, 10)
	if err != nil {
		t.Fatalf("list preserved run: %v", err)
	}
	if len(runs) != 1 || runs[0].ID != runID || runs[0].Status != RunStatusRunning {
		t.Fatalf("active delete changed ledger: %+v", runs)
	}

	if err := repo.FinishRun(fixture.context, fixture.tenantID, runID,
		FinishRunInput{Status: RunStatusFailed, ErrMsg: "test terminal receipt"}); err != nil {
		t.Fatalf("finish run: %v", err)
	}
	if _, err := repo.UpdateRoutine(fixture.context, fixture.tenantID, routine.ID,
		UpdateInput{Name: &changedName}); err != nil {
		t.Fatalf("update after terminal receipt: %v", err)
	}
	if err := repo.DeleteRoutine(fixture.context, fixture.tenantID, routine.ID); err != nil {
		t.Fatalf("delete after terminal receipt: %v", err)
	}
}

func TestRepoInsertRunRacesClaimDue_DB(t *testing.T) {
	fixture := newTargetSegmentDBFixture(t)
	repo := &Repo{Pool: fixture.pool}
	routine, err := repo.CreateRoutine(fixture.context, fixture.tenantID, CreateInput{
		Name:     "manual-scheduler-race-" + time.Now().UTC().Format("150405.000000000"),
		Prompt:   "Draft exactly once across manual and scheduled replicas.",
		Kind:     KindDraftCampaign,
		Schedule: ScheduleDaily,
	}, "db-test@example.test")
	if err != nil {
		t.Fatalf("create due routine: %v", err)
	}
	// Exercise the public ClaimDue lifecycle while constraining its discovery
	// phase to the one fixture row. Production's nil scanner still uses the
	// cross-tenant worker/RLS query; this test must never claim another tenant's
	// due work when DATABASE_URL points at a shared developer database.
	repo.dueCandidateScan = func(context.Context, int) ([]DueRoutine, error) {
		return []DueRoutine{{RoutineID: routine.ID, TenantID: fixture.tenantID}}, nil
	}

	type manualResult struct {
		id  string
		err error
	}
	type schedulerResult struct {
		claims []DueRoutine
		err    error
	}
	start := make(chan struct{})
	manual := make(chan manualResult, 1)
	scheduled := make(chan schedulerResult, 1)
	var ready sync.WaitGroup
	ready.Add(2)
	go func() {
		ready.Done()
		<-start
		runID, startErr := repo.InsertRun(fixture.context, fixture.tenantID, routine.ID)
		manual <- manualResult{id: runID, err: startErr}
	}()
	go func() {
		ready.Done()
		<-start
		claims, claimErr := repo.ClaimDue(fixture.context, schedulerClaimMaxBatch)
		scheduled <- schedulerResult{claims: claims, err: claimErr}
	}()
	ready.Wait()
	close(start)

	manualOutcome := <-manual
	schedulerOutcome := <-scheduled
	if manualOutcome.err == nil {
		t.Cleanup(func() {
			_ = repo.FinishRun(context.Background(), fixture.tenantID, manualOutcome.id,
				FinishRunInput{Status: RunStatusFailed, ErrMsg: "test cleanup"})
		})
	}
	if schedulerOutcome.err != nil {
		t.Fatalf("ClaimDue: %v", schedulerOutcome.err)
	}
	for _, claim := range schedulerOutcome.claims {
		if claim.RoutineID != routine.ID || claim.TenantID != fixture.tenantID {
			t.Fatalf("fixture-scoped ClaimDue returned unrelated claim: %+v", claim)
		}
		claim := claim
		t.Cleanup(func() {
			_ = repo.FinishRun(context.Background(), fixture.tenantID, claim.RunID,
				FinishRunInput{Status: RunStatusFailed, ErrMsg: "test cleanup"})
		})
	}
	targetClaims := make([]DueRoutine, 0, 1)
	for _, claim := range schedulerOutcome.claims {
		if claim.RoutineID == routine.ID && claim.TenantID == fixture.tenantID {
			targetClaims = append(targetClaims, claim)
		}
	}
	switch {
	case manualOutcome.err == nil:
		if strings.TrimSpace(manualOutcome.id) == "" || len(targetClaims) != 0 {
			t.Fatalf("manual winner: run=%q target scheduler claims=%+v", manualOutcome.id, targetClaims)
		}
	case errors.Is(manualOutcome.err, ErrRoutineActive):
		if len(targetClaims) != 1 || strings.TrimSpace(targetClaims[0].RunID) == "" {
			t.Fatalf("scheduler winner: manual=%v target scheduler claims=%+v", manualOutcome.err, targetClaims)
		}
	default:
		t.Fatalf("manual start error = %v, want success or ErrRoutineActive", manualOutcome.err)
	}

	runs, err := repo.ListRuns(fixture.context, fixture.tenantID, routine.ID, 10)
	if err != nil {
		t.Fatalf("ListRuns: %v", err)
	}
	running := make([]Run, 0, 1)
	for _, run := range runs {
		if run.Status == RunStatusRunning {
			running = append(running, run)
		}
	}
	if len(running) != 1 {
		t.Fatalf("manual/scheduler race left %d running receipts: %+v", len(running), runs)
	}
	winnerID := manualOutcome.id
	if len(targetClaims) == 1 {
		winnerID = targetClaims[0].RunID
	}
	if running[0].ID != winnerID {
		t.Fatalf("running receipt=%s, winner=%s", running[0].ID, winnerID)
	}
}

func TestRepoInsertRunRacesDeleteRoutine_DB(t *testing.T) {
	fixture := newTargetSegmentDBFixture(t)
	repo := &Repo{Pool: fixture.pool}
	routine, err := repo.CreateRoutine(fixture.context, fixture.tenantID, CreateInput{
		Name:     "manual-delete-race-" + time.Now().UTC().Format("150405.000000000"),
		Prompt:   "Keep an accepted run receipt durable.",
		Kind:     KindDraftCampaign,
		Schedule: ScheduleManual,
	}, "db-test@example.test")
	if err != nil {
		t.Fatalf("create routine: %v", err)
	}

	type startResult struct {
		id  string
		err error
	}
	start := make(chan struct{})
	manual := make(chan startResult, 1)
	deleted := make(chan error, 1)
	var ready sync.WaitGroup
	ready.Add(2)
	go func() {
		ready.Done()
		<-start
		runID, startErr := repo.InsertRun(fixture.context, fixture.tenantID, routine.ID)
		manual <- startResult{id: runID, err: startErr}
	}()
	go func() {
		ready.Done()
		<-start
		deleted <- repo.DeleteRoutine(fixture.context, fixture.tenantID, routine.ID)
	}()
	ready.Wait()
	close(start)

	manualOutcome := <-manual
	deleteErr := <-deleted
	if manualOutcome.err == nil {
		t.Cleanup(func() {
			_ = repo.FinishRun(context.Background(), fixture.tenantID, manualOutcome.id,
				FinishRunInput{Status: RunStatusFailed, ErrMsg: "test cleanup"})
		})
	}

	switch {
	case deleteErr == nil:
		if !errors.Is(manualOutcome.err, ErrNotFound) || manualOutcome.id != "" {
			t.Fatalf("delete winner: manual run=%q err=%v, want empty/ErrNotFound", manualOutcome.id, manualOutcome.err)
		}
		if _, err := repo.GetRoutine(fixture.context, fixture.tenantID, routine.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("deleted routine read error = %v, want ErrNotFound", err)
		}
		runs, err := repo.ListRuns(fixture.context, fixture.tenantID, routine.ID, 10)
		if err != nil {
			t.Fatalf("list deleted routine ledger: %v", err)
		}
		if len(runs) != 0 {
			t.Fatalf("delete winner left orphan receipts: %+v", runs)
		}
	case manualOutcome.err == nil:
		if !errors.Is(deleteErr, ErrRoutineActive) || strings.TrimSpace(manualOutcome.id) == "" {
			t.Fatalf("start winner: run=%q delete err=%v, want run/ErrRoutineActive", manualOutcome.id, deleteErr)
		}
		persisted, err := repo.GetRoutine(fixture.context, fixture.tenantID, routine.ID)
		if err != nil {
			t.Fatalf("get start winner: %v", err)
		}
		if !persisted.HasActiveRun {
			t.Fatal("start winner routine did not expose has_active_run")
		}
		runs, err := repo.ListRuns(fixture.context, fixture.tenantID, routine.ID, 10)
		if err != nil {
			t.Fatalf("list start winner ledger: %v", err)
		}
		if len(runs) != 1 || runs[0].ID != manualOutcome.id || runs[0].Status != RunStatusRunning {
			t.Fatalf("start winner ledger was orphaned or cascade-erased: %+v", runs)
		}
	default:
		t.Fatalf("invalid race result: start run=%q err=%v; delete err=%v", manualOutcome.id, manualOutcome.err, deleteErr)
	}
}

func TestRepoClaimDueIsAtomicAcrossReplicas_DB(t *testing.T) {
	fixture := newTargetSegmentDBFixture(t)
	repo := &Repo{Pool: fixture.pool}
	routine, err := repo.CreateRoutine(fixture.context, fixture.tenantID, CreateInput{
		Name:     "claim-race-" + time.Now().UTC().Format("150405.000000000"),
		Prompt:   "Draft one safely claimed campaign.",
		Kind:     KindDraftCampaign,
		Schedule: ScheduleDaily,
	}, "db-test@example.test")
	if err != nil {
		t.Fatalf("create due routine: %v", err)
	}
	repo.dueCandidateScan = func(context.Context, int) ([]DueRoutine, error) {
		return []DueRoutine{{RoutineID: routine.ID, TenantID: fixture.tenantID}}, nil
	}

	start := make(chan struct{})
	results := make(chan []DueRoutine, 2)
	errs := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for range 2 {
		go func() {
			ready.Done()
			<-start
			claimed, claimErr := repo.ClaimDue(fixture.context, schedulerClaimMaxBatch)
			results <- claimed
			errs <- claimErr
		}()
	}
	ready.Wait()
	close(start)

	targetClaims := []DueRoutine{}
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatalf("ClaimDue: %v", err)
		}
		for _, claimed := range <-results {
			if claimed.RoutineID == routine.ID {
				targetClaims = append(targetClaims, claimed)
			}
		}
	}
	if len(targetClaims) != 1 || strings.TrimSpace(targetClaims[0].RunID) == "" {
		t.Fatalf("target claims=%+v, want one durable run receipt", targetClaims)
	}
	t.Cleanup(func() {
		_ = repo.FinishRun(context.Background(), fixture.tenantID, targetClaims[0].RunID,
			FinishRunInput{Status: RunStatusFailed, ErrMsg: "test cleanup"})
	})
	runs, err := repo.ListRuns(fixture.context, fixture.tenantID, routine.ID, 10)
	if err != nil {
		t.Fatalf("ListRuns: %v", err)
	}
	if len(runs) != 1 || runs[0].ID != targetClaims[0].RunID || runs[0].Status != RunStatusRunning {
		t.Fatalf("runs=%+v, want the one claimed running receipt", runs)
	}
	persisted, err := repo.GetRoutine(fixture.context, fixture.tenantID, routine.ID)
	if err != nil {
		t.Fatalf("GetRoutine: %v", err)
	}
	if persisted.LastRunAt == nil {
		t.Fatal("claimed routine did not persist its attempt timestamp")
	}
}

func TestRepoFailStaleRunsLeavesFreshReceiptUntouched_DB(t *testing.T) {
	fixture := newTargetSegmentDBFixture(t)
	repo := &Repo{Pool: fixture.pool}
	create := func(name string) (*Routine, string) {
		t.Helper()
		routine, err := repo.CreateRoutine(fixture.context, fixture.tenantID, CreateInput{
			Name: name, Prompt: "Draft safely.", Kind: KindDraftCampaign, Schedule: ScheduleManual,
		}, "db-test@example.test")
		if err != nil {
			t.Fatalf("create routine: %v", err)
		}
		runID, err := repo.InsertRun(fixture.context, fixture.tenantID, routine.ID)
		if err != nil {
			t.Fatalf("InsertRun: %v", err)
		}
		return routine, runID
	}
	staleRoutine, staleRunID := create("stale-receipt-" + time.Now().UTC().Format("150405.000000000"))
	freshRoutine, freshRunID := create("fresh-receipt-" + time.Now().UTC().Format("150405.000000000"))
	for _, runID := range []string{staleRunID, freshRunID} {
		runID := runID
		t.Cleanup(func() {
			_ = repo.FinishRun(context.Background(), fixture.tenantID, runID,
				FinishRunInput{Status: RunStatusFailed, ErrMsg: "test cleanup"})
		})
	}

	tx, err := fixture.pool.Begin(fixture.context)
	if err != nil {
		t.Fatalf("begin timestamp fixture: %v", err)
	}
	if _, err := tx.Exec(fixture.context,
		"SELECT set_config('app.tenant_id', $1, true)", fixture.tenantID); err != nil {
		_ = tx.Rollback(fixture.context)
		t.Fatalf("bind tenant: %v", err)
	}
	if _, err := tx.Exec(fixture.context, `
UPDATE agent_routine_runs SET started_at = now() - interval '20 minutes'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, fixture.tenantID, staleRunID); err != nil {
		_ = tx.Rollback(fixture.context)
		t.Fatalf("age stale run: %v", err)
	}
	if err := tx.Commit(fixture.context); err != nil {
		t.Fatalf("commit timestamp fixture: %v", err)
	}

	cutoff := time.Now().UTC().Add(-schedulerStaleRunAfter)
	repo.staleRunScan = func(context.Context, time.Time, int) ([]staleRunCandidate, error) {
		return []staleRunCandidate{{id: staleRunID, tenantID: fixture.tenantID}}, nil
	}
	start := make(chan struct{})
	counts := make(chan int, 2)
	errs := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			count, finalizeErr := repo.FailStaleRuns(
				fixture.context, cutoff, schedulerStaleMaxBatch,
			)
			counts <- count
			errs <- finalizeErr
		}()
	}
	close(start)
	finalized := 0
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatalf("FailStaleRuns: %v", err)
		}
		finalized += <-counts
	}
	if finalized != 1 {
		t.Fatalf("finalized across replicas=%d, want 1", finalized)
	}
	staleRuns, err := repo.ListRuns(fixture.context, fixture.tenantID, staleRoutine.ID, 10)
	if err != nil {
		t.Fatalf("list stale runs: %v", err)
	}
	freshRuns, err := repo.ListRuns(fixture.context, fixture.tenantID, freshRoutine.ID, 10)
	if err != nil {
		t.Fatalf("list fresh runs: %v", err)
	}
	if len(staleRuns) != 1 || staleRuns[0].Status != RunStatusFailed ||
		staleRuns[0].Error != staleRunInterruptedError || staleRuns[0].FinishedAt == nil {
		t.Fatalf("stale receipt=%+v", staleRuns)
	}
	if len(freshRuns) != 1 || freshRuns[0].ID != freshRunID ||
		freshRuns[0].Status != RunStatusRunning || freshRuns[0].FinishedAt != nil || freshRuns[0].Error != "" {
		t.Fatalf("fresh receipt=%+v", freshRuns)
	}
	if err := repo.FinishRun(fixture.context, fixture.tenantID, staleRunID, FinishRunInput{
		Status: RunStatusSucceeded,
	}); !errors.Is(err, ErrRunNotRunning) {
		t.Fatalf("late terminal overwrite error=%v, want ErrRunNotRunning", err)
	}
	staleRuns, err = repo.ListRuns(fixture.context, fixture.tenantID, staleRoutine.ID, 10)
	if err != nil {
		t.Fatalf("re-list stale runs: %v", err)
	}
	if staleRuns[0].Status != RunStatusFailed || staleRuns[0].Error != staleRunInterruptedError {
		t.Fatalf("late writer overwrote stale terminal receipt: %+v", staleRuns[0])
	}
}
