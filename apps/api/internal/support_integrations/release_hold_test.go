// SPDX-License-Identifier: AGPL-3.0-only

package support_integrations

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type countingReadCloser struct {
	reader io.Reader
	reads  int
}

func (r *countingReadCloser) Read(out []byte) (int, error) {
	r.reads++
	return r.reader.Read(out)
}

func (*countingReadCloser) Close() error { return nil }

type legacySupportReplayStore struct{ calls int }

type supportProjectionReadStore struct {
	Store
	items           []IntegrationProjection
	detail          *IntegrationProjection
	projectionReads int
	detailReads     int
}

func (s *supportProjectionReadStore) ListIntegrationProjections(context.Context, string, time.Time, time.Time, string, int) ([]IntegrationProjection, error) {
	s.projectionReads++
	return append([]IntegrationProjection(nil), s.items...), nil
}

func (s *supportProjectionReadStore) GetIntegrationProjection(context.Context, string, string) (*IntegrationProjection, error) {
	s.detailReads++
	if s.detail == nil {
		return nil, ErrNotFound
	}
	copy := *s.detail
	return &copy, nil
}

func (s *legacySupportReplayStore) Get(context.Context, string, string) (*idempotency.Record, error) {
	s.calls++
	return &idempotency.Record{ResponseStatus: http.StatusOK, ResponseBody: []byte(`{"legacy":true}`)}, nil
}
func (s *legacySupportReplayStore) Claim(context.Context, *idempotency.Record) (bool, error) {
	s.calls++
	return false, nil
}
func (s *legacySupportReplayStore) Complete(context.Context, *idempotency.Record) error {
	s.calls++
	return nil
}
func (s *legacySupportReplayStore) DeletePending(context.Context, string, string) error {
	s.calls++
	return nil
}

func TestPublicSupportProviderFamilyIsMethodAgnosticZeroReadHold(t *testing.T) {
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/public/support-integrations/zendesk/short-account/webhooks?ordinary=secret"},
		{http.MethodPut, "/api/public/support-integrations/future/short-id/new-route?ordinary=secret"},
		{http.MethodGet, "/api/public/support-integrations/gorgias/short-account/ingest/short-token?ordinary=secret"},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			body := &countingReadCloser{reader: bytes.NewBufferString("raw-customer-body")}
			req := httptest.NewRequest(tc.method, tc.path, nil)
			req.Body = body
			router := chi.NewRouter()
			MountPublicRoutes(router, nil)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, req)

			if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"code":"support_provider_ingress_held"`) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if body.reads != 0 {
				t.Fatalf("held ingress read request body %d times", body.reads)
			}
			if got := recorder.Header().Get("Cache-Control"); !strings.Contains(got, "private") || !strings.Contains(got, "no-store") {
				t.Fatalf("Cache-Control=%q", got)
			}
			if req.URL.RawQuery != "" || strings.Contains(req.URL.Path, "short-") {
				t.Fatalf("held request was not minimized for after-handler sinks: %s?%s", req.URL.Path, req.URL.RawQuery)
			}
		})
	}
}

func TestSupportEffectHandlersAreStableZeroReadHolds(t *testing.T) {
	deps := &Deps{}
	for name, handler := range map[string]http.HandlerFunc{
		"create":     deps.CreateIntegration,
		"sync":       deps.SyncIntegration,
		"backfill":   deps.BackfillIntegration,
		"ingest":     deps.IngestEvent,
		"pause":      deps.PauseIntegration,
		"disconnect": deps.DisconnectIntegration,
		"provision":  deps.ProvisionIngest,
		"rotate":     deps.RotateIngest,
	} {
		t.Run(name, func(t *testing.T) {
			body := &countingReadCloser{reader: bytes.NewBufferString(`{"secret":"raw"}`)}
			req := httptest.NewRequest(http.MethodPost, "/api/v1/support-integrations/held", nil)
			req.Body = body
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, req)
			if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"code":"support_integration_runtime_held"`) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if body.reads != 0 {
				t.Fatalf("held effect read request body %d times", body.reads)
			}
		})
	}
}

