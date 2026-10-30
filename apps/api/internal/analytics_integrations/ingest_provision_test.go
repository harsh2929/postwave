// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAnalyticsListIngestProvidersListsCDP(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{Repo: newFakeStore()}).ListIngestProviders(rec, analyticsReq(http.MethodGet, "/api/v1/analytics-integrations/webhook-ingest/providers", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Items []IngestProviderOption `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	cdp := map[string]bool{}
	seen := map[string]bool{}
	for _, item := range res.Items {
		seen[item.Provider] = true
		cdp[item.Provider] = item.CDP
	}
	for _, p := range []string{ProviderSegment, ProviderRudderStack} {
		if !seen[p] || !cdp[p] {
			t.Fatalf("provider %q should be present and CDP: seen=%v cdp=%v", p, seen[p], cdp[p])
		}
	}
	if !seen[ProviderPostHog] || cdp[ProviderPostHog] {
		t.Fatalf("posthog should be present and NOT a CDP ingest provider")
	}
}

func TestAnalyticsProvisionIngestMintsTokenAndURL(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "awhk_segment_1", nil }}

	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/webhook-ingest", `{"provider":"segment"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep); err != nil {
		t.Fatal(err)
	}
	if ep.Provider != ProviderSegment || ep.IngestToken != "awhk_segment_1" || !ep.CDP {
		t.Fatalf("endpoint=%+v", ep)
	}
	wantPath := "/api/public/analytics-integrations/segment/ingest/awhk_segment_1"
	if ep.IngestPath != wantPath {
		t.Fatalf("ingest_path=%q want %q", ep.IngestPath, wantPath)
	}
	if !strings.HasSuffix(ep.IngestURL, wantPath) || !strings.HasPrefix(ep.IngestURL, "http") {
		t.Fatalf("ingest_url=%q should be an absolute URL ending in the path", ep.IngestURL)
	}
	// The minted token must land under the Segment-specific lookup key.
	if store.lastIngest.Provider != ProviderSegment {
		t.Fatalf("repo provision provider=%q", store.lastIngest.Provider)
	}
	if store.integration.Settings[segmentIngestTokenSetting] != "awhk_segment_1" {
		t.Fatalf("settings=%+v want %s=awhk_segment_1", store.integration.Settings, segmentIngestTokenSetting)
	}
}

func TestAnalyticsProvisionIngestPersistsRudderStackKey(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "awhk_rudder_1", nil }}

	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/webhook-ingest", `{"provider":"rudderstack"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep); err != nil {
		t.Fatal(err)
	}
	wantPath := "/api/public/analytics-integrations/rudderstack/ingest/awhk_rudder_1"
	if ep.IngestPath != wantPath {
		t.Fatalf("ingest_path=%q want %q", ep.IngestPath, wantPath)
	}
	if store.integration.Settings[rudderStackIngestTokenSetting] != "awhk_rudder_1" {
		t.Fatalf("settings=%+v want %s=awhk_rudder_1", store.integration.Settings, rudderStackIngestTokenSetting)
	}
}

func TestAnalyticsProvisionIngestAcceptsGenericProvider(t *testing.T) {
	// Any non-CDP tool (payments/events/cms and other profile+event sources)
	// provisions via the GENERIC webhook-ingest path (analytics_ingest_token key).
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "awhk_generic_1", nil }}
	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/webhook-ingest", `{"provider":"Stripe"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep); err != nil {
		t.Fatal(err)
	}
	if ep.Provider != "stripe" || ep.CDP || ep.IngestToken != "awhk_generic_1" {
		t.Fatalf("generic provider endpoint wrong: %+v", ep)
	}
	if ep.IngestPath != "/api/public/analytics-integrations/stripe/ingest/awhk_generic_1" {
		t.Fatalf("ingest_path=%q", ep.IngestPath)
	}
	if store.integration.Settings[analyticsIngestTokenKey] != "awhk_generic_1" {
		t.Fatalf("generic token not stored under %s: %+v", analyticsIngestTokenKey, store.integration.Settings)
	}
}

func TestAnalyticsProvisionIngestRejectsEmptyProvider(t *testing.T) {
	deps := &Deps{Repo: newFakeStore()}
	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/webhook-ingest", `{"provider":"  ~  "}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAnalyticsProvisionIngestIsIdempotent(t *testing.T) {
	store := newFakeStore()
	mints := 0
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) {
		mints++
		return "awhk_mint_x", nil
	}}

	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/webhook-ingest", `{"provider":"segment"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("first provision status=%d body=%s", rec.Code, rec.Body.String())
	}

	// Second request for the same provider returns the existing endpoint and
	// does NOT mint/rotate a new token (idempotent — no surprise URL break).
	rec = httptest.NewRecorder()
	deps.ProvisionIngest(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/webhook-ingest", `{"provider":"segment"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("second provision status=%d body=%s", rec.Code, rec.Body.String())
	}
	if mints != 1 {
		t.Fatalf("expected token minted exactly once, got %d", mints)
	}
}

func TestAnalyticsRotateIngestIssuesFreshToken(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "awhk_rotated_2", nil }}
	// seed a provisioned ingest integration
	store.integration = Integration{
		ID:       "analytics_ingest_1",
		TenantID: "tenant-1",
		Provider: ProviderSegment,
		Name:     "Segment (webhook ingest)",
		Status:   "connected",
		Settings: map[string]any{segmentIngestTokenSetting: "awhk_old_1"},
	}

	rec := httptest.NewRecorder()
	deps.RotateIngest(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/webhook-ingest/analytics_ingest_1/rotate", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep); err != nil {
		t.Fatal(err)
	}
	if ep.IngestToken == "awhk_old_1" {
		t.Fatalf("rotate did not change the token: %+v", ep)
	}
	if ep.IngestToken != "awhk_rotated_2" || !strings.HasSuffix(ep.IngestPath, "awhk_rotated_2") {
		t.Fatalf("rotate did not refresh token: %+v", ep)
	}
}

func TestAnalyticsListIngestEndpointsOnlyReturnsTokenedRows(t *testing.T) {
	store := newFakeStore()
	// default fake integration is segment WITHOUT an ingest token -> excluded
	deps := &Deps{Repo: store}
	rec := httptest.NewRecorder()
	deps.ListIngestEndpoints(rec, analyticsReq(http.MethodGet, "/api/v1/analytics-integrations/webhook-ingest", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Items []IngestEndpoint `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 0 {
		t.Fatalf("expected no ingest endpoints for a tokenless integration, got %+v", res.Items)
	}

	// now seed a webhook-ingest integration and confirm it surfaces
	store.integration.Settings = map[string]any{segmentIngestTokenSetting: "awhk_abc"}
	store.integration.Provider = ProviderSegment
	rec = httptest.NewRecorder()
	deps.ListIngestEndpoints(rec, analyticsReq(http.MethodGet, "/api/v1/analytics-integrations/webhook-ingest", ""))
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 1 || res.Items[0].IngestToken != "awhk_abc" {
		t.Fatalf("expected the seeded segment endpoint, got %+v", res.Items)
	}
}
