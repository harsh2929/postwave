// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The global sweep must complete BOTH of its statements.
//
// `sweepGlobal` prunes web_vitals_events and then stripe_webhook_attempts, and
// returns on the first error. `postwave_app` held no DELETE on
// web_vitals_events, so the first statement raised "permission denied" and the
// second never ran — stripe_webhook_attempts was never pruned either, despite
// having its own grant. One missing privilege disabled the whole function.
//
// This drives the real sweepGlobal rather than asserting a grant, because the
// failure that mattered was the early return, not the permission itself.
func TestTheGlobalSweepCompletesBothStatements(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping global retention sweep test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	// A web vital old enough for any configured window.
	// Fatal, never Skip. A skipped seed reports PASS, which is precisely the
	// pattern this repository's check-test-skip-honesty guard exists to end —
	// and which I reached for here by reflex before the column names were
	// checked. The required columns are metric_name and value.
	if _, err := pool.Exec(ctx, `
INSERT INTO web_vitals_events (metric_name, value, at)
VALUES ('probe-retention', 1, now() - interval '400 days')`); err != nil {
		t.Fatalf("seed web vital: %v", err)
	}

	sweeper := &Sweeper{Pool: pool}
	if err := sweeper.sweepGlobal(ctx); err != nil {
		t.Fatalf("sweepGlobal: %v. It returns on the first error, so a single "+
			"missing privilege stops every global prune — including tables whose "+
			"own grants are fine.", err)
	}

	var left int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM web_vitals_events WHERE metric_name = 'probe-retention'`).Scan(&left); err != nil {
		t.Fatalf("count: %v", err)
	}
	if left != 0 {
		t.Fatalf("%d expired web vital(s) survived the global sweep", left)
	}
}
