// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestSupportMountRoutesWebhookIngestPrecedence proves the static
// "webhook-ingest" segment resolves to the provisioning handler rather than the
// {id} route, and that MountRoutes registers without a chi route conflict.
func TestSupportMountRoutesWebhookIngestPrecedence(t *testing.T) {
	defer func() {
		if rec := recover(); rec != nil {
			t.Fatalf("MountRoutes panicked (route conflict?): %v", rec)
		}
	}()
	store := newFakeStore()
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"})
			ctx = middleware.WithUser(ctx, &middleware.User{ID: "owner-1", TenantID: "tenant-1", Role: "owner"})
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	mountArchivedRoutesFixture(r, &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_route_1", nil }})

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/support-integrations/webhook-ingest", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET webhook-ingest status=%d body=%s", rec.Code, rec.Body.String())
	}
	var listRes struct {
		Items []IngestEndpoint `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&listRes); err != nil {
		t.Fatalf("webhook-ingest list should return {items:[]}, got %s", rec.Body.String())
	}

	// POST provisioning on the static segment resolves to ProvisionIngest.
	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/support-integrations/webhook-ingest", strings.NewReader(`{"provider":"freshchat"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST webhook-ingest status=%d body=%s", rec.Code, rec.Body.String())
	}

	// The {id} route still resolves for a non-static id.
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/support-integrations/support_1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET {id} status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSupportRotateIngestRejectsDisconnected(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_x", nil }}
	store.integration = Integration{
		ID:       "support_ingest_1",
		TenantID: "tenant-1",
		Provider: ProviderFreshchat,
		Status:   "disconnected",
		Settings: map[string]any{"support_ingest_token": "tok_old"},
	}
	rec := httptest.NewRecorder()
	deps.RotateIngest(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/webhook-ingest/support_ingest_1/rotate", ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("rotating a disconnected ingest endpoint should 404, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSupportListIntegrationsRedactsIngestToken(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings = map[string]any{
		"support_ingest_token": "tok_secret_value",
		"subdomain":            "acme",
	}
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.ListIntegrations(rec, supportReq(http.MethodGet, "/api/v1/support-integrations", ""))
	if strings.Contains(rec.Body.String(), "tok_secret_value") {
		t.Fatalf("read-scoped list leaked the ingest token: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "acme") {
		t.Fatalf("redaction stripped non-token settings: %s", rec.Body.String())
	}
}

func TestSupportListIngestProvidersFlagsPushOnly(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{Repo: newFakeStore()}).ListIngestProviders(rec, supportReq(http.MethodGet, "/api/v1/support-integrations/webhook-ingest/providers", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Items []IngestProviderOption `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	pushOnly := map[string]bool{}
	seen := map[string]bool{}
	for _, item := range res.Items {
		seen[item.Provider] = true
		pushOnly[item.Provider] = item.PushOnly
	}
	for _, p := range []string{ProviderFreshchat, ProviderTidio, ProviderGladly} {
		if !seen[p] || pushOnly[p] {
			t.Fatalf("provider %q should be present and NOT push-only after native puller wiring: seen=%v pushOnly=%v", p, seen[p], pushOnly[p])
		}
	}
	if !seen[ProviderZendesk] || pushOnly[ProviderZendesk] {
		t.Fatalf("zendesk should be present and NOT push-only (it has a puller)")
	}
}

func TestSupportProvisionIngestMintsTokenAndURL(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_freshchat_1", nil }}

	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/webhook-ingest", `{"provider":"freshchat"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep); err != nil {
		t.Fatal(err)
	}
	if ep.Provider != ProviderFreshchat || ep.IngestToken != "tok_freshchat_1" || ep.PushOnly {
		t.Fatalf("endpoint=%+v", ep)
	}
	wantPath := "/api/public/support-integrations/freshchat/ingest/tok_freshchat_1"
	if ep.IngestPath != wantPath {
		t.Fatalf("ingest_path=%q want %q", ep.IngestPath, wantPath)
	}
	if !strings.HasSuffix(ep.IngestURL, wantPath) || !strings.HasPrefix(ep.IngestURL, "http") {
		t.Fatalf("ingest_url=%q should be an absolute URL ending in the path", ep.IngestURL)
	}
}

func TestSupportProvisionIngestStoresWebhookSecretRef(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_tidio_1", nil }}

	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/webhook-ingest", `{"provider":"tidio","webhook_secret_ref":"cred_tidio_webhook_1"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.integration.Settings["webhook_secret_ref"] != "cred_tidio_webhook_1" {
		t.Fatalf("webhook secret ref should be persisted as a vault ref: %+v", store.integration.Settings)
	}
}

func TestSupportProvisionIngestAcceptsArbitraryProvider(t *testing.T) {
	// Any support/chat tool that can POST a webhook is set-up-able via ingest.
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_bridge_2", nil }}
	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/webhook-ingest", `{"provider":"HelpCrunch"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep); err != nil {
		t.Fatal(err)
	}
	if ep.Provider != "helpcrunch" || ep.IngestPath != "/api/public/support-integrations/helpcrunch/ingest/tok_bridge_2" {
		t.Fatalf("arbitrary provider not slugified into the ingest path: %+v", ep)
	}
}

func TestSupportProvisionIngestNameConflictReturns409(t *testing.T) {
	store := newFakeStore()
	store.provisionErr = ErrIngestNameConflict
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_c", nil }}
	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/webhook-ingest", `{"provider":"zendesk","name":"Zendesk support"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "name_conflict") {
		t.Fatalf("expected 409 name_conflict, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestSupportProvisionIngestRejectsEmptyProvider(t *testing.T) {
	deps := &Deps{Repo: newFakeStore()}
	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/webhook-ingest", `{"provider":"  ~  "}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSupportProvisionIngestIsIdempotent(t *testing.T) {
	store := newFakeStore()
	mints := 0
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) {
		mints++
		return "tok_mint_y", nil
	}}

	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/webhook-ingest", `{"provider":"tidio"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("first provision status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	deps.ProvisionIngest(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/webhook-ingest", `{"provider":"tidio"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("second provision status=%d body=%s", rec.Code, rec.Body.String())
	}
	if mints != 1 {
		t.Fatalf("expected token minted exactly once, got %d", mints)
	}
}

func TestSupportRotateIngestIssuesFreshToken(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_rotated_3", nil }}
	store.integration = Integration{
		ID:       "support_ingest_1",
		TenantID: "tenant-1",
		Provider: ProviderGladly,
		Name:     "Gladly (webhook ingest)",
		Status:   "connected",
		Settings: map[string]any{"support_ingest_token": "tok_old_1"},
	}
	rec := httptest.NewRecorder()
	deps.RotateIngest(rec, supportReq(http.MethodPost, "/api/v1/support-integrations/webhook-ingest/support_ingest_1/rotate", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep); err != nil {
		t.Fatal(err)
	}
	if ep.IngestToken != "tok_rotated_3" || !strings.HasSuffix(ep.IngestPath, "tok_rotated_3") {
		t.Fatalf("rotate did not refresh token: %+v", ep)
	}
}

func TestSupportListIngestEndpointsOnlyReturnsWebhookIntegrations(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}
	rec := httptest.NewRecorder()
	deps.ListIngestEndpoints(rec, supportReq(http.MethodGet, "/api/v1/support-integrations/webhook-ingest", ""))
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
		t.Fatalf("expected no ingest endpoints for a pull-only integration, got %+v", res.Items)
	}
	store.integration.Settings = map[string]any{"support_ingest_token": "tok_abc"}
	store.integration.Provider = ProviderFreshchat
	rec = httptest.NewRecorder()
	deps.ListIngestEndpoints(rec, supportReq(http.MethodGet, "/api/v1/support-integrations/webhook-ingest", ""))
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 1 || res.Items[0].IngestToken != "tok_abc" {
		t.Fatalf("expected the seeded freshchat endpoint, got %+v", res.Items)
	}
}
