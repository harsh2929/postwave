package apikeys

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeSupplementalBearerResolver struct {
	auth *SupplementalBearerAuth
	err  error
}

type principalAuthResolver struct {
	key    *APIKey
	tenant *middleware.Tenant
}

func (f *principalAuthResolver) HashKey(plaintext string) string { return plaintext }
func (f *principalAuthResolver) LookupByHash(context.Context, string) (*APIKey, error) {
	return f.key, nil
}
func (*principalAuthResolver) TouchLastUsed(context.Context, string) error { return nil }
func (f *principalAuthResolver) ResolveAuth(context.Context, string) (*APIKey, *middleware.Tenant, error) {
	return f.key, f.tenant, nil
}

func TestAPIKeyMiddlewareBindsNonImpersonableUserPrincipal(t *testing.T) {
	resolver := &principalAuthResolver{
		key: &APIKey{
			ID: "key-1", TenantID: "tenant-1", UserID: "user-1",
			Scopes: []Scope{ScopeReadCampaigns},
		},
		tenant: &middleware.Tenant{ID: "tenant-1", Slug: "acme"},
	}
	handler := MiddlewareWithOptions(nil, resolver, MiddlewareOptions{})(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, ok := middleware.UserFromContext(r.Context())
			if !ok || user.ID != "user-1" || user.TenantID != "tenant-1" {
				t.Fatalf("user=%#v ok=%v", user, ok)
			}
			w.WriteHeader(http.StatusNoContent)
		}),
	)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/mcp", nil)
	req.Header.Set("Authorization", "Bearer pw_principal_test")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func (f fakeSupplementalBearerResolver) SupportsBearerToken(plaintext string) bool {
	return strings.HasPrefix(plaintext, "pw_at_")
}

func (f fakeSupplementalBearerResolver) ResolveBearerToken(context.Context, string) (*SupplementalBearerAuth, error) {
	return f.auth, f.err
}

func TestRequireScopeRejectsMissingPrincipal(t *testing.T) {
	called := false
	handler := RequireScope(ScopeWriteSubscribers)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || called {
		t.Fatalf("missing principal should fail closed, status=%d called=%v", rec.Code, called)
	}
}

func TestMiddlewareRejectsMalformedBearerBeforeSessionFallback(t *testing.T) {
	for _, header := range []string{"Bearer x", "bearer x", "Basic abc", "Bearer", "Bearer pw_one extra"} {
		t.Run(header, func(t *testing.T) {
			called := false
			h := MiddlewareWithOptions(nil, nil, MiddlewareOptions{})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}))
			req := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers", nil)
			req.Header.Set("Authorization", header)
			req.AddCookie(&http.Cookie{Name: "pw_session", Value: "ambient-session"})
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized || called {
				t.Fatalf("header %q status=%d called=%v body=%s", header, rec.Code, called, rec.Body.String())
			}
		})
	}
}

func TestBearerCredentialQueryIsRestrictedToStreamingRoutes(t *testing.T) {
	for _, rawURL := range []string{
		"/api/v1/events?api_key=pw_test",
		"/api/v1/audit/export?api_key=pw_test",
		"/api/v1/mcp/executions/stream?api_key=pw_live_long_lived_secret",
		"/api/v1/subscribers?api_key=pw_test",
	} {
		req := httptest.NewRequest(http.MethodGet, rawURL, nil)
		got, present, err := bearerCredentialFromRequest(req)
		if err == nil || !present || got != "" {
			t.Fatalf("url=%q got=(%q,%v,%v), want long-lived query credential rejected", rawURL, got, present, err)
		}
	}
}

func TestBearerCredentialRejectsHeaderAndQuerySmuggling(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/events?api_key=pw_query", nil)
	req.Header.Set("Authorization", "Bearer pw_header")
	if _, present, err := bearerCredentialFromRequest(req); err == nil || !present {
		t.Fatalf("combined header/query credential got present=%v err=%v, want rejection", present, err)
	}
	req = httptest.NewRequest(http.MethodGet, "/api/v1/events?api_key=pw_one&api_key=pw_two", nil)
	if _, present, err := bearerCredentialFromRequest(req); err == nil || !present {
		t.Fatalf("duplicate query credentials got present=%v err=%v, want rejection", present, err)
	}
	req = httptest.NewRequest(http.MethodGet, "/api/v1/events", nil)
	req.Header.Add("Authorization", "Bearer pw_one")
	req.Header.Add("Authorization", "Bearer pw_two")
	if _, present, err := bearerCredentialFromRequest(req); err == nil || !present {
		t.Fatalf("duplicate header credentials got present=%v err=%v, want rejection", present, err)
	}
}

func TestMiddlewareRejectsStreamTokenCombinedWithBearer(t *testing.T) {
	secret := []byte("stream-token-secret-with-enough-entropy")
	token, err := IssueStreamToken(secret, StreamTokenClaims{
		TenantID: "tenant-1",
		Scopes:   []Scope{ScopeReadReports},
	}, time.Now().UTC(), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	called := false
	h := MiddlewareWithOptions(nil, nil, MiddlewareOptions{StreamTokenSecret: secret})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/events?stream_token="+token, nil)
	req.Header.Set("Authorization", "Bearer pw_other")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized || called || !strings.Contains(rec.Body.String(), "conflicting_credentials") {
		t.Fatalf("status=%d called=%v body=%s", rec.Code, called, rec.Body.String())
	}
}

func TestRequireScopeAllowsRequiredScope(t *testing.T) {
	handler := RequireScope(ScopeWriteSubscribers)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers", nil)
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = WithScopes(ctx, []Scope{ScopeReadSubscribers, ScopeWriteSubscribers})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req.WithContext(ctx))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
}

