package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMFAExemptPathAllowsTheRealCompletionFlow(t *testing.T) {
	t.Parallel()

	allowed := []string{
		"/api/v1/me",
		"/api/v1/auth/me",
		"/api/v1/auth/logout",
		"/api/v1/auth/totp/enroll",
		"/api/v1/auth/totp/verify",
		"/api/v1/auth/totp/challenge",
		"/api/v1/auth/cli/device/approve",
	}
	for _, path := range allowed {
		path := path
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			if !mfaExemptPath(path) {
				t.Fatalf("mfaExemptPath(%q) = false, want true", path)
			}
		})
	}

	blocked := []string{
		"/api/v1/security/settings",
		"/api/v1/auth/totp/setup",
		"/api/v1/auth/totp/confirm",
	}
	for _, path := range blocked {
		path := path
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			if mfaExemptPath(path) {
				t.Fatalf("mfaExemptPath(%q) = true, want false", path)
			}
		})
	}
}

func TestMFAGateDoesNotTrustForgedBearerHeader(t *testing.T) {
	called := false
	h := RequireMFAIfPolicy(nil)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/123/send", nil)
	req.Header.Set("Authorization", "Bearer attacker-controlled")
	ctx := WithTenant(req.Context(), &Tenant{ID: "tenant-1"})
	ctx = WithUser(ctx, &User{ID: "user-1", TenantID: "tenant-1", Role: "admin"})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req.WithContext(ctx))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("forged bearer header status=%d, want 503 policy-store failure; body=%s", rec.Code, rec.Body.String())
	}
	if called {
		t.Fatal("forged bearer header bypassed MFA middleware")
	}
}

func TestMFAGateBypassesOnlyVerifiedAPIKeyContext(t *testing.T) {
	called := false
	h := RequireMFAIfPolicy(nil)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/123/send", nil)
	ctx := WithAPIKeyAuth(req.Context())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req.WithContext(ctx))

	if rec.Code != http.StatusNoContent || !called {
		t.Fatalf("verified API-key context status=%d called=%v body=%s", rec.Code, called, rec.Body.String())
	}
}

func TestMFARequiredByPolicyCoversEveryDurableRole(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name          string
		requireAll    bool
		requireAdmins bool
		role          string
		want          bool
	}{
		{name: "disabled owner", role: "owner", want: false},
		{name: "admin policy owner", requireAdmins: true, role: "owner", want: true},
		{name: "admin policy admin case insensitive", requireAdmins: true, role: " ADMIN ", want: true},
		{name: "admin policy editor", requireAdmins: true, role: "editor", want: false},
		{name: "admin policy member", requireAdmins: true, role: "member", want: false},
		{name: "admin policy viewer", requireAdmins: true, role: "viewer", want: false},
		{name: "all policy editor", requireAll: true, role: "editor", want: true},
		{name: "all policy member", requireAll: true, role: "member", want: true},
		{name: "all policy viewer", requireAll: true, role: "viewer", want: true},
		{name: "all policy owner", requireAll: true, role: "owner", want: true},
		{name: "all and admin policy owner", requireAll: true, requireAdmins: true, role: "owner", want: true},
		{name: "disabled admin", role: "admin", want: false},
		{name: "all policy admin", requireAll: true, role: "admin", want: true},
		{name: "all and admin policy admin", requireAll: true, requireAdmins: true, role: "admin", want: true},
		{name: "disabled editor", role: "editor", want: false},
		{name: "all and admin policy editor", requireAll: true, requireAdmins: true, role: "editor", want: true},
		{name: "disabled member", role: "member", want: false},
		{name: "all and admin policy member", requireAll: true, requireAdmins: true, role: "member", want: true},
		{name: "disabled viewer", role: "viewer", want: false},
		{name: "all and admin policy viewer", requireAll: true, requireAdmins: true, role: "viewer", want: true},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := mfaRequiredByPolicy(tt.requireAll, tt.requireAdmins, tt.role); got != tt.want {
				t.Fatalf("mfaRequiredByPolicy(%v, %v, %q) = %v, want %v", tt.requireAll, tt.requireAdmins, tt.role, got, tt.want)
			}
		})
	}
}
