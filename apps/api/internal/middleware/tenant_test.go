package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTenantMiddleware_HonorsExistingTenant(t *testing.T) {
	existing := &Tenant{ID: "tenant_1", Slug: "from-api-key"}
	called := false
	h := TenantMiddleware(nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		got, ok := TenantFromContext(r.Context())
		if !ok {
			t.Fatalf("tenant missing from context")
		}
		if got != existing {
			t.Fatalf("tenant overwritten: got %#v want %#v", got, existing)
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	r := httptest.NewRequest("GET", "/x", nil)
	r.Header.Set("X-Tenant-Slug", "different")
	r = r.WithContext(withTenantOnContext(r.Context(), existing))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if !called {
		t.Fatalf("inner handler was not called")
	}
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", w.Code)
	}
}

func TestTenantMiddleware_DevSlugHeaderDefaultClosed(t *testing.T) {
	h := TenantMiddleware(nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("inner handler should not be called")
	}))

	r := httptest.NewRequest("GET", "/x", nil)
	r.Header.Set("X-Tenant-Slug", "demo")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if !strings.Contains(w.Body.String(), "missing_tenant") {
		t.Fatalf("body = %s", w.Body.String())
	}
}

// TestUser_EffectiveRoleOrDurable covers the SUB-091 coalescing helper:
// the effective role wins when set, otherwise the durable role is used.
func TestUser_EffectiveRoleOrDurable(t *testing.T) {
	cases := []struct {
		name string
		user *User
		want string
	}{
		{"nil user", nil, ""},
		{"no override", &User{Role: "admin"}, "admin"},
		{"override active", &User{Role: "admin", EffectiveRole: "viewer"}, "viewer"},
		{"empty override falls back", &User{Role: "owner", EffectiveRole: ""}, "owner"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.user.EffectiveRoleOrDurable(); got != c.want {
				t.Fatalf("EffectiveRoleOrDurable() = %q, want %q", got, c.want)
			}
		})
	}
}

// TestTenantMiddleware_SessionResolverSurfacesEffectiveRole verifies the
// resolved (Tenant, User) — including the SUB-091 effective role — flows
// onto the request context for downstream handlers.
func TestTenantMiddleware_SessionResolverSurfacesEffectiveRole(t *testing.T) {
	resolver := func(r *http.Request) (*Tenant, *User, error) {
		return &Tenant{ID: "t1", Slug: "acme"},
			&User{ID: "u1", TenantID: "t1", Role: "admin", EffectiveRole: "viewer"},
			nil
	}
	var gotUser *User
	h := TenantMiddlewareWithOptions(nil, TenantOptions{SessionResolver: resolver})(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			u, ok := UserFromContext(r.Context())
			if !ok {
				t.Fatal("user missing from context")
			}
			gotUser = u
			w.WriteHeader(http.StatusNoContent)
		}))

	r := httptest.NewRequest("GET", "/x", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body=%s", w.Code, w.Body.String())
	}
	if gotUser == nil {
		t.Fatal("handler did not capture user")
	}
	if gotUser.Role != "admin" {
		t.Errorf("durable Role = %q, want admin", gotUser.Role)
	}
	if got := gotUser.EffectiveRoleOrDurable(); got != "viewer" {
		t.Errorf("effective role = %q, want viewer", got)
	}
}
