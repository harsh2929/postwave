// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestMountRoutesWebhookIngestPrecedence registers the real router and proves the
// static "webhook-ingest" segment resolves to the provisioning handler (not the
// {id} GetIntegration route) — chi route conflicts only surface at
// registration/serve time, which a compile cannot catch. A resolved owner
// session exercises the real scope boundary without standing up API-key auth.
func TestMountRoutesWebhookIngestPrecedence(t *testing.T) {
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
	MountRoutes(r, &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_route_1", nil }})

	// Static segment must hit the provisioning list handler, not GetIntegration({id}).
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/review-integrations/webhook-ingest", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET webhook-ingest status=%d body=%s", rec.Code, rec.Body.String())
	}
	var listRes struct {
		Items []IngestEndpoint `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&listRes); err != nil {
		t.Fatalf("webhook-ingest list should return {items:[]}, got %s", rec.Body.String())
	}

	// The {id} route still resolves for a non-static id.
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/review-integrations/review_1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET {id} status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestListIngestProvidersFlagsPushOnly(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{Repo: newFakeStore()}).ListIngestProviders(rec, reviewReq(http.MethodGet, "/api/v1/review-integrations/webhook-ingest/providers", ""))
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
	// Every shipped review provider has a native REST puller, so none are
	// push-only — they remain webhook-ingest-provisionable but not exclusively so.
	for _, p := range []string{
		ProviderYotpo, ProviderJudgeMe, ProviderOkendo, ProviderLoox,
		ProviderStamped, ProviderTrustpilot, ProviderReviewsIO,
		ProviderBazaarvoice, ProviderPowerReviews,
	} {
		if !seen[p] {
			t.Fatalf("provider %q should be present in the ingest provider list", p)
		}
		if pushOnly[p] {
			t.Fatalf("provider %q has a native puller and must NOT be flagged push-only", p)
		}
	}
}

func TestProvisionIngestMintsTokenAndURL(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_yotpo_1", nil }}

	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/webhook-ingest", `{"provider":"yotpo"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep); err != nil {
		t.Fatal(err)
	}
	if ep.Provider != ProviderYotpo || ep.IngestToken != "tok_yotpo_1" {
		t.Fatalf("endpoint=%+v", ep)
	}
	wantPath := "/api/public/review-integrations/yotpo/ingest/tok_yotpo_1"
	if ep.IngestPath != wantPath {
		t.Fatalf("ingest_path=%q want %q", ep.IngestPath, wantPath)
	}
	if !strings.HasSuffix(ep.IngestURL, wantPath) || !strings.HasPrefix(ep.IngestURL, "http") {
		t.Fatalf("ingest_url=%q should be an absolute URL ending in the path", ep.IngestURL)
	}
}

func TestReviewProvisionIngestStoresWebhookSecretRef(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_yotpo_1", nil }}

	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/webhook-ingest", `{
		"provider":"yotpo",
		"webhook_secret_ref":"cred_yotpo_webhook_1"
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.integration.Provider != ProviderYotpo || store.integration.Settings["webhook_secret_ref"] != "cred_yotpo_webhook_1" {
		t.Fatalf("integration=%+v", store.integration)
	}
}

func TestReviewProvisionIngestRejectsRawWebhookSecret(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_yotpo_1", nil }}

	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/webhook-ingest", `{
		"provider":"yotpo",
		"webhook_secret_ref":"{\"secret\":\"raw\"}"
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if settingString(store.integration.Settings, reviewIngestTokenSetting) != "" {
		t.Fatalf("raw webhook secret should not provision endpoint: %+v", store.integration)
	}
}

func TestProvisionIngestAcceptsArbitraryProvider(t *testing.T) {
	// Any reviews tool that can POST a webhook is set-up-able via ingest.
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_bridge_3", nil }}
	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/webhook-ingest", `{"provider":"Feefo"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep); err != nil {
		t.Fatal(err)
	}
	if ep.Provider != "feefo" || ep.IngestPath != "/api/public/review-integrations/feefo/ingest/tok_bridge_3" {
		t.Fatalf("arbitrary provider not slugified into the ingest path: %+v", ep)
	}
}

