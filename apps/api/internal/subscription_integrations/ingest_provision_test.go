// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

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
// the static "webhook-ingest" segment resolves to the provisioning handler (not
// the {id} GetIntegration route) — chi route conflicts only surface at
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
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/subscription-integrations/webhook-ingest", nil))
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
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/subscription-integrations/subscription_1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET {id} status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestListIngestProvidersFlagsPushOnly(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{Repo: newFakeStore()}).ListIngestProviders(rec, subscriptionReq(http.MethodGet, "/api/v1/subscription-integrations/webhook-ingest/providers", ""))
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
	for _, p := range []string{ProviderOrdergroove, ProviderWonderment, ProviderMalomo, ProviderRoute} {
		if !seen[p] || !pushOnly[p] {
			t.Fatalf("provider %q should be present and push-only: seen=%v pushOnly=%v", p, seen[p], pushOnly[p])
		}
	}
	if !seen[ProviderRecharge] || pushOnly[ProviderRecharge] {
		t.Fatalf("recharge should be present and NOT push-only (it has a puller)")
	}
}

func TestProvisionIngestMintsTokenAndURL(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_ordergroove_1", nil }}

	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/webhook-ingest", `{"provider":"ordergroove"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep); err != nil {
		t.Fatal(err)
	}
	if ep.Provider != ProviderOrdergroove || ep.IngestToken != "tok_ordergroove_1" || !ep.PushOnly {
		t.Fatalf("endpoint=%+v", ep)
	}
	wantPath := "/api/public/subscription-integrations/ordergroove/ingest/tok_ordergroove_1"
	if ep.IngestPath != wantPath {
		t.Fatalf("ingest_path=%q want %q", ep.IngestPath, wantPath)
	}
	if !strings.HasSuffix(ep.IngestURL, wantPath) || !strings.HasPrefix(ep.IngestURL, "http") {
		t.Fatalf("ingest_url=%q should be an absolute URL ending in the path", ep.IngestURL)
	}
}

func TestProvisionRechargeIngestStoresWebhookSecretRef(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_recharge_1", nil }}

	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/webhook-ingest", `{
		"provider":"recharge",
		"webhook_secret_ref":"cred_recharge_webhook_1"
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.integration.Provider != ProviderRecharge || store.integration.Settings["webhook_secret_ref"] != "cred_recharge_webhook_1" {
		t.Fatalf("integration=%+v", store.integration)
	}
}

func TestProvisionIngestAcceptsArbitraryProvider(t *testing.T) {
	// Any subscription/shipping tool that can POST a webhook is set-up-able.
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_bridge_4", nil }}
	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/webhook-ingest", `{"provider":"Sticky.io"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var ep IngestEndpoint
	if err := json.NewDecoder(rec.Body).Decode(&ep); err != nil {
		t.Fatal(err)
	}
	if ep.Provider != "sticky-io" || ep.IngestPath != "/api/public/subscription-integrations/sticky-io/ingest/tok_bridge_4" {
		t.Fatalf("arbitrary provider not slugified into the ingest path: %+v", ep)
	}
}

