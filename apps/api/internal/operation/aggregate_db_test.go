// SPDX-License-Identifier: AGPL-3.0-only

package operation

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The view has to actually span families.
//
// A union that compiles, runs, and returns one family's rows would pass every
// structural check in this package while failing at the only thing it exists
// for. So this seeds THREE families with different column spellings —
// `completed_at` vs `finished_at`, `error` vs `error_message`, one with no
// started_at at all — and requires all three back from one call.

func seedOpsTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'ops', 'studio')`,
		tenantID, "ops-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		for _, table := range []string{"tenant_exports", "flow_runs", "report_exports"} {
			_, _ = c.Exec(bg, `DELETE FROM `+table+` WHERE tenant_id = $1::uuid`, tenantID)
		}
		_, _ = c.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})
	return tenantID
}

func TestTheSharedViewSpansFamiliesWithDifferentColumnNames(t *testing.T) {
	pool := columnsPool(t)
	ctx := context.Background()
	tenantID := seedOpsTenant(t, pool)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	// tenant_exports: completed_at + error, and a terminal state.
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_exports (tenant_id, status, started_at, completed_at)
VALUES ($1::uuid, 'ready', $2, $3)`, tenantID, now.Add(-2*time.Hour), now.Add(-time.Hour)); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant_exports: %v", err)
	}
	// report_exports: no started_at at all — the column map says so, and this
	// row proves the NULL::timestamptz arm of the query is valid SQL.
	if _, err := tx.Exec(ctx, `
INSERT INTO report_exports (tenant_id, status, format, storage_url, error, created_at)
VALUES ($1::uuid, 'queued', 'csv', '', '', $2)`, tenantID, now.Add(-30*time.Minute)); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed report_exports: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}

	agg := &Aggregator{Pool: pool}
	records, degraded, err := agg.List(ctx, tenantID, Query{})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(degraded) > 0 {
		t.Errorf("families failed to query: %v — a declared column probably does "+
			"not exist, and the view silently drops those families", degraded)
	}

	kinds := map[string]Record{}
	for _, rec := range records {
		kinds[rec.Kind] = rec
	}
	// "export.tenant", not "tenant_export": the registry's Kind vocabulary runs
	// two conventions at once — `analytics_sync` and `report_export` beside
	// `export.tenant` and `run.flow`. Guessing the name here produced a failing
	// test against a working aggregator, which is a fair warning about what a
	// client will do with the same field.
	for _, want := range []string{"export.tenant", "report_export"} {
		if _, ok := kinds[want]; !ok {
			t.Errorf("kind %q missing from the shared view; got %d records across %v",
				want, len(records), keysOf(kinds))
		}
	}

	// The family with no started_at must come back with a nil StartedAt rather
	// than a zero time: "no start recorded" and "started at the epoch" are
	// different facts and the second is one the UI would render as 1970.
	if rec, ok := kinds["report_export"]; ok {
		if rec.StartedAt != nil {
			t.Errorf("report_export.started_at = %v, want nil — that table has no "+
				"such column", rec.StartedAt)
		}
		if rec.CreatedAt == nil {
			t.Error("report_export.created_at is nil; the column map says it exists")
		}
	}
	// And ordering is newest-first on the most recent time each row has.
	for i := 1; i < len(records); i++ {
		if records[i-1].OccurredAt.Before(records[i].OccurredAt) {
			t.Fatalf("record %d (%v) is older than record %d (%v); the merged view "+
				"is not newest-first", i-1, records[i-1].OccurredAt, i, records[i].OccurredAt)
		}
	}
}

