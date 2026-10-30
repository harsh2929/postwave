// SPDX-License-Identifier: AGPL-3.0-only
package exports

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestRetentionDeadlineUsesTheTenantDayWindow(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 30, 18, 45, 0, 0, time.FixedZone("IST", 5*60*60+30*60))
	got := retentionDeadline(now, 45)
	want := now.UTC().AddDate(0, 0, 45)
	if !got.Equal(want) {
		t.Fatalf("retentionDeadline() = %s, want %s", got, want)
	}
	if got.Location() != time.UTC {
		t.Fatalf("retentionDeadline location = %s, want UTC", got.Location())
	}
}

// Exercises the real handler and policy row lock against Postgres. It pins the
// invariant that queued/running jobs reserve storage capacity, not just rows
// that happened to reach ready before the next request arrived.
func TestCreateFailsClosedAtTenantExportCapacity(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping export capacity integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := uuid.NewString()
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant(seed): %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'export-capacity', 'export-capacity-' || right($1::text, 12), 'studio')`, tenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO export_retention_policy (tenant_id, retention_days, max_per_tenant)
VALUES ($1::uuid, 45, 1)`, tenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed policy: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenant_exports (tenant_id, status, include)
VALUES ($1::uuid, 'queued', '[]'::jsonb)`, tenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed reserved export: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		tx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = tx.Rollback(cleanupCtx) }()
		_, _ = tx.Exec(cleanupCtx, `SELECT set_config('app.retention_worker', 'true', true)`)
		_, _ = tx.Exec(cleanupCtx, `DELETE FROM tenant_exports WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = tx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = tx.Commit(cleanupCtx)
	})

	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/exports",
		strings.NewReader(`{"include":["subscribers"]}`),
	)
	request.Header.Set("Content-Type", "application/json")
	request = request.WithContext(middleware.WithTenant(
		request.Context(),
		&middleware.Tenant{ID: tenantID},
	))
	recorder := httptest.NewRecorder()
	// Storage is intentionally non-nil so this fixture reaches the capacity
	// guard. No object operation is expected when an existing export already
	// reserves the tenant's final slot.
	storage := &downloadStorageStub{}
	(&Deps{Pool: pool, Storage: storage}).Create(recorder, request)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("Create status = %d, want 409: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"code":"export_capacity_reached"`) {
		t.Fatalf("Create body = %q, want stable capacity code", recorder.Body.String())
	}

	read, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant(read): %v", err)
	}
	defer func() { _ = read.Rollback(ctx) }()
	var count int
	if err := read.QueryRow(ctx, `
SELECT count(*) FROM tenant_exports WHERE tenant_id = $1::uuid`, tenantID).Scan(&count); err != nil {
		t.Fatalf("count exports: %v", err)
	}
	if count != 1 {
		t.Fatalf("exports after refused create = %d, want 1", count)
	}
	if len(storage.opened) != 0 || len(storage.stated) != 0 {
		t.Fatalf("capacity refusal reached object storage: opened=%#v stated=%#v", storage.opened, storage.stated)
	}
}

func TestWorkerRetentionReadIsTenantBoundAndUsesStoredPolicy(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping worker retention integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	firstID := uuid.NewString()
	secondID := uuid.NewString()
	for _, fixture := range []struct {
		id   string
		name string
		days int
	}{
		{id: firstID, name: "a", days: 45},
		{id: secondID, name: "b", days: 90},
	} {
		seed, seedErr := db.WithTenant(ctx, pool, fixture.id)
		if seedErr != nil {
			t.Fatalf("WithTenant(seed %s): %v", fixture.name, seedErr)
		}
		if _, seedErr = seed.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, $2, 'export-policy-' || $2 || '-' || right($1::text, 12), 'studio')`, fixture.id, "export-policy-"+fixture.name); seedErr != nil {
			_ = seed.Rollback(ctx)
			t.Fatalf("seed tenant %s: %v", fixture.name, seedErr)
		}
		if _, seedErr = seed.Exec(ctx, `
INSERT INTO export_retention_policy (tenant_id, retention_days, max_per_tenant)
VALUES ($1::uuid, $2, 20)`, fixture.id, fixture.days); seedErr != nil {
			_ = seed.Rollback(ctx)
			t.Fatalf("seed policy %s: %v", fixture.name, seedErr)
		}
		if seedErr = seed.Commit(ctx); seedErr != nil {
			t.Fatalf("commit seed %s: %v", fixture.name, seedErr)
		}
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		for _, tenantID := range []string{firstID, secondID} {
			tx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
			if cleanupErr != nil {
				continue
			}
			_, _ = tx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
			_ = tx.Commit(cleanupCtx)
		}
	})

	worker := &Worker{Pool: pool}
	firstDays, err := worker.retentionDays(ctx, firstID)
	if err != nil {
		t.Fatalf("first retentionDays: %v", err)
	}
	secondDays, err := worker.retentionDays(ctx, secondID)
	if err != nil {
		t.Fatalf("second retentionDays: %v", err)
	}
	if firstDays != 45 || secondDays != 90 {
		t.Fatalf("tenant policy reads = (%d, %d), want (45, 90)", firstDays, secondDays)
	}
}
