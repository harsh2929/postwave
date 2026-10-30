// SPDX-License-Identifier: AGPL-3.0-only
package zerocopy_triggers

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Durable execution receipts for the zero-copy poll loop.
//
// These run against a real database because the mechanism IS the SQL. A pure
// function asserting "we would skip a duplicate" tests a belief about ON
// CONFLICT rather than ON CONFLICT — and the property that matters most, that
// two replicas cannot both win a row, only exists at the isolation level.
//
// Context, because an earlier version of this file overstated it: the zero-copy
// subsystem has never executed. Four independent gates stop it — the runtime
// constant, a worker main.go never starts (with a contract test forbidding it),
// a "Poll now" handler that is unconditionally 503, and flowbuilder's own
// closed gate, which means no flow_runs row can be created at all. Nothing here
// repairs an incident; it establishes the precondition for opening the gate.

func TestClaimFireIsExactlyOncePerWarehouseRow(t *testing.T) {
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	id, outcome, err := repo.ClaimFire(ctx, tenantID, triggerID, "2026-08-04T09:00:00Z", "a@example.com", time.Hour)
	if err != nil || outcome != ClaimAcquired || id == 0 {
		t.Fatalf("first claim = (%d, %q, %v); want an acquired receipt", id, outcome, err)
	}

	// The re-poll after an interrupted batch.
	_, outcome, err = repo.ClaimFire(ctx, tenantID, triggerID, "2026-08-04T09:00:00Z", "a@example.com", time.Hour)
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if outcome != ClaimHeld {
		t.Fatalf("second claim outcome = %q, want %q — a fresh claim must not be re-acquirable", outcome, ClaimHeld)
	}
}

// The headline concurrency property, asserted rather than reasoned about.
func TestClaimFireLetsExactlyOneConcurrentPollerWin(t *testing.T) {
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	ctx := context.Background()
	const racers = 8

	var wg sync.WaitGroup
	outcomes := make([]ClaimOutcome, racers)
	errs := make([]error, racers)
	start := make(chan struct{})
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			repo := &Repo{Pool: pool}
			<-start
			_, outcomes[i], errs[i] = repo.ClaimFire(ctx, tenantID, triggerID, "c1", "a@example.com", time.Hour)
		}(i)
	}
	close(start)
	wg.Wait()

	acquired := 0
	for i, o := range outcomes {
		if errs[i] != nil {
			t.Fatalf("racer %d: %v", i, errs[i])
		}
		if o == ClaimAcquired {
			acquired++
		}
	}
	if acquired != 1 {
		t.Fatalf("%d of %d concurrent pollers acquired the same warehouse row; want exactly 1", acquired, racers)
	}
}

func TestClaimFireSeparatesRowsWithinATrigger(t *testing.T) {
	// The receipt key must be the WAREHOUSE ROW, not the trigger. Keying on the
	// trigger alone would make one claim swallow a whole batch.
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	for _, tc := range []struct{ cursor, key string }{
		{"2026-08-04T09:00:00Z", "a@example.com"},
		{"2026-08-04T09:00:00Z", "b@example.com"}, // same cursor, different profile
		{"2026-08-04T09:00:01Z", "a@example.com"}, // same profile, later cursor
	} {
		_, outcome, err := repo.ClaimFire(ctx, tenantID, triggerID, tc.cursor, tc.key, time.Hour)
		if err != nil || outcome != ClaimAcquired {
			t.Fatalf("claim %v = (%q, %v); each warehouse row is its own receipt", tc, outcome, err)
		}
	}
}

// A warehouse cell wider than btree's 2704-byte index-tuple limit used to abort
// the claim outright — and, if such a row already existed, the migration.
func TestClaimFireAcceptsOversizedWarehouseValues(t *testing.T) {
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	huge := strings.Repeat("x", 4000)

	_, outcome, err := repo.ClaimFire(ctx, tenantID, triggerID, huge, huge+"@example.com", time.Hour)
	if err != nil {
		t.Fatalf("oversized key: %v — the index must hash the key columns", err)
	}
	if outcome != ClaimAcquired {
		t.Fatalf("oversized key outcome = %q, want acquired", outcome)
	}
	// And it must still deduplicate, not merely not-crash.
	_, outcome, err = repo.ClaimFire(ctx, tenantID, triggerID, huge, huge+"@example.com", time.Hour)
	if err != nil || outcome != ClaimHeld {
		t.Fatalf("oversized re-claim = (%q, %v); want held", outcome, err)
	}
}

