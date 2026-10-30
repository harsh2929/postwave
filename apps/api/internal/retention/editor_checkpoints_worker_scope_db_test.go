// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/editorcheckpoint"
)

// TestMigration1937KeepsWorkerScopeReadOnlyOnEditorCheckpoints pins the exact
// property that made migration 1937 safe to write.
//
// 1937 had to widen `tenant_isolation`'s USING so the retention worker can
// discover WHICH tenants hold abandoned drafts — a tenant-scoped transaction
// cannot enumerate tenants by definition. On this table `tenant_visible` is
// PERMISSIVE FOR ALL USING (true), so that restrictive USING is the only thing
// standing between a worker-scoped transaction and every tenant's rows. Widening
// it for reads therefore also widened it for UPDATE and DELETE, whose row
// visibility comes from USING — and the migration re-tightens both with two
// RESTRICTIVE command-scoped policies.
//
// Those two policies were the whole security argument and NOTHING asserted them.
// An adversarial pass proved it: `DROP POLICY tenant_isolation_delete` and a
// worker-scoped `DELETE` removed rows belonging to two different tenants while
// the entire retention and editorcheckpoint suites stayed green. A guard that
// only proves the widening works, and not that the re-tightening does, has
// tested the convenient half of the change.
//
// Written as a BEHAVIOUR test rather than a catalogue assertion. Checking that
// a policy named `tenant_isolation_delete` exists would pass against a policy
// whose predicate had been loosened to `true`; issuing the write and counting
// what survives cannot.
//
// THE TWO ARMS ARE NOT EQUALLY LOAD-BEARING, and this test does not pretend
// otherwise. Measured by dropping each policy in turn:
//
//   - DROP tenant_isolation_delete  -> the worker-scoped DELETE removes rows
//     from BOTH tenants. That policy is the only thing standing there, because
//     DELETE has no WITH CHECK to fall back on. This test goes red.
//   - DROP tenant_isolation_update  -> the UPDATE still fails, with "new row
//     violates row-level security policy tenant_isolation". `tenant_isolation`
//     kept its WITH CHECK tenant-only, and WITH CHECK governs the row being
//     written. The UPDATE policy is defence in depth, not the primary block.
//
// So the UPDATE assertion below pins "a worker-scoped cross-tenant UPDATE is
// refused" — which is the property that matters — and deliberately accepts
// either a refusal or zero rows, because both are that property. It does NOT
// claim to pin which policy refused it, and a comment saying otherwise would be
// the kind of overstatement this file exists to catch.
func TestMigration1937KeepsWorkerScopeReadOnlyOnEditorCheckpoints(t *testing.T) {
	pool, admin := checkpointTestPools(t)
	ctx := context.Background()

	mine := seedCheckpointTenant(t, admin, "worker-scope-mine")
	theirs := seedCheckpointTenant(t, admin, "worker-scope-theirs")
	stale := editorcheckpoint.SweepAge + 24*time.Hour
	seedCheckpoint(t, pool, mine, uuid.NewString(), "mine-1", stale)
	seedCheckpoint(t, pool, theirs, uuid.NewString(), "theirs-1", stale)

	// The widening must WORK — the worker has to see both tenants, or the
	// re-tightening below would be trivially satisfied by a policy that blocks
	// everything and the sweep would never find anyone.
	workerTx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("begin worker scope: %v", err)
	}
	defer func() { _ = workerTx.Rollback(ctx) }()
	var visible int
	if err := workerTx.QueryRow(ctx, `
SELECT count(DISTINCT tenant_id) FROM editor_checkpoints
 WHERE tenant_id = ANY($1::uuid[])`, []string{mine, theirs}).Scan(&visible); err != nil {
		t.Fatalf("worker discovery read: %v", err)
	}
	if visible != 2 {
		t.Fatalf("tenants visible to worker discovery = %d, want 2 — the widening "+
			"1937 exists for is not in effect, so the rest of this test proves nothing", visible)
	}

	// ...and must not extend to writes.
	deleted, err := workerTx.Exec(ctx, `
DELETE FROM editor_checkpoints WHERE tenant_id = ANY($1::uuid[])`,
		[]string{mine, theirs})
	if err == nil && deleted.RowsAffected() != 0 {
		t.Fatalf("worker-scoped DELETE removed %d row(s) across tenants; "+
			"tenant_isolation_delete is not holding", deleted.RowsAffected())
	}

	updated, err := workerTx.Exec(ctx, `
UPDATE editor_checkpoints SET content = '{"subject":"overwritten"}'::jsonb
 WHERE tenant_id = ANY($1::uuid[])`, []string{mine, theirs})
	if err == nil && updated.RowsAffected() != 0 {
		t.Fatalf("worker-scoped UPDATE rewrote %d row(s) across tenants; "+
			"tenant_isolation_update is not holding", updated.RowsAffected())
	}
	_ = workerTx.Rollback(ctx)

	// Both drafts must still be there. RowsAffected of 0 above could also mean
	// the statement silently matched nothing for an unrelated reason, so the
	// surviving rows are checked directly.
	if got := survivingCheckpoints(t, pool, mine); len(got) != 1 {
		t.Fatalf("owner tenant checkpoints after the worker write attempts = %v, want 1", got)
	}
	if got := survivingCheckpoints(t, pool, theirs); len(got) != 1 {
		t.Fatalf("neighbour tenant checkpoints after the worker write attempts = %v, want 1", got)
	}
}