func TestMiddlewareAcceptsSupplementalBearerResolver(t *testing.T) {
	resolver := fakeSupplementalBearerResolver{
		auth: &SupplementalBearerAuth{
			Tenant: &middleware.Tenant{
				ID:   "tenant-1",
				Slug: "acme",
				Name: "Acme",
				Tier: "pro",
			},
			Scopes:     []Scope{ScopeReadSubscribers},
			ActorType:  "agent",
			ActorLabel: "developer-marketplace:inventory:install-1",
		},
	}
	handler := MiddlewareWithOptions(nil, nil, MiddlewareOptions{
		SupplementalBearerResolvers: []SupplementalBearerResolver{resolver},
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tenant, ok := middleware.TenantFromContext(r.Context())
		if !ok || tenant.ID != "tenant-1" || tenant.Slug != "acme" {
			t.Fatalf("tenant context = %+v ok=%v", tenant, ok)
		}
		if !middleware.IsAPIKeyAuth(r.Context()) || !HasScope(r.Context(), ScopeReadSubscribers) {
			t.Fatalf("supplemental bearer did not attach API-key-style scope")
		}
		actorType, actorLabel := middleware.ActorFromContext(r.Context())
		if actorType != "agent" || actorLabel != "developer-marketplace:inventory:install-1" {
			t.Fatalf("actor = %q %q", actorType, actorLabel)
		}
		if got := middleware.APIKeyIDFromContext(r.Context()); got != "" {
			t.Fatalf("non-api-key supplemental bearer should not attach api key id, got %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/subscribers", nil)
	req.Header.Set("Authorization", "Bearer pw_at_test")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestMiddlewareRejectsInvalidSupplementalBearer(t *testing.T) {
	handler := MiddlewareWithOptions(nil, nil, MiddlewareOptions{
		SupplementalBearerResolvers: []SupplementalBearerResolver{
			fakeSupplementalBearerResolver{err: errors.New("invalid")},
		},
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/subscribers", nil)
	req.Header.Set("Authorization", "Bearer pw_at_test")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d want %d body=%s", rec.Code, http.StatusUnauthorized, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_api_key") {
		t.Fatalf("body=%s", rec.Body.String())
	}
}

func TestRequireScopeRejectsMissingScope(t *testing.T) {
	handler := RequireScope(ScopeWriteSubscribers)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers", nil)
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = WithScopes(ctx, []Scope{ScopeReadSubscribers})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req.WithContext(ctx))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	if !strings.Contains(rec.Body.String(), "insufficient_scope") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestRequireScopeAllowsAdminScope(t *testing.T) {
	handler := RequireScope(ScopeWriteSubscribers)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers", nil)
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = WithScopes(ctx, []Scope{ScopeAdmin})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req.WithContext(ctx))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
}

func TestRequireAllScopesRejectsPartialMatch(t *testing.T) {
	handler := RequireAllScopes(ScopeWriteCampaigns, ScopeSendTransactional)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/test-send", nil)
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = WithScopes(ctx, []Scope{ScopeWriteCampaigns})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req.WithContext(ctx))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestRequireAllScopesAllowsFullMatch(t *testing.T) {
	handler := RequireAllScopes(ScopeWriteCampaigns, ScopeSendTransactional)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/campaigns/test-send", nil)
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = WithScopes(ctx, []Scope{ScopeWriteCampaigns, ScopeSendTransactional})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req.WithContext(ctx))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
}

func TestMiddlewareAcceptsStreamTokenOnRealtimeRoutes(t *testing.T) {
	secret := []byte("stream-token-secret-with-enough-entropy")
	token, err := IssueStreamToken(secret, StreamTokenClaims{
		TenantID:   "tenant-1",
		TenantSlug: "acme",
		Scopes:     []Scope{ScopeReadReports},
	}, time.Now().UTC(), time.Minute)
	if err != nil {
		t.Fatalf("IssueStreamToken: %v", err)
	}
	called := false
	handler := MiddlewareWithOptions(nil, nil, MiddlewareOptions{StreamTokenSecret: secret})(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			called = true
			tnt, ok := middleware.TenantFromContext(r.Context())
			if !ok || tnt.ID != "tenant-1" {
				t.Fatalf("tenant context = %+v ok=%v", tnt, ok)
			}
			if !middleware.IsAPIKeyAuth(r.Context()) || !HasScope(r.Context(), ScopeReadReports) {
				t.Fatal("stream token did not attach API-key-style read scope")
			}
			actorType, _ := middleware.ActorFromContext(r.Context())
			if actorType != "human" {
				t.Fatalf("actor type = %q, want canonical human fallback", actorType)
			}
			w.WriteHeader(http.StatusNoContent)
		}),
	)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/events?stream_token="+token, nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent || !called {
		t.Fatalf("status=%d called=%v body=%s", rec.Code, called, rec.Body.String())
	}
}

func TestMiddlewareRejectsStreamTokenOnNonStreamRoutes(t *testing.T) {
	secret := []byte("stream-token-secret-with-enough-entropy")
	token, err := IssueStreamToken(secret, StreamTokenClaims{
		TenantID: "tenant-1",
		Scopes:   []Scope{ScopeReadReports},
	}, time.Now().UTC(), time.Minute)
	if err != nil {
		t.Fatalf("IssueStreamToken: %v", err)
	}
	handler := MiddlewareWithOptions(nil, nil, MiddlewareOptions{StreamTokenSecret: secret})(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}),
	)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/subscribers?stream_token="+token, nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d want=%d body=%s", rec.Code, http.StatusUnauthorized, rec.Body.String())
	}
}