func TestClaimFireRecoversAStaleClaimButNotAStaleEnqueue(t *testing.T) {
	// The distinction the whole design turns on. A row still `claimed` provably
	// never reached EnqueueRun, so recovering it cannot duplicate anything. A
	// row in `enqueueing` may have — and flow_runs has no idempotency key, so
	// nothing downstream can tell. Guessing either way is wrong.
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	if _, _, err := repo.ClaimFire(ctx, tenantID, triggerID, "c-claimed", "a@example.com", time.Hour); err != nil {
		t.Fatalf("claim: %v", err)
	}
	enqueueingID, _, err := repo.ClaimFire(ctx, tenantID, triggerID, "c-enqueueing", "b@example.com", time.Hour)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := repo.MarkEnqueueing(ctx, tenantID, enqueueingID); err != nil {
		t.Fatalf("mark enqueueing: %v", err)
	}
	ageReceipts(t, pool, tenantID, triggerID, "2 hours")

	_, outcome, err := repo.ClaimFire(ctx, tenantID, triggerID, "c-claimed", "a@example.com", time.Hour)
	if err != nil {
		t.Fatalf("re-claim: %v", err)
	}
	if outcome != ClaimAcquired {
		t.Fatalf("stale `claimed` outcome = %q, want acquired — a crash before EnqueueRun must self-heal", outcome)
	}

	_, outcome, err = repo.ClaimFire(ctx, tenantID, triggerID, "c-enqueueing", "b@example.com", time.Hour)
	if err != nil {
		t.Fatalf("re-claim: %v", err)
	}
	if outcome != ClaimIndeterminate {
		t.Fatalf("stale `enqueueing` outcome = %q, want %q — retrying it risks a duplicate enrolment", outcome, ClaimIndeterminate)
	}
}