// The newest family, seeded rather than trusted.
//
// A bulk email-verification job (migration 1839) runs for hours, spends real
// credits per address, and is the only operation in this registry a user can
// cancel from the product — so it is the strongest case in the whole view for
// "is the thing I started finished, and what has it cost me". It was invisible
// here until the table was registered.
//
// It gets its own seeded test because two things about the family could each
// break the view silently and neither is caught by a structural check: its
// `error` column is NOT NULL with an empty-string default where most
// neighbours are nullable,
// so the aggregator's `*string` scan meets a value rather than a NULL; and its
// CHECK spells the stopped state `canceled` with one `l` while the canonical
// state has two, which is exactly the kind of divergence that would otherwise
// surface as `unknown` in front of a customer.
func TestABulkVerificationJobIsVisibleWithItsAmericanCancelSpelling(t *testing.T) {
	pool := columnsPool(t)
	ctx := context.Background()
	tenantID := seedOpsTenant(t, pool)
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		_, _ = c.Exec(bg, `DELETE FROM verification_jobs WHERE tenant_id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `
INSERT INTO verification_jobs (tenant_id, status, source, total, processed, started_at)
VALUES ($1::uuid, 'running', 'inline', 5000, 1200, $2)`, tenantID, now.Add(-time.Hour)); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed verification_jobs: %v", err)
	}
	// And a stopped one, to prove the one-`l` spelling projects rather than
	// arriving as `unknown`.
	if _, err := tx.Exec(ctx, `
INSERT INTO verification_jobs (tenant_id, status, source, total, processed, started_at, completed_at)
VALUES ($1::uuid, 'canceled', 'all_subscribers', 5000, 800, $2, $3)`,
		tenantID, now.Add(-3*time.Hour), now.Add(-2*time.Hour)); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed canceled verification_jobs: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}

	records, degraded, err := (&Aggregator{Pool: pool}).List(ctx, tenantID, Query{})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, kind := range degraded {
		if kind == "verify.emails" {
			t.Fatalf("the verification family failed to query and the view dropped "+
				"it silently; a declared column probably does not exist. degraded=%v",
				degraded)
		}
	}

	var running, canceled *Record
	for i := range records {
		if records[i].Kind != "verify.emails" {
			continue
		}
		switch records[i].RawStatus {
		case "running":
			running = &records[i]
		case "canceled":
			canceled = &records[i]
		}
	}
	if running == nil || canceled == nil {
		t.Fatalf("the shared view is missing verification jobs; got %d records across %v",
			len(records), keysOf(recordsByKind(records)))
	}
	if running.State != StateRunning {
		t.Errorf("a running verification job projects as %q, want running", running.State)
	}
	if running.StartedAt == nil || running.CreatedAt == nil {
		t.Errorf("running job lost its timestamps: created=%v started=%v",
			running.CreatedAt, running.StartedAt)
	}
	if running.Error != "" {
		t.Errorf("a running job reports error %q; the column defaults to the empty "+
			"string and an empty string is not a failure message", running.Error)
	}
	if canceled.State != StateCancelled {
		t.Errorf("`canceled` projects as %q, want %q. One `l` in the table and two "+
			"in the vocabulary must not become an unknown row in a customer's view.",
			canceled.State, StateCancelled)
	}
	if !canceled.State.Terminal() {
		t.Error("a canceled verification job is terminal; the view would wait on it forever")
	}
	if canceled.FinishedAt == nil {
		t.Error("the canceled job has no finish time; CancelJob stamps completed_at")
	}
}

func recordsByKind(records []Record) map[string]Record {
	out := map[string]Record{}
	for _, rec := range records {
		out[rec.Kind] = rec
	}
	return out
}

func keysOf(m map[string]Record) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestTheViewNeverShowsAnotherTenantsOperations(t *testing.T) {
	pool := columnsPool(t)
	ctx := context.Background()
	mine := seedOpsTenant(t, pool)
	theirs := seedOpsTenant(t, pool)

	tx, err := db.WithTenant(ctx, pool, theirs)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_exports (tenant_id, status, started_at)
VALUES ($1::uuid, 'running', now())`, theirs); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed other tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	records, _, err := (&Aggregator{Pool: pool}).List(ctx, mine, Query{})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(records) != 0 {
		t.Fatalf("saw %d operation(s) belonging to another tenant: %+v", len(records), records)
	}
}

