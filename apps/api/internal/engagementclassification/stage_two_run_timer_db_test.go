// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// stageTwoLeastTenantID is the least uuid there is, so a one-tenant sweep page
// opened at the empty cursor lands on it and on nothing else. StageTwoWorker.Run
// hardcodes its opening cursor to "", so this is the only way to make the FIRST
// tick of a real Run reach a fixture in a shared database.
const stageTwoLeastTenantID = "00000000-0000-0000-0000-000000000000"

// stageTwoSweepCursorTracer records the tenant cursor SweepOnce was actually
// called with, by tapping listTenantPage's query on the wire.
//
// This is the only observable that distinguishes "Run called SweepOnce" from
// "Run called SweepOnce and carried the cursor forward": SweepOnce is a method
// on a concrete type, and the cursor Run holds between ticks is a local
// variable. The tap is on runtime behaviour — a query issued with an argument —
// not on source text.
type stageTwoSweepCursorTracer struct {
	mu      sync.Mutex
	cursors []string
}

func (tracer *stageTwoSweepCursorTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	// listTenantPage is the first statement of every sweep and the only one that
	// pages the tenants table by a text cursor.
	if strings.Contains(data.SQL, "FROM tenants") &&
		strings.Contains(data.SQL, "id::text > $1") && len(data.Args) > 0 {
		cursor, _ := data.Args[0].(string)
		tracer.mu.Lock()
		tracer.cursors = append(tracer.cursors, cursor)
		tracer.mu.Unlock()
	}
	return ctx
}

func (tracer *stageTwoSweepCursorTracer) TraceQueryEnd(
	context.Context, *pgx.Conn, pgx.TraceQueryEndData,
) {
}

func (tracer *stageTwoSweepCursorTracer) snapshot() []string {
	tracer.mu.Lock()
	defer tracer.mu.Unlock()
	return append([]string(nil), tracer.cursors...)
}

