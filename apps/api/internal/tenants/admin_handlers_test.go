package tenants

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestAuthorize_RejectsMissingBearerInProd(t *testing.T) {
	d := &AdminDeps{InternalAPIToken: "secret"}
	req := httptest.NewRequest(http.MethodDelete, "/api/internal/tenants/foo", nil)
	if d.authorize(req) {
		t.Fatal("missing Authorization header should not authorize")
	}
}

func TestAuthorize_RejectsWrongBearerInProd(t *testing.T) {
	d := &AdminDeps{InternalAPIToken: "secret"}
	req := httptest.NewRequest(http.MethodDelete, "/api/internal/tenants/foo", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	if d.authorize(req) {
		t.Fatal("wrong bearer should not authorize")
	}
}

func TestAuthorize_AcceptsCorrectBearerInProd(t *testing.T) {
	d := &AdminDeps{InternalAPIToken: "secret"}
	req := httptest.NewRequest(http.MethodDelete, "/api/internal/tenants/foo", nil)
	req.Header.Set("Authorization", "Bearer secret")
	if !d.authorize(req) {
		t.Fatal("correct bearer should authorize")
	}
}

func TestAuthorize_DevTokenAllowsAnything(t *testing.T) {
	d := &AdminDeps{AllowDevToken: true}
	req := httptest.NewRequest(http.MethodDelete, "/api/internal/tenants/foo", nil)
	if !d.authorize(req) {
		t.Fatal("dev token mode should allow any request")
	}
}

func TestAuthorize_NoTokenNoDevFailsClosed(t *testing.T) {
	d := &AdminDeps{}
	req := httptest.NewRequest(http.MethodDelete, "/api/internal/tenants/foo", nil)
	if d.authorize(req) {
		t.Fatal("no token configured + no dev mode should fail closed")
	}
}

func TestDeleteHandler_NoPoolReturnsError(t *testing.T) {
	d := &AdminDeps{AllowDevToken: true}
	r := chi.NewRouter()
	MountAdmin(r, d)

	req := httptest.NewRequest(http.MethodDelete, "/api/internal/tenants/missing", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 (no pool), got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDeleteHandler_RequiresAuth(t *testing.T) {
	d := &AdminDeps{InternalAPIToken: "secret"}
	r := chi.NewRouter()
	MountAdmin(r, d)

	req := httptest.NewRequest(http.MethodDelete, "/api/internal/tenants/missing", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", rec.Code)
	}
}

func TestIsUndefinedTable(t *testing.T) {
	if !isUndefinedTable(stubError("ERROR: relation \"foo\" does not exist (SQLSTATE 42P01)")) {
		t.Fatal("should detect 42P01")
	}
	if isUndefinedTable(stubError("syntax error")) {
		t.Fatal("should not falsely flag syntax error")
	}
	if isUndefinedTable(nil) {
		t.Fatal("nil should be false")
	}
}

func TestCascadeDeleteAllowsRequiredMergeFieldErasure(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed tenant cascade test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := uuid.NewString()
	subscriberID := uuid.NewString()
	slug := "cascade-merge-fields-" + tenantID[:8]

	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for fixture: %v", err)
	}
	if _, err = seedTx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'tenant-cascade-test', $2, 'studio')`, tenantID, slug); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err = seedTx.Exec(ctx, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::uuid, $3, 'unconfirmed', 'api')`, subscriberID, tenantID,
		fmt.Sprintf("cascade-%s@example.test", tenantID[:8])); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	if _, err = seedTx.Exec(ctx, `
INSERT INTO merge_field_schema (tenant_id, key, label, type, required, position)
VALUES ($1::uuid, 'FNAME', 'First name', 'text', false, 1)`, tenantID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed merge-field schema: %v", err)
	}
	if _, err = seedTx.Exec(ctx, `
INSERT INTO merge_field_values (tenant_id, subscriber_id, key, value)
VALUES ($1::uuid, $2::uuid, 'FNAME', 'Required value')`, tenantID, subscriberID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed merge-field value: %v", err)
	}
	if _, err = seedTx.Exec(ctx, `
UPDATE merge_field_schema
   SET required = true
 WHERE tenant_id = $1::uuid AND key = 'FNAME'`, tenantID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed required merge field: %v", err)
	}
	if err = seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		cleanupTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		_, _ = cleanupTx.Exec(cleanupCtx, `SELECT set_config('app.tenant_cascade_delete', 'on', true)`)
		_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanupTx.Commit(cleanupCtx)
	})

	counts, err := cascadeDelete(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("cascade delete tenant with required merge field: %v", err)
	}
	if counts["tenants"] != 1 {
		t.Fatalf("deleted tenants = %d; want 1", counts["tenants"])
	}

	verifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for verification: %v", err)
	}
	defer func() { _ = verifyTx.Rollback(ctx) }()
	var tenantExists bool
	if err = verifyTx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1::uuid)`, tenantID,
	).Scan(&tenantExists); err != nil {
		t.Fatalf("verify tenant deletion: %v", err)
	}
	if tenantExists {
		t.Fatal("tenant still exists after cascade delete")
	}
}

type stubError string

func (s stubError) Error() string { return string(s) }
