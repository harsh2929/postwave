package apikeys

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestRealtimeStreamRoutePatternsStayInSyncWithMatcher(t *testing.T) {
	samples := map[string]string{
		"/api/v1/events":                           "/api/v1/events",
		"/api/v1/dashboard/live":                   "/api/v1/dashboard/live",
		"/api/v1/campaigns/{id}/events":            "/api/v1/campaigns/cmp_123/events",
		"/api/v1/migrations/{id}/events":           "/api/v1/migrations/job_123/events",
		"/api/v1/audit/export":                     "/api/v1/audit/export",
		"/api/v1/audit/export-jobs/{id}/download":  "/api/v1/audit/export-jobs/5b1f6a7e-0000-0000-0000-000000000000/download",
		"/api/v1/audit/stream":                     "/api/v1/audit/stream",
		"/api/v1/audit/investigations/{id}/stream": "/api/v1/audit/investigations/inv_123/stream",
		"/api/v1/mcp/executions/stream":            "/api/v1/mcp/executions/stream",
		"/api/v1/forms/{id}/submissions.csv":       "/api/v1/forms/frm_123/submissions.csv",
		"/api/v1/subscriber-imports/{id}/progress": "/api/v1/subscriber-imports/5b1f6a7e-0000-0000-0000-000000000000/progress",
		"/api/v1/track/stream":                     "/api/v1/track/stream",
		"/api/v1/track/events.csv":                 "/api/v1/track/events.csv",
	}
	for _, pattern := range RealtimeStreamRoutePatterns {
		sample, ok := samples[pattern]
		if !ok {
			t.Fatalf("no matcher sample for realtime route pattern %q", pattern)
		}
		if !StreamTokenAllowedPath(sample) {
			t.Fatalf("pattern %q sample %q is not accepted by stream token matcher", pattern, sample)
		}
	}
}

func TestStreamTokenMatcherRejectsNonRealtimeRoutes(t *testing.T) {
	for _, path := range []string{
		"/api/v1/subscribers/events",
		"/api/v1/campaigns/cmp_123",
		"/api/v1/migrations/job_123",
		"/api/v1/billing/events",
		// Audit surface: the synchronous export, the async job download,
		// the live-tail SSE (/audit/stream), and per-investigation SSE
		// accept URL-token auth (D13#1). Everything else on /api/v1/audit
		// stays header/cookie auth.
		"/api/v1/audit",
		"/api/v1/audit/export/manifests",
		"/api/v1/audit/export-async",
		"/api/v1/audit/export-jobs",
		"/api/v1/audit/export-jobs/job_123",
		"/api/v1/audit/export-jobs//download",
		"/api/v1/audit/export-jobs/job_123/extra/download",
		"/api/v1/audit/events",
		"/api/v1/audit/access-requests",
		"/api/v1/mcp/executions",
		"/api/v1/mcp/executions.csv",
		"/api/v1/mcp/executions/stream/extra",
		"/api/v1/mcp/catalog",
		// Investigation stream + forms CSV require exactly one id segment.
		"/api/v1/audit/investigations//stream",
		"/api/v1/audit/investigations/inv_1/extra/stream",
		"/api/v1/forms//submissions.csv",
		"/api/v1/forms/frm_1/extra/submissions.csv",
		"/api/v1/subscriber-imports//progress",
		"/api/v1/subscriber-imports/job_1/extra/progress",
		"/api/v1/subscriber-imports/job_1",
		"/api/v1/track",
		"/api/v1/track/events",
		"/api/v1/track/catalog",
		"/api/v1/track/stats",
		"/api/v1/track/stream/extra",
		"/api/v1/track/events.csv/extra",
	} {
		if StreamTokenAllowedPath(path) {
			t.Fatalf("path %q should not accept stream-token URL auth", path)
		}
	}
}

func TestStreamTokenMatcherAcceptsOnlyProductEventLiveAndExportRoutes(t *testing.T) {
	for _, path := range []string{
		"/api/v1/track/stream",
		"/api/v1/track/events.csv",
	} {
		if !StreamTokenAllowedPath(path) {
			t.Fatalf("path %q should accept stream-token URL auth", path)
		}
	}
}

func mintSessionStreamToken(
	t *testing.T,
	secret []byte,
	role string,
	effectiveRole string,
) string {
	t.Helper()
	ctx := middleware.WithTenant(
		context.Background(),
		&middleware.Tenant{ID: "tenant-1"},
	)
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID:            "user-1",
		TenantID:      "tenant-1",
		Role:          role,
		EffectiveRole: effectiveRole,
	})
	request := httptest.NewRequestWithContext(
		ctx,
		http.MethodPost,
		"/api/v1/streams/token",
		nil,
	)
	response := httptest.NewRecorder()
	StreamTokenHandler(secret, time.Minute)(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("mint status=%d body=%s", response.Code, response.Body.String())
	}
	var body StreamTokenResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Token == "" {
		t.Fatal("minted stream token is empty")
	}
	return body.Token
}

