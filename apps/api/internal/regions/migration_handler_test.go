// SPDX-License-Identifier: AGPL-3.0-only

package regions

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestMigrateTenant_CommitsRegionAndBothAuditRecords(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed region migration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, poolErr := db.New(ctx, databaseURL)
	if poolErr != nil {
		t.Fatalf("db.New: %v", poolErr)
	}
	t.Cleanup(pool.Close)

	tenantID := uuid.NewString()
	seedTx, poolErr := db.WithTenant(ctx, pool, tenantID)
	if poolErr != nil {
		t.Fatalf("begin tenant seed: %v", poolErr)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier, data_region)
VALUES ($1::uuid, $2, 'Region migration transaction test', 'studio', 'us-east-1')`,
		tenantID, "region-migration-"+tenantID[:8]); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		if tx, err := db.WithTenant(cleanupCtx, pool, tenantID); err == nil {
			_, _ = tx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
			_ = tx.Commit(cleanupCtx)
		}
	})

	d := &MigrationDeps{Pool: pool, InternalAPIToken: "region-test-token"}
	call := func(newRegion string) *httptest.ResponseRecorder {
		t.Helper()
		body, err := json.Marshal(migrateInput{
			TenantID:  tenantID,
			NewRegion: newRegion,
			Reason:    "verified disaster-recovery cutover",
		})
		if err != nil {
			t.Fatalf("marshal request: %v", err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/internal/regions/migrate-tenant", strings.NewReader(string(body)))
		req.Header.Set("Authorization", "Bearer region-test-token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		d.MigrateTenant(rec, req)
		return rec
	}

	if rec := call("eu-central-1"); rec.Code != http.StatusOK {
		t.Fatalf("migration status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	verifyTx, poolErr := db.WithTenant(ctx, pool, tenantID)
	if poolErr != nil {
		t.Fatalf("begin verification: %v", poolErr)
	}
	defer func() { _ = verifyTx.Rollback(ctx) }()
	var region string
	if err := verifyTx.QueryRow(ctx,
		`SELECT data_region FROM tenants WHERE id = $1::uuid`, tenantID,
	).Scan(&region); err != nil {
		t.Fatalf("read migrated region: %v", err)
	}
	if region != "eu-central-1" {
		t.Fatalf("data_region = %q, want eu-central-1", region)
	}
	var actorType, previous, next, reason string
	if err := verifyTx.QueryRow(ctx, `
SELECT actor_type, metadata->>'prev_region', metadata->>'new_region', metadata->>'reason'
  FROM audit_log
 WHERE tenant_id = $1::uuid AND action = 'tenant.data_region_changed'
 ORDER BY at DESC
 LIMIT 1`, tenantID).Scan(&actorType, &previous, &next, &reason); err != nil {
		t.Fatalf("read audit row: %v", err)
	}
	if actorType != "system" || previous != "us-east-1" || next != "eu-central-1" || reason != "verified disaster-recovery cutover" {
		t.Fatalf("audit row = actor=%q from=%q to=%q reason=%q", actorType, previous, next, reason)
	}
	var historyCount int
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*)
  FROM tenant_region_history
 WHERE tenant_id = $1::uuid
   AND from_region = 'us-east-1'
   AND to_region = 'eu-central-1'
   AND reason = 'verified disaster-recovery cutover'`, tenantID).Scan(&historyCount); err != nil {
		t.Fatalf("read history row: %v", err)
	}
	if historyCount != 1 {
		t.Fatalf("history rows = %d, want 1", historyCount)
	}
	if err := verifyTx.Commit(ctx); err != nil {
		t.Fatalf("commit verification: %v", err)
	}

	// A no-op request commits its read transaction but creates no duplicate
	// audit/history record.
	if rec := call("eu-central-1"); rec.Code != http.StatusOK {
		t.Fatalf("no-op migration status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	countTx, poolErr := db.WithTenant(ctx, pool, tenantID)
	if poolErr != nil {
		t.Fatalf("begin count verification: %v", poolErr)
	}
	defer func() { _ = countTx.Rollback(ctx) }()
	if err := countTx.QueryRow(ctx,
		`SELECT count(*) FROM tenant_region_history WHERE tenant_id = $1::uuid`, tenantID,
	).Scan(&historyCount); err != nil {
		t.Fatalf("count history rows: %v", err)
	}
	if historyCount != 1 {
		t.Fatalf("history rows after no-op = %d, want 1", historyCount)
	}
	if err := countTx.Commit(ctx); err != nil {
		t.Fatalf("commit count verification: %v", err)
	}
}

func TestMigrateTenantRejectsUnauthorizedRequestBeforeDatabaseAccess(t *testing.T) {
	d := &MigrationDeps{InternalAPIToken: "expected-token"}
	req := httptest.NewRequest(http.MethodPost, "/api/internal/regions/migrate-tenant", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	d.MigrateTenant(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}
