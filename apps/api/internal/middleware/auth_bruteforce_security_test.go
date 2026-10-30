package middleware

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type unavailableAuthRateLimitStore struct{}

func (unavailableAuthRateLimitStore) Reserve(context.Context, string, int, time.Duration, time.Time) (int, time.Time, error) {
	return 0, time.Time{}, errors.New("redis unavailable")
}

func securityTestAuthLimiter() *AuthBruteforceLimiter {
	l := NewAuthBruteforceLimiter()
	l.MaxAttempts = 1
	l.Window = time.Minute
	l.Cooldown = time.Minute
	return l
}

func TestAuthBruteforceHasPreAuthAccountBudgetIndependentOfIP(t *testing.T) {
	l := securityTestAuthLimiter()
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The limiter must restore the body for the auth handler.
		var body struct {
			Email string `json:"email"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Email == "" {
			t.Fatalf("restored body decode: %v body=%+v", err, body)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	for i, remote := range []string{"198.51.100.10:1", "198.51.100.11:1"} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"email":"Target@Example.com","password":"wrong"}`))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = remote
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		want := http.StatusNoContent
		if i == 1 {
			want = http.StatusTooManyRequests
		}
		if rec.Code != want {
			t.Fatalf("request %d status=%d want=%d", i+1, rec.Code, want)
		}
	}
}

func TestAuthBruteforceIgnoresSpoofedForwardedIPFromDirectPeer(t *testing.T) {
	defer func() { _ = SetTrustedProxyCIDRs(nil) }()
	_ = SetTrustedProxyCIDRs(nil)
	l := securityTestAuthLimiter()
	l.TrustForwardedIPHeaders = true
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))

	for i, forged := range []string{"203.0.113.1", "203.0.113.2"} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
		req.RemoteAddr = "198.51.100.10:4321"
		req.Header.Set("X-Forwarded-For", forged)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		want := http.StatusNoContent
		if i == 1 {
			want = http.StatusTooManyRequests
		}
		if rec.Code != want {
			t.Fatalf("request %d status=%d want=%d", i+1, rec.Code, want)
		}
	}
}

func TestAuthBruteforceHasUserBudgetIndependentOfIP(t *testing.T) {
	l := securityTestAuthLimiter()
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))

	for i, remote := range []string{"198.51.100.10:1", "198.51.100.11:1"} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/totp/challenge", nil)
		req.RemoteAddr = remote
		req = req.WithContext(WithUser(req.Context(), &User{ID: "target-user", TenantID: "tenant-1"}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		want := http.StatusNoContent
		if i == 1 {
			want = http.StatusTooManyRequests
		}
		if rec.Code != want {
			t.Fatalf("request %d status=%d want=%d", i+1, rec.Code, want)
		}
	}
}

func TestAuthBruteforceHasSessionBudgetIndependentOfIPAndUser(t *testing.T) {
	l := securityTestAuthLimiter()
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))

	for i, remote := range []string{"198.51.100.10:1", "198.51.100.11:1"} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/totp/challenge", nil)
		req.RemoteAddr = remote
		req.AddCookie(&http.Cookie{Name: "pw_session", Value: "opaque-session-id.opaque-verifier"})
		// Deliberately vary the projected user: the independently keyed session
		// budget must still stop the second guess.
		req = req.WithContext(WithUser(req.Context(), &User{ID: "user-" + remote, TenantID: "tenant-1"}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		want := http.StatusNoContent
		if i == 1 {
			want = http.StatusTooManyRequests
		}
		if rec.Code != want {
			t.Fatalf("request %d status=%d want=%d", i+1, rec.Code, want)
		}
	}
}

func TestAuthBruteforceFailsClosedWhenDistributedStoreIsUnavailable(t *testing.T) {
	l := securityTestAuthLimiter()
	l.Store = unavailableAuthRateLimitStore{}
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Fatal("downstream handler must not run without the distributed auth limiter")
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/totp/challenge", nil)
	req.RemoteAddr = "198.51.100.10:1"
	req.AddCookie(&http.Cookie{Name: "pw_session", Value: "opaque-session-id.opaque-verifier"})
	req = req.WithContext(WithUser(req.Context(), &User{ID: "target-user", TenantID: "tenant-1"}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "auth_rate_limit_unavailable") {
		t.Fatalf("status=%d body=%q, want fail-closed 503", rec.Code, rec.Body.String())
	}
}