func TestSessionStreamTokenPreservesEffectiveRoleBoundary(t *testing.T) {
	secret := []byte("stream-token-secret-with-enough-entropy")
	tests := []struct {
		name          string
		role          string
		effectiveRole string
		wantScopes    []Scope
	}{
		{
			name:       "viewer",
			role:       "viewer",
			wantScopes: []Scope{ScopeReadReports, ScopeReadSubscribers},
		},
		{
			name:       "editor",
			role:       "editor",
			wantScopes: []Scope{ScopeReadReports, ScopeReadSubscribers},
		},
		{name: "admin", role: "admin", wantScopes: []Scope{ScopeAdmin}},
		{name: "owner", role: "owner", wantScopes: []Scope{ScopeAdmin}},
		{
			name:          "admin previewing viewer",
			role:          "admin",
			effectiveRole: "viewer",
			wantScopes:    []Scope{ScopeReadReports, ScopeReadSubscribers},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			token := mintSessionStreamToken(
				t,
				secret,
				test.role,
				test.effectiveRole,
			)
			claims, err := ParseStreamToken(secret, token, time.Now().UTC())
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(claims.Scopes, test.wantScopes) {
				t.Fatalf("scopes=%v, want exact least-privilege scopes %v", claims.Scopes, test.wantScopes)
			}
		})
	}
}

func TestMintedStreamTokenOmitsPresentationPIIFromReadablePayload(t *testing.T) {
	secret := []byte("stream-token-secret-with-enough-entropy")
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{
		ID: "tenant-id-opaque", Slug: "sensitive-workspace-slug", Name: "Sensitive Workspace", Tier: "enterprise",
	})
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID: "user-id-opaque", TenantID: "tenant-id-opaque", Email: "person@example.test", Role: "admin",
	})
	ctx = middleware.WithActor(ctx, "human", "person@example.test")
	request := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/v1/streams/token", nil)
	response := httptest.NewRecorder()
	StreamTokenHandler(secret, time.Minute)(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body StreamTokenResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(strings.TrimPrefix(body.Token, streamTokenPrefix), ".")
	if len(parts) != 2 {
		t.Fatalf("token shape=%q", body.Token)
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		"sensitive-workspace-slug", "Sensitive Workspace", "enterprise", "person@example.test", `"user_role"`,
	} {
		if strings.Contains(string(payload), forbidden) {
			t.Fatalf("readable token payload leaked %q: %s", forbidden, payload)
		}
	}
	claims, err := ParseStreamToken(secret, body.Token, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if claims.TenantID != "tenant-id-opaque" || claims.PrincipalID != "user-id-opaque" || claims.ActorType != "human" {
		t.Fatalf("minimized opaque claims=%+v", claims)
	}
}

func TestNonAdminSessionStreamTokenPreservesOnlyExplicitAdditionalGrants(t *testing.T) {
	ctx := middleware.WithUser(context.Background(), &middleware.User{Role: "viewer"})
	ctx = WithScopes(ctx, []Scope{
		ScopeReadCampaigns,
		ScopeReadReports,
		ScopeReadSubscribers,
		ScopeReadCampaigns,
		ScopeAdmin,
	})

	got := sessionStreamTokenScopes(ctx, &middleware.User{Role: "viewer"})
	want := []Scope{ScopeReadReports, ScopeReadSubscribers, ScopeReadCampaigns}
	if !slices.Equal(got, want) {
		t.Fatalf("session stream scopes = %v, want %v", got, want)
	}
}

func TestViewerStreamTokenPassesRawProductEventReadGate(t *testing.T) {
	secret := []byte("stream-token-secret-with-enough-entropy")
	token := mintSessionStreamToken(t, secret, "viewer", "")
	called := false
	handler := MiddlewareWithOptions(
		nil,
		nil,
		MiddlewareOptions{StreamTokenSecret: secret},
	)(RequireAllScopes(
		ScopeReadReports,
		ScopeReadSubscribers,
	)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	})))

	request := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/track/stream?stream_token="+token,
		nil,
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent || !called {
		t.Fatalf(
			"viewer token did not pass raw Product Events read gate: status=%d called=%v body=%s",
			response.Code,
			called,
			response.Body.String(),
		)
	}
}

func TestViewerStreamTokenCannotEscalateOnAllowlistedRoute(t *testing.T) {
	secret := []byte("stream-token-secret-with-enough-entropy")
	token := mintSessionStreamToken(t, secret, "viewer", "")
	called := false
	handler := MiddlewareWithOptions(
		nil,
		nil,
		MiddlewareOptions{StreamTokenSecret: secret},
	)(RequireScope(ScopeAdmin)(http.HandlerFunc(
		func(w http.ResponseWriter, _ *http.Request) {
			called = true
			w.WriteHeader(http.StatusNoContent)
		},
	)))

	request := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/track/events.csv?stream_token="+token,
		nil,
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusForbidden || called {
		t.Fatalf(
			"viewer token escalated: status=%d called=%v body=%s",
			response.Code,
			called,
			response.Body.String(),
		)
	}
}

