// SPDX-License-Identifier: AGPL-3.0-only
//
// recompute_bgnbd_db_test.go — Repo.Recompute records which model a run's
// CLV forecasts came from and, when the BG/NBD fit was not used, why. The
// record is in the run's metrics, persisted on predictive_model_runs, and in
// the log with the tenant and the run. Runs against DATABASE_URL (the app
// role in CI), like the package's other pg-backed tests.
package predictive

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/predictive_clv"
)

// recomputeWindowDays covers the oldest first order in makeSignals (59
// weeks), so every seeded order is inside the window Recompute loads.
const recomputeWindowDays = 730

func TestRecompute_RecordsWhyTheBGNBDFitWasNotUsed(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed recompute test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	debug := slog.LevelDebug
	for _, tc := range []struct {
		name      string
		signals   []ProfileSignals
		model     string
		reason    string
		mention   string
		customers int
		// level is the fallback record's level; nil when nothing is logged.
		level *slog.Level
	}{
		{
			name: "fitted", signals: makeSignals(80), model: clvModelBGNBD, customers: 80,
		},
		{
			name: "too few customers", signals: makeSignals(3), model: clvModelHeuristic, customers: 3,
			reason: BGNBDFallbackTooFewCustomers, level: &debug,
			mention: fmt.Sprintf("3 scorable customers, %d needed", MinCustomersForBGNBD),
		},
		{
			name: "no repeat purchases", signals: singleOrderSignals(55), model: clvModelHeuristic, customers: 55,
			reason: string(predictive_clv.RejectNoRepeatTransactions), level: &debug, mention: "none of the 55 summaries",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			tenantID := createRecomputeTestTenant(t, pool)
			seedRecomputeOrders(ctx, t, pool, tenantID, tc.signals)

			logger, records := newRecordingLogger()
			res, err := (&Repo{Pool: pool, Logger: logger}).Recompute(ctx, tenantID, recomputeWindowDays)
			if err != nil {
				t.Fatalf("Recompute: %v", err)
			}
			if res.Predictions != tc.customers {
				t.Fatalf("Recompute scored %d profiles, want %d", res.Predictions, tc.customers)
			}

			// The returned run's metrics. Both fallback messages depend only on
			// the number of customers, so the bridge gives the same error for
			// the base before it was written to the database.
			want := map[string]any{
				"window_days":     float64(recomputeWindowDays),
				"clv_model":       tc.model,
				"bgnbd_customers": float64(tc.customers),
			}
			var wantErr string
			if tc.reason != "" {
				bridge := FitTenantBGNBD(tc.signals, bgnbdNow)
				if bridge.FallbackReason() != tc.reason || !strings.Contains(bridge.Err.Error(), tc.mention) {
					t.Fatalf("precondition: the bridge falls back on this base with %q mentioning %q, got %q: %v",
						tc.reason, tc.mention, bridge.FallbackReason(), bridge.Err)
				}
				wantErr = bridge.Err.Error()
				want["bgnbd_fallback_reason"] = tc.reason
				want["bgnbd_fallback_error"] = wantErr
			}
			got := res.Run.Metrics
			if !reflect.DeepEqual(got, want) {
				t.Errorf("run metrics = %v, want %v", got, want)
			}

			// The same metrics are persisted on the run, and every prediction
			// the run wrote names the model the metrics name.
			persisted, byModel := readRecomputeRun(ctx, t, pool, tenantID, res.Run.ID)
			if !reflect.DeepEqual(persisted, got) {
				t.Errorf("persisted run metrics = %v, want the returned %v", persisted, got)
			}
			if wantByModel := map[string]int{tc.model: tc.customers}; !reflect.DeepEqual(byModel, wantByModel) {
				t.Errorf("the run's predictions by explanation model = %v, want %v", byModel, wantByModel)
			}

			// The log.
			logged := records()
			if tc.level == nil {
				if len(logged) != 0 {
					t.Errorf("a fitted run logged %+v, want nothing", logged)
				}
				return
			}
			if len(logged) != 1 {
				t.Fatalf("logged %d records, want 1: %+v", len(logged), logged)
			}
			requireFallbackLog(t, logged[0], *tc.level, map[string]any{
				"tenant_id": tenantID,
				"run_id":    res.Run.ID,
				"reason":    tc.reason,
				"customers": int64(tc.customers),
				"err":       wantErr,
			})
		})
	}
}

