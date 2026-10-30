// SPDX-License-Identifier: AGPL-3.0-only
package track

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func doTrackAPIKey(
	t *testing.T,
	request *http.Request,
	scopes ...apikeys.Scope,
) *httptest.ResponseRecorder {
	t.Helper()
	return doTrackAPIKeyWithDeps(t, &Deps{}, request, scopes...)
}

func doTrackAPIKeyWithDeps(
	t *testing.T,
	deps *Deps,
	request *http.Request,
	scopes ...apikeys.Scope,
) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	deps.MountRoutes(router)

	ctx := middleware.WithAPIKeyAuth(request.Context())
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "tenant-1"})
	ctx = apikeys.WithScopes(ctx, scopes)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request.WithContext(ctx))
	return response
}

func doTrackAPIKeyWithoutTenant(
	t *testing.T,
	request *http.Request,
	scopes ...apikeys.Scope,
) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	(&Deps{}).MountRoutes(router)

	ctx := middleware.WithAPIKeyAuth(request.Context())
	ctx = apikeys.WithScopes(ctx, scopes)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request.WithContext(ctx))
	return response
}

func TestTrackRawEventRoutesRequireReportsAndSubscribersScopes(t *testing.T) {
	for _, path := range []string{
		"/api/v1/track/events",
		"/api/v1/track/stream",
		"/api/v1/track/events.csv",
	} {
		path := path
		for _, scopes := range [][]apikeys.Scope{
			{apikeys.ScopeReadReports},
			{apikeys.ScopeReadSubscribers},
		} {
			request := httptest.NewRequest(http.MethodGet, path, nil)
			response := doTrackAPIKey(t, request, scopes...)
			if response.Code != http.StatusForbidden ||
				!strings.Contains(response.Body.String(), "insufficient_scope") {
				t.Fatalf(
					"GET %s with partial scopes %v: status=%d body=%q, want 403 insufficient_scope",
					path,
					scopes,
					response.Code,
					response.Body.String(),
				)
			}
		}
	}
}

func TestTrackAggregateRoutesRemainReadReportsOnly(t *testing.T) {
	for _, path := range []string{
		"/api/v1/track/catalog",
		"/api/v1/track/stats",
	} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		response := doTrackAPIKey(t, request, apikeys.ScopeReadSubscribers)
		if response.Code != http.StatusForbidden ||
			!strings.Contains(response.Body.String(), "insufficient_scope") {
			t.Fatalf(
				"GET %s without read:reports: status=%d body=%q, want 403 insufficient_scope",
				path,
				response.Code,
				response.Body.String(),
			)
		}

		request = httptest.NewRequest(http.MethodGet, path, nil)
		response = doTrackAPIKeyWithoutTenant(t, request, apikeys.ScopeReadReports)
		if response.Code != http.StatusUnauthorized ||
			!strings.Contains(response.Body.String(), "no_tenant") {
			t.Fatalf(
				"GET %s with read:reports did not reach handler: status=%d body=%q",
				path,
				response.Code,
				response.Body.String(),
			)
		}
	}
}

func TestTrackRawEventRoutesReachHandlersWithBothReadScopes(t *testing.T) {
	// An invalid cursor is rejected inside ListEvents. Reaching that handler
	// proves both scopes passed the production route gate without requiring a
	// database fixture.
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/track/events?before=not-rfc3339",
		nil,
	)
	response := doTrackAPIKey(
		t,
		request,
		apikeys.ScopeReadReports,
		apikeys.ScopeReadSubscribers,
	)
	if response.Code != http.StatusBadRequest ||
		!strings.Contains(response.Body.String(), "bad_before") {
		t.Fatalf(
			"both raw-event scopes did not reach list handler: status=%d body=%q",
			response.Code,
			response.Body.String(),
		)
	}

	request = httptest.NewRequest(
		http.MethodGet,
		"/api/v1/track/events.csv?occurred_after=not-rfc3339",
		nil,
	)
	response = doTrackAPIKey(
		t,
		request,
		apikeys.ScopeReadReports,
		apikeys.ScopeReadSubscribers,
	)
	if response.Code != http.StatusBadRequest ||
		!strings.Contains(response.Body.String(), "invalid_occurred_after") {
		t.Fatalf(
			"both raw-event scopes did not reach CSV handler: status=%d body=%q",
			response.Code,
			response.Body.String(),
		)
	}

	streamRepo := &eventStreamRepositoryStub{maxID: 73}
	streamContext, cancel := context.WithCancel(context.Background())
	cancel()
	request = httptest.NewRequest(http.MethodGet, "/api/v1/track/stream", nil).
		WithContext(streamContext)
	response = doTrackAPIKeyWithDeps(
		t,
		&Deps{EventStreamRepo: streamRepo},
		request,
		apikeys.ScopeReadReports,
		apikeys.ScopeReadSubscribers,
	)
	if response.Code != http.StatusOK ||
		!strings.Contains(response.Body.String(), `"sinceId":73`) {
		t.Fatalf(
			"both raw-event scopes did not reach stream handler: status=%d body=%q",
			response.Code,
			response.Body.String(),
		)
	}
}

func TestTrackIngestionRequiresAdminScope(t *testing.T) {
	for _, scope := range []apikeys.Scope{
		apikeys.ScopeReadReports,
		apikeys.ScopeWriteCampaigns,
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/track", nil)
		response := doTrackAPIKey(t, request, scope)
		if response.Code != http.StatusForbidden ||
			!strings.Contains(response.Body.String(), "insufficient_scope") {
			t.Fatalf(
				"POST /api/v1/track with %s: status=%d body=%q, want 403 insufficient_scope",
				scope,
				response.Code,
				response.Body.String(),
			)
		}
	}

	// Admin reaches the handler, which then rejects the empty body as invalid
	// JSON. This distinguishes route authorization from input validation.
	request := httptest.NewRequest(http.MethodPost, "/api/v1/track", nil)
	response := doTrackAPIKey(t, request, apikeys.ScopeAdmin)
	if response.Code == http.StatusForbidden {
		t.Fatalf("admin scope was rejected by the track ingestion route gate")
	}
}