func TestProvisionIngestNameConflictReturns409(t *testing.T) {
	store := newFakeStore()
	store.provisionErr = ErrIngestNameConflict
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_c", nil }}
	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/webhook-ingest", `{"provider":"judge-me","name":"Judge.me reviews"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "name_conflict") {
		t.Fatalf("expected 409 name_conflict, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestProvisionIngestRejectsEmptyProvider(t *testing.T) {
	deps := &Deps{Repo: newFakeStore()}
	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/webhook-ingest", `{"provider":"  ~  "}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestProvisionIngestIsIdempotent(t *testing.T) {
	store := newFakeStore()
	mints := 0
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) {
		mints++
		return "tok_mint_x", nil
	}}

	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/webhook-ingest", `{"provider":"yotpo"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("first provision status=%d body=%s", rec.Code, rec.Body.String())
	}

	// Second request for the same provider returns the existing endpoint and does
	// NOT mint/rotate a new token (idempotent — no surprise URL break).
	rec = httptest.NewRecorder()
	deps.ProvisionIngest(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/webhook-ingest", `{"provider":"yotpo"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("second provision status=%d body=%s", rec.Code, rec.Body.String())
	}
	if mints != 1 {
		t.Fatalf("expected token minted exactly once, got %d", mints)
	}
}

func TestRotateIngestIssuesFreshToken(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_rotated_2", nil }}
	// seed a provisioned ingest integration
	store.integration = Integration{
		ID:       "review_ingest_1",
		TenantID: "tenant-1",
		Provider: ProviderJudgeMe,
		Name:     "Judge.me (webhook ingest)",
		Status:   "connected",
		Settings: map[string]any{
			"review_ingest_token": "tok_old_1",
			"provider_cleanup":    map[string]any{"status": "stale"},
		},
	}

	rec := httptest.NewRecorder()
	deps.RotateIngest(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/webhook-ingest/review_ingest_1/rotate", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep); err != nil {
		t.Fatal(err)
	}
	if ep.IngestToken != "tok_rotated_2" || !strings.HasSuffix(ep.IngestPath, "tok_rotated_2") {
		t.Fatalf("rotate did not refresh token: %+v", ep)
	}
	if store.integration.Settings["provider_cleanup"] != nil || strings.Contains(rec.Body.String(), "provider_cleanup") {
		t.Fatalf("rotate should clear stale provider cleanup evidence: settings=%+v body=%s", store.integration.Settings, rec.Body.String())
	}
}

func TestRotateIngestRejectsDisconnected(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_x", nil }}
	store.integration = Integration{
		ID:       "review_ingest_1",
		TenantID: "tenant-1",
		Provider: ProviderYotpo,
		Status:   "disconnected",
		Settings: map[string]any{"review_ingest_token": "tok_old"},
	}
	rec := httptest.NewRecorder()
	deps.RotateIngest(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/webhook-ingest/review_ingest_1/rotate", ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("rotating a disconnected ingest endpoint should 404, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestListIntegrationsRedactsIngestToken(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings = map[string]any{
		"review_ingest_token": "tok_secret_value",
		"store_id":            "acme-store",
	}
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.ListIntegrations(rec, reviewReq(http.MethodGet, "/api/v1/review-integrations", ""))
	if strings.Contains(rec.Body.String(), "tok_secret_value") {
		t.Fatalf("read-scoped list leaked the ingest token: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "acme-store") {
		t.Fatalf("redaction stripped non-token settings: %s", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.GetIntegration(rec, reviewReq(http.MethodGet, "/api/v1/review-integrations/review_1", ""))
	if strings.Contains(rec.Body.String(), "tok_secret_value") {
		t.Fatalf("read-scoped get leaked the ingest token: %s", rec.Body.String())
	}
}

func TestListIngestEndpointsOnlyReturnsWebhookIntegrations(t *testing.T) {
	store := newFakeStore()
	// default fake integration is yotpo WITHOUT an ingest token -> excluded
	deps := &Deps{Repo: store}
	rec := httptest.NewRecorder()
	deps.ListIngestEndpoints(rec, reviewReq(http.MethodGet, "/api/v1/review-integrations/webhook-ingest", ""))
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

	// now seed a webhook-ingest integration and confirm it surfaces
	store.integration.Settings = map[string]any{"review_ingest_token": "tok_abc"}
	store.integration.Provider = ProviderJudgeMe
	rec = httptest.NewRecorder()
	deps.ListIngestEndpoints(rec, reviewReq(http.MethodGet, "/api/v1/review-integrations/webhook-ingest", ""))
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 1 || res.Items[0].IngestToken != "tok_abc" {
		t.Fatalf("expected the seeded judge-me endpoint, got %+v", res.Items)
	}
}
