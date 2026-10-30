// SPDX-License-Identifier: AGPL-3.0-only
package apidocs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/routeauth"
)

type fixedWindowStoreFunc func(context.Context, string, int, time.Duration, time.Time) (int, time.Time, error)

func (f fixedWindowStoreFunc) Reserve(ctx context.Context, key string, limit int, window time.Duration, now time.Time) (int, time.Time, error) {
	return f(ctx, key, limit, window, now)
}

func testRateLimitedDeps() *Deps {
	sessionLimit := middleware.NewTenantRateLimit(1000, time.Minute)
	apiKeyLimit := middleware.NewKeyRateLimit(func(context.Context, string) (int, int, int, error) {
		return 1000, 0, 0, nil
	})
	return &Deps{
		APIKeyRateLimit:  apiKeyLimit.Middleware,
		SessionRateLimit: sessionLimit.Middleware,
	}
}

func TestOpenAPISpecAuthorizationContractIsAuthenticatedViewerRead(t *testing.T) {
	var document struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(SpecJSON, &document); err != nil {
		t.Fatalf("decode embedded OpenAPI: %v", err)
	}
	rawOperation, ok := document.Paths["/api/v1/openapi.json"]["get"]
	if !ok {
		t.Fatal("embedded OpenAPI omits GET /api/v1/openapi.json")
	}
	var operation struct {
		Security        []map[string][]string `json:"security"`
		RequiredScopes  []string              `json:"x-required-scopes"`
		RequiredRole    string                `json:"x-required-role"`
		Source          string                `json:"x-postwave-source"`
		PrivateResponse bool                  `json:"x-postwave-private-response"`
		RateLimit       struct {
			Identity             string `json:"identity"`
			Requests             int    `json:"requests"`
			WindowSeconds        int    `json:"window-seconds"`
			Bucket               string `json:"bucket"`
			AdditionalToKeyLimit bool   `json:"additional-to-configured-api-key-limit"`
		} `json:"x-postwave-rate-limit"`
		Responses map[string]struct {
			Content map[string]json.RawMessage `json:"content"`
			Headers map[string]json.RawMessage `json:"headers"`
		} `json:"responses"`
	}
	if err := json.Unmarshal(rawOperation, &operation); err != nil {
		t.Fatalf("decode GET /api/v1/openapi.json: %v", err)
	}
	if operation.RequiredRole != "viewer" || !slices.Equal(operation.RequiredScopes, []string{"read:reports"}) {
		t.Fatalf("OpenAPI authorization = role %q scopes %v, want viewer + read:reports", operation.RequiredRole, operation.RequiredScopes)
	}
	if operation.Source != "apps/api/internal/apidocs/apidocs.go:100" {
		t.Fatalf("OpenAPI source = %q, want current GetSpec handler", operation.Source)
	}
	if len(operation.Security) != 2 || operation.Security[0]["bearerAuth"] == nil || operation.Security[1]["sessionCookie"] == nil {
		t.Fatalf("OpenAPI security = %#v, want bearerAuth OR sessionCookie", operation.Security)
	}
	response, ok := operation.Responses["200"]
	if !ok || response.Content["application/json"] == nil {
		t.Fatalf("OpenAPI 200 response = %#v, want declared application/json content", response)
	}
	if !operation.PrivateResponse {
		t.Fatal("OpenAPI operation must mark the authenticated build-wide document as a private response")
	}
	if operation.RateLimit.Identity != "verified-api-key-id" ||
		operation.RateLimit.Requests != APIKeyRateLimitPerMinute ||
		operation.RateLimit.WindowSeconds != 60 ||
		operation.RateLimit.Bucket != "api-docs-per-api-key" ||
		!operation.RateLimit.AdditionalToKeyLimit {
		t.Fatalf("OpenAPI API-key fallback rate limit = %+v", operation.RateLimit)
	}
	for _, status := range []string{"401", "403", "429", "503"} {
		privateResponse, ok := operation.Responses[status]
		if !ok {
			t.Fatalf("OpenAPI operation omits %s response", status)
		}
		for _, header := range []string{"Cache-Control", "Pragma", "Vary", "X-Content-Type-Options"} {
			if privateResponse.Headers[header] == nil {
				t.Fatalf("OpenAPI %s response omits documented %s header", status, header)
			}
		}
	}
	for _, header := range []string{"Cache-Control", "Pragma", "Vary", "X-Content-Type-Options"} {
		if response.Headers[header] == nil {
			t.Fatalf("OpenAPI 200 response omits documented %s header", header)
		}
	}

	policy, ok := routeauth.PolicyFor(http.MethodGet, "/api/v1/openapi.json")
	if !ok {
		t.Fatal("generated routeauth manifest omits GET /api/v1/openapi.json")
	}
	if policy.Exposure != routeauth.ExposureAuthenticated ||
		policy.SessionMinimumRole != "viewer" ||
		!slices.Equal(policy.AuthMethods, []string{"session", "api_key"}) ||
		!slices.Equal(policy.APIKeyScopes, []string{"read:reports"}) ||
		policy.APIKeyScopeMode != routeauth.ScopeModeAny {
		t.Fatalf("generated routeauth policy = %+v, want authenticated viewer/read:reports", policy)
	}
}