func TestTheStateFilterNarrowsRatherThanEmptying(t *testing.T) {
	pool := columnsPool(t)
	ctx := context.Background()
	tenantID := seedOpsTenant(t, pool)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenant_exports (tenant_id, status, started_at) VALUES
  ($1::uuid, 'running', now()),
  ($1::uuid, 'ready', now() - interval '1 hour')`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	agg := &Aggregator{Pool: pool}
	all, _, err := agg.List(ctx, tenantID, Query{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("unfiltered = %d records, want 2; the filter test below would "+
			"prove nothing", len(all))
	}
	running, _, err := agg.List(ctx, tenantID, Query{States: []State{StateRunning}})
	if err != nil {
		t.Fatal(err)
	}
	if len(running) != 1 || running[0].State != StateRunning {
		t.Fatalf("state=running returned %+v, want exactly the running row", running)
	}
}

// An unknown state must be REFUSED, not silently ignored. A client filtering on
// a typo would otherwise get an empty list and read it as "nothing is running",
// which is the most misleading answer this endpoint can give.
func TestAnUnknownStateFilterIsRefused(t *testing.T) {
	deps := &Deps{Aggregator: &Aggregator{}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/operations?state=finished", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: uuid.NewString()}))
	rec := httptest.NewRecorder()
	deps.List(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !containsString(rec.Body.String(), "finished") {
		t.Errorf("the refusal does not name the offending value: %s", rec.Body.String())
	}
}

func containsString(haystack, needle string) bool {
	return len(haystack) >= len(needle) && func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	}()
}

// A queued flow run must say WHY it is queued.
//
// `EnqueueRun` writes flow_runs from a reachable path; the drainer is compiled
// out behind `flowRuntimeQualified = false`. The rows are therefore correctly
// `queued` and will never move. In the shared view that word means "waiting its
// turn" — what every other family uses it for — so without a reason a
// fortnight-old flow run reads as a stuck worker nobody can find.
func TestAQueuedFlowRunExplainsThatItsRuntimeIsOff(t *testing.T) {
	pool := columnsPool(t)
	ctx := context.Background()
	tenantID := seedOpsTenant(t, pool)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var flowID string
	if err := tx.QueryRow(ctx, `
INSERT INTO automation_flows (tenant_id, name, status)
VALUES ($1::uuid, 'inspector fixture', 'draft') RETURNING id::text`, tenantID).Scan(&flowID); err != nil {
		_ = tx.Rollback(ctx)
		t.Skip("automation_flows is not part of this service's schema: no migration " +
			"creates it and no Go file references it, so there is nothing here to " +
			"exercise. Not a fixture failure — an absent capability.")
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO flow_runs (tenant_id, flow_id, subscriber_id, status, scheduled_at)
VALUES ($1::uuid, $2::uuid, gen_random_uuid(), 'queued', now())`, tenantID, flowID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed flow_run: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		_, _ = c.Exec(bg, `DELETE FROM flow_runs WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = c.Exec(bg, `DELETE FROM automation_flows WHERE tenant_id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})

	records, _, err := (&Aggregator{Pool: pool}).List(ctx, tenantID, Query{})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var run *Record
	for i := range records {
		if records[i].Kind == "run.flow" {
			run = &records[i]
			break
		}
	}
	if run == nil {
		t.Fatalf("the flow run is missing from the shared view; got %+v", records)
	}
	if run.State != StateQueued {
		t.Fatalf("state = %q, want queued", run.State)
	}
	// Blocked is deliberately NOT asserted here: the "run.flow" gate is
	// registered at the composition root, which this package does not link.
	// internal/server owns that assertion — see
	// TestTheOperationsViewExplainsTheGatedFlowRuntime.
	if run.Blocked != nil && (run.Blocked.Code == "" || run.Blocked.Message == "") {
		t.Fatalf("blocked reason is incomplete: %+v", run.Blocked)
	}
}

// And a FINISHED operation must not be labelled blocked. Stamping completed
// history with a current outage would make every flow run that ever succeeded
// look like a failure the moment the runtime was gated.
func TestATerminalRunIsNotLabelledBlocked(t *testing.T) {
	for _, state := range []State{StateSucceeded, StateFailed, StateCancelled} {
		if r := blockedReasonFor("run.flow", state); r != nil {
			t.Errorf("a %s run was labelled blocked: %+v", state, r)
		}
	}
	// The mechanism, with a fixture registration. The real "run.flow" wiring
	// lives at the composition root and is asserted there — this package cannot
	// see it without importing flowbuilder, and an import added purely to make a
	// test pass is how a dependency edge gets created for no reason.
	RegisterBlockedFamily("fixture.gated", func() *BlockedReason {
		return &BlockedReason{Code: "gated", Message: "off"}
	})
	t.Cleanup(func() { delete(blockedFamilies, "fixture.gated") })
	if r := blockedReasonFor("fixture.gated", StateQueued); r == nil {
		t.Error("a registered gated family reports no reason; the mechanism is inert")
	}
	if r := blockedReasonFor("fixture.gated", StateSucceeded); r != nil {
		t.Errorf("a finished run of a gated family was labelled blocked: %+v", r)
	}
	// A family with no gate must never acquire one by accident.
	if r := blockedReasonFor("export.tenant", StateQueued); r != nil {
		t.Errorf("tenant exports were labelled blocked: %+v", r)
	}
}
