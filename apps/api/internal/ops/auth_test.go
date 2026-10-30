// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// seedOperator inserts (or refreshes) a platform_operators row and returns its
// id. totp_secret_enc is a placeholder byte — v1 derives TOTP state from the
// account session via the SessionResolver; the column is reserved for a future
// dedicated operator enrollment flow.
func seedOperator(t *testing.T, pool *pgxpool.Pool, email string, allowlist []string) string {
	t.Helper()

	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO platform_operators (email, totp_secret_enc, ip_allowlist)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (email) DO UPDATE
		   SET ip_allowlist = EXCLUDED.ip_allowlist, disabled_at = NULL
		 RETURNING id`,
		email, []byte{0x00}, allowlist).Scan(&id)
	if err != nil {
		t.Fatalf("seedOperator(%s): %v", email, err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM platform_operators WHERE id = $1`, id)
	})
	return id
}

// noSession is a SessionResolver for requests that carry no operator session
// at all — which is exactly what a tenant API key looks like to the ops
// console: the resolver only understands web sessions, so a Bearer key
// resolves to nothing.
func noSession(*http.Request) (OperatorSession, bool) {
	return OperatorSession{}, false
}

func sessionFor(email string, totpVerified bool) SessionResolver {
	return func(*http.Request) (OperatorSession, bool) {
		return OperatorSession{Email: email, TOTPVerified: totpVerified}, true
	}
}

// The ops console holds cross-tenant destructive controls. A tenant admin key
// must never reach it — ScopeAdmin is a TENANT wildcard, not a platform one.
// The resolver never resolves API keys, so the Bearer header means nothing.
func TestRequirePlatformOperator_RejectsTenantAdminKey(t *testing.T) {
	h := RequirePlatformOperator(testPool(t), noSession)(http.HandlerFunc(
		func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))

	req := httptest.NewRequest("GET", "/api/internal/ops/board", nil)
	req.Header.Set("Authorization", "Bearer pw_live_a_perfectly_valid_TENANT_admin_key")
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("a tenant admin key must not reach the ops console, got %d", rec.Code)
	}
}

func TestRequirePlatformOperator_RejectsOffAllowlistIP(t *testing.T) {
	pool := testPool(t)
	seedOperator(t, pool, "operator@example.invalid", []string{"203.0.113.7/32"})

	h := RequirePlatformOperator(pool, sessionFor("operator@example.invalid", true))(
		http.HandlerFunc(
			func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))

	req := httptest.NewRequest("GET", "/api/internal/ops/board", nil)
	req.RemoteAddr = "198.51.100.4:1234" // not on the allowlist
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("an off-allowlist IP must be refused even with a valid session, got %d", rec.Code)
	}
}

// Regression pin for XFF spoofing: under the default posture
// (POSTWAVE_TRUST_FORWARDED_IP_HEADERS unset/false) the IP gate must resolve
// the client from RemoteAddr ONLY. A forged X-Forwarded-For naming an
// allowlisted IP, sent from an off-allowlist TCP peer, must still 403.
// Production runs with the trust flag ON behind a proxy, so any future change
// to the trusted-proxy XFF walk moves this exact boundary — this test keeps
// the untrusted default fail-closed.
func TestRequirePlatformOperator_SpoofedXFFDoesNotBypassIPGate(t *testing.T) {
	t.Setenv("POSTWAVE_TRUST_FORWARDED_IP_HEADERS", "") // pin the default: headers untrusted

	pool := testPool(t)
	seedOperator(t, pool, "operator@example.invalid", []string{"203.0.113.7/32"})

	h := RequirePlatformOperator(pool, sessionFor("operator@example.invalid", true))(
		http.HandlerFunc(
			func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))

	req := httptest.NewRequest("GET", "/api/internal/ops/board", nil)
	req.RemoteAddr = "198.51.100.4:1234"             // real TCP peer: NOT allowlisted
	req.Header.Set("X-Forwarded-For", "203.0.113.7") // forged: IS allowlisted
	req.Header.Set("X-Real-IP", "203.0.113.7")       // forged: IS allowlisted
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("a spoofed X-Forwarded-For must not bypass the IP allowlist when forwarded headers are untrusted, got %d", rec.Code)
	}
}