func TestSupportEffectsBypassLegacyReplayBeforeBodyAndStore(t *testing.T) {
	deps := &Deps{}
	for _, tc := range []struct {
		name    string
		method  string
		path    string
		handler http.HandlerFunc
	}{
		{"create", http.MethodPost, "/api/v1/support-integrations", deps.CreateIntegration},
		{"sync", http.MethodPost, "/api/v1/support-integrations/00000000-0000-0000-0000-000000000001/sync", deps.SyncIntegration},
		{"backfill", http.MethodPost, "/api/v1/support-integrations/00000000-0000-0000-0000-000000000001/backfill", deps.BackfillIntegration},
		{"ingest", http.MethodPost, "/api/v1/support-integrations/00000000-0000-0000-0000-000000000001/ingest", deps.IngestEvent},
		{"pause", http.MethodPost, "/api/v1/support-integrations/00000000-0000-0000-0000-000000000001/pause", deps.PauseIntegration},
		{"disconnect", http.MethodDelete, "/api/v1/support-integrations/00000000-0000-0000-0000-000000000001", deps.DisconnectIntegration},
		{"provision", http.MethodPost, "/api/v1/support-integrations/webhook-ingest", deps.ProvisionIngest},
		{"rotate", http.MethodPost, "/api/v1/support-integrations/webhook-ingest/00000000-0000-0000-0000-000000000001/rotate", deps.RotateIngest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := &countingReadCloser{reader: bytes.NewBufferString(strings.Repeat("x", 65<<10))}
			store := &legacySupportReplayStore{}
			handler := idempotency.ProcessWithReplayBypass(
				store,
				func(*http.Request) (string, bool) { return "tenant-id", true },
				EffectReplayBypass,
			)(tc.handler)
			req := httptest.NewRequest(tc.method, tc.path, nil)
			req.Body = body
			req.Header.Set(idempotency.HeaderName, "legacy-support-success")
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, req)
			if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"code":"support_integration_runtime_held"`) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if body.reads != 0 || store.calls != 0 {
				t.Fatalf("body_reads=%d replay_store_calls=%d, want 0/0", body.reads, store.calls)
			}
		})
	}
}

func TestMinimizedSupportReadsPreserveBoundedLongTailProviderSlugs(t *testing.T) {
	tenantID := "10000000-0000-4000-8000-000000000041"
	integrationID := "20000000-0000-4000-8000-000000000041"
	now := time.Date(2026, 8, 25, 10, 0, 0, 0, time.UTC)
	projection := IntegrationProjection{
		ID:                   integrationID,
		TenantID:             tenantID,
		Provider:             "long-tail-bridge",
		Name:                 "Historical long-tail bridge",
		Status:               "paused",
		CredentialConfigured: false,
		CreatedAt:            now.Add(-2 * time.Hour),
		UpdatedAt:            now.Add(-time.Hour),
	}
	store := &supportProjectionReadStore{items: []IntegrationProjection{projection}, detail: &projection}
	deps := &Deps{Repo: store, Now: func() time.Time { return now }}
	request := func(method, path string) *http.Request {
		req := httptest.NewRequest(method, path, nil)
		ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
		return req.WithContext(ctx)
	}

	listRecorder := httptest.NewRecorder()
	deps.ListIntegrations(listRecorder, request(http.MethodGet, "/api/v1/support-integrations"))
	if listRecorder.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", listRecorder.Code, listRecorder.Body.String())
	}
	var listBody struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(listRecorder.Body.Bytes(), &listBody); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(listBody.Items) != 1 || listBody.Items[0]["provider"] != projection.Provider ||
		listBody.Items[0]["runtime_status"] != "held" || listBody.Items[0]["hold_code"] != "support_integration_runtime_held" {
		t.Fatalf("unexpected minimized list projection: %#v", listBody.Items)
	}
	if _, catalogMember := ProviderSpecByKey(projection.Provider); catalogMember {
		t.Fatalf("test provider unexpectedly entered the static catalog")
	}

	router := chi.NewRouter()
	router.Get("/api/v1/support-integrations/{id}", deps.GetIntegration)
	detailRecorder := httptest.NewRecorder()
	router.ServeHTTP(detailRecorder, request(http.MethodGet, "/api/v1/support-integrations/"+integrationID))
	if detailRecorder.Code != http.StatusOK || !strings.Contains(detailRecorder.Body.String(), `"provider":"long-tail-bridge"`) ||
		!strings.Contains(detailRecorder.Body.String(), `"runtime_status":"held"`) {
		t.Fatalf("detail status=%d body=%s", detailRecorder.Code, detailRecorder.Body.String())
	}
}

func TestMinimizedSupportDetailRejectsNonExactCanonicalID(t *testing.T) {
	tenantID := "10000000-0000-4000-8000-000000000041"
	integrationID := "20000000-0000-4000-8000-000000000041"
	now := time.Date(2026, 8, 25, 10, 0, 0, 0, time.UTC)
	projection := IntegrationProjection{
		ID: integrationID, TenantID: tenantID, Provider: "zendesk", Name: "Historical bridge",
		Status: "paused", CreatedAt: now.Add(-time.Hour), UpdatedAt: now,
	}
	deps := &Deps{
		Repo: &supportProjectionReadStore{detail: &projection},
		Now:  func() time.Time { return now },
	}
	router := chi.NewRouter()
	router.Get("/api/v1/support-integrations/{id}", deps.GetIntegration)
	request := func(path string) *http.Request {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
		return req.WithContext(ctx)
	}

	canonical := httptest.NewRecorder()
	router.ServeHTTP(canonical, request("/api/v1/support-integrations/"+integrationID))
	if canonical.Code != http.StatusOK {
		t.Fatalf("canonical detail status=%d body=%s", canonical.Code, canonical.Body.String())
	}

	for _, encodedID := range []string{
		"%20" + integrationID,
		integrationID + "%20",
		"%09" + integrationID,
		integrationID + "%0A",
		"%C2%85" + integrationID,
		"%E2%80%AE" + integrationID,
	} {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request("/api/v1/support-integrations/"+encodedID))
		if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"id_invalid"`) {
			t.Fatalf("encoded id %q status=%d body=%s", encodedID, recorder.Code, recorder.Body.String())
		}
	}
}

