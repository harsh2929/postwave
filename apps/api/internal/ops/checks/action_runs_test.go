// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/postwave/postwave/apps/api/internal/ops"
)

func TestStaleActionRunCheckIsCriticalAndHasNoRetryAction(t *testing.T) {
	check, ok := ops.Get("ops.action-runs-stuck")
	if !ok {
		t.Fatal("stale action-run check is not registered")
	}
	if check.Severity != ops.SevCritical || check.Kind != ops.KindEvaluated || check.Probe == nil {
		t.Fatalf("stale action-run check is not fail-loud: %+v", check)
	}
	if check.Action != nil {
		t.Fatal("ambiguous action inventory must never expose an automatic retry action")
	}
	if !strings.Contains(check.Remediation, "Do not retry") {
		t.Fatalf("remediation does not warn against retry: %q", check.Remediation)
	}
}

// staleInventoryCheckPrefix returns the check_id namespace for one run of
// TestProbeStaleActionRunsIsBoundedNonPIIInventory.
//
// ops_action_runs is a platform ledger with no tenant dimension, and every
// package's tests share one database, so rows can only be told apart by what
// they are named. The namespace is:
//
//   - outside "t.%", the prefix apps/api/internal/ops gives its action-test
//     checks. That package's cleanup used to run
//     `DELETE FROM ops_action_runs WHERE check_id LIKE 't.%'`, which also
//     matched the "t.health.NN" rows this test used to seed. Run concurrently,
//     it deleted some or all of them between the seed and the probe, and the
//     probe truthfully reported 13 or 10 of 22 (or "ok"). That cleanup now
//     names its checks; this namespace keeps any future pattern delete there
//     away from these rows as well.
//   - unique to the run, so this test's own cleanup and its "clear" UPDATE
//     touch exactly the rows it inserted and nothing another run owns.
func staleInventoryCheckPrefix() string {
	return fmt.Sprintf("ops-checks-test.stale-inventory.%d.", time.Now().UnixNano())
}

func TestProbeStaleActionRunsIsBoundedNonPIIInventory(t *testing.T) {
	pool := testPool(t)
	var table *string
	if err := pool.QueryRow(context.Background(),
		`SELECT to_regclass('ops_action_runs')::text`).Scan(&table); err != nil {
		t.Fatal(err)
	}
	if table == nil {
		t.Fatalf("ops_action_runs missing: apply the canonical migrations")
	}
	prefix := staleInventoryCheckPrefix()
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM ops_action_runs WHERE starts_with(check_id, $1)`, prefix); err != nil {
			t.Errorf("cleanup ops_action_runs: %v", err)
		}
	})

	now := time.Now().UTC()
	oldestCheck := prefix + "00"
	seeded := make(map[string]string, actionRunInventoryLimit+4) // check_id -> seeded status
	for i := 0; i < actionRunInventoryLimit+2; i++ {
		checkID := fmt.Sprintf("%s%02d", prefix, i)
		started := now.Add(-time.Duration(30-i) * time.Minute)
		if _, err := pool.Exec(context.Background(), `
			INSERT INTO ops_action_runs
			       (check_id, action_id, idempotency_key, operator_email, input, status, started_at)
			VALUES ($1, $2, $3, 'secret-operator@postwave.test',
			        '{"private":"must-not-render"}'::jsonb, 'running', $4)`,
			checkID, "replay-"+strings.Repeat("x", 140),
			fmt.Sprintf("%skey.%02d", prefix, i), started); err != nil {
			t.Fatal(err)
		}
		seeded[checkID] = "running"
	}
	// Fresh and terminal rows must not appear in the ambiguous inventory.
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO ops_action_runs
		       (check_id, action_id, idempotency_key, operator_email, input, status, started_at, finished_at)
		VALUES ($1, 'fresh', $2, 'fresh-secret@postwave.test', 'null', 'running', now(), NULL),
		       ($3, 'done', $4, 'done-secret@postwave.test', 'null', 'succeeded', now() - interval '1 day', now())`,
		prefix+"fresh", prefix+"key.fresh",
		prefix+"done", prefix+"key.done"); err != nil {
		t.Fatal(err)
	}
	seeded[prefix+"fresh"] = "running"
	seeded[prefix+"done"] = "succeeded"

	status, detail, err := probeStaleActionRuns(context.Background(), &ops.Env{Pool: pool})
	if err != nil {
		t.Fatal(err)
	}
	requireStaleInventoryPremise(t, pool, prefix, seeded)
	if status != ops.StatusRed {
		t.Fatalf("status=%q detail=%q", status, detail)
	}
	for _, want := range []string{
		fmt.Sprintf("%d operator action(s)", actionRunInventoryLimit+2),
		oldestCheck,
		fmt.Sprintf("showing %d of %d", actionRunInventoryLimit, actionRunInventoryLimit+2),
		"NEVER auto-retry",
	} {
		if !strings.Contains(detail, want) {
			t.Fatalf("inventory missing %q: %s", want, detail)
		}
	}
	for _, secret := range []string{"secret-operator", "fresh-secret", "must-not-render"} {
		if strings.Contains(detail, secret) {
			t.Fatalf("inventory leaked %q: %s", secret, detail)
		}
	}
	if strings.Contains(detail, strings.Repeat("x", 100)) {
		t.Fatalf("unbounded action id escaped into inventory: %s", detail)
	}

	cleared, err := pool.Exec(context.Background(), `
		UPDATE ops_action_runs
		   SET status = 'failed', finished_at = now()
		 WHERE starts_with(check_id, $1) AND status = 'running'`, prefix)
	if err != nil {
		t.Fatal(err)
	}
	// Every stale row plus the fresh one: the clear is exactly this test's.
	if got, want := cleared.RowsAffected(), int64(actionRunInventoryLimit+3); got != want {
		t.Fatalf("clearing this test's running rows updated %d row(s), want %d: something outside "+
			"this test changed its ops_action_runs rows in the shared table", got, want)
	}
	status, detail, err = probeStaleActionRuns(context.Background(), &ops.Env{Pool: pool})
	if err != nil || status != ops.StatusOK || !strings.Contains(detail, "no operator action") {
		t.Fatalf("cleared inventory status=%q detail=%q err=%v", status, detail, err)
	}
}

