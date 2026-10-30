// SPDX-License-Identifier: AGPL-3.0-only
package collections

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestListRejectsAmbiguousIncludeDataBeforeRepositoryAccess(t *testing.T) {
	t.Parallel()

	for _, requestTarget := range []string{
		"/api/v1/collections?include_data=TRUE",
		"/api/v1/collections?include_data=1",
		"/api/v1/collections?include_data=yes",
		"/api/v1/collections?include_data=false%20",
		"/api/v1/collections?include_data=%20true",
		"/api/v1/collections?include_data=",
		"/api/v1/collections?include_data=false&include_data=true",
	} {
		requestTarget := requestTarget
		t.Run(requestTarget, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest(http.MethodGet, requestTarget, nil)
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
				ID: "11111111-1111-1111-1111-111111111111",
			}))
			recorder := httptest.NewRecorder()

			(&Deps{}).List(recorder, req)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body=%s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
			}
			if body := recorder.Body.String(); !strings.Contains(body, `"code":"invalid_include_data"`) {
				t.Fatalf("body missing stable validation code: %s", body)
			}
		})
	}
}

func TestParseListOptionsDefaultsToBoundedMetadataAndNormalizesFilters(t *testing.T) {
	t.Parallel()

	const tenantID = "11111111-1111-4111-8111-111111111111"
	opts, queryErr := parseListOptions(url.Values{
		"q":               {"  50%_OFF  "},
		"collection_type": {"content"},
		"limit":           {"25"},
	}, tenantID)
	if queryErr != nil {
		t.Fatalf("parse options: %+v", queryErr)
	}
	if opts.Limit != 25 || opts.Query != "50%_OFF" || opts.CollectionType != "content" || opts.Cursor.ID != "" {
		t.Fatalf("unexpected options: %+v", opts)
	}

	defaults, queryErr := parseListOptions(url.Values{}, tenantID)
	if queryErr != nil || defaults.Limit != DefaultListLimit {
		t.Fatalf("default options=%+v error=%+v", defaults, queryErr)
	}
}

func TestParseListOptionsRejectsConfidentialDataAndInvalidFilters(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		q    url.Values
		code string
	}{
		{name: "data bodies", q: url.Values{"include_data": {"true"}}, code: "include_data_not_supported"},
		{name: "zero limit", q: url.Values{"limit": {"0"}}, code: "invalid_limit"},
		{name: "large limit", q: url.Values{"limit": {"201"}}, code: "invalid_limit"},
		{name: "bad type", q: url.Values{"collection_type": {"coupon_pool"}}, code: "invalid_collection_type"},
		{name: "bidi search", q: url.Values{"q": {"safe\u202eevil"}}, code: "invalid_query"},
		{name: "duplicate search", q: url.Values{"q": {"one", "two"}}, code: "invalid_query"},
		{name: "unknown parameter", q: url.Values{"collection_typo": {"coupons"}}, code: "invalid_query_parameter"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, queryErr := parseListOptions(test.q, "11111111-1111-4111-8111-111111111111")
			if queryErr == nil || queryErr.Code != test.code {
				t.Fatalf("error=%+v, want code %q", queryErr, test.code)
			}
		})
	}
}

func TestUnknownListParameterDoesNotReflectUntrustedName(t *testing.T) {
	t.Parallel()

	const hostile = "very-long-spoof\u202eparameter"
	_, queryErr := parseListOptions(url.Values{hostile: {"value"}}, testCollectionTenantID)
	if queryErr == nil || queryErr.Code != "invalid_query_parameter" {
		t.Fatalf("query error=%+v", queryErr)
	}
	if strings.Contains(queryErr.Message, hostile) {
		t.Fatalf("public query error reflected an untrusted parameter name: %q", queryErr.Message)
	}
}

func TestCollectionCursorIsStableAndBoundToFilters(t *testing.T) {
	t.Parallel()

	id := uuid.NewString()
	created := time.Date(2026, 7, 22, 12, 30, 0, 123, time.UTC)
	opts := ListOptions{Limit: 20, Query: "calendar", CollectionType: "schedule"}
	const tenantID = "11111111-1111-4111-8111-111111111111"
	raw := encodeCollectionCursor(Collection{ID: id, CreatedAt: created}, opts, tenantID)
	decoded, err := decodeCollectionCursor(raw, opts, tenantID)
	if err != nil || decoded.ID != id || !decoded.SortKey.Equal(created) {
		t.Fatalf("decoded=%+v err=%v", decoded, err)
	}
	for _, changed := range []ListOptions{
		{Limit: 20, Query: "other", CollectionType: "schedule"},
		{Limit: 20, Query: "calendar", CollectionType: "content"},
	} {
		if _, err := decodeCollectionCursor(raw, changed, tenantID); err == nil {
			t.Fatalf("cursor should reject changed filters: %+v", changed)
		}
	}
	if _, err := decodeCollectionCursor(raw, opts, "22222222-2222-4222-8222-222222222222"); err == nil {
		t.Fatal("cursor should reject a different tenant binding")
	}
}

