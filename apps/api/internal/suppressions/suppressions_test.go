package suppressions

// Handler-level tests for the suppressions surface. Repo methods are
// SQL-driven and would need DATABASE_URL.

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

func TestAdd_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions",
		strings.NewReader(`{"email":"x@y.co"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.Add(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestAdd_RejectsMissingEmail(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions",
		strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Add(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	// The legacy Deps.Add surface ships "missing_field" + "email is
	// required" (suppressions.go); the X1 StoreHandlers surface uses
	// "missing_email". Pin the actual legacy wire code rather than
	// changing a shipped contract.
	if !strings.Contains(w.Body.String(), "missing_field") ||
		!strings.Contains(w.Body.String(), "email is required") {
		t.Errorf("body = %q", w.Body.String())
	}
}

func TestAdd_RejectsBadJSON(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions",
		strings.NewReader("xx"))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Add(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestAdd_RejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions",
		strings.NewReader(`{"email":"x@y.co","reason":"`+strings.Repeat("x", int(suppressionJSONMaxBodyBytes))+`"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Add(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", w.Code)
	}
	if !strings.Contains(w.Body.String(), "payload_too_large") {
		t.Errorf("body = %q, want payload_too_large", w.Body.String())
	}
}

// TestBulkAdd_TooManyRowsRejected — 50000 is the cap; 50001 must 413
// before BulkAdd is called (and so before any DB access).
func TestBulkAdd_TooManyRowsRejected(t *testing.T) {
	emails := make([]string, 50001)
	for i := range emails {
		emails[i] = "a@b.co"
	}
	body := `{"emails":[`
	for i := range emails {
		if i > 0 {
			body += `,`
		}
		body += `"a@b.co"`
	}
	body += `]}`

	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.BulkAdd(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413 for >50k", w.Code)
	}
}

func TestBulkAdd_RejectsBadJSON(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk", strings.NewReader("xx"))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.BulkAdd(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

// TestBulkAdd_EmptyBatchSucceedsImmediately — the BulkAdd repo helper
// short-circuits on empty input and returns a zero-row result without
// touching the pool. The handler should respond 200 with that result.
func TestBulkAdd_EmptyBatchSucceedsImmediately(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk",
		strings.NewReader(`{"emails":[]}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.BulkAdd(w, r)
	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"imported":0`) {
		t.Errorf("body = %q, want zero counts", w.Body.String())
	}
}

// TestRepoList_QFilter inserts 5 suppressions with mixed emails and
// asserts that List(q) filters by email substring (case-insensitive).
// Skips silently when DATABASE_URL is unset.
func TestRepoList_QFilter(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, poolErr := db.New(ctx, url)
	if poolErr != nil {
		t.Fatalf("db.New: %v", poolErr)
	}
	t.Cleanup(pool.Close)

	tenantID := newSuppressionTestTenant(t, ctx, pool)
	tag := randHex4Sup(t)
	prefix := "qf" + tag
	repo := &Repo{Pool: pool}
	t.Cleanup(func() { cleanupSuppressions(pool, tenantID, prefix) })

	emails := []string{
		prefix + "+alpha@example.com",
		prefix + "+ALPHAbet@example.com",
		prefix + "+beta@example.com",
		prefix + "+gamma@example.com",
		prefix + "+delta@example.com",
	}
	for _, e := range emails {
		if _, err := repo.Add(ctx, tenantID, e, string(ReasonManualUnsubscribe)); err != nil {
			t.Fatalf("seed %q: %v", e, err)
		}
	}

	// List with q=alpha should match the two alpha emails (ILIKE = case-insensitive).
	got, poolErr := repo.List(ctx, tenantID, prefix+"+alpha", 50, 0)
	if poolErr != nil {
		t.Fatalf("List q=alpha: %v", poolErr)
	}
	matched := 0
	for _, s := range got {
		if strings.HasPrefix(strings.ToLower(s.Email), strings.ToLower(prefix)) {
			matched++
		}
	}
	if matched != 2 {
		t.Fatalf("q=alpha: matched %d, want 2 (got=%v)", matched, got)
	}
}

// TestNormalizeReason_KlaviyoTaxonomy — SUB-047: the consolidated
// suppression taxonomy must map the Klaviyo-compatible reasons and a
// representative set of aliases onto the canonical Reason enum. The
// legacy back-compat mappings are covered by TestConvergerNormalizeReason;
// this pins the NEW taxonomy + alias folding so a drifting client can
// pass either label.
func TestNormalizeReason_KlaviyoTaxonomy(t *testing.T) {
	cases := map[string]Reason{
		// soft bounce (single-event, distinct from soft_bounce_threshold)
		"soft_bounce": ReasonSoftBounce,
		"softbounce":  ReasonSoftBounce,
		"transient":   ReasonSoftBounce,
		// list-unsubscribe header (RFC 8058)
		"list_unsub_header": ReasonListUnsubHeader,
		"list_unsubscribe":  ReasonListUnsubHeader,
		"rfc8058":           ReasonListUnsubHeader,
		// spamtrap / honeypot
		"spamtrap":     ReasonSpamtrap,
		"spam_trap":    ReasonSpamtrap,
		"spamtrap_hit": ReasonSpamtrap,
		"honeypot":     ReasonSpamtrap,
		// role account
		"role_account": ReasonRoleAccount,
		"roleaccount":  ReasonRoleAccount,
		// dns failure
		"dns_failure": ReasonDNSFail,
		"dns_fail":    ReasonDNSFail,
		"nxdomain":    ReasonDNSFail,
		"no_mx":       ReasonDNSFail,
		// invalid address
		"invalid_address": ReasonInvalidAddress,
		"bad_address":     ReasonInvalidAddress,
		// `complaint` still folds into the established canonical
		// spam_complaint for read-side convergence stability.
		"complaint": ReasonSpamComplaint,
		"spam":      ReasonSpamComplaint,
	}
	for input, want := range cases {
		if got := NormalizeReason(input); got != want {
			t.Errorf("NormalizeReason(%q) = %q, want %q", input, got, want)
		}
	}
}

func randHex4Sup(t *testing.T) string {
	t.Helper()
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}

func cleanupSuppressions(pool *db.Pool, tenantID, prefix string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `DELETE FROM email_suppressions WHERE tenant_id = $1::uuid AND email::text ILIKE $2`, tenantID, prefix+"%")
	_ = tx.Commit(ctx)
}