func TestOpenAPISpecMiddlewareBoundaryDeniesAnonymousAndServesViewer(t *testing.T) {
	router := chi.NewRouter()
	router.Use(ProtectResponses)
	router.Use(httpcache.Conditional())
	router.Use(routeauth.Middleware)
	testRateLimitedDeps().Mount(router)

	t.Run("anonymous denied before artifact", func(t *testing.T) {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/api/v1/openapi.json", nil)
		router.ServeHTTP(response, request)

		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401; body=%s", response.Code, response.Body.String())
		}
		assertDoesNotExposeSpec(t, response)
		assertPrivateArtifactBoundary(t, response)
	})

	t.Run("under-scoped API key denied before artifact", func(t *testing.T) {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, specPath, nil)
		ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant-1"})
		ctx = middleware.WithAPIKeyAuth(ctx)
		ctx = middleware.WithAPIKeyID(ctx, "under-scoped-key")
		router.ServeHTTP(response, request.WithContext(ctx))

		if response.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403; body=%s", response.Code, response.Body.String())
		}
		assertDoesNotExposeSpec(t, response)
		assertPrivateArtifactBoundary(t, response)
	})

	t.Run("authorized API key without verified key identity fails closed", func(t *testing.T) {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, specPath, nil)
		ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant-1"})
		ctx = middleware.WithAPIKeyAuth(ctx)
		ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
		router.ServeHTTP(response, request.WithContext(ctx))

		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503; body=%s", response.Code, response.Body.String())
		}
		assertDoesNotExposeSpec(t, response)
		assertPrivateArtifactBoundary(t, response)
	})

	t.Run("authenticated viewer receives real embedded artifact", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/openapi.json", nil)
		ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant-1"})
		ctx = middleware.WithUser(ctx, &middleware.User{
			ID:       "user-1",
			TenantID: "tenant-1",
			Role:     "viewer",
		})
		assertServesEmbeddedSpec(t, router, request.WithContext(ctx))
	})

	t.Run("authenticated read-scoped API key receives real embedded artifact", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/openapi.json", nil)
		ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant-1"})
		ctx = middleware.WithAPIKeyAuth(ctx)
		ctx = middleware.WithAPIKeyID(ctx, "read-key")
		ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
		assertServesEmbeddedSpec(t, router, request.WithContext(ctx))
	})
}

