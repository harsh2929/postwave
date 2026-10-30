// SPDX-License-Identifier: AGPL-3.0-only
package subscription_types

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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

// ---------- handler-only tests (no DB) ----------

func TestList_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/subscription-types", nil)
	w := httptest.NewRecorder()
	d.List(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401, body=%s", w.Code, w.Body.String())
	}
}

func TestList_RejectsInvalidChannel(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/subscription-types?channel=bogus", nil)
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.List(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "invalid_channel") {
		t.Fatalf("body = %s", w.Body.String())
	}
}

func TestCreate_RequiresName(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/subscription-types",
		strings.NewReader(`{"description":"x"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "missing_name") {
		t.Fatalf("body = %s", w.Body.String())
	}
}

func TestCreate_RejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"name":"` + strings.Repeat("x", int(jsonMaxBodyBytes)) + `"}`
	r := httptest.NewRequest(http.MethodPost, "/api/v1/subscription-types",
		strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", w.Code, w.Body.String())
	}
}

func TestOptOut_RequiresIDs(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers//subscription-types//opt-out", nil)
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	// Wire empty chi URL params explicitly so chi.URLParam returns "".
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", "")
	rctx.URLParams.Add("type_id", "")
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	w := httptest.NewRecorder()
	d.OptOut(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", w.Code, w.Body.String())
	}
}

func TestUpdate_RejectsBadJSON(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest(http.MethodPatch, "/api/v1/subscription-types/x",
		strings.NewReader("garbage"))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", "00000000-0000-0000-0000-000000000001")
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	w := httptest.NewRecorder()
	d.Update(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", w.Code, w.Body.String())
	}
}

// ---------- integration tests (DB-gated) ----------

// TestRepoCreate_AndDeleteOfDefaultForbidden inserts a fresh
// subscription_type with is_default=true and asserts that delete fails
// with ErrCannotDeleteDefault when it is the only default.
func TestRepoCreate_AndDeleteOfDefaultForbidden(t *testing.T) {
	pool := openTestPool(t)
	t.Cleanup(pool.Close)

	repo := &Repo{Pool: pool}
	ctx := timeoutCtx(t)
	tenantID := newSubscriptionTypesTenant(t, pool, ctx)

	// Wipe out any prior subscription types for this tenant so the
	// seed-defaults call inside List() doesn't muddy the count.
	resetTenant(t, pool, tenantID)

	// Trigger seed via List — yields two defaults: Marketing emails
	// (is_default=true) + Product updates (is_default=false).
	seeded, err := repo.List(ctx, tenantID, "")
	if err != nil {
		t.Fatalf("seed list: %v", err)
	}
	if len(seeded) != 2 {
		t.Fatalf("seed count = %d, want 2 (got=%v)", len(seeded), seeded)
	}

	var defaultID string
	for _, s := range seeded {
		if s.IsDefault {
			defaultID = s.ID
			break
		}
	}
	if defaultID == "" {
		t.Fatalf("no default among %v", seeded)
	}

	if err := repo.Delete(ctx, tenantID, defaultID); err == nil {
		t.Fatalf("delete-only-default: want ErrCannotDeleteDefault, got nil")
	} else if !strings.Contains(err.Error(), "cannot delete the only default") {
		t.Fatalf("delete-only-default: err = %v, want cannot-delete-default", err)
	}
}

// TestRepoOptOut_RoundTrip creates a tenant subscription_type, opts a
// subscriber out, asserts the per-subscriber list reflects the opt-out
// state, then opts back in and re-asserts.
func TestRepoOptOut_RoundTrip(t *testing.T) {
	pool := openTestPool(t)
	t.Cleanup(pool.Close)

	repo := &Repo{Pool: pool}
	ctx := timeoutCtx(t)
	tenantID := newSubscriptionTypesTenant(t, pool, ctx)

	resetTenant(t, pool, tenantID)

	// Seed defaults so a subscriber view has at least two types.
	if _, err := repo.List(ctx, tenantID, ""); err != nil {
		t.Fatalf("seed list: %v", err)
	}

	// Create an additional channel-specific type so we can target it.
	created, createErr := repo.Create(ctx, tenantID, CreateInput{
		Name:    "Transactional receipts " + randHex4(t),
		Channel: ChannelEmail,
	})
	if createErr != nil {
		t.Fatalf("create: %v", createErr)
	}

	// Create a throwaway subscriber row so the FK in the opt-out
	// table is satisfied. We insert directly via a tenant-bound tx
	// because the subscribers repo isn't a dependency of this package.
	subID := newSubscriber(t, pool, tenantID)

	// Opt out on the type's default channel.
	view, createErr := repo.OptOut(ctx, tenantID, subID, created.ID, OptOutInput{Source: SourceAPI})
	if createErr != nil {
		t.Fatalf("opt-out: %v", createErr)
	}
	if !view.OptedOut || view.Source != SourceAPI {
		t.Fatalf("opt-out view = %+v, want opted_out + source=api", view)
	}

	// List-for-subscriber should now show this type as opted-out and
	// the seeded defaults still opted-in.
	views, createErr := repo.ListForSubscriber(ctx, tenantID, subID)
	if createErr != nil {
		t.Fatalf("list-for-subscriber: %v", createErr)
	}
	var foundOptedOut, foundOptedIn bool
	for _, v := range views {
		switch v.Type.ID {
		case created.ID:
			if v.OptedOut {
				foundOptedOut = true
			}
		default:
			if !v.OptedOut {
				foundOptedIn = true
			}
		}
	}
	if !foundOptedOut {
		t.Fatalf("opted-out type missing from list: %+v", views)
	}
	if !foundOptedIn {
		t.Fatalf("seeded defaults should be opted-in: %+v", views)
	}

	// Opt back in.
	if err := repo.OptIn(ctx, tenantID, subID, created.ID, ""); err != nil {
		t.Fatalf("opt-in: %v", err)
	}
	views2, createErr := repo.ListForSubscriber(ctx, tenantID, subID)
	if createErr != nil {
		t.Fatalf("list-for-subscriber 2: %v", createErr)
	}
	for _, v := range views2 {
		if v.Type.ID == created.ID && v.OptedOut {
			t.Fatalf("expected opt-in but type still flagged opted-out: %+v", v)
		}
	}
}

// ---------- helpers ----------

func openTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	return pool
}

func timeoutCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func newSubscriptionTypesTenant(t *testing.T, pool *db.Pool, ctx context.Context) string {
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
VALUES ($1::uuid, $2, 'Subscription-types test', 'studio')`,
		tenantID, "subscription-types-"+randHex4(t)); err != nil {
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

func resetTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("reset begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Cascade deletes wipe opt-outs.
	if _, err := tx.Exec(ctx, `DELETE FROM subscription_types WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		t.Fatalf("reset delete: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("reset commit: %v", err)
	}
}

func newSubscriber(t *testing.T, pool *db.Pool, tenantID string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("subscriber begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag := randHex4(t)
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')
RETURNING id::text`,
		tenantID, "sub-"+tag+"@example.com",
	).Scan(&id); err != nil {
		t.Fatalf("subscriber insert: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("subscriber commit: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()
		_, _ = tx.Exec(ctx, `DELETE FROM subscribers WHERE id = $1::uuid`, id)
		_ = tx.Commit(ctx)
	})
	return id
}

func randHex4(t *testing.T) string {
	t.Helper()
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}