func TestProvisionIngestNameConflictReturns409(t *testing.T) {
	store := newFakeStore()
	store.provisionErr = ErrIngestNameConflict
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_c", nil }}
	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/webhook-ingest", `{"provider":"recharge","name":"Recharge"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "name_conflict") {
		t.Fatalf("expected 409 name_conflict, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestProvisionIngestRejectsEmptyProvider(t *testing.T) {
	deps := &Deps{Repo: newFakeStore()}
	rec := httptest.NewRecorder()
	deps.ProvisionIngest(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/webhook-ingest", `{"provider":"  ~  "}`))
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
	deps.ProvisionIngest(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/webhook-ingest", `{"provider":"ordergroove"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("first provision status=%d body=%s", rec.Code, rec.Body.String())
	}

	// Second request for the same provider returns the existing endpoint and does
	// NOT mint/rotate a new token (idempotent — no surprise URL break).
	rec = httptest.NewRecorder()
	deps.ProvisionIngest(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/webhook-ingest", `{"provider":"ordergroove"}`))
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
		ID:       "subscription_ingest_1",
		TenantID: "tenant-1",
		Provider: ProviderWonderment,
		Name:     "Wonderment (webhook ingest)",
		Status:   "connected",
		Settings: map[string]any{"subscription_ingest_token": "tok_old_1"},
	}

	rec := httptest.NewRecorder()
	deps.RotateIngest(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/webhook-ingest/subscription_ingest_1/rotate", ""))
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

func TestRotateIngestStripsStaleProviderCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_rotated_3", nil }}
	store.integration = Integration{
		ID:       "subscription_ingest_1",
		TenantID: "tenant-1",
		Provider: ProviderRecharge,
		Name:     "Recharge (webhook ingest)",
		Status:   "connected",
		Settings: map[string]any{
			"subscription_ingest_token": "tok_old_1",
			"provider_cleanup":          map[string]any{"status": "stale"},
		},
	}

	rec := httptest.NewRecorder()
	deps.RotateIngest(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/webhook-ingest/subscription_ingest_1/rotate", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.integration.Settings["provider_cleanup"] != nil || strings.Contains(rec.Body.String(), "provider_cleanup") {
		t.Fatalf("rotate should strip stale provider cleanup evidence: settings=%+v body=%s", store.integration.Settings, rec.Body.String())
	}
}

func TestRotateIngestRejectsDisconnected(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store, NewIngestToken: func() (string, error) { return "tok_x", nil }}
	store.integration = Integration{
		ID:       "subscription_ingest_1",
		TenantID: "tenant-1",
		Provider: ProviderOrdergroove,
		Status:   "disconnected",
		Settings: map[string]any{"subscription_ingest_token": "tok_old"},
	}
	rec := httptest.NewRecorder()
	deps.RotateIngest(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/webhook-ingest/subscription_ingest_1/rotate", ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("rotating a disconnected ingest endpoint should 404, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestListIntegrationsRedactsIngestToken(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings = map[string]any{
		"subscription_ingest_token": "tok_secret_value",
		"store_domain":              "acme.myshopify.com",
	}
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.ListIntegrations(rec, subscriptionReq(http.MethodGet, "/api/v1/subscription-integrations", ""))
	if strings.Contains(rec.Body.String(), "tok_secret_value") {
		t.Fatalf("read-scoped list leaked the ingest token: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "acme.myshopify.com") {
		t.Fatalf("redaction stripped non-token settings: %s", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.GetIntegration(rec, subscriptionReq(http.MethodGet, "/api/v1/subscription-integrations/subscription_1", ""))
	if strings.Contains(rec.Body.String(), "tok_secret_value") {
		t.Fatalf("read-scoped get leaked the ingest token: %s", rec.Body.String())
	}
}

func TestListIngestEndpointsOnlyReturnsWebhookIntegrations(t *testing.T) {
	store := newFakeStore()
	// default fake integration is recharge WITHOUT an ingest token -> excluded
	deps := &Deps{Repo: store}
	rec := httptest.NewRecorder()
	deps.ListIngestEndpoints(rec, subscriptionReq(http.MethodGet, "/api/v1/subscription-integrations/webhook-ingest", ""))
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
	store.integration.Settings = map[string]any{"subscription_ingest_token": "tok_abc"}
	store.integration.Provider = ProviderOrdergroove
	rec = httptest.NewRecorder()
	deps.ListIngestEndpoints(rec, subscriptionReq(http.MethodGet, "/api/v1/subscription-integrations/webhook-ingest", ""))
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 1 || res.Items[0].IngestToken != "tok_abc" {
		t.Fatalf("expected the seeded ordergroove endpoint, got %+v", res.Items)
	}
}

func TestSubscriptionWebhookIngestMapsSubscription(t *testing.T) {
	req, ok := mapSubscriptionWebhook(ProviderOrdergroove, []byte(`{
		"event":"subscription.updated",
		"email":"VIP@Example.com",
		"subscription_id":"sub_99",
		"status":"active",
		"plan_name":"monthly",
		"next_charge_at":"2026-07-01T00:00:00Z"
	}`))
	if !ok {
		t.Fatal("expected the webhook to map")
	}
	if len(req.Subscriptions) != 1 || len(req.Shipments) != 0 {
		t.Fatalf("expected a single subscription, got %+v", req)
	}
	sub := req.Subscriptions[0]
	if sub.Email != "VIP@Example.com" && sub.Email != "vip@example.com" {
		// email is lowercased by normalizeSyncRequest, not the mapper
		t.Fatalf("email=%q", sub.Email)
	}
	if sub.SubscriptionID != "sub_99" || sub.Status != "active" || sub.Frequency != "monthly" || sub.NextChargeAt == nil {
		t.Fatalf("subscription=%+v", sub)
	}
}

func TestSubscriptionWebhookIngestVerifiesRechargeSignatureAndMapsProviderEvent(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderRecharge
	store.integration.Settings = map[string]any{
		"subscription_ingest_token": "tok_recharge_1",
		"webhook_secret_ref":        "cred_recharge_webhook_1",
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:           store,
		Profiles:       profiles,
		Events:         events,
		WebhookSecrets: fakeRechargeSecretResolver{token: "rc_webhook_secret"},
	}
	r := chi.NewRouter()
	MountPublicRoutes(r, deps)
	body := []byte(`{"subscription":{"id":9001,"email":"VIP@Example.com","status":"active","product_title":"Coffee"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/subscription-integrations/recharge/ingest/tok_recharge_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Recharge-Hmac-Sha256", rechargeTestSignature("rc_webhook_secret", body))
	req.Header.Set("X-Recharge-Topic", "subscription/updated")
	req.Header.Set("X-Recharge-Webhook-ID", "evt_signature_1")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.subscriptions) != 1 || profiles.subscriptions[0].Email != "vip@example.com" || profiles.subscriptions[0].SubscriptionID != "9001" {
		t.Fatalf("subscriptions=%+v", profiles.subscriptions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" {
		t.Fatalf("runs=%+v", store.runs)
	}

	bad := httptest.NewRequest(http.MethodPost, "/api/public/subscription-integrations/recharge/ingest/tok_recharge_1", strings.NewReader(string(body)))
	bad.Header.Set("Content-Type", "application/json")
	bad.Header.Set("X-Recharge-Hmac-Sha256", "wrong")
	bad.Header.Set("X-Recharge-Topic", "subscription/updated")
	bad.Header.Set("X-Recharge-Webhook-ID", "evt_signature_1")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, bad)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("bad signature status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSubscriptionWebhookIngestDeduplicatesRechargeReplay(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderRecharge
	store.integration.Settings = map[string]any{
		"subscription_ingest_token": "tok_recharge_1",
		"webhook_secret_ref":        "cred_recharge_webhook_1",
	}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:           store,
		Profiles:       profiles,
		WebhookSecrets: fakeRechargeSecretResolver{token: "rc_webhook_secret"},
	}
	r := chi.NewRouter()
	MountPublicRoutes(r, deps)
	body := []byte(`{"subscription":{"id":9001,"email":"VIP@Example.com","status":"active","product_title":"Coffee"}}`)
	newReq := func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/api/public/subscription-integrations/recharge/ingest/tok_recharge_1", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Recharge-Hmac-Sha256", rechargeTestSignature("rc_webhook_secret", body))
		req.Header.Set("X-Recharge-Topic", "subscription/updated")
		req.Header.Set("X-Recharge-Webhook-ID", "evt_replay_1")
		return req
	}

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, newReq())
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, newReq())
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "duplicate") {
		t.Fatalf("replay status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.subscriptions) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not write again, profiles=%+v runs=%+v", profiles.subscriptions, store.runs)
	}
	if store.webhooks[ProviderRecharge+":delivery:evt_replay_1"] != WebhookProcessed {
		t.Fatalf("webhooks=%+v", store.webhooks)
	}
}

func TestSubscriptionWebhookInProgressClaimReturnsRetry(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderRecharge
	store.integration.Settings = map[string]any{
		"subscription_ingest_token": "tok_recharge_1",
		"webhook_secret_ref":        "cred_recharge_webhook_1",
	}
	store.webhooks = map[string]WebhookClaim{ProviderRecharge + ":delivery:evt_busy": WebhookInProgress}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:           store,
		Profiles:       profiles,
		WebhookSecrets: fakeRechargeSecretResolver{token: "rc_webhook_secret"},
	}
	r := chi.NewRouter()
	MountPublicRoutes(r, deps)
	body := []byte(`{"subscription":{"id":9001,"email":"VIP@Example.com","status":"active","product_title":"Coffee"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/subscription-integrations/recharge/ingest/tok_recharge_1", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Recharge-Hmac-Sha256", rechargeTestSignature("rc_webhook_secret", body))
	req.Header.Set("X-Recharge-Topic", "subscription/updated")
	req.Header.Set("X-Recharge-Webhook-ID", "evt_busy")
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "10" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if len(profiles.subscriptions) != 0 || len(store.runs) != 0 {
		t.Fatalf("in-progress delivery should not write, profiles=%+v runs=%+v", profiles.subscriptions, store.runs)
	}
}

func TestSubscriptionWebhookIngestRejectsProviderPathMismatch(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderRecharge
	store.integration.Settings = map[string]any{"subscription_ingest_token": "tok_recharge_1"}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
	}
	r := chi.NewRouter()
	MountPublicRoutes(r, deps)
	rec := httptest.NewRecorder()

	req := httptest.NewRequest(http.MethodPost, "/api/public/subscription-integrations/ordergroove/ingest/tok_recharge_1", strings.NewReader(`{"email":"vip@example.com","subscription_id":"sub_1"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "integration_not_found") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.subscriptions) != 0 || len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("mismatch should not write, profiles=%+v runs=%+v webhooks=%+v", profiles.subscriptions, store.runs, store.webhooks)
	}
}

func TestSubscriptionWebhookIngestTreatsDisconnectedRowsAsNotFound(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderRecharge
	store.integration.Status = "disconnected"
	store.integration.Settings = map[string]any{"subscription_ingest_token": "tok_recharge_1"}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		Events:   events,
	}
	r := chi.NewRouter()
	MountPublicRoutes(r, deps)
	rec := httptest.NewRecorder()

	req := httptest.NewRequest(http.MethodPost, "/api/public/subscription-integrations/recharge/ingest/tok_recharge_1", strings.NewReader(`{"email":"vip@example.com","subscription_id":"sub_1"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "integration_not_found") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.subscriptions)+len(profiles.shipments) != 0 || len(events.events) != 0 || len(store.runs) != 0 {
		t.Fatalf("profiles=%+v/%+v events=%+v runs=%+v", profiles.subscriptions, profiles.shipments, events.events, store.runs)
	}
}

func TestSubscriptionWebhookIngestMapsShipment(t *testing.T) {
	req, ok := mapSubscriptionWebhook(ProviderWonderment, []byte(`{
		"event":"tracking.updated",
		"email":"buyer@example.com",
		"tracking_number":"1Z999",
		"carrier":"ups",
		"status":"in_transit"
	}`))
	if !ok {
		t.Fatal("expected the webhook to map")
	}
	if len(req.Shipments) != 1 || len(req.Subscriptions) != 0 {
		t.Fatalf("expected a single shipment, got %+v", req)
	}
	if req.Shipments[0].TrackingNumber != "1Z999" || req.Shipments[0].Carrier != "ups" {
		t.Fatalf("shipment=%+v", req.Shipments[0])
	}
}

func TestSubscriptionWebhookIngestRejectsMissingEmail(t *testing.T) {
	if _, ok := mapSubscriptionWebhook(ProviderOrdergroove, []byte(`{"subscription_id":"sub_1","status":"active"}`)); ok {
		t.Fatal("a webhook with no email must not map to a write")
	}
}