func TestOpenAPISpecRateLimitsRepeatedSessionsWithoutDoubleChargingAPIKeys(t *testing.T) {
	sessionLimit := middleware.NewTenantRateLimit(1, time.Minute)
	apiKeyLimit := middleware.NewKeyRateLimit(func(context.Context, string) (int, int, int, error) {
		return APIKeyRateLimitPerMinute, 0, 0, nil
	})
	deps := &Deps{
		APIKeyRateLimit:  apiKeyLimit.Middleware,
		SessionRateLimit: sessionLimit.Middleware,
	}
	router := chi.NewRouter()
	router.Use(ProtectResponses)
	router.Use(routeauth.Middleware)
	deps.Mount(router)

	requestFor := func(apiKey bool) *http.Request {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/openapi.json", nil)
		ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant-rate-limited"})
		if apiKey {
			ctx = middleware.WithAPIKeyAuth(ctx)
			ctx = middleware.WithAPIKeyID(ctx, "read-key")
			ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
		} else {
			ctx = middleware.WithUser(ctx, &middleware.User{
				ID:       "session-user",
				TenantID: "tenant-rate-limited",
				Role:     "viewer",
			})
		}
		return request.WithContext(ctx)
	}

	first := httptest.NewRecorder()
	router.ServeHTTP(first, requestFor(false))
	if first.Code != http.StatusOK {
		t.Fatalf("first session status = %d, want 200", first.Code)
	}

	limited := httptest.NewRecorder()
	router.ServeHTTP(limited, requestFor(false))
	if limited.Code != http.StatusTooManyRequests {
		t.Fatalf("repeated session status = %d, want 429", limited.Code)
	}
	if limited.Header().Get("Retry-After") == "" {
		t.Fatal("repeated session response omits Retry-After")
	}
	assertDoesNotExposeSpec(t, limited)
	assertPrivateArtifactBoundary(t, limited)

	// Bearer requests have already crossed the authenticated stack's per-key
	// limiter. The route-local session bucket must neither consume nor replace it.
	for attempt := 0; attempt < 2; attempt++ {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, requestFor(true))
		if response.Code != http.StatusOK {
			t.Fatalf("API-key attempt %d status = %d, want 200", attempt+1, response.Code)
		}
		if !bytes.Equal(response.Body.Bytes(), SpecJSON) {
			t.Fatalf("API-key attempt %d did not receive the exact embedded artifact", attempt+1)
		}
	}
}

func TestOpenAPISpecMissingRouteLimiterFailsClosed(t *testing.T) {
	router := chi.NewRouter()
	router.Use(ProtectResponses)
	router.Use(routeauth.Middleware)
	(&Deps{}).Mount(router)

	requests := []struct {
		name    string
		request *http.Request
	}{
		{
			name: "session",
			request: func() *http.Request {
				r := httptest.NewRequest(http.MethodGet, specPath, nil)
				ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "tenant-missing-limit"})
				ctx = middleware.WithUser(ctx, &middleware.User{ID: "user-1", TenantID: "tenant-missing-limit", Role: "viewer"})
				return r.WithContext(ctx)
			}(),
		},
		{
			name: "api key",
			request: func() *http.Request {
				r := httptest.NewRequest(http.MethodGet, specPath, nil)
				ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "tenant-missing-limit"})
				ctx = middleware.WithAPIKeyAuth(ctx)
				ctx = middleware.WithAPIKeyID(ctx, "key-missing-limit")
				ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
				return r.WithContext(ctx)
			}(),
		},
	}
	for _, test := range requests {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			router.ServeHTTP(response, test.request)
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503", response.Code)
			}
			assertDoesNotExposeSpec(t, response)
			assertPrivateArtifactBoundary(t, response)
		})
	}
}

