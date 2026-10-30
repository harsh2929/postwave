// SPDX-License-Identifier: AGPL-3.0-only

package campaign_clone

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// A clone must not inherit its parent's dispatch timestamps.
//
// The clone copies every campaigns column that information_schema reports,
// minus a hand-maintained exclusion map. started_at was not in that map, so a
// clone of a sent campaign was born carrying the instant its PARENT began
// sending.
//
// That was always wrong data. It became a user-visible failure when
// campaigns.Repo.Update started freezing delivered content on started_at: the
// operator clicks "duplicate" precisely to fix a typo they cannot fix on the
// original, and lands on a fresh draft that refuses the edit for a send it
// never made.

func cloneTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping clone SQL test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestCloneDoesNotInheritParentDispatchTimestamps(t *testing.T) {
	pool := cloneTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var tenantID string
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatalf("tenant id: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	slug := "clone-ts-" + tenantID[:8]
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, $2, $2, 'studio')`,
		tenantID, slug); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	var srcID string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status, body_html, started_at, finished_at)
VALUES ($1::uuid, 'shipped', 'subject', 'sent', '<p>hi</p>', now() - interval '2 days',
        now() - interval '2 days')
RETURNING id::text`, tenantID).Scan(&srcID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed source campaign: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		c, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(context.Background()) }()
		_, _ = c.Exec(context.Background(), `DELETE FROM campaigns WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = c.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = c.Commit(context.Background())
	})

	router := chi.NewRouter()
	MountRoutes(router, &Deps{Pool: pool})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/"+srcID+"/clone",
		strings.NewReader(`{"name":"Copy for the fix"}`))
	req.Header.Set("Content-Type", "application/json")
	rctx := middleware.WithAPIKeyAuth(req.Context())
	rctx = apikeys.WithScopes(rctx, []apikeys.Scope{apikeys.ScopeAdmin})
	rctx = middleware.WithTenant(rctx, &middleware.Tenant{ID: tenantID})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(rctx))
	if rec.Code != http.StatusCreated {
		t.Fatalf("clone status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.ID == "" {
		t.Fatalf("clone response=%s err=%v", rec.Body.String(), err)
	}

	rtx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = rtx.Rollback(ctx) }()
	var startedAt, finishedAt *time.Time
	var status string
	if err := rtx.QueryRow(ctx, `
SELECT started_at, finished_at, status FROM campaigns WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, out.ID).Scan(&startedAt, &finishedAt, &status); err != nil {
		t.Fatalf("read clone: %v", err)
	}
	if startedAt != nil {
		t.Errorf("the clone carries started_at=%v from its parent; campaigns."+
			"Repo.Update freezes content on that column, so this fresh draft "+
			"refuses every edit", startedAt)
	}
	if finishedAt != nil {
		t.Errorf("the clone carries finished_at=%v from its parent", finishedAt)
	}
	if status != "draft" {
		t.Errorf("clone status=%q, want draft", status)
	}
}