// requireStaleInventoryPremise fails when the platform-wide ledger the probe
// just read was not the one this test arranged:
//
//   - a seeded row is missing or changed, so something outside the test
//     rewrote it and the exclusion assertions could pass vacuously;
//   - a stale 'running' row outside this run's namespace exists, so the
//     probe's exact totals would describe someone else's rows.
//
// Either is interference through the shared database, not a verdict on the
// probe, and is reported as such before the probe's detail line is judged.
func requireStaleInventoryPremise(t *testing.T, pool *pgxpool.Pool, prefix string, seeded map[string]string) {
	t.Helper()
	ctx := context.Background()

	rows, err := pool.Query(ctx,
		`SELECT check_id, status FROM ops_action_runs WHERE starts_with(check_id, $1)`, prefix)
	if err != nil {
		t.Fatalf("reading back seeded ops_action_runs: %v", err)
	}
	present := make(map[string]string, len(seeded))
	for rows.Next() {
		var checkID, status string
		if err := rows.Scan(&checkID, &status); err != nil {
			rows.Close()
			t.Fatalf("reading back seeded ops_action_runs: %v", err)
		}
		present[checkID] = status
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("reading back seeded ops_action_runs: %v", err)
	}
	var drift []string
	for checkID, want := range seeded {
		if got, ok := present[checkID]; !ok {
			drift = append(drift, fmt.Sprintf("%s deleted", checkID))
		} else if got != want {
			drift = append(drift, fmt.Sprintf("%s is %q, seeded %q", checkID, got, want))
		}
	}
	for checkID := range present {
		if _, ok := seeded[checkID]; !ok {
			drift = append(drift, fmt.Sprintf("%s was never seeded", checkID))
		}
	}
	if len(drift) > 0 {
		sort.Strings(drift)
		t.Fatalf("%d of this test's ops_action_runs rows were changed by something else "+
			"while the probe read the shared table: %s", len(drift), strings.Join(drift, "; "))
	}

	var foreign int64
	var sample []string
	if err := pool.QueryRow(ctx, `
		SELECT count(*),
		       COALESCE((array_agg(check_id ORDER BY started_at, id))[1:5], '{}')
		  FROM ops_action_runs
		 WHERE status = 'running'
		   AND started_at < $2
		   AND NOT starts_with(check_id, $1)`,
		prefix, time.Now().UTC().Add(-actionRunStaleAfter)).Scan(&foreign, &sample); err != nil {
		t.Fatalf("counting stale ops_action_runs outside this test: %v", err)
	}
	if foreign > 0 {
		t.Fatalf("the inventory also holds %d stale 'running' ops_action_runs row(s) this test did not "+
			"seed (oldest check_ids: %s); the probe is platform-wide, so its totals cannot be checked "+
			"against this test's rows until that writer or leftover is removed",
			foreign, strings.Join(sample, ", "))
	}
}