func TestMCPExecutionStreamTokenPreservesAdminGate(t *testing.T) {
	secret := []byte("stream-token-secret-with-enough-entropy")
	for _, test := range []struct {
		name       string
		role       string
		wantStatus int
		wantCalled bool
	}{
		{name: "admin admitted", role: "admin", wantStatus: http.StatusNoContent, wantCalled: true},
		{name: "viewer denied", role: "viewer", wantStatus: http.StatusForbidden, wantCalled: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			token := mintSessionStreamToken(t, secret, test.role, "")
			called := false
			handler := MiddlewareWithOptions(
				nil,
				nil,
				MiddlewareOptions{StreamTokenSecret: secret},
			)(RequireScope(ScopeAdmin)(http.HandlerFunc(
				func(w http.ResponseWriter, _ *http.Request) {
					called = true
					w.WriteHeader(http.StatusNoContent)
				},
			)))

			request := httptest.NewRequest(
				http.MethodGet,
				"/api/v1/mcp/executions/stream?stream_token="+token,
				nil,
			)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			if response.Code != test.wantStatus || called != test.wantCalled {
				t.Fatalf(
					"status=%d called=%v, want status=%d called=%v body=%s",
					response.Code,
					called,
					test.wantStatus,
					test.wantCalled,
					response.Body.String(),
				)
			}
		})
	}
}

// TestStreamTokenMatcherAcceptsAuditStreamAndFormsCSV covers the routes
// added for D13#1 (audit live-tail + investigation SSE) and D08#3 (forms
// submissions CSV) — all use buildStreamUrl in cookieless Electron
// contexts and can't set an Authorization header.
func TestStreamTokenMatcherAcceptsAuditStreamAndFormsCSV(t *testing.T) {
	for _, path := range []string{
		"/api/v1/audit/stream",
		"/api/v1/audit/investigations/inv_123/stream",
		"/api/v1/forms/frm_123/submissions.csv",
	} {
		if !StreamTokenAllowedPath(path) {
			t.Fatalf("path %q should accept stream-token URL auth", path)
		}
	}
}

// Desktop-audit gap A15: the export-job download must authenticate via
// the SAME MiddlewareWithOptions chain the realtime routes use — a
// ?stream_token on the download path resolves tenant + API-key-style
// scopes, while sibling export-job routes keep rejecting URL tokens.
func TestMiddlewareAcceptsStreamTokenOnAuditExportDownload(t *testing.T) {
	secret := []byte("stream-token-secret-with-enough-entropy")
	token, err := IssueStreamToken(secret, StreamTokenClaims{
		TenantID: "tenant-1",
		Scopes:   []Scope{ScopeAuditRead},
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
			// The route gate in main.go is RequireScope(ScopeAuditRead);
			// assert the token's scope survives into context the same
			// way it does for the realtime routes.
			if !middleware.IsAPIKeyAuth(r.Context()) || !HasScope(r.Context(), ScopeAuditRead) {
				t.Fatal("stream token did not attach audit:read scope")
			}
			w.WriteHeader(http.StatusNoContent)
		}),
	)

	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/audit/export-jobs/5b1f6a7e-0000-0000-0000-000000000000/download?stream_token="+token, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || !called {
		t.Fatalf("download path: status=%d called=%v body=%s", rec.Code, called, rec.Body.String())
	}

	// Sibling job-status route must keep rejecting URL tokens.
	req = httptest.NewRequest(http.MethodGet,
		"/api/v1/audit/export-jobs/5b1f6a7e-0000-0000-0000-000000000000?stream_token="+token, nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("job-status path: status=%d want=%d body=%s",
			rec.Code, http.StatusUnauthorized, rec.Body.String())
	}
}

func TestMiddlewareAcceptsStreamTokenOnlyOnSubscriberImportProgress(t *testing.T) {
	secret := []byte("stream-token-secret-with-enough-entropy")
	token, err := IssueStreamToken(secret, StreamTokenClaims{
		TenantID: "tenant-1",
		Scopes:   []Scope{ScopeAdmin},
	}, time.Now().UTC(), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	called := false
	handler := MiddlewareWithOptions(nil, nil, MiddlewareOptions{StreamTokenSecret: secret})(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			called = true
			if !middleware.IsAPIKeyAuth(r.Context()) || !HasScope(r.Context(), ScopeAdmin) {
				t.Fatal("subscriber-import stream token scope/context was not attached")
			}
			w.WriteHeader(http.StatusNoContent)
		}),
	)
	progress := "/api/v1/subscriber-imports/5b1f6a7e-0000-0000-0000-000000000000/progress"
	req := httptest.NewRequest(http.MethodGet, progress+"?stream_token="+token, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || !called {
		t.Fatalf("progress stream: status=%d called=%v body=%s", rec.Code, called, rec.Body.String())
	}

	for _, sibling := range []string{
		"/api/v1/subscriber-imports/5b1f6a7e-0000-0000-0000-000000000000",
		"/api/v1/subscriber-imports/5b1f6a7e-0000-0000-0000-000000000000/cancel",
	} {
		req = httptest.NewRequest(http.MethodGet, sibling+"?stream_token="+token, nil)
		rec = httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("sibling %q accepted URL token: status=%d", sibling, rec.Code)
		}
	}
}
