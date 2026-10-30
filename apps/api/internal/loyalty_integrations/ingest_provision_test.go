// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestMountRoutesWebhookIngestPrecedence registers the real router and proves
// the static "webhook-ingest" segment resolves to the provisioning handler
// (not the {id} GetIntegration route) — chi route conflicts only surface at
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
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/loyalty-integrations/webhook-ingest", nil))
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
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/loyalty-integrations/loyalty_1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET {id} status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestListIngestProvidersFlagsPushOnly(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{Repo: newFakeStore()}).ListIngestProviders(rec, loyaltyReq(http.MethodGet, "/api/v1/loyalty-integrations/webhook-ingest/providers", ""))
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
	for _, p := range []string{ProviderGrowave, ProviderMarsello, ProviderAntavo, ProviderTalkable} {
		if !seen[p] || !pushOnly[p] {
			t.Fatalf("provider %q should be present and push-only: seen=%v pushOnly=%v", p, seen[p], pushOnly[p])
		}
	}
	if !seen[ProviderSmile] || pushOnly[ProviderSmile] {
		t.Fatalf("smile should be present and NOT push-only (it has a puller)")
	}
}

func TestProvisionIngestMintsTokenAndURL(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_growave_1", nil }}

	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/webhook-ingest", `{"provider":"growave"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep); err != nil {
		t.Fatal(err)
	}
	if ep.Provider != ProviderGrowave || ep.IngestToken != "tok_growave_1" || !ep.PushOnly {
		t.Fatalf("endpoint=%+v", ep)
	}
	wantPath := "/api/public/loyalty-integrations/growave/ingest/tok_growave_1"
	if ep.IngestPath != wantPath {
		t.Fatalf("ingest_path=%q want %q", ep.IngestPath, wantPath)
	}
	if !strings.HasSuffix(ep.IngestURL, wantPath) || !strings.HasPrefix(ep.IngestURL, "http") {
		t.Fatalf("ingest_url=%q should be an absolute URL ending in the path", ep.IngestURL)
	}
}

func TestProvisionIngestAcceptsArbitraryProvider(t *testing.T) {
	// Any loyalty/referral tool that can POST a webhook is set-up-able, not just
	// curated pullers — the long-tail bridge entries provision via webhook ingest.
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_bridge_1", nil }}
	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/webhook-ingest", `{"provider":"Viral Loops"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep); err != nil {
		t.Fatal(err)
	}
	// Provider label is slug-normalized for a stable URL path segment.
	if ep.Provider != "viral-loops" || ep.IngestPath != "/api/public/loyalty-integrations/viral-loops/ingest/tok_bridge_1" {
		t.Fatalf("arbitrary provider not slugified into the ingest path: %+v", ep)
	}
}

func TestProvisionIngestNameConflictReturns409(t *testing.T) {
	// Provisioning ingest onto a (provider, name) that already belongs to a
	// curated pull integration must not clobber it — the repo signals a conflict.
	store := newFakeStore()
	store.provisionErr = ErrIngestNameConflict
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_c", nil }}
	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/webhook-ingest", `{"provider":"smile","name":"Smile store"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "name_conflict") {
		t.Fatalf("expected 409 name_conflict, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestProvisionIngestRejectsEmptyProvider(t *testing.T) {
	deps := &Deps{Repo: newFakeStore()}
	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/webhook-ingest", `{"provider":"  ~  "}`))
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
	deps.ProvisionIngest(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/webhook-ingest", `{"provider":"growave"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("first provision status=%d body=%s", rec.Code, rec.Body.String())
	}

	// Second request for the same provider returns the existing endpoint and
	// does NOT mint/rotate a new token (idempotent — no surprise URL break).
	rec = httptest.NewRecorder()
	deps.ProvisionIngest(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/webhook-ingest", `{"provider":"growave"}`))
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
		ID:       "loyalty_ingest_1",
		TenantID: "tenant-1",
		Provider: ProviderMarsello,
		Name:     "Marsello (webhook ingest)",
		Status:   "connected",
		Settings: map[string]any{"loyalty_ingest_token": "tok_old_1"},
	}

	rec := httptest.NewRecorder()
	deps.RotateIngest(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/webhook-ingest/loyalty_ingest_1/rotate", ""))
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
}

func TestRotateIngestRejectsDisconnected(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_x", nil }}
	store.integration = Integration{
		ID:       "loyalty_ingest_1",
		TenantID: "tenant-1",
		Provider: ProviderGrowave,
		Status:   "disconnected",
		Settings: map[string]any{"loyalty_ingest_token": "tok_old"},
	}
	rec := httptest.NewRecorder()
	deps.RotateIngest(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/webhook-ingest/loyalty_ingest_1/rotate", ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("rotating a disconnected ingest endpoint should 404, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestListIntegrationsRedactsIngestToken(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings = map[string]any{
		"loyalty_ingest_token": "tok_secret_value",
		"shop_domain":          "acme.myshopify.com",
	}
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.ListIntegrations(rec, loyaltyReq(http.MethodGet, "/api/v1/loyalty-integrations", ""))
	if strings.Contains(rec.Body.String(), "tok_secret_value") {
		t.Fatalf("read-scoped list leaked the ingest token: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "acme.myshopify.com") {
		t.Fatalf("redaction stripped non-token settings: %s", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.GetIntegration(rec, loyaltyReq(http.MethodGet, "/api/v1/loyalty-integrations/loyalty_1", ""))
	if strings.Contains(rec.Body.String(), "tok_secret_value") {
		t.Fatalf("read-scoped get leaked the ingest token: %s", rec.Body.String())
	}
}

func TestListIngestEndpointsOnlyReturnsWebhookIntegrations(t *testing.T) {
	store := newFakeStore()
	// default fake integration is smile WITHOUT an ingest token -> excluded
	deps := &Deps{Repo: store}
	rec := httptest.NewRecorder()
	deps.ListIngestEndpoints(rec, loyaltyReq(http.MethodGet, "/api/v1/loyalty-integrations/webhook-ingest", ""))
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
	store.integration.Settings = map[string]any{"loyalty_ingest_token": "tok_abc"}
	store.integration.Provider = ProviderGrowave
	rec = httptest.NewRecorder()
	deps.ListIngestEndpoints(rec, loyaltyReq(http.MethodGet, "/api/v1/loyalty-integrations/webhook-ingest", ""))
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 1 || res.Items[0].IngestToken != "tok_abc" {
		t.Fatalf("expected the seeded growave endpoint, got %+v", res.Items)
	}
}

func TestLoyaltyWebhookIngestTreatsDisconnectedRowsAsNotFound(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGrowave
	store.integration.Status = "disconnected"
	store.integration.Settings = map[string]any{"loyalty_ingest_token": "tok_growave_1"}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{Repo: store, Profiles: profiles, Events: events}
	r := chi.NewRouter()
	MountPublicRoutes(r, deps)
	rec := httptest.NewRecorder()

	req := httptest.NewRequest(http.MethodPost, "/api/public/loyalty-integrations/growave/ingest/tok_growave_1", strings.NewReader(`{"email":"vip@example.com","points":120}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "integration_not_found") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.members) != 0 || len(events.events) != 0 || len(store.runs) != 0 {
		t.Fatalf("profiles=%+v events=%+v runs=%+v", profiles.members, events.events, store.runs)
	}
}
