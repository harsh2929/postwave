// SPDX-License-Identifier: AGPL-3.0-only
//
// PostgreSQL-backed aggregate contract test. It follows the repository-wide
// convention of skipping when DATABASE_URL is absent.
package track

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func trackAggregateDB(t *testing.T) *db.Pool {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed track aggregate contract test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestEventAggregatesDensifyUTCWindowsDB(t *testing.T) {
	pool := trackAggregateDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	subscriberID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant seed tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $2, 'studio')`,
		tenantID, "track-aggregate-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant (database role or migrations unavailable): %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::uuid, $3, 'enabled', 'api')`,
		subscriberID, tenantID, "track-aggregate-"+tenantID[:8]+"@example.test"); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}

	now := time.Now().UTC()
	start := utcDailyWindowStart(now, catalogDailySeriesPeriodDays)
	events := []struct {
		name string
		at   time.Time
	}{
		{name: "checkout.started", at: start.Add(2 * time.Hour)},
		{name: "checkout.started", at: start.Add(3 * time.Hour)},
		{name: "checkout.started", at: start.AddDate(0, 0, 2).Add(2 * time.Hour)},
		{name: "checkout.completed", at: now},
		// This row belongs to a 30-day catalog count but not its independently
		// disclosed seven-day mini-series.
		{name: "checkout.started", at: start.AddDate(0, 0, -3).Add(2 * time.Hour)},
		// Future occurred_at values must not leak into an as-of aggregate.
		{name: "checkout.started", at: now.Add(24 * time.Hour)},
	}
	for _, event := range events {
		if _, err := tx.Exec(ctx, `
INSERT INTO product_events
       (tenant_id, subscriber_id, event_name, properties, occurred_at)
VALUES ($1::uuid, $2::uuid, $3, '{}'::jsonb, $4)`,
			tenantID, subscriberID, event.name, event.at); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed product event %s: %v", event.name, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() { deleteTrackTestTenant(t, pool, tenantID) })

	deps := &Deps{Repo: &Repo{Pool: pool}}
	request := func(target string, handler http.HandlerFunc) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, target, nil)
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
		rec := httptest.NewRecorder()
		handler(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d, body = %s", target, rec.Code, rec.Body.String())
		}
		return rec
	}

	statsRecorder := request("/api/v1/track/stats?days=7", deps.EventStats)
	var stats EventStatsResponse
	if err := json.Unmarshal(statsRecorder.Body.Bytes(), &stats); err != nil {
		t.Fatalf("decode stats: %v", err)
	}
	if stats.PeriodDays != 7 || stats.TimeZone != "UTC" || stats.AsOf.IsZero() {
		t.Fatalf("stats scope metadata = %#v", stats)
	}
	if stats.TotalEvents != 4 || stats.UniqueSubscribers != 1 || stats.UniqueEventNames != 2 {
		t.Fatalf("stats totals = %#v", stats)
	}
	if len(stats.Daily) != 7 {
		t.Fatalf("stats daily length = %d, want 7: %#v", len(stats.Daily), stats.Daily)
	}
	wantStatsCounts := []int64{2, 0, 1, 0, 0, 0, 1}
	for i, want := range wantStatsCounts {
		if stats.Daily[i].Count != want {
			t.Fatalf("stats daily[%d] = %#v, want count %d", i, stats.Daily[i], want)
		}
		wantDate := start.AddDate(0, 0, i).Format(time.DateOnly)
		if stats.Daily[i].Date != wantDate {
			t.Fatalf("stats daily[%d] date = %s, want %s", i, stats.Daily[i].Date, wantDate)
		}
	}

	catalogRecorder := request("/api/v1/track/catalog?days=30", deps.EventCatalog)
	var catalog EventCatalogResponse
	if err := json.Unmarshal(catalogRecorder.Body.Bytes(), &catalog); err != nil {
		t.Fatalf("decode catalog: %v", err)
	}
	if catalog.PeriodDays != 30 ||
		catalog.DailySeriesPeriodDays != 7 ||
		catalog.EventBoundsScope != "period" ||
		catalog.TimeZone != "UTC" ||
		catalog.AsOf.IsZero() {
		t.Fatalf("catalog scope metadata = %#v", catalog)
	}
	if len(catalog.Items) != 2 {
		t.Fatalf("catalog items = %d, want 2: %#v", len(catalog.Items), catalog.Items)
	}
	if catalog.TotalDistinctEventNames != 2 {
		t.Fatalf("catalog total distinct names = %d, want 2", catalog.TotalDistinctEventNames)
	}
	byName := make(map[string]CatalogRow, len(catalog.Items))
	for _, item := range catalog.Items {
		byName[item.EventName] = item
		if len(item.Daily) != 7 {
			t.Fatalf("%s daily length = %d, want 7", item.EventName, len(item.Daily))
		}
	}
	started, ok := byName["checkout.started"]
	if !ok {
		t.Fatalf("checkout.started missing: %#v", catalog.Items)
	}
	if started.Count != 4 || started.UniqueSubs != 1 {
		t.Fatalf("checkout.started aggregate = %#v", started)
	}
	wantStartedCounts := []int64{2, 0, 1, 0, 0, 0, 0}
	for i, want := range wantStartedCounts {
		if started.Daily[i].Count != want {
			t.Fatalf("checkout.started daily[%d] = %#v, want count %d", i, started.Daily[i], want)
		}
	}
	completed, ok := byName["checkout.completed"]
	if !ok || completed.Count != 1 || completed.Daily[6].Count != 1 {
		t.Fatalf("checkout.completed aggregate = %#v, present=%v", completed, ok)
	}

	if catalog.AsOf.Before(stats.AsOf) {
		t.Fatalf("catalog asOf %s unexpectedly predates prior stats asOf %s", catalog.AsOf, stats.AsOf)
	}
}
