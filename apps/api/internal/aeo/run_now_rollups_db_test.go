// SPDX-License-Identifier: AGPL-3.0-only

package aeo

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestAEORunNowAnswersRollupsAsArray drives POST /api/v1/aeo/run-now through
// MountRoutes against real Postgres (as postwave_app) for a workspace that has
// not set AEO up. RunOnce returns a nil rollup slice there (AEO disabled, or
// no enabled prompt), which marshalled to `"rollups": null`; the dashboard's
// run-now decoder requires an array and rejected the receipt.
func TestAEORunNowAnswersRollupsAsArray(t *testing.T) {
	pool := aeoDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := seedAEOTenant(ctx, t, pool)
	repo := &Repo{Pool: pool}
	deps := &Deps{Repo: repo, Runner: NewRunner(repo, nil)}

	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			c := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
			c = middleware.WithUser(c, &middleware.User{ID: "owner-1", TenantID: tenantID, Role: "owner"})
			next.ServeHTTP(w, req.WithContext(c))
		})
	})
	MountRoutes(router, deps)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/aeo/run-now", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got := string(body["rollups"]); got != "[]" {
		t.Fatalf("rollups=%s, want [] (body=%s)", got, rec.Body.String())
	}
}

func aeoDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed AEO wire test")
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

func seedAEOTenant(ctx context.Context, t *testing.T, pool *db.Pool) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	tenantID := h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("seed tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, "aeo-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("seed commit: %v", err)
	}
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if cleanup, e := db.WithTenant(c, pool, tenantID); e == nil {
			_, _ = cleanup.Exec(c, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
			_ = cleanup.Commit(c)
		}
	})
	return tenantID
}
