// SPDX-License-Identifier: AGPL-3.0-only
package deliverability_control

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestPlanDerivedEntitlementHardStopsAndReconciles(t *testing.T) {
	pool := controlDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := seedControlTenant(ctx, t, pool)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE tenants SET tier = 'launch' WHERE id = $1::uuid`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	repo := &Repo{Pool: pool}
	for used := 1; used <= 5; used++ {
		remaining, ceiling, err := repo.CheckAndConsume(ctx, tenantID, "inbox_tests")
		if err != nil || ceiling != nil || remaining != 5-used {
			t.Fatalf("consume %d: remaining=%d ceiling=%+v err=%v", used, remaining, ceiling, err)
		}
	}
	if remaining, ceiling, err := repo.CheckAndConsume(ctx, tenantID, "inbox_tests"); !errors.Is(err, ErrQuotaExceeded) || remaining != 0 || ceiling == nil || ceiling.Limit != 5 || ceiling.Used != 5 || ceiling.Tier != "launch" {
		t.Fatalf("hard stop: remaining=%d ceiling=%+v err=%v", remaining, ceiling, err)
	}

	// Even a stale/high database projection is repaired from billing state at
	// the consumption boundary before it can authorize another unit.
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE deliverability_entitlements
   SET inbox_tests_monthly = 999999, overage_policy = 'allow_overage'
 WHERE tenant_id = $1::uuid AND period_start = date_trunc('month', now())::date`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, ceiling, err := repo.CheckAndConsume(ctx, tenantID, "inbox_tests"); !errors.Is(err, ErrQuotaExceeded) || ceiling == nil || ceiling.Limit != 5 {
		t.Fatalf("reconciled hard stop: ceiling=%+v err=%v", ceiling, err)
	}
}

// TestUnsetPoliciesAnswerNamedNotConfigured is the staging regression behind
// "Evidence could not be verified" on /app/deliverability.
//
// On staging, GET click-tracking and ip-routing answered
// `404 {"error":{"code":"not_found","message":""}}` (44 bytes) while
// domain-setups answered 200 from the same pool in the same request burst:
// the routes and the store were live, and only the workspace's policy rows
// were absent. The bare code gave every client nothing to render but a
// generic failure with a Retry that could never succeed.
//
// This drives the production router as a workspace owner against real
// Postgres (as postwave_app, so RLS applies) for a workspace that has never
// saved a policy. Billing-derived entitlements are the exception: GET must
// materialize the active tier, and PUT must never let the owner change it.
func TestUnsetPoliciesAnswerNamedNotConfigured(t *testing.T) {
	pool := controlDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := seedControlTenant(ctx, t, pool)

	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			c := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
			c = middleware.WithUser(c, &middleware.User{ID: "owner-1", TenantID: tenantID, Role: "owner"})
			next.ServeHTTP(w, req.WithContext(c))
		})
	})
	MountRoutes(router, &Deps{Repo: &Repo{Pool: pool}})

	serve := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	if rec := serve(http.MethodGet, "/api/v1/deliverability-control/domain-setups", ""); rec.Code != http.StatusOK {
		t.Fatalf("domain-setups status=%d body=%s; the store must be reachable for this test to mean anything", rec.Code, rec.Body.String())
	}

	for _, tc := range []struct {
		path string
		code string
	}{
		{"/api/v1/deliverability-control/click-tracking", "click_tracking_not_configured"},
		{"/api/v1/deliverability-control/ip-routing", "ip_routing_not_configured"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			rec := serve(http.MethodGet, tc.path, "")
			if rec.Code != http.StatusNotFound {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			var envelope struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
				t.Fatalf("decode: %v body=%s", err, rec.Body.String())
			}
			if envelope.Error.Code != tc.code {
				t.Fatalf("code=%q, want %q (body=%s)", envelope.Error.Code, tc.code, rec.Body.String())
			}
			if strings.TrimSpace(envelope.Error.Message) == "" {
				t.Fatalf("an unset policy must say what is unset; body=%s", rec.Body.String())
			}
		})
	}

	entitlement := serve(http.MethodGet, "/api/v1/deliverability-control/entitlements", "")
	if entitlement.Code != http.StatusOK ||
		!strings.Contains(entitlement.Body.String(), `"plan_tier":"studio"`) ||
		!strings.Contains(entitlement.Body.String(), `"inbox_tests_monthly":0`) ||
		!strings.Contains(entitlement.Body.String(), `"render_previews_monthly":0`) {
		t.Fatalf("billing-derived entitlement status=%d body=%s", entitlement.Code, entitlement.Body.String())
	}
	put := serve(http.MethodPut, "/api/v1/deliverability-control/entitlements", `{"plan_tier":"scale","inbox_tests_monthly":999999}`)
	if put.Code != http.StatusForbidden || !strings.Contains(put.Body.String(), `"code":"entitlement_managed_by_billing"`) {
		t.Fatalf("entitlement mutation must be blocked: status=%d body=%s", put.Code, put.Body.String())
	}

	// Once the workspace saves a policy the same read answers it, so the
	// named 404 is reserved for the absent row.
	if rec := serve(http.MethodPut, "/api/v1/deliverability-control/click-tracking", `{"tracking_domain":"links.example.test"}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT click-tracking status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec := serve(http.MethodGet, "/api/v1/deliverability-control/click-tracking", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"tracking_domain":"links.example.test"`) {
		t.Fatalf("configured click-tracking status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func controlDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed deliverability-control test")
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

func seedControlTenant(ctx context.Context, t *testing.T, pool *db.Pool) string {
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
VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, "dc-"+tenantID[:8]); err != nil {
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