func tracedClassifierAppPool(
	t *testing.T,
	ctx context.Context,
	tracer pgx.QueryTracer,
) *pgxpool.Pool {
	t.Helper()
	appURL := strings.TrimSpace(os.Getenv("POSTWAVE_ENGAGEMENT_CLASSIFIER_APP_TEST_DATABASE_URL"))
	if appURL == "" {
		t.Skip("POSTWAVE_ENGAGEMENT_CLASSIFIER_APP_TEST_DATABASE_URL is required for F01 PostgreSQL proof")
	}
	config, err := pgxpool.ParseConfig(appURL)
	if err != nil {
		t.Fatalf("parse classifier app database url: %v", err)
	}
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("connect traced classifier app database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// TestStageTwoWorkerRunDrivesSweepOnceAndCarriesTheCursorForward_DB covers the
// seam between the Stage-2 worker's timer and its work.
//
// SweepOnce and EvaluateTenantOnce are both well covered — directly, by tests
// that call them. Run was not: the only test that reached it pre-cancelled its
// context, so execution always took the <-ctx.Done() branch and the <-timer.C
// branch never ran once. Run could therefore be edited to never call SweepOnce
// at all — Stage 2 completely dead, the schedule never drained in production —
// and the whole suite stayed green.
//
// Two things about the loop are load-bearing and are both asserted here:
//
//   - the timer actually fires and reaches SweepOnce, doing real work; and
//   - `cursor = result.NextTenantCursor` — without it every tick re-sweeps the
//     first page of tenants forever and every tenant past it is never drained.
func TestStageTwoWorkerRunDrivesSweepOnceAndCarriesTheCursorForward_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	admin, _ := classifierDBPools(t, ctx)

	// A crashed earlier run of this test is the only thing that can own this id.
	if _, err := admin.Exec(ctx,
		`DELETE FROM tenants WHERE id = $1::uuid AND slug LIKE 'f01-s2-%'`,
		stageTwoLeastTenantID); err != nil {
		t.Fatalf("clear leftover least-tenant fixture: %v", err)
	}
	fixture := seedStageTwoFixtureForTenant(t, ctx, admin,
		stageTwoLeastTenantID, 8, 200*time.Millisecond)

	sweeps := &stageTwoSweepCursorTracer{}
	app := tracedClassifierAppPool(t, ctx, sweeps)
	repo := stageTwoRepo(t, app, "stage-two-run-timer")
	classifier := stageTwoBootstrapClassifier(t, ctx, repo)
	stageTwoIngestAll(t, ctx, repo, classifier, fixture)

	// Premise: the work exists and nobody has done it. Without this the
	// "completed" assertion below could pass on a row that was already settled.
	before := readStageTwoSchedule(t, ctx, admin, fixture.TenantID,
		fixture.MessageHash, StageTwoDelayed)
	if before.State != "pending" {
		t.Fatalf("delayed schedule row is %q before Run; there is nothing for the timer to drain", before.State)
	}
	if sweeps.snapshot() != nil {
		t.Fatalf("tenant paging happened before Run started: %v", sweeps.snapshot())
	}

	var nowCalls atomic.Int64
	dueAt := fixture.FirstIngested.Add(StageTwoDelay)
	worker := &StageTwoWorker{
		Repo: repo, Classifier: classifier,
		// The tightest cadence validate() accepts, so the second tick is five
		// seconds away rather than thirty.
		Interval:         minimumStageTwoSweepInterval,
		TenantBatchSize:  1,
		MessageBatchSize: 50,
		// EvaluateTenantOnce calls this exactly once per tenant it drains, so it
		// witnesses that the sweep reached the per-tenant work and not merely the
		// tenant listing.
		Now: func() time.Time {
			nowCalls.Add(1)
			return dueAt
		},
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError}))
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	done := make(chan error, 1)
	go func() { done <- worker.Run(runCtx, logger) }()

	// Two ticks: the first proves the timer reaches SweepOnce at all, the second
	// is where the cursor Run carried between ticks becomes observable.
	deadline := time.Now().Add(30 * time.Second)
	for len(sweeps.snapshot()) < 2 {
		if time.Now().After(deadline) {
			cancelRun()
			t.Fatalf("Run swept %d times in 30s at a %s cadence; the timer never reached SweepOnce",
				len(sweeps.snapshot()), minimumStageTwoSweepInterval)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Let the second sweep finish before pulling the context out from under it.
	time.Sleep(250 * time.Millisecond)
	cancelRun()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run returned %v after cancellation, want context.Canceled", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}

	cursors := sweeps.snapshot()
	if cursors[0] != "" {
		t.Fatalf("the first sweep opened at cursor %q, want the start of the tenant order", cursors[0])
	}
	// THE CURSOR ADVANCE. The first page held exactly one tenant — this fixture,
	// which owns the least uuid there is — so the sweep that follows it must open
	// AFTER that tenant. A Run that drops result.NextTenantCursor re-opens at ""
	// forever and every tenant past the first page is never drained.
	if cursors[1] == "" {
		t.Fatal("the second sweep re-opened at the start of the tenant order: Run did not carry NextTenantCursor forward, so no tenant past the first page is ever drained")
	}
	if cursors[1] != fixture.TenantID {
		t.Fatalf("the second sweep opened at cursor %q, want the tenant the first page ended on (%s)",
			cursors[1], fixture.TenantID)
	}
	if nowCalls.Load() < 1 {
		t.Fatal("Run never reached EvaluateTenantOnce; it listed tenants but drained none")
	}

	// And the work was really done, not merely attempted: the schedule row is
	// closed and the message's evidence carries Stage-2 verdicts.
	after := readStageTwoSchedule(t, ctx, admin, fixture.TenantID,
		fixture.MessageHash, StageTwoDelayed)
	if after.State != "completed" || after.ErrorCode != "" || after.RunID == "" {
		t.Fatalf("delayed schedule row after Run = %+v, want completed with a run", after)
	}
	stageTwoMethodology, err := stageTwoMethodologyVersion(
		classifier.Config().MethodologyVersion, StageTwoDelayed)
	if err != nil {
		t.Fatal(err)
	}
	for index, event := range fixture.Opens {
		var count int
		for _, verdict := range stageTwoVerdicts(t, ctx, admin, fixture.TenantID, event) {
			if verdict.MethodologyVersion == stageTwoMethodology {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("open %d carries %d Stage-2 verdicts after Run, want exactly 1", index, count)
		}
	}
}