func TestOpenAPISpecDistributedSessionKeyAndStoreFailure(t *testing.T) {
	var (
		keys     []string
		storeErr error
	)
	store := fixedWindowStoreFunc(func(_ context.Context, key string, _ int, window time.Duration, now time.Time) (int, time.Time, error) {
		keys = append(keys, key)
		if storeErr != nil {
			return 0, now.Add(window), storeErr
		}
		return len(keys), now.Add(window), nil
	})
	sessionLimit := middleware.NewTenantRateLimitWithOptions(10, time.Minute, middleware.TenantRateLimitOptions{
		Store:     store,
		Namespace: "tenant:api-docs-session",
	})
	router := chi.NewRouter()
	router.Use(ProtectResponses)
	router.Use(routeauth.Middleware)
	apiKeyLimit := middleware.NewKeyRateLimit(func(context.Context, string) (int, int, int, error) {
		return APIKeyRateLimitPerMinute, 0, 0, nil
	})
	(&Deps{
		APIKeyRateLimit:  apiKeyLimit.Middleware,
		SessionRateLimit: sessionLimit.Middleware,
	}).Mount(router)

	sessionRequest := httptest.NewRequest(http.MethodGet, specPath, nil)
	sessionContext := middleware.WithTenant(sessionRequest.Context(), &middleware.Tenant{ID: "tenant-distributed"})
	sessionContext = middleware.WithUser(sessionContext, &middleware.User{
		ID:       "session-user",
		TenantID: "tenant-distributed",
		Role:     "viewer",
	})
	sessionResponse := httptest.NewRecorder()
	router.ServeHTTP(sessionResponse, sessionRequest.WithContext(sessionContext))
	if sessionResponse.Code != http.StatusOK {
		t.Fatalf("session status = %d, want 200", sessionResponse.Code)
	}
	if !slices.Equal(keys, []string{"tenant:api-docs-session:tenant:tenant-distributed"}) {
		t.Fatalf("distributed reservation keys = %v", keys)
	}

	apiKeyRequest := httptest.NewRequest(http.MethodGet, specPath, nil)
	apiKeyContext := middleware.WithTenant(apiKeyRequest.Context(), &middleware.Tenant{ID: "tenant-distributed"})
	apiKeyContext = middleware.WithAPIKeyAuth(apiKeyContext)
	apiKeyContext = middleware.WithAPIKeyID(apiKeyContext, "distributed-key")
	apiKeyContext = apikeys.WithScopes(apiKeyContext, []apikeys.Scope{apikeys.ScopeReadReports})
	apiKeyResponse := httptest.NewRecorder()
	router.ServeHTTP(apiKeyResponse, apiKeyRequest.WithContext(apiKeyContext))
	if apiKeyResponse.Code != http.StatusOK {
		t.Fatalf("API-key status = %d, want 200", apiKeyResponse.Code)
	}
	if len(keys) != 1 {
		t.Fatalf("API key consumed the session store; keys = %v", keys)
	}

	storeErr = errors.New("shared store unavailable")
	failureRequest := httptest.NewRequest(http.MethodGet, specPath, nil)
	failureContext := middleware.WithTenant(failureRequest.Context(), &middleware.Tenant{ID: "tenant-store-failure"})
	failureContext = middleware.WithUser(failureContext, &middleware.User{
		ID:       "session-user",
		TenantID: "tenant-store-failure",
		Role:     "viewer",
	})
	failureResponse := httptest.NewRecorder()
	router.ServeHTTP(failureResponse, failureRequest.WithContext(failureContext))
	if failureResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("store failure status = %d, want 503", failureResponse.Code)
	}
	assertDoesNotExposeSpec(t, failureResponse)
	assertPrivateArtifactBoundary(t, failureResponse)
}

func TestOpenAPISpecAPIKeyRetainsOuterPerKeyLimiter(t *testing.T) {
	keyLimit := middleware.NewKeyRateLimit(func(context.Context, string) (int, int, int, error) {
		return 1, 0, 0, nil
	})
	routeFallback := middleware.NewKeyRateLimit(func(context.Context, string) (int, int, int, error) {
		return APIKeyRateLimitPerMinute, 0, 0, nil
	})
	router := chi.NewRouter()
	router.Use(ProtectResponses)
	router.Use(keyLimit.Middleware)
	router.Use(routeauth.Middleware)
	(&Deps{
		APIKeyRateLimit:  routeFallback.Middleware,
		SessionRateLimit: middleware.NewTenantRateLimit(1, time.Minute).Middleware,
	}).Mount(router)

	request := func() *http.Request {
		r := httptest.NewRequest(http.MethodGet, specPath, nil)
		ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "tenant-key-limit"})
		ctx = middleware.WithAPIKeyAuth(ctx)
		ctx = middleware.WithAPIKeyID(ctx, "api-key-1")
		ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
		return r.WithContext(ctx)
	}
	first := httptest.NewRecorder()
	router.ServeHTTP(first, request())
	if first.Code != http.StatusOK || !bytes.Equal(first.Body.Bytes(), SpecJSON) {
		t.Fatalf("first API-key response = %d/%d bytes, want exact 200 artifact", first.Code, first.Body.Len())
	}

	limited := httptest.NewRecorder()
	router.ServeHTTP(limited, request())
	if limited.Code != http.StatusTooManyRequests {
		t.Fatalf("second API-key status = %d, want 429", limited.Code)
	}
	assertDoesNotExposeSpec(t, limited)
	assertPrivateArtifactBoundary(t, limited)
}