func TestSupportProjectionProviderSlugMatchesPublishedWireBoundary(t *testing.T) {
	for _, provider := range []string{"zendesk", "long-tail-bridge", "custom_support_2", strings.Repeat("a", 64)} {
		if !validSupportProjectionProvider(provider) {
			t.Fatalf("valid provider %q rejected", provider)
		}
	}
	for _, provider := range []string{"", strings.Repeat("a", 65), "Uppercase", "space provider", "provider/path", "provider\nname", "provider\u202ename"} {
		if validSupportProjectionProvider(provider) {
			t.Fatalf("invalid provider %q accepted", provider)
		}
	}
}

func TestSupportProjectionDisplayNameMatchesLineOrientedWireBoundary(t *testing.T) {
	for _, name := range []string{
		"Historical support bridge",
		"Historical support bridge — مرحبا 👩🏽",
		strings.Repeat("a", 200),
	} {
		if !validSupportProjectionText(name, 200, false) {
			t.Fatalf("valid display name %q rejected", name)
		}
	}
	for _, name := range []string{
		"", " padded", "padded ", "trusted\tconnected", "trusted\nconnected",
		"trusted\rconnected", "trusted\u0085connected", "trusted\u2028connected",
		"trusted\u202econnected", strings.Repeat("a", 201),
	} {
		if validSupportProjectionText(name, 200, false) {
			t.Fatalf("unsafe display name %q accepted", name)
		}
	}
}

