package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAdminIPAllowlistRejectsForgedForwardedIPFromUntrustedPeer(t *testing.T) {
	defer func() { _ = SetTrustedProxyCIDRs(nil) }()
	if err := SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
		t.Fatal(err)
	}
	lookup := func(context.Context, string) ([]string, error) {
		return []string{"203.0.113.7"}, nil
	}
	called := false
	handler := AdminIPAllowlistWithOptions(lookup, AdminIPAllowlistOptions{
		TrustForwardedIPHeaders: true,
	})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/dangerous", nil)
	req.RemoteAddr = "198.51.100.44:1234"
	req.Header.Set("X-Forwarded-For", "203.0.113.7")
	req = req.WithContext(WithTenant(req.Context(), &Tenant{ID: "00000000-0000-0000-0000-000000000001"}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body=%s", rec.Code, rec.Body.String())
	}
	if called {
		t.Fatal("protected handler ran for a forged allowlisted XFF value")
	}
	if !strings.Contains(rec.Body.String(), "ip_not_allowed") {
		t.Fatalf("body = %s, want ip_not_allowed", rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
}

func TestAdminIPAllowlistAcceptsClientBehindTrustedProxyChain(t *testing.T) {
	defer func() { _ = SetTrustedProxyCIDRs(nil) }()
	if err := SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
		t.Fatal(err)
	}
	lookup := func(_ context.Context, tenantID string) ([]string, error) {
		if tenantID != "tenant-1" {
			t.Fatalf("tenantID = %q", tenantID)
		}
		return []string{"203.0.113.0/24"}, nil
	}
	called := false
	handler := AdminIPAllowlistWithOptions(lookup, AdminIPAllowlistOptions{
		TrustForwardedIPHeaders: true,
	})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/dangerous", nil)
	req.RemoteAddr = "10.0.0.5:443"
	req.Header.Set("X-Forwarded-For", "203.0.113.7, 10.1.2.3")
	req = req.WithContext(WithTenant(req.Context(), &Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent || !called {
		t.Fatalf("status=%d called=%v, want trusted allowlisted request to pass", rec.Code, called)
	}
}

func TestAdminIPAllowlistSkipsNonPrivilegedPrincipal(t *testing.T) {
	lookupCalled := false
	lookup := func(context.Context, string) ([]string, error) {
		lookupCalled = true
		return nil, errors.New("must not run")
	}
	handler := AdminIPAllowlistWithOptions(lookup, AdminIPAllowlistOptions{
		Applies: func(context.Context) bool { return false },
	})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/reports", nil)
	req = req.WithContext(WithTenant(req.Context(), &Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if lookupCalled {
		t.Fatal("allowlist lookup ran for a principal outside the gate")
	}
}

func TestAdminIPAllowlistFailsClosedWhenPolicyCannotBeLoaded(t *testing.T) {
	lookup := func(context.Context, string) ([]string, error) {
		return nil, errors.New("database unavailable")
	}
	called := false
	handler := AdminIPAllowlist(lookup)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin", nil)
	req.RemoteAddr = "203.0.113.7:1"
	req = req.WithContext(WithTenant(req.Context(), &Tenant{ID: "tenant-1"}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
	if called {
		t.Fatal("protected handler ran when allowlist policy lookup failed")
	}
	if !strings.Contains(rec.Body.String(), "ip_allowlist_lookup_failed") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestAdminIPAllowlistDefersRequestsWithoutTenantToAuthChain(t *testing.T) {
	lookupCalled := false
	handler := AdminIPAllowlist(func(context.Context, string) ([]string, error) {
		lookupCalled = true
		return []string{"127.0.0.1"}, nil
	})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/admin", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want downstream 401", rec.Code)
	}
	if lookupCalled {
		t.Fatal("allowlist lookup ran without a resolved tenant")
	}
}