// createRecomputeTestTenant inserts a fresh tenant and deletes it, with
// everything that cascades from it, when the test ends.
func createRecomputeTestTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'predictive-recompute-test', 'predictive-recompute-' || $1::text, 'studio')`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	t.Cleanup(func() { deletePredictiveTestTenant(t, pool, tenantID) })
	return tenantID
}

// seedRecomputeOrders writes each signal as paid commerce orders under one
// integration, re-anchored from bgnbdNow to the present so that
// loadProfileSignals reads the same order counts, spend and first and last
// order times, relative to now, that the signal has relative to bgnbdNow.
// A customer's orders are spread evenly from the first to the last order.
// Each customer gets its own address: makeSignals repeats addresses, and
// loadProfileSignals groups orders by address.
func seedRecomputeOrders(ctx context.Context, t *testing.T, pool *pgxpool.Pool, tenantID string, signals []ProfileSignals) {
	t.Helper()
	shift := time.Now().UTC().Sub(bgnbdNow)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var integrationID string
	if err := tx.QueryRow(ctx, `
INSERT INTO commerce_integrations (tenant_id, provider)
VALUES ($1::uuid, 'shopify')
RETURNING id::text`, tenantID).Scan(&integrationID); err != nil {
		t.Fatalf("seed commerce integration: %v", err)
	}
	for i, s := range signals {
		first, last := s.FirstOrderAt.Add(shift), s.LastOrderAt.Add(shift)
		for k := 0; k < s.OrderCount; k++ {
			at := first
			if s.OrderCount > 1 {
				at = first.Add(time.Duration(float64(last.Sub(first)) * float64(k) / float64(s.OrderCount-1)))
			}
			if _, err := tx.Exec(ctx, `
INSERT INTO commerce_orders (tenant_id, integration_id, source_id, customer_email, status, total_cents, ordered_at)
VALUES ($1::uuid, $2::uuid, $3, $4, 'paid', $5, $6)`,
				tenantID, integrationID, fmt.Sprintf("order-%d-%d", i, k),
				fmt.Sprintf("customer-%d@example.test", i), s.HistoricCLVCents/s.OrderCount, at); err != nil {
				t.Fatalf("seed commerce order: %v", err)
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit order seed: %v", err)
	}
}

// readRecomputeRun returns the persisted metrics of the tenant's run runID,
// and how many of the predictions it wrote each explanation model scored.
func readRecomputeRun(ctx context.Context, t *testing.T, pool *pgxpool.Pool, tenantID, runID string) (map[string]any, map[string]int) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var raw []byte
	if err = tx.QueryRow(ctx, `
SELECT metrics FROM predictive_model_runs WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, runID).Scan(&raw); err != nil {
		t.Fatalf("read run %s: %v", runID, err)
	}
	var metrics map[string]any
	if err = json.Unmarshal(raw, &metrics); err != nil {
		t.Fatalf("decode run metrics %s: %v", raw, err)
	}
	rows, err := tx.Query(ctx, `
SELECT COALESCE(explanation->>'model', ''), count(*)::int
  FROM profile_predictions
 WHERE tenant_id = $1::uuid AND model_run_id = $2::uuid
 GROUP BY 1`, tenantID, runID)
	if err != nil {
		t.Fatalf("read the run's predictions: %v", err)
	}
	defer rows.Close()
	byModel := map[string]int{}
	for rows.Next() {
		var model string
		var n int
		if err := rows.Scan(&model, &n); err != nil {
			t.Fatalf("scan prediction count: %v", err)
		}
		byModel[model] = n
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read the run's predictions: %v", err)
	}
	return metrics, byModel
}

// deletePredictiveTestTenant removes a tenant the test created, and everything
// that cascades from it, in a transaction bound to that tenant: the tenants
// DELETE policy sees only the row whose id equals app.tenant_id. It retries
// when Postgres reports its shared lock table full (SQLSTATE 53200) or picks
// the delete as a deadlock victim (40P01). The cascade locks every table that
// references tenants(id), so concurrent deletes from other packages sharing
// the database can briefly cause either. Any other failure, or a delete that
// removes no row, fails the test, so a leaked tenant cannot go unnoticed.
func deletePredictiveTestTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deletePredictiveTestTenantOnce(ctx, pool, tenantID)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "53200" || pgErr.Code == "40P01") && ctx.Err() == nil {
			t.Logf("cleanup of tenant %s: %s (SQLSTATE %s), retrying in %v", tenantID, pgErr.Message, pgErr.Code, wait)
			time.Sleep(wait)
			continue
		}
		if err != nil {
			t.Errorf("cleanup of tenant %s: %v", tenantID, err)
		} else if removed != 1 {
			t.Errorf("cleanup of tenant %s removed %d tenant rows, want 1", tenantID, removed)
		}
		return
	}
}

func deletePredictiveTestTenantOnce(ctx context.Context, pool *pgxpool.Pool, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}