func TestCreateRejectsUnsafeJSONIntegerBeforeRepositoryAccess(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/collections", strings.NewReader(
		`{"name":"Unsafe identifier","data":[{"external_id":9007199254740993}]}`,
	))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: "11111111-1111-4111-8111-111111111111",
	}))
	recorder := httptest.NewRecorder()

	(&Deps{Repo: &Repo{}}).Create(recorder, req)

	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"invalid_data"`) ||
		!strings.Contains(recorder.Body.String(), "safe range") {
		t.Fatalf("status=%d body=%s, want stable safe-integer validation", recorder.Code, recorder.Body.String())
	}
}

func TestCreateRejectsMalformedUnicodeBeforeRepositoryAccess(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/collections", strings.NewReader(
		`{"name":"Unicode","data":[{"value":"\ud800"}]}`,
	))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: testCollectionTenantID}))
	recorder := httptest.NewRecorder()

	(&Deps{Repo: &Repo{}}).Create(recorder, req)

	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"invalid_json_unicode"`) {
		t.Fatalf("status=%d body=%s, want malformed-surrogate rejection", recorder.Code, recorder.Body.String())
	}
}

func TestCollectionRoutesFailFastOnIncompleteDependencies(t *testing.T) {
	t.Parallel()

	for _, mount := range []func(){
		func() { MountRoutes(nil, &Deps{Repo: &Repo{Pool: &db.Pool{}}}) },
		func() { MountRoutes(chi.NewRouter(), nil) },
		func() { MountRoutes(chi.NewRouter(), &Deps{}) },
		func() { MountRoutes(chi.NewRouter(), &Deps{Repo: &Repo{}}) },
	} {
		func() {
			defer func() {
				if recover() == nil {
					t.Fatal("MountRoutes should panic on incomplete dependencies")
				}
			}()
			mount()
		}()
	}
}

func TestCollectionDetailRequiresWriteScopeWhileMetadataListAllowsRead(t *testing.T) {
	t.Parallel()

	router := chi.NewRouter()
	MountRoutes(router, &Deps{Repo: &Repo{Pool: &db.Pool{}}})
	serve := func(path string, scopes ...apikeys.Scope) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		ctx := middleware.WithAPIKeyAuth(req.Context())
		ctx = apikeys.WithScopes(ctx, scopes)
		ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "11111111-1111-4111-8111-111111111111"})
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, req.WithContext(ctx))
		return recorder
	}

	denied := serve("/api/v1/collections/not-a-uuid", apikeys.ScopeReadSubscribers)
	if denied.Code != http.StatusForbidden || !strings.Contains(denied.Body.String(), "insufficient_scope") {
		t.Fatalf("detail with read scope status=%d body=%s", denied.Code, denied.Body.String())
	}
	allowed := serve("/api/v1/collections/not-a-uuid", apikeys.ScopeWriteSubscribers)
	if allowed.Code != http.StatusBadRequest || !strings.Contains(allowed.Body.String(), "invalid_id") {
		t.Fatalf("detail with write scope status=%d body=%s", allowed.Code, allowed.Body.String())
	}
	metadata := serve("/api/v1/collections?include_data=true", apikeys.ScopeReadSubscribers)
	if metadata.Code != http.StatusBadRequest || !strings.Contains(metadata.Body.String(), "include_data_not_supported") {
		t.Fatalf("metadata with read scope status=%d body=%s", metadata.Code, metadata.Body.String())
	}
	if metadata.Header().Get("Cache-Control") != "no-store" || metadata.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("collection response headers=%v, want no-store and nosniff", metadata.Header())
	}
}

func TestReadCollectionIDSeparatesMissingMalformedAndCanonical(t *testing.T) {
	t.Parallel()

	requestWithID := func(id string) *http.Request {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		routeCtx := chi.NewRouteContext()
		routeCtx.URLParams.Add("id", id)
		return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
	}
	for _, test := range []struct {
		id, code string
	}{
		{"", "missing_id"},
		{"not-a-uuid", "invalid_id"},
	} {
		recorder := httptest.NewRecorder()
		if _, ok := readCollectionID(recorder, requestWithID(test.id)); ok || !strings.Contains(recorder.Body.String(), test.code) {
			t.Fatalf("id=%q status=%d body=%s", test.id, recorder.Code, recorder.Body.String())
		}
	}
	recorder := httptest.NewRecorder()
	id, ok := readCollectionID(recorder, requestWithID("11111111-1111-4111-8111-111111111111"))
	if !ok || id != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("canonical id=%q ok=%v body=%s", id, ok, recorder.Body.String())
	}
}
