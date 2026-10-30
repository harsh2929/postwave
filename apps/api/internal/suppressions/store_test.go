package suppressions

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

// TestEntry_IsActive checks the time-window semantics. Permanent rows
// stay active forever; rows with expires_at in the future stay active
// until that point; rows with expires_at in the past don't.
func TestEntry_IsActive(t *testing.T) {
	now := time.Now()
	past := now.Add(-time.Hour)
	future := now.Add(time.Hour)

	cases := []struct {
		name string
		e    *Entry
		want bool
	}{
		{"nil", nil, false},
		{"permanent", &Entry{}, true},
		{"future", &Entry{ExpiresAt: &future}, true},
		{"past", &Entry{ExpiresAt: &past}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.e.IsActive(now)
			if got != tc.want {
				t.Errorf("IsActive = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestStoreHandlers_AddRequiresTenant — the handler must reject any
// request that doesn't carry a tenant in context.
func TestStoreHandlers_AddRequiresTenant(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/deliverability/suppressions",
		strings.NewReader(`{"email":"a@b.co"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.Add(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestStoreHandlers_AddRejectsMissingEmail covers the validation
// short-circuit before hitting the (nil) store.
func TestStoreHandlers_AddRejectsMissingEmail(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/deliverability/suppressions",
		strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.Add(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "missing_email") {
		t.Errorf("body = %q", w.Body.String())
	}
}

// TestStoreHandlers_AddRejectsBadJSON covers the JSON-decode error
// path.
func TestStoreHandlers_AddRejectsBadJSON(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/deliverability/suppressions",
		strings.NewReader("xx"))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.Add(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

// TestStoreHandlers_RemoveRequiresTenant — symmetry with Add.
func TestStoreHandlers_RemoveRequiresTenant(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("DELETE",
		"/api/v1/deliverability/suppressions/x@y.co", nil)
	w := httptest.NewRecorder()
	h.Remove(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestStoreHandlers_ListRequiresTenant — symmetry with Add+Remove.
func TestStoreHandlers_ListRequiresTenant(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("GET",
		"/api/v1/deliverability/suppressions", nil)
	w := httptest.NewRecorder()
	h.List(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestStore_ValidationRejectsBadInput exercises the pre-DB validation
// guards. Each call should error WITHOUT touching the (nil) pool, so
// the test runs even on machines without DATABASE_URL.
func TestStore_ValidationRejectsBadInput(t *testing.T) {
	s := &Store{Pool: nil}
	ctx := context.Background()

	// Bad reason short-circuits before pool deref.
	if _, err := s.Add(ctx, "tid", "a@b.co", "not_a_reason", SourceManual, "", nil, nil); err == nil {
		t.Errorf("expected error for invalid reason")
	}
	// Bad source.
	if _, err := s.Add(ctx, "tid", "a@b.co", ReasonHardBounce, "lol", "", nil, nil); err == nil {
		t.Errorf("expected error for invalid source")
	}
	// Empty/invalid email.
	if _, err := s.Add(ctx, "tid", "", ReasonHardBounce, SourceManual, "", nil, nil); err == nil {
		t.Errorf("expected error for empty email")
	}
	if _, err := s.Add(ctx, "tid", "no-at-sign", ReasonHardBounce, SourceManual, "", nil, nil); err == nil {
		t.Errorf("expected error for malformed email")
	}
}

// TestStore_AddCheckRoundtrip is the integration happy path. Skips
// when DATABASE_URL is unset to match the existing repo test pattern.
func TestStore_AddCheckRoundtrip(t *testing.T) {
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

	tenantID := newSuppressionTestTenant(t, ctx, pool)
	tag := randHex4(t)
	email := "rt" + tag + "@example.com"
	store := &Store{Pool: pool}
	t.Cleanup(func() { _ = store.Remove(context.Background(), tenantID, email) })

	// Initial Add.
	out, err := store.Add(ctx, tenantID, email, ReasonHardBounce, SourcePostmark,
		"evt-"+tag, nil, map[string]any{"diag": "550 5.1.1"})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if out == nil || out.Email != email {
		t.Fatalf("Add returned unexpected entry: %+v", out)
	}

	// Check sees the suppression.
	suppressed, hit, err := store.Check(ctx, tenantID, email)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if !suppressed {
		t.Errorf("Check: not suppressed; want suppressed")
	}
	if hit == nil || hit.Reason != ReasonHardBounce {
		t.Errorf("Check: hit reason = %v, want hard_bounce", hit)
	}

	// Idempotent re-add by same source_event_id is a no-op.
	out2, err := store.Add(ctx, tenantID, email, ReasonHardBounce, SourcePostmark,
		"evt-"+tag, nil, map[string]any{"redelivered": true})
	if err != nil {
		t.Fatalf("Add (idempotent): %v", err)
	}
	if out2.ID != out.ID {
		t.Errorf("Add idempotent: id changed (%s → %s)", out.ID, out2.ID)
	}

	// Remove clears it.
	if err := store.Remove(ctx, tenantID, email); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	suppressed2, _, err := store.Check(ctx, tenantID, email)
	if err != nil {
		t.Fatalf("Check after remove: %v", err)
	}
	if suppressed2 {
		t.Errorf("Check after remove: still suppressed")
	}
}

// TestStore_ExpiredSuppressionNotActive — a row with expires_at in the
// past should NOT be reported by Check (it's effectively a tombstone
// pending cleanup).
func TestStore_ExpiredSuppressionNotActive(t *testing.T) {
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
	tenantID := newSuppressionTestTenant(t, ctx, pool)
	tag := randHex4(t)
	email := "exp" + tag + "@example.com"
	store := &Store{Pool: pool}
	t.Cleanup(func() { _ = store.Remove(context.Background(), tenantID, email) })

	past := time.Now().Add(-time.Hour)
	if _, err := store.Add(ctx, tenantID, email,
		ReasonSoftBounceThreshold, SourceMailgun, "", &past, nil); err != nil {
		t.Fatalf("Add: %v", err)
	}
	suppressed, _, err := store.Check(ctx, tenantID, email)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if suppressed {
		t.Errorf("Check: expired row reported as suppressed")
	}
}

// TestStore_NewTaxonomyReasonsValid — SUB-047/SUB-048: every
// Klaviyo-compatible reason added to the taxonomy must be a member of
// ValidReasons so Store.Add / AddWithCategory accept it instead of
// rejecting with "invalid reason".
func TestStore_NewTaxonomyReasonsValid(t *testing.T) {
	want := []Reason{
		ReasonSoftBounce, ReasonComplaint, ReasonListUnsubHeader,
		ReasonSpamtrap, ReasonRoleAccount, ReasonDNSFail, ReasonInvalidAddress,
		// operator-driven reasons promoted into ValidReasons by SUB-047.
		ReasonDSARDeletion, ReasonRoleAddress, ReasonInvalidEmail, ReasonBlocklistAuto,
	}
	for _, r := range want {
		if !ValidReasons[r] {
			t.Errorf("ValidReasons[%q] = false, want true", r)
		}
	}
}

// TestStore_AddWithCategoryValidation — the SUB-048 write path must
// reject an unknown reason, an unknown source, an unknown bounce
// category, and a malformed email BEFORE dereferencing the (nil) pool.
func TestStore_AddWithCategoryValidation(t *testing.T) {
	s := &Store{Pool: nil}
	ctx := context.Background()

	// Unknown bounce category.
	if _, err := s.AddWithCategory(ctx, "tid", "a@b.co",
		ReasonSpamtrap, SourceManual, "", nil, nil, BounceCategory("not_a_cat")); err == nil {
		t.Errorf("expected error for invalid bounce category")
	}
	// Valid new reason + valid category but nil pool: the validation
	// passes, so the error must come from the pool deref (WithTenant),
	// not from validation. Either way it errors; we just assert non-nil.
	if _, err := s.AddWithCategory(ctx, "tid", "a@b.co",
		ReasonSpamtrap, SourceManual, "", nil, nil, CategorySpamtrap); err == nil {
		t.Errorf("expected error from nil pool")
	}
	// Empty category is allowed (degrades to Add semantics) — still
	// errors only because the pool is nil.
	if _, err := s.AddWithCategory(ctx, "tid", "a@b.co",
		ReasonHardBounce, SourceManual, "", nil, nil, ""); err == nil {
		t.Errorf("expected error from nil pool (empty category)")
	}
	// Unknown reason short-circuits before the pool deref.
	if _, err := s.AddWithCategory(ctx, "tid", "a@b.co",
		Reason("garbage"), SourceManual, "", nil, nil, CategorySpamtrap); err == nil {
		t.Errorf("expected error for invalid reason")
	}
}

// TestStore_ValidBounceCategories pins the category vocabulary mirrored
// from migration 0514's CHECK constraint.
func TestStore_ValidBounceCategories(t *testing.T) {
	for _, c := range []BounceCategory{
		CategoryHardBounce, CategorySoftBounce, CategorySpamtrap,
		CategoryRoleAccount, CategoryDNSFailure, CategoryInvalidAddress,
		CategoryComplaint,
	} {
		if !ValidBounceCategories[c] {
			t.Errorf("ValidBounceCategories[%q] = false, want true", c)
		}
	}
	if ValidBounceCategories[BounceCategory("nope")] {
		t.Errorf("unexpected category accepted")
	}
}

func randHex4(t *testing.T) string {
	t.Helper()
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}

func newSuppressionTestTenant(t *testing.T, ctx context.Context, pool *db.Pool) string {
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
VALUES ($1::uuid, $2, 'Suppressions integration test', 'studio')`,
		tenantID, "suppressions-"+randHex4(t)); err != nil {
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