func TestOpenAPISpecDefaultUnlimitedAPIKeyHitsRouteFallbackWithIsolation(t *testing.T) {
	// This models the ordinary database default: the authenticated stack's
	// configured limiter sees zero/zero and passes the key through.
	globalUnlimited := middleware.NewKeyRateLimit(func(context.Context, string) (int, int, int, error) {
		return 0, 0, 0, nil
	})
	// Keep the test small; production wires APIKeyRateLimitPerMinute (30).
	routeFallback := middleware.NewKeyRateLimit(func(context.Context, string) (int, int, int, error) {
		return 2, 0, 0, nil
	})
	router := chi.NewRouter()
	router.Use(ProtectResponses)
	router.Use(globalUnlimited.Middleware)
	router.Use(routeauth.Middleware)
	(&Deps{
		APIKeyRateLimit:  routeFallback.Middleware,
		SessionRateLimit: middleware.NewTenantRateLimit(1, time.Minute).Middleware,
	}).Mount(router)

	apiKeyRequest := func(tenantID, keyID string) *http.Request {
		request := httptest.NewRequest(http.MethodGet, specPath, nil)
		ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: tenantID})
		ctx = middleware.WithAPIKeyAuth(ctx)
		ctx = middleware.WithAPIKeyID(ctx, keyID)
		ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
		return request.WithContext(ctx)
	}
	for attempt := 1; attempt <= 2; attempt++ {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, apiKeyRequest("tenant-a", "key-a"))
		if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), SpecJSON) {
			t.Fatalf("key-a attempt %d = %d/%d bytes, want exact 200 artifact", attempt, response.Code, response.Body.Len())
		}
	}
	limited := httptest.NewRecorder()
	router.ServeHTTP(limited, apiKeyRequest("tenant-a", "key-a"))
	if limited.Code != http.StatusTooManyRequests {
		t.Fatalf("key-a fallback status = %d, want 429", limited.Code)
	}
	if limited.Header().Get("Retry-After") == "" {
		t.Fatal("API-key fallback 429 omits Retry-After")
	}
	assertDoesNotExposeSpec(t, limited)
	assertPrivateArtifactBoundary(t, limited)

	for _, identity := range []struct {
		tenantID string
		keyID    string
	}{
		{tenantID: "tenant-a", keyID: "key-b"},
		{tenantID: "tenant-b", keyID: "key-c"},
	} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, apiKeyRequest(identity.tenantID, identity.keyID))
		if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), SpecJSON) {
			t.Fatalf("isolated %s/%s = %d/%d bytes, want exact 200 artifact", identity.tenantID, identity.keyID, response.Code, response.Body.Len())
		}
	}

	// Exhausting a key does not consume the separate session tenant bucket.
	sessionRequest := httptest.NewRequest(http.MethodGet, specPath, nil)
	sessionContext := middleware.WithTenant(sessionRequest.Context(), &middleware.Tenant{ID: "tenant-a"})
	sessionContext = middleware.WithUser(sessionContext, &middleware.User{ID: "user-a", TenantID: "tenant-a", Role: "viewer"})
	sessionResponse := httptest.NewRecorder()
	router.ServeHTTP(sessionResponse, sessionRequest.WithContext(sessionContext))
	if sessionResponse.Code != http.StatusOK || !bytes.Equal(sessionResponse.Body.Bytes(), SpecJSON) {
		t.Fatalf("separate session bucket = %d/%d bytes, want exact 200 artifact", sessionResponse.Code, sessionResponse.Body.Len())
	}
}

func TestOpenAPISpecDistributedAPIKeyFallbackKeyingAndFailure(t *testing.T) {
	var (
		keys     []string
		storeErr error
	)
	store := fixedWindowStoreFunc(func(_ context.Context, key string, _ int, window time.Duration, now time.Time) (int, time.Time, error) {
		keys = append(keys, key)
		if storeErr != nil {
			return 0, now.Add(window), storeErr
		}
		return 1, now.Add(window), nil
	})
	routeFallback := middleware.NewKeyRateLimitWithOptions(
		func(context.Context, string) (int, int, int, error) {
			return APIKeyRateLimitPerMinute, 0, 0, nil
		},
		middleware.KeyRateLimitOptions{Store: store, Namespace: "api-docs:key"},
	)
	router := chi.NewRouter()
	router.Use(ProtectResponses)
	router.Use(routeauth.Middleware)
	(&Deps{APIKeyRateLimit: routeFallback.Middleware}).Mount(router)

	requestFor := func(keyID string) *http.Request {
		request := httptest.NewRequest(http.MethodGet, specPath, nil)
		ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant-distributed"})
		ctx = middleware.WithAPIKeyAuth(ctx)
		ctx = middleware.WithAPIKeyID(ctx, keyID)
		ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
		return request.WithContext(ctx)
	}
	success := httptest.NewRecorder()
	router.ServeHTTP(success, requestFor("key-distributed-a"))
	if success.Code != http.StatusOK || !bytes.Equal(success.Body.Bytes(), SpecJSON) {
		t.Fatalf("distributed fallback success = %d/%d bytes", success.Code, success.Body.Len())
	}
	if !slices.Equal(keys, []string{"api-docs:key:minute:key-distributed-a"}) {
		t.Fatalf("distributed API-key reservation keys = %v", keys)
	}

	storeErr = errors.New("shared store unavailable")
	failure := httptest.NewRecorder()
	router.ServeHTTP(failure, requestFor("key-distributed-b"))
	if failure.Code != http.StatusServiceUnavailable {
		t.Fatalf("distributed fallback failure = %d, want 503", failure.Code)
	}
	assertDoesNotExposeSpec(t, failure)
	assertPrivateArtifactBoundary(t, failure)
}