func TestIndeterminateReceiptsAreTerminalAndQueryable(t *testing.T) {
	// Terminal so one unknowable row cannot wedge a trigger's cursor forever;
	// queryable so "surfaced for a human" is a fact rather than a comment.
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	id, _, err := repo.ClaimFire(ctx, tenantID, triggerID, "c1", "a@example.com", time.Hour)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := repo.MarkEnqueueing(ctx, tenantID, id); err != nil {
		t.Fatalf("mark enqueueing: %v", err)
	}
	if err := repo.MarkIndeterminate(ctx, tenantID, id); err != nil {
		t.Fatalf("mark indeterminate: %v", err)
	}

	found, err := repo.ListIndeterminate(ctx, tenantID, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(found) != 1 || found[0].ID != id {
		t.Fatalf("ListIndeterminate = %+v, want the one escalated receipt", found)
	}
	// Terminal: never re-claimed, however old.
	ageReceipts(t, pool, tenantID, triggerID, "30 days")
	_, outcome, err := repo.ClaimFire(ctx, tenantID, triggerID, "c1", "a@example.com", time.Hour)
	if err != nil {
		t.Fatalf("re-claim: %v", err)
	}
	if outcome != ClaimSettled {
		t.Fatalf("escalated receipt outcome = %q, want settled", outcome)
	}
}

func TestClaimFireNeverReopensACompletedRow(t *testing.T) {
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	id, _, err := repo.ClaimFire(ctx, tenantID, triggerID, "c1", "a@example.com", time.Hour)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := repo.FinishFire(ctx, tenantID, id, Fire{Status: "fired"}); err != nil {
		t.Fatalf("finish: %v", err)
	}
	ageReceipts(t, pool, tenantID, triggerID, "30 days")

	_, outcome, err := repo.ClaimFire(ctx, tenantID, triggerID, "c1", "a@example.com", time.Hour)
	if err != nil {
		t.Fatalf("re-claim: %v", err)
	}
	if outcome != ClaimSettled {
		t.Fatalf("outcome = %q, want settled — a finished row is done however old", outcome)
	}
}

func TestClaimFireIsInvisibleAcrossTenants(t *testing.T) {
	// Not merely "tenant_id participates in the key": tenant B must be able to
	// claim the same cursor/profile, AND must not be able to touch tenant A's
	// receipt. RLS, asserted rather than assumed.
	pool, tenantA, triggerA := seedTriggerForReceipts(t)
	tenantB, triggerB := seedSecondTenantTrigger(t, pool)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	idA, _, err := repo.ClaimFire(ctx, tenantA, triggerA, "c1", "a@example.com", time.Hour)
	if err != nil {
		t.Fatalf("tenant A claim: %v", err)
	}
	_, outcome, err := repo.ClaimFire(ctx, tenantB, triggerB, "c1", "a@example.com", time.Hour)
	if err != nil || outcome != ClaimAcquired {
		t.Fatalf("tenant B claim = (%q, %v); want acquired", outcome, err)
	}

	// Tenant B, naming tenant A's receipt id, must change nothing — and must be
	// TOLD so. RLS hides the row, so the UPDATE matches nothing, and because
	// rows-affected is the ownership check the caller gets ErrFireClaimLost
	// rather than a silent success. A cross-tenant write that reports nil is
	// indistinguishable from one that worked.
	if err := repo.MarkEnqueueing(ctx, tenantB, idA); !errors.Is(err, ErrFireClaimLost) {
		t.Fatalf("cross-tenant mark err = %v, want %v", err, ErrFireClaimLost)
	}
	fires, err := repo.ListFires(ctx, tenantA, triggerA, 10)
	if err != nil {
		t.Fatalf("list tenant A: %v", err)
	}
	if len(fires) != 1 || fires[0].Status != "claimed" {
		t.Fatalf("tenant A receipt = %+v; tenant B must not be able to touch it", fires)
	}
}

func TestClaimFireRejectsASubMillisecondLease(t *testing.T) {
	// A lease under a millisecond renders as `0 milliseconds`, making
	// `fired_at < now() - interval '0'` true for every prior claim — dedup
	// silently off. `lease <= 0` did not catch it.
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	if _, _, err := repo.ClaimFire(ctx, tenantID, triggerID, "c1", "a@example.com", 500*time.Microsecond); err != nil {
		t.Fatalf("claim: %v", err)
	}
	_, outcome, err := repo.ClaimFire(ctx, tenantID, triggerID, "c1", "a@example.com", 500*time.Microsecond)
	if err != nil {
		t.Fatalf("re-claim: %v", err)
	}
	if outcome == ClaimAcquired {
		t.Fatal("a sub-millisecond lease disabled deduplication entirely")
	}
}

func TestReceiptMutationsAreGated(t *testing.T) {
	// Every other mutation in this repo refuses before touching the pool when
	// the runtime is contained; these must too, or a closed runtime accumulates
	// receipts for sends it must not make. Deliberately uses a nil pool: the
	// gate has to fire first for this not to panic.
	repo := &Repo{}
	ctx := context.Background()
	if _, _, err := repo.ClaimFire(ctx, "t", "tr", "c", "p", time.Hour); err != ErrZeroCopyRuntimeUnavailable {
		t.Fatalf("ClaimFire err = %v, want %v", err, ErrZeroCopyRuntimeUnavailable)
	}
	if err := repo.MarkEnqueueing(ctx, "t", 1); err != ErrZeroCopyRuntimeUnavailable {
		t.Fatalf("MarkEnqueueing err = %v", err)
	}
	if err := repo.MarkIndeterminate(ctx, "t", 1); err != ErrZeroCopyRuntimeUnavailable {
		t.Fatalf("MarkIndeterminate err = %v", err)
	}
	if err := repo.FinishFire(ctx, "t", 1, Fire{}); err != ErrZeroCopyRuntimeUnavailable {
		t.Fatalf("FinishFire err = %v", err)
	}
}

// --- harness ----------------------------------------------------------------

func ageReceipts(t *testing.T, pool *db.Pool, tenantID, triggerID, interval string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("age tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE external_warehouse_trigger_fires
		    SET fired_at = now() - $3::interval
		  WHERE tenant_id = $1::uuid AND trigger_id = $2::uuid`,
		tenantID, triggerID, interval); err != nil {
		t.Fatalf("age receipts: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("age commit: %v", err)
	}
}

// receiptTestPool opens the verification database, or skips.
func receiptTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping receipt integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedTriggerForReceipts(t *testing.T) (*db.Pool, string, string) {
	t.Helper()
	// The receipt is a gated mutation like every other write here, so these
	// tests open the gate explicitly and close it again — which also exercises
	// the setter on a real path. t.Cleanup keeps it out of the tests that
	// assert the contained behaviour.
	SetExecutionEnabled(true)
	t.Cleanup(func() { SetExecutionEnabled(false) })
	pool := receiptTestPool(t)
	tenantID := seedReceiptTenant(t, pool)
	return pool, tenantID, seedReceiptTrigger(t, pool, tenantID)
}

func seedSecondTenantTrigger(t *testing.T, pool *db.Pool) (string, string) {
	t.Helper()
	tenantID := seedReceiptTenant(t, pool)
	return tenantID, seedReceiptTrigger(t, pool, tenantID)
}

func seedReceiptTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	// Fatal, not Skip. Past the "is there a database" check, a seed failure is
	// a schema or permissions regression, and reporting it as SKIP reads green.
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Zero-copy receipt test', 'studio')`,
		tenantID, "zerocopy-receipt-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("tenant commit: %v", err)
	}
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		clean, err := db.WithTenant(c, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = clean.Rollback(c) }()
		_, _ = clean.Exec(c, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
		_ = clean.Commit(c)
	})
	return tenantID
}

func seedReceiptTrigger(t *testing.T, pool *db.Pool, tenantID string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("trigger tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	connID := uuid.NewString()
	if _, err := tx.Exec(ctx, `
INSERT INTO warehouse_connections (id, tenant_id, name, provider, config)
VALUES ($1::uuid, $2::uuid, 'receipt-test', 'postgres', '{}'::jsonb)`,
		connID, tenantID); err != nil {
		t.Fatalf("seed warehouse connection: %v", err)
	}
	triggerID := uuid.NewString()
	if _, err := tx.Exec(ctx, `
INSERT INTO external_warehouse_triggers
    (id, tenant_id, connection_id, name, provider, query, status)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'receipt-test', 'postgres', 'SELECT 1', 'active')`,
		triggerID, tenantID, connID); err != nil {
		t.Fatalf("seed trigger: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("trigger commit: %v", err)
	}
	return triggerID
}
