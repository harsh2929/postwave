package tags

// Handler-level tests that don't require a database. The Repo methods
// hit postgres so they're covered separately at the SQL level when
// DATABASE_URL is set.

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

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestList_RequiresTenant — 401 without tenant.
func TestList_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/tags", nil)
	w := httptest.NewRecorder()
	d.List(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestCreate_RejectsBlankName — blank or whitespace-only names must
// 400 before any DB call.
func TestCreate_RejectsBlankName(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	for _, body := range []string{`{"name":""}`, `{"name":"   "}`, `{}`} {
		r := httptest.NewRequest("POST", "/api/v1/tags", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
		w := httptest.NewRecorder()
		d.Create(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("body=%q status = %d, want 400", body, w.Code)
		}
		if !strings.Contains(w.Body.String(), "missing_name") {
			t.Errorf("body=%q response = %q", body, w.Body.String())
		}
	}
}

// TestCreate_RejectsBadJSON — malformed body → 400.
func TestCreate_RejectsBadJSON(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/tags", strings.NewReader("not json"))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_json") {
		t.Errorf("body = %q, want bad_json", w.Body.String())
	}
}

func TestCreate_RejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/tags",
		strings.NewReader(`{"name":"`+strings.Repeat("x", int(tagJSONMaxBodyBytes))+`"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Create(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", w.Code)
	}
	if !strings.Contains(w.Body.String(), "payload_too_large") {
		t.Errorf("body = %q, want payload_too_large", w.Body.String())
	}
}

// TestIsUniqueViolation — string-match guard. Locks the contract so a
// move to a typed error helper updates this test deliberately.
func TestIsUniqueViolation(t *testing.T) {
	if isUniqueViolation(nil) {
		t.Error("nil should not be unique violation")
	}
	if !isUniqueViolation(testErr("some err 23505 detail")) {
		t.Error("string-matched 23505 should detect")
	}
	if isUniqueViolation(testErr("plain message")) {
		t.Error("non-23505 should not detect")
	}
}

type testErr string

func (e testErr) Error() string { return string(e) }

// TestRepoList_QFilter inserts 5 tags with mixed names and asserts that
// List(q="alpha") returns only the substring matches (case-insensitive).
// Skips silently when DATABASE_URL is unset.
func TestRepoList_QFilter(t *testing.T) {
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
	t.Cleanup(pool.Close)

	tenantID := seedTagsTenant(t, ctx, pool)
	prefix := "qf_" + randHex(t, 4) + "_"
	repo := &Repo{Pool: pool}
	t.Cleanup(func() { cleanupTags(pool, tenantID, prefix) })

	// 5 rows with varied names — 2 should match q=prefix+"alpha" via ILIKE.
	for _, n := range []string{prefix + "alpha", prefix + "ALPHAbet",
		prefix + "beta", prefix + "gamma", prefix + "delta"} {
		if _, err := repo.Create(ctx, tenantID, CreateInput{Name: n}); err != nil {
			t.Fatalf("seed %q: %v", n, err)
		}
	}

	got, err := repo.List(ctx, tenantID, prefix+"alpha")
	if err != nil {
		t.Fatalf("List q: %v", err)
	}
	matched := 0
	for _, tag := range got {
		if strings.HasPrefix(strings.ToLower(tag.Name), prefix) {
			matched++
		}
	}
	if matched != 2 {
		t.Fatalf("q=%q: matched %d, want 2 (got=%v)", prefix+"alpha", matched, got)
	}

	// Empty q returns the full set (additive: no behavior change).
	all, err := repo.List(ctx, tenantID, "")
	if err != nil {
		t.Fatalf("List empty q: %v", err)
	}
	tot := 0
	for _, tag := range all {
		if strings.HasPrefix(strings.ToLower(tag.Name), prefix) {
			tot++
		}
	}
	if tot != 5 {
		t.Fatalf("empty q: got %d test rows, want 5", tot)
	}
}

func randHex(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b)
}

func seedTagsTenant(t *testing.T, ctx context.Context, pool *db.Pool) string {
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
VALUES ($1::uuid, $2, 'Tags q-filter test', 'studio')`,
		tenantID, "tags-qfilter-"+randHex(t, 4)); err != nil {
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

func cleanupTags(pool *db.Pool, tenantID, prefix string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `DELETE FROM tags WHERE tenant_id = $1::uuid AND name ILIKE $2`, tenantID, prefix+"%")
	_ = tx.Commit(ctx)
}