func TestProtectResponsesLeavesSiblingPathsUntouched(t *testing.T) {
	handler := ProtectResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=60")
		w.Header().Set("ETag", `"public"`)
		w.WriteHeader(http.StatusNoContent)
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, specPath+"-metadata", nil))
	if got := response.Header().Get("Cache-Control"); got != "public, max-age=60" {
		t.Fatalf("sibling Cache-Control = %q", got)
	}
	if got := response.Header().Get("ETag"); got != `"public"` {
		t.Fatalf("sibling ETag = %q", got)
	}
}

func TestOpenAPISpecPreservesExistingVaryDimensions(t *testing.T) {
	response := httptest.NewRecorder()
	response.Header().Set("Vary", "Accept-Encoding, authorization")

	testRateLimitedDeps().GetSpec(response, httptest.NewRequest(http.MethodGet, "/api/v1/openapi.json", nil))

	if !response.Flushed {
		t.Fatal("large no-store OpenAPI response was not switched to streaming")
	}
	if got := response.Header().Get("Vary"); got != "Accept-Encoding, authorization, Cookie" {
		t.Fatalf("Vary = %q, want existing dimensions plus credential dimensions without duplicates", got)
	}
}

func assertServesEmbeddedSpec(t *testing.T, router http.Handler, request *http.Request) {
	t.Helper()
	if len(SpecJSON) <= 4*1024*1024 {
		t.Fatalf("embedded fixture = %d bytes, want the real >4 MiB generated artifact", len(SpecJSON))
	}

	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", response.Code, response.Body.String())
	}
	if !bytes.Equal(response.Body.Bytes(), SpecJSON) {
		t.Fatalf("served body = %d bytes, want exact %d-byte embedded artifact", response.Body.Len(), len(SpecJSON))
	}
	if !response.Flushed {
		t.Fatal("multi-megabyte artifact was buffered instead of flushed")
	}
	assertPrivateArtifactBoundary(t, response)
}

func assertDoesNotExposeSpec(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if bytes.Equal(response.Body.Bytes(), SpecJSON) {
		t.Fatal("refusal exposed the complete embedded OpenAPI artifact")
	}
	prefixLength := 256
	if len(SpecJSON) < prefixLength {
		prefixLength = len(SpecJSON)
	}
	if prefixLength > 0 && bytes.Contains(response.Body.Bytes(), SpecJSON[:prefixLength]) {
		t.Fatal("refusal exposed an embedded OpenAPI artifact prefix")
	}
}

func assertPrivateArtifactBoundary(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if got := response.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want private, no-store", got)
	}
	if got := response.Header().Get("Pragma"); got != "no-cache" {
		t.Fatalf("Pragma = %q, want no-cache", got)
	}
	if got := response.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
	}
	varied := map[string]bool{}
	for _, line := range response.Header().Values("Vary") {
		for _, dimension := range strings.Split(line, ",") {
			varied[strings.ToLower(strings.TrimSpace(dimension))] = true
		}
	}
	for _, dimension := range []string{"authorization", "cookie"} {
		if !varied[dimension] {
			t.Fatalf("Vary = %q, missing %s", response.Header().Values("Vary"), dimension)
		}
	}
}
