// SPDX-License-Identifier: AGPL-3.0-only

package email_template

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func thumbnailSecurityTenant(t *testing.T, ctx context.Context, pool *db.Pool, label string) string {
	t.Helper()
	var tenantID string
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatalf("generate tenant id: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'studio')`, tenantID, "thumbnail-security-"+label+"-"+strings.ReplaceAll(tenantID[:8], "-", ""), "Thumbnail security "+label); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		cleanupTx, err := db.WithTenant(cleanupCtx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanupTx.Commit(cleanupCtx)
	})
	return tenantID
}

func thumbnailSecurityTemplate(t *testing.T, ctx context.Context, pool *db.Pool, tenantID, slug string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin template tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaign_templates (tenant_id, slug, name, subject, body_html)
VALUES ($1::uuid, $2, $3, 'Thumbnail subject', '<p>Tenant-private body</p>')
RETURNING id::text`, tenantID, slug, "Thumbnail "+slug).Scan(&id); err != nil {
		t.Fatalf("seed template: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit template: %v", err)
	}
	return id
}

func TestThumbnailLoadTemplateIsTenantScopedDB(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping thumbnail tenant-scope integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	tenantID := thumbnailSecurityTenant(t, ctx, pool, "own")
	foreignTenantID := thumbnailSecurityTenant(t, ctx, pool, "foreign")
	ownID := thumbnailSecurityTemplate(t, ctx, pool, tenantID, "own-"+tenantID[:8])
	foreignID := thumbnailSecurityTemplate(t, ctx, pool, foreignTenantID, "foreign-"+foreignTenantID[:8])

	workerTx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("begin platform seed tx: %v", err)
	}
	var platformID string
	if err := workerTx.QueryRow(ctx, `
INSERT INTO campaign_templates (tenant_id, slug, name, subject, body_html)
VALUES (NULL, $1, 'Platform thumbnail', 'Platform subject', '<p>Platform body</p>')
RETURNING id::text`, "platform-thumbnail-"+tenantID[:8]).Scan(&platformID); err != nil {
		_ = workerTx.Rollback(ctx)
		t.Fatalf("seed platform template: %v", err)
	}
	if err := workerTx.Commit(ctx); err != nil {
		t.Fatalf("commit platform template: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		tx, txErr := db.WithWorkerScope(cleanupCtx, pool)
		if txErr != nil {
			return
		}
		defer func() { _ = tx.Rollback(cleanupCtx) }()
		_, _ = tx.Exec(cleanupCtx, `DELETE FROM campaign_templates WHERE id = $1::uuid`, platformID)
		_ = tx.Commit(cleanupCtx)
	})

	deps := &ThumbnailDeps{Pool: pool, Renderer: func(ThumbnailSource) ([]byte, error) {
		t.Fatal("renderer called for foreign template")
		return nil, nil
	}}
	if _, ownerID, _, err := deps.loadTemplate(ctx, tenantID, ownID); err != nil || ownerID != tenantID {
		t.Fatalf("load own owner=%q error=%v", ownerID, err)
	}
	if _, ownerID, _, err := deps.loadTemplate(ctx, tenantID, platformID); err != nil || ownerID != "" {
		t.Fatalf("load platform owner=%q error=%v", ownerID, err)
	}
	if _, _, _, err := deps.loadTemplate(ctx, tenantID, foreignID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("load foreign error=%v, want pgx.ErrNoRows", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/templates/"+foreignID+"/thumbnail.png", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", foreignID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()
	deps.Serve(rec, req)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"code":"not_found"`) {
		t.Fatalf("foreign Serve status=%d body=%s, want 404/not_found", rec.Code, rec.Body.String())
	}
}