func TestSupportListRejectsNonExactCursorBeforeProjectionRead(t *testing.T) {
	tenantID := "10000000-0000-4000-8000-000000000041"
	integrationID := "20000000-0000-4000-8000-000000000041"
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	key := []byte("route41-support-cursor-key-32-bytes-minimum")
	token, err := encodeSupportIntegrationCursor(key, supportIntegrationCursor{
		TenantID: tenantID,
		Limit:    50,
		AsOf:     now,
		At:       now.Add(-time.Minute),
		ID:       integrationID,
	})
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}
	store := &supportProjectionReadStore{}
	deps := &Deps{
		Repo:      store,
		CursorKey: key,
		Now:       func() time.Time { return now.Add(time.Minute) },
	}
	request := func(cursor string) *http.Request {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/support-integrations?limit=50&cursor="+url.QueryEscape(cursor), nil)
		ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
		return req.WithContext(ctx)
	}

	valid := httptest.NewRecorder()
	deps.ListIntegrations(valid, request(token))
	if valid.Code != http.StatusOK {
		t.Fatalf("valid cursor status=%d body=%s", valid.Code, valid.Body.String())
	}
	if store.projectionReads != 1 {
		t.Fatalf("valid cursor projection reads=%d, want 1", store.projectionReads)
	}

	for _, cursor := range []string{"", " " + token, token + " ", token + "\n", token + "\u0085", token + "\u202e", strings.Repeat("a", maxSupportIntegrationCursorBytes+1)} {
		readsBefore := store.projectionReads
		recorder := httptest.NewRecorder()
		deps.ListIntegrations(recorder, request(cursor))
		if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"cursor_invalid"`) {
			t.Fatalf("cursor %q status=%d body=%s", cursor, recorder.Code, recorder.Body.String())
		}
		if store.projectionReads != readsBefore {
			t.Fatalf("cursor %q reached projection store: reads=%d want=%d", cursor, store.projectionReads, readsBefore)
		}
	}
}

func TestSupportListRequiresExactUnsignedDecimalLimitBeforeProjectionRead(t *testing.T) {
	tenantID := "10000000-0000-4000-8000-000000000041"
	store := &supportProjectionReadStore{}
	deps := &Deps{Repo: store, Now: func() time.Time {
		return time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	}}
	request := func(rawQuery string) *http.Request {
		path := "/api/v1/support-integrations"
		if rawQuery != "" {
			path += "?" + rawQuery
		}
		req := httptest.NewRequest(http.MethodGet, path, nil)
		ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
		return req.WithContext(ctx)
	}

	for _, rawQuery := range []string{"", "limit=1", "limit=100"} {
		readsBefore := store.projectionReads
		recorder := httptest.NewRecorder()
		deps.ListIntegrations(recorder, request(rawQuery))
		if recorder.Code != http.StatusOK {
			t.Fatalf("valid query %q status=%d body=%s", rawQuery, recorder.Code, recorder.Body.String())
		}
		if store.projectionReads != readsBefore+1 {
			t.Fatalf("valid query %q projection reads=%d want=%d", rawQuery, store.projectionReads, readsBefore+1)
		}
	}

	for _, rawQuery := range []string{
		"limit=", "limit=%2B50", "limit=+50", "limit=%2050%20",
		"limit=01", "limit=1.0", "limit=0", "limit=101",
	} {
		readsBefore := store.projectionReads
		recorder := httptest.NewRecorder()
		deps.ListIntegrations(recorder, request(rawQuery))
		if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), `"code":"limit_invalid"`) {
			t.Fatalf("limit query %q status=%d body=%s", rawQuery, recorder.Code, recorder.Body.String())
		}
		if store.projectionReads != readsBefore {
			t.Fatalf("limit query %q reached projection store: reads=%d want=%d", rawQuery, store.projectionReads, readsBefore)
		}
	}
}

func TestSupportReadsRejectMalformedRawQueryBeforeProjectionRead(t *testing.T) {
	tenantID := "10000000-0000-4000-8000-000000000041"
	integrationID := "20000000-0000-4000-8000-000000000041"
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	projection := IntegrationProjection{
		ID: integrationID, TenantID: tenantID, Provider: "zendesk", Name: "Historical bridge",
		Status: "paused", CreatedAt: now.Add(-time.Hour), UpdatedAt: now,
	}
	store := &supportProjectionReadStore{detail: &projection}
	deps := &Deps{Repo: store, Now: func() time.Time { return now }}
	request := func(path, rawQuery string) *http.Request {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.URL.RawQuery = rawQuery
		ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
		return req.WithContext(ctx)
	}
	router := chi.NewRouter()
	router.Get("/api/v1/support-integrations/{id}", deps.GetIntegration)

	for _, rawQuery := range []string{
		"cursor=%ZZ", "limit=%ZZ", "cursor=x;y=z", "limit=50;x=y",
	} {
		listReads := store.projectionReads
		listRecorder := httptest.NewRecorder()
		deps.ListIntegrations(listRecorder, request("/api/v1/support-integrations", rawQuery))
		if listRecorder.Code != http.StatusBadRequest || !strings.Contains(listRecorder.Body.String(), `"code":"query_invalid"`) {
			t.Fatalf("list query %q status=%d body=%s", rawQuery, listRecorder.Code, listRecorder.Body.String())
		}
		if store.projectionReads != listReads {
			t.Fatalf("list query %q reached projection store: reads=%d want=%d", rawQuery, store.projectionReads, listReads)
		}

		detailReads := store.detailReads
		detailRecorder := httptest.NewRecorder()
		router.ServeHTTP(detailRecorder, request("/api/v1/support-integrations/"+integrationID, rawQuery))
		if detailRecorder.Code != http.StatusBadRequest || !strings.Contains(detailRecorder.Body.String(), `"code":"query_invalid"`) {
			t.Fatalf("detail query %q status=%d body=%s", rawQuery, detailRecorder.Code, detailRecorder.Body.String())
		}
		if store.detailReads != detailReads {
			t.Fatalf("detail query %q reached projection store: reads=%d want=%d", rawQuery, store.detailReads, detailReads)
		}
	}
}