func TestRequirePlatformOperator_HappyPath(t *testing.T) {
	pool := testPool(t)
	wantID := seedOperator(t, pool, "operator@example.invalid", []string{"198.51.100.0/24"})

	var got Operator
	var gotOK bool
	h := RequirePlatformOperator(pool, sessionFor("operator@example.invalid", true))(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got, gotOK = OperatorFromContext(r.Context())
			w.WriteHeader(http.StatusOK)
		}))

	req := httptest.NewRequest("GET", "/api/internal/ops/board", nil)
	req.RemoteAddr = "198.51.100.4:1234" // inside 198.51.100.0/24
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("session+TOTP+allowlisted IP must pass, got %d: %s", rec.Code, rec.Body.String())
	}
	if !gotOK {
		t.Fatal("OperatorFromContext must return the operator inside the handler")
	}
	if got.ID != wantID || got.Email != "operator@example.invalid" {
		t.Fatalf("OperatorFromContext = %+v, want id=%s email=operator@example.invalid", got, wantID)
	}
}

// An operator row with an EMPTY allowlist is a misconfiguration, not an
// invitation: fail closed until ip_allowlist is populated.
func TestRequirePlatformOperator_EmptyAllowlistFailsClosed(t *testing.T) {
	pool := testPool(t)
	seedOperator(t, pool, "operator@example.invalid", []string{})

	h := RequirePlatformOperator(pool, sessionFor("operator@example.invalid", true))(
		http.HandlerFunc(
			func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))

	req := httptest.NewRequest("GET", "/api/internal/ops/board", nil)
	req.RemoteAddr = "198.51.100.4:1234"
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("an empty allowlist must fail closed with 403, got %d", rec.Code)
	}
}

// A valid web session whose email has no platform_operators row is just a
// customer — 401, indistinguishable from no session at all.
func TestRequirePlatformOperator_RejectsNonOperatorSession(t *testing.T) {
	pool := testPool(t)

	h := RequirePlatformOperator(pool, sessionFor("customer@example.com", true))(
		http.HandlerFunc(
			func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))

	req := httptest.NewRequest("GET", "/api/internal/ops/board", nil)
	req.RemoteAddr = "198.51.100.4:1234"
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("a session without an operator row must be refused, got %d", rec.Code)
	}
}

func TestRequirePlatformOperator_RejectsUnverifiedTOTP(t *testing.T) {
	pool := testPool(t)
	seedOperator(t, pool, "operator@example.invalid", []string{"198.51.100.0/24"})

	h := RequirePlatformOperator(pool, sessionFor("operator@example.invalid", false))(
		http.HandlerFunc(
			func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))

	req := httptest.NewRequest("GET", "/api/internal/ops/board", nil)
	req.RemoteAddr = "198.51.100.4:1234"
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("a session without TOTP must be refused, got %d", rec.Code)
	}
}

func TestRequireWriteCSRF(t *testing.T) {
	called := 0
	h := RequireWriteCSRF(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called++
		w.WriteHeader(http.StatusNoContent)
	}))

	get := httptest.NewRequest(http.MethodGet, "/api/internal/ops/board", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, get)
	if w.Code != http.StatusNoContent || called != 1 {
		t.Fatalf("read must pass: status=%d called=%d", w.Code, called)
	}

	post := httptest.NewRequest(http.MethodPost, "/api/internal/ops/views/incidents", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, post)
	if w.Code != http.StatusForbidden || called != 1 {
		t.Fatalf("write without header must fail: status=%d called=%d", w.Code, called)
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("CSRF error headers=%v", w.Header())
	}

	post = httptest.NewRequest(http.MethodPost, "/api/internal/ops/views/incidents", nil)
	post.Header.Set(opsCSRFHeader, opsCSRFValue)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, post)
	if w.Code != http.StatusNoContent || called != 2 {
		t.Fatalf("write with header must pass: status=%d called=%d", w.Code, called)
	}
}
