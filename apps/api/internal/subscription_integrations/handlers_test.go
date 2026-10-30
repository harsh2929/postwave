// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeStore struct {
	integration  Integration
	runs         []SyncRun
	webhooks     map[string]WebhookClaim
	lastInput    IntegrationInput
	paused       bool
	deleted      bool
	provisionErr error
}

func newFakeStore() *fakeStore {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	return &fakeStore{integration: Integration{
		ID:             "subscription_1",
		TenantID:       "tenant-1",
		Provider:       ProviderRecharge,
		Name:           "Recharge store",
		Status:         "connected",
		Scopes:         []string{"subscriptions.read"},
		CredentialsRef: "cred_recharge_1",
		Settings:       map[string]any{"store_domain": "acme.myshopify.com"},
		CreatedAt:      now,
		UpdatedAt:      now,
	}}
}

func (f *fakeStore) ListIntegrations(context.Context, string) ([]Integration, error) {
	return []Integration{f.integration}, nil
}
func (f *fakeStore) GetIntegration(context.Context, string, string) (*Integration, error) {
	return &f.integration, nil
}
func (f *fakeStore) UpsertIntegration(_ context.Context, tenantID string, in IntegrationInput) (*Integration, error) {
	f.lastInput = in
	delete(in.Settings, "provider_cleanup")
	f.integration.TenantID = tenantID
	f.integration.Provider = in.Provider
	f.integration.Name = in.Name
	f.integration.Status = in.Status
	f.integration.Scopes = in.Scopes
	f.integration.CredentialsRef = in.CredentialsRef
	f.integration.Settings = in.Settings
	return &f.integration, nil
}
func (f *fakeStore) ProvisionIngestIntegration(_ context.Context, tenantID string, in IngestProvisionInput, token string) (*Integration, error) {
	if f.provisionErr != nil {
		return nil, f.provisionErr
	}
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	name := in.Name
	if name == "" {
		name = in.Provider + " (webhook ingest)"
	}
	f.integration = Integration{
		ID:        "subscription_ingest_1",
		TenantID:  tenantID,
		Provider:  in.Provider,
		Name:      name,
		Status:    "connected",
		Settings:  map[string]any{"subscription_ingest_token": token, "ingest_mode": "webhook"},
		CreatedAt: now,
		UpdatedAt: now,
	}
	if strings.TrimSpace(in.WebhookSecretRef) != "" {
		f.integration.Settings["webhook_secret_ref"] = strings.TrimSpace(in.WebhookSecretRef)
	}
	return &f.integration, nil
}
func (f *fakeStore) RotateIngestToken(_ context.Context, _ string, _ string, token string) (*Integration, error) {
	// Model the repo's WHERE guard: a disconnected or non-ingest row → no match
	// → ErrNotFound (404). (Wrong-id matching is exercised by the router test.)
	if f.integration.Status == "disconnected" ||
		settingString(f.integration.Settings, "subscription_ingest_token") == "" {
		return nil, ErrNotFound
	}
	delete(f.integration.Settings, "provider_cleanup")
	f.integration.Settings["subscription_ingest_token"] = token
	return &f.integration, nil
}
func (f *fakeStore) PauseIntegration(context.Context, string, string) (*Integration, error) {
	f.paused = true
	f.integration.Status = "paused"
	return &f.integration, nil
}
func (f *fakeStore) DisconnectIntegration(context.Context, string, string) error {
	f.deleted = true
	f.integration.Status = "disconnected"
	return nil
}
func (f *fakeStore) DisconnectIntegrationWithProviderCleanup(_ context.Context, _ string, _ string, cleanup *DisconnectCleanupEvidence) error {
	f.deleted = true
	f.integration.Status = "disconnected"
	if cleanup != nil {
		if f.integration.Settings == nil {
			f.integration.Settings = map[string]any{}
		}
		var stored map[string]any
		payload, _ := json.Marshal(cleanup)
		_ = json.Unmarshal(payload, &stored)
		f.integration.Settings["provider_cleanup"] = stored
	}
	return nil
}
func (f *fakeStore) AcknowledgeProviderCleanup(_ context.Context, _ string, _ string, in ProviderCleanupAcknowledgementInput, acknowledgedAt time.Time) (*Integration, error) {
	if f.integration.Status != "disconnected" ||
		f.integration.Settings == nil || f.integration.Settings["provider_cleanup"] == nil {
		return nil, ErrProviderCleanupMissing
	}
	stored, ok := f.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		stored = map[string]any{}
		f.integration.Settings["provider_cleanup"] = stored
	}
	stored["status"] = "operator_acknowledged"
	stored["acknowledged_at"] = acknowledgedAt.UTC().Format(time.RFC3339)
	stored["managed_provider_cleanup"] = false
	if strings.TrimSpace(in.AcknowledgedBy) != "" {
		stored["acknowledged_by"] = strings.TrimSpace(in.AcknowledgedBy)
	}
	if len(in.CompletedActions) > 0 {
		stored["completed_actions"] = append([]string(nil), in.CompletedActions...)
	}
	if strings.TrimSpace(in.Notes) != "" {
		stored["operator_notes"] = strings.TrimSpace(in.Notes)
	}
	return &f.integration, nil
}
func (f *fakeStore) RecordSyncRun(_ context.Context, _ string, _ string, summary SyncSummary, req SyncRequest, started, completed time.Time) (*SyncRun, error) {
	cursor := firstString(summary.Cursor, req.Cursor, f.integration.SyncCursor)
	run := SyncRun{
		ID:                    "run_1",
		IntegrationID:         summary.IntegrationID,
		RunMode:               req.RunMode,
		Status:                summary.Status,
		CursorTo:              cursor,
		SubscriptionsSeen:     summary.SubscriptionsSeen,
		SubscriptionsUpserted: summary.SubscriptionsUpserted,
		ShipmentsSeen:         summary.ShipmentsSeen,
		ShipmentsUpserted:     summary.ShipmentsUpserted,
		EventsSeen:            summary.EventsSeen,
		EventsTracked:         summary.EventsTracked,
		RowsFailed:            summary.RowsFailed,
		ErrorMessage:          summary.ErrorMessage,
		StartedAt:             started,
		CompletedAt:           &completed,
		CreatedAt:             completed,
	}
	f.runs = append(f.runs, run)
	if f.integration.Status != "disconnected" {
		f.integration.SyncCursor = cursor
		f.integration.LastSyncAt = &completed
		f.integration.ErrorMessage = summary.ErrorMessage
		switch summary.Status {
		case "failed":
			f.integration.Status = "error"
		case "":
			if f.integration.Status != "paused" {
				f.integration.Status = "connected"
			}
		default:
			if f.integration.Status != "paused" {
				f.integration.Status = "connected"
			}
		}
	}
	return &run, nil
}
func (f *fakeStore) ListRuns(context.Context, string, string, int) ([]SyncRun, error) {
	return f.runs, nil
}
func (f *fakeStore) FindSubscriptionIntegrationByIngestToken(_ context.Context, provider, token string) (*Integration, error) {
	if f.integration.Provider == strings.TrimSpace(provider) &&
		settingString(f.integration.Settings, "subscription_ingest_token") == token && token != "" &&
		f.integration.Status != "disconnected" {
		return &f.integration, nil
	}
	return nil, ErrNotFound
}
func (f *fakeStore) ClaimSubscriptionWebhook(_ context.Context, _ string, _ string, provider, webhookID, _ string, _ []byte) (WebhookClaim, error) {
	if f.webhooks == nil {
		f.webhooks = map[string]WebhookClaim{}
	}
	key := provider + ":" + webhookID
	switch f.webhooks[key] {
	case WebhookProcessed:
		return WebhookProcessed, nil
	case WebhookInProgress:
		return WebhookInProgress, nil
	default:
		f.webhooks[key] = WebhookInProgress
		return WebhookClaimed, nil
	}
}
func (f *fakeStore) MarkSubscriptionWebhookProcessed(_ context.Context, _ string, provider, webhookID string) error {
	if f.webhooks == nil {
		f.webhooks = map[string]WebhookClaim{}
	}
	f.webhooks[provider+":"+webhookID] = WebhookProcessed
	return nil
}
func (f *fakeStore) MarkSubscriptionWebhookFailed(_ context.Context, _ string, provider, webhookID string, _ error) error {
	if f.webhooks == nil {
		f.webhooks = map[string]WebhookClaim{}
	}
	f.webhooks[provider+":"+webhookID] = ""
	return nil
}

type fakeProfileSink struct {
	subscriptions []SubscriptionInput
	shipments     []ShipmentInput
	err           error
}

func (f *fakeProfileSink) UpsertSubscription(_ context.Context, _ string, _ string, subscription SubscriptionInput) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.subscriptions = append(f.subscriptions, subscription)
	return "sub_1", nil
}

func (f *fakeProfileSink) UpsertShipment(_ context.Context, _ string, _ string, shipment ShipmentInput) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.shipments = append(f.shipments, shipment)
	return "sub_1", nil
}

type fakeEventSink struct {
	events []LifecycleEventInput
	err    error
}

func (f *fakeEventSink) TrackLifecycleEvent(_ context.Context, _ string, _ string, event LifecycleEventInput) (int64, error) {
	if f.err != nil {
		return 0, f.err
	}
	f.events = append(f.events, event)
	return int64(len(f.events)), nil
}

type fakeRechargeBackfiller struct {
	req         SyncRequest
	err         error
	called      bool
	cursor      string
	tenantID    string
	integration Integration
}

func (f *fakeRechargeBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	return f.req, nil
}

func subscriptionReq(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
}

func providerFieldByKey(fields []ProviderField, key string) (ProviderField, bool) {
	for _, field := range fields {
		if field.Key == key {
			return field, true
		}
	}
	return ProviderField{}, false
}

func hasString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func TestListProvidersIncludesSubscriptionAndShippingNatives(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{Repo: newFakeStore()}).ListProviders(rec, httptest.NewRequest(http.MethodGet, "/api/v1/subscription-integrations/providers", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Items []ProviderSpec `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, item := range res.Items {
		seen[item.Provider] = item.Managed
	}
	for _, provider := range []string{
		ProviderRecharge,
		ProviderSkio,
		ProviderAfterShip,
		ProviderShipStation,
		ProviderShippo,
		ProviderEasyship,
		ProviderShipBob,
		ProviderEasyPost,
		ProviderNarvar,
		ProviderRoute,
		ProviderMalomo,
		ProviderWonderment,
		ProviderBoldSubscriptions,
		ProviderOrdergroove,
		ProviderLoopSubscriptions,
		ProviderAppstle,
		ProviderSealSubscriptions,
		ProviderChargebee,
	} {
		if !seen[provider] {
			t.Fatalf("provider %q missing or unmanaged: %+v", provider, res.Items)
		}
	}
}

func TestProviderSpecsExposeIngestModelWithoutWebhookSecretClaims(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{Repo: newFakeStore()}).ListProviders(rec, httptest.NewRequest(http.MethodGet, "/api/v1/subscription-integrations/providers", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Items []ProviderSpec `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	seen := map[string]ProviderSpec{}
	for _, item := range res.Items {
		seen[item.Provider] = item
	}
	recharge, ok := seen[ProviderRecharge]
	if !ok {
		t.Fatalf("missing recharge in %+v", res.Items)
	}
	if recharge.SyncModel != rechargeSyncModelNative ||
		recharge.VerificationMode != "recharge_api_token_subscriptions_pull_hmac_webhook_ingest_pending_live_certification" {
		t.Fatalf("recharge should expose its native pull/webhook runtime: %+v", recharge)
	}
	if len(recharge.SyncObjects) != 3 || recharge.SyncObjects[0] != "subscriptions" || recharge.SyncObjects[1] != "charges" || recharge.SyncObjects[2] != "webhook_events" {
		t.Fatalf("recharge sync objects=%+v", recharge.SyncObjects)
	}
	if len(recharge.WebhookTopics) == 0 || !hasString(recharge.WebhookTopics, "subscription/updated") || !hasString(recharge.WebhookTopics, "charge/paid") {
		t.Fatalf("recharge webhook topics=%+v", recharge.WebhookTopics)
	}
	if _, ok := providerFieldByKey(recharge.OptionalSettings, "webhook_secret_ref"); !ok {
		t.Fatalf("recharge should advertise webhook_secret_ref for HMAC verification: %+v", recharge.OptionalSettings)
	}
	for _, provider := range []string{
		ProviderSkio,
		ProviderAfterShip,
		ProviderShipStation,
		ProviderChargebee,
		ProviderLoopSubscriptions,
		ProviderSealSubscriptions,
		ProviderAppstle,
		ProviderBoldSubscriptions,
	} {
		spec, ok := seen[provider]
		if !ok {
			t.Fatalf("missing provider %q in %+v", provider, res.Items)
		}
		if spec.SyncModel != nativeSubscriptionPullerSyncModel(provider) {
			t.Fatalf("%s sync model = %q, want %q", provider, spec.SyncModel, nativeSubscriptionPullerSyncModel(provider))
		}
		if !strings.Contains(spec.VerificationMode, "backfill") {
			t.Fatalf("%s should expose native backfill verification posture, got %+v", provider, spec)
		}
		if len(spec.WebhookTopics) != 0 {
			t.Fatalf("%s should not expose provider webhook topics until handlers exist: %+v", provider, spec.WebhookTopics)
		}
		if len(spec.SyncObjects) == 0 {
			t.Fatalf("%s should expose provider-native sync objects, got %+v", provider, spec.SyncObjects)
		}
		if _, ok := providerFieldByKey(spec.OptionalSettings, "webhook_secret_ref"); ok {
			t.Fatalf("%s should not advertise webhook secrets until raw-body verification is wired: %+v", provider, spec.OptionalSettings)
		}
	}
}

func TestCreateShippoIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations", `{
			"provider":"shippo",
			"settings":{
				"account_id":"shippo_123",
				"credentials_ref":"cred_shippo_1"
			}
		}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderShippo || store.lastInput.CredentialsRef != "cred_shippo_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["account_id"] != "shippo_123" ||
		store.lastInput.Settings["setup_surface"] != "subscription_integrations" ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
}

func TestCreateChargebeeIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations", `{
			"provider":"chargebee",
			"settings":{
				"site_id":"acme",
				"credentials_ref":"cred_chargebee_1"
			}
		}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderChargebee || store.lastInput.CredentialsRef != "cred_chargebee_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["site_id"] != "acme" ||
		store.lastInput.Settings["setup_surface"] != "subscription_integrations" ||
		store.lastInput.Settings["sync_model"] != chargebeeSyncModelNative ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
}

func TestCreateIntegrationRequiresCredentialRefAndRejectsRawToken(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations", `{
		"provider":"recharge",
		"settings":{"store_domain":"acme.myshopify.com","api_key":"secret"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("raw token status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations", `{
		"provider":"recharge",
		"settings":{"store_domain":"acme.myshopify.com","credentials_ref":"Bearer raw-provider-token"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("raw credential ref status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations", `{
		"provider":"recharge",
		"settings":{
			"store_domain":"acme.myshopify.com",
			"credentials_ref":"cred_recharge_1",
			"provider_cleanup":{"status":"spoofed","credential_ref":"vault://ignore"}
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderRecharge || store.lastInput.CredentialsRef != "cred_recharge_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if len(store.lastInput.Scopes) != 0 {
		t.Fatalf("api-token Recharge connection should not invent provider scopes: %+v", store.lastInput.Scopes)
	}
	if store.lastInput.Settings["api_key"] != nil || store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["provider_cleanup"] != nil || strings.Contains(rec.Body.String(), "provider_cleanup") {
		t.Fatalf("create should strip caller-supplied provider cleanup evidence: settings=%+v body=%s", store.lastInput.Settings, rec.Body.String())
	}
}

func TestCreateRechargeIntegrationKeepsWebhookSecretRef(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations", `{
		"provider":"recharge",
		"settings":{
			"store_domain":"acme.myshopify.com",
			"credentials_ref":"cred_recharge_1",
			"webhook_secret_ref":"cred_recharge_webhook_1",
			"signing_secret_ref":"cred_recharge_signing_1"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Settings["webhook_secret_ref"] != "cred_recharge_webhook_1" {
		t.Fatalf("recharge webhook_secret_ref should be persisted for HMAC verification: %+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["signing_secret_ref"] != nil {
		t.Fatalf("unrecognized signing_secret_ref should still be stripped: %+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["credentials_ref"] != "cred_recharge_1" {
		t.Fatalf("credential reference should remain, settings=%+v", store.lastInput.Settings)
	}
}

func TestCreateGenericSubscriptionIntegrationStripsUnverifiedWebhookCredentialRefs(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations", `{
		"provider":"chargebee",
		"settings":{
			"site_id":"acme",
			"credentials_ref":"cred_chargebee_1",
			"webhook_secret_ref":"cred_chargebee_webhook_1"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Settings["webhook_secret_ref"] != nil {
		t.Fatalf("generic subscription runtime should strip unverified webhook refs: %+v", store.lastInput.Settings)
	}
}

func TestDisconnectRechargeReturnsAndPersistsProviderCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings = map[string]any{
		"store_domain":                "acme.myshopify.com",
		"subscription_ingest_token":   "tok_recharge_1",
		"webhook_secret_ref":          "cred_recharge_webhook_1",
		"recharge_webhook_id":         "wh_123",
		"provider_cleanup":            map[string]any{"status": "stale"},
		"some_non_cleanup_setting":    "kept",
		"recharge_webhook_secret_ref": "ignored-second-choice",
	}
	deps := &Deps{
		Repo: store,
		Now:  func() time.Time { return time.Date(2026, 6, 29, 12, 34, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, subscriptionReq(http.MethodDelete, "/api/v1/subscription-integrations/subscription_1", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		OK              bool                      `json:"ok"`
		ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.OK ||
		out.ProviderCleanup.Provider != ProviderRecharge ||
		out.ProviderCleanup.RecordedAt != "2026-06-29T12:34:00Z" ||
		out.ProviderCleanup.PostwaveStatus != "disconnected" ||
		out.ProviderCleanup.ProviderScopeID != "acme.myshopify.com" ||
		out.ProviderCleanup.ProviderWebhookID != "wh_123" ||
		!out.ProviderCleanup.CredentialRefPresent ||
		!out.ProviderCleanup.WebhookSecretRefPresent ||
		!out.ProviderCleanup.TokenizedIngestTokenPresent ||
		out.ProviderCleanup.ManagedProviderCleanup {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	if !hasString(out.ProviderCleanup.PostwaveEffects, "tokenized Recharge webhook ingest no longer resolves this row") ||
		!hasString(out.ProviderCleanup.ProviderConsoleActions, "delete or disable the Moosewave Recharge webhook target or subscription if configured") {
		t.Fatalf("cleanup evidence should include local effects and provider actions: %+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if store.integration.Status != "disconnected" ||
		stored["provider"] != ProviderRecharge ||
		stored["provider_scope_id"] != "acme.myshopify.com" ||
		stored["provider_webhook_id"] != "wh_123" ||
		stored["managed_provider_cleanup"] != false ||
		store.integration.Settings["some_non_cleanup_setting"] != "kept" {
		t.Fatalf("stored cleanup/settings=%+v", store.integration.Settings)
	}
}

func TestDisconnectNativeSubscriptionProviderReturnsProviderCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderChargebee
	store.integration.Name = "Chargebee site"
	store.integration.Settings = map[string]any{"site_id": "acme", "provider_webhook_id": "wh_chargebee_1"}
	store.integration.CredentialsRef = "cred_chargebee_1"
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, subscriptionReq(http.MethodDelete, "/api/v1/subscription-integrations/subscription_1", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		OK              bool                      `json:"ok"`
		ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.OK ||
		out.ProviderCleanup.Provider != ProviderChargebee ||
		out.ProviderCleanup.ProviderScopeType != "chargebee_site" ||
		out.ProviderCleanup.ProviderScopeID != "acme" ||
		out.ProviderCleanup.ProviderWebhookID != "wh_chargebee_1" ||
		!out.ProviderCleanup.CredentialRefPresent ||
		out.ProviderCleanup.ManagedProviderCleanup {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	if !hasString(out.ProviderCleanup.ProviderConsoleActions, "revoke or rotate the Chargebee API token if it is no longer used") {
		t.Fatalf("provider actions should be Chargebee-specific: %+v", out.ProviderCleanup.ProviderConsoleActions)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok || stored["provider"] != ProviderChargebee || stored["provider_scope_id"] != "acme" {
		t.Fatalf("stored cleanup=%+v settings=%+v", stored, store.integration.Settings)
	}
}

func TestAcknowledgeProviderCleanupPersistsRechargeOperatorAttestation(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.Settings = map[string]any{
		"store_domain":              "acme.myshopify.com",
		"webhook_secret_ref":        "vault://subscription/recharge-webhook",
		"subscription_ingest_token": "tok_secret_should_not_leak",
		"provider_cleanup": map[string]any{
			"provider":                 ProviderRecharge,
			"status":                   "operator_action_required",
			"recorded_at":              "2026-06-29T13:00:00Z",
			"managed_provider_cleanup": false,
			"provider_scope_id":        "acme.myshopify.com",
		},
	}
	deps := &Deps{
		Repo: store,
		Now:  func() time.Time { return time.Date(2026, 6, 29, 14, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.AcknowledgeProviderCleanup(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/provider-cleanup/acknowledge", `{
		"completed_actions":["api_token_revoked_or_rotated","webhook_target_or_subscription_removed_or_disabled","api_token_revoked_or_rotated"],
		"notes":"Verified in Recharge console",
		"acknowledged_by":"ops@example.com"
	}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, "vault://") || strings.Contains(body, "tok_secret_should_not_leak") {
		t.Fatalf("ack response leaked secret-like settings: %s", body)
	}
	stored := store.integration.Settings["provider_cleanup"].(map[string]any)
	actions, ok := stored["completed_actions"].([]string)
	if !ok {
		t.Fatalf("completed actions type=%T value=%+v", stored["completed_actions"], stored["completed_actions"])
	}
	if stored["status"] != "operator_acknowledged" ||
		stored["acknowledged_at"] != "2026-06-29T14:00:00Z" ||
		stored["acknowledged_by"] != "ops@example.com" ||
		stored["operator_notes"] != "Verified in Recharge console" ||
		stored["managed_provider_cleanup"] != false ||
		stored["recorded_at"] != "2026-06-29T13:00:00Z" ||
		len(actions) != 2 ||
		actions[0] != "api_token_revoked_or_rotated" ||
		actions[1] != "webhook_target_or_subscription_removed_or_disabled" {
		t.Fatalf("stored provider cleanup=%+v", stored)
	}
	var out struct {
		OK              bool           `json:"ok"`
		ProviderCleanup map[string]any `json:"provider_cleanup"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.OK ||
		out.ProviderCleanup["status"] != "operator_acknowledged" ||
		out.ProviderCleanup["acknowledged_at"] != "2026-06-29T14:00:00Z" ||
		out.ProviderCleanup["managed_provider_cleanup"] != false {
		t.Fatalf("response=%+v", out)
	}
}

func TestAcknowledgeProviderCleanupRejectsConnectedRecharge(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderRecharge,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/provider-cleanup/acknowledge", `{"notes":"done"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "provider_cleanup_missing") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAcknowledgeProviderCleanupAllowsNonRechargeWithRecordedEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderChargebee
	store.integration.Status = "disconnected"
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderChargebee,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/provider-cleanup/acknowledge", `{"notes":"done"}`))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "operator_acknowledged") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	stored := store.integration.Settings["provider_cleanup"].(map[string]any)
	if stored["operator_notes"] != "done" || stored["status"] != "operator_acknowledged" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func TestAcknowledgeProviderCleanupRequiresRecordedEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/provider-cleanup/acknowledge", `{"notes":"done"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "provider_cleanup_missing") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAcknowledgeProviderCleanupRequiresAttestationEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderRecharge,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/provider-cleanup/acknowledge", `{}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "completed_actions or notes is required") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAcknowledgeProviderCleanupValidatesRechargeActionKeys(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderRecharge,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/provider-cleanup/acknowledge", `{
		"completed_actions":["revoked Recharge API token"]
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "unsupported subscription cleanup action key") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSyncIntegrationUpsertsSubscriptionsShipmentsAndEvents(t *testing.T) {
	store := newFakeStore()
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		Events:   events,
		Now:      func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/sync", `{
		"cursor":"after-123",
		"subscriptions":[{"source_id":"s1","email":"VIP@Example.com","subscription_id":"sub_123","status":"active","sku":"coffee"}],
		"shipments":[{"source_id":"sh1","email":"vip@example.com","order_id":"ord_123","tracking_number":"trk_123","status":"delivered"}],
		"events":[{"source_id":"e1","email":"vip@example.com","event_name":"subscription.renewal_upcoming","subscription_id":"sub_123"}]
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "completed" || out.SubscriptionsUpserted != 1 || out.ShipmentsUpserted != 1 || out.EventsTracked != 3 || out.RunID == "" {
		t.Fatalf("summary=%+v", out)
	}
	if len(profiles.subscriptions) != 1 || profiles.subscriptions[0].Email != "vip@example.com" {
		t.Fatalf("subscriptions=%+v", profiles.subscriptions)
	}
	if len(profiles.shipments) != 1 || profiles.shipments[0].TrackingNumber != "trk_123" {
		t.Fatalf("shipments=%+v", profiles.shipments)
	}
	if len(events.events) != 3 || events.events[2].EventName != "subscription.renewal_upcoming" {
		t.Fatalf("events=%+v", events.events)
	}
}

func TestSyncIntegrationRequiresCanonicalSubscriptionRows(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
		Events:   &fakeEventSink{},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/sync", `{"cursor":"after-123"}`))

	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "payload_required") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("empty subscription sync should not record a provider-pull-like run: %+v", store.runs)
	}
}

func TestSyncIntegrationUsesStoredRechargeCursorOnEmptyRequest(t *testing.T) {
	store := newFakeStore()
	store.integration.SyncCursor = rechargeCursorPrefix + "cur_1"
	backfiller := &fakeRechargeBackfiller{req: SyncRequest{
		RunMode: "backfill",
		Cursor:  rechargeCursorPrefix + "cur_2",
		Subscriptions: []SubscriptionInput{{
			SourceID:       "recharge://subscription/9001",
			Email:          "buyer@example.com",
			SubscriptionID: "9001",
			Status:         "active",
		}},
	}}
	deps := &Deps{
		Repo:               store,
		Profiles:           &fakeProfileSink{},
		Events:             &fakeEventSink{},
		RechargeBackfiller: backfiller,
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != rechargeCursorPrefix+"cur_1" {
		t.Fatalf("called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != rechargeCursorPrefix+"cur_2" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationSkipsRechargeRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := rechargeCursorPrefix + "cur_1"
	retryCursor := encodeRechargeRetryCursor(rechargeRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeRechargeBackfiller{}
	deps := &Deps{
		Repo:               store,
		RechargeBackfiller: backfiller,
		Now:                func() time.Time { return now },
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.called || len(store.runs) != 0 {
		t.Fatalf("called=%v runs=%+v", backfiller.called, store.runs)
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Cursor != retryCursor {
		t.Fatalf("cursor=%q want %q", out.Cursor, retryCursor)
	}
}

func TestSyncIntegrationResumesRechargeRetryCursorWhenDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := rechargeCursorPrefix + "cur_1"
	retryCursor := encodeRechargeRetryCursor(rechargeRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeRechargeBackfiller{req: SyncRequest{
		RunMode:       "backfill",
		Cursor:        rechargeCursorPrefix + "cur_2",
		Subscriptions: []SubscriptionInput{{SourceID: "recharge://subscription/9001", Email: "buyer@example.com", SubscriptionID: "9001", Status: "active"}},
	}}
	deps := &Deps{
		Repo:               store,
		Profiles:           &fakeProfileSink{},
		Events:             &fakeEventSink{},
		RechargeBackfiller: backfiller,
		Now:                func() time.Time { return now },
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != rechargeCursorPrefix+"cur_2" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationStoresRechargeRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := rechargeCursorPrefix + "cur_1"
	retryCursor := encodeRechargeRetryCursor(rechargeRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeRechargeBackfiller{err: RechargeRESTError{StatusCode: http.StatusTooManyRequests, RetryAfter: 2 * time.Minute, Snippet: "still throttled"}}
	deps := &Deps{
		Repo:               store,
		RechargeBackfiller: backfiller,
		Now:                func() time.Time { return now },
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/backfill", `{}`))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeRechargeRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, err, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 2 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationStoresRechargeRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := rechargeCursorPrefix + "cur_1"
	store := newFakeStore()
	store.integration.SyncCursor = cursor
	profiles := &fakeProfileSink{err: errors.New("profile sink unavailable")}
	backfiller := &fakeRechargeBackfiller{req: SyncRequest{
		Cursor:        rechargeCursorComplete,
		Subscriptions: []SubscriptionInput{{SourceID: "recharge://subscription/9001", Email: "buyer@example.com", SubscriptionID: "9001", Status: "active"}},
	}}
	deps := &Deps{
		Repo:               store,
		Profiles:           profiles,
		RechargeBackfiller: backfiller,
		Now:                func() time.Time { return now },
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" || store.runs[0].RunMode != "backfill" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeRechargeRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, err, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.ProviderCursor != "cur_1" || retry.Attempts != 1 || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(rechargeRetryInitialDelay).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationPreservesRechargeRetryAttemptsOnDueSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := rechargeCursorPrefix + "cur_1"
	retryCursor := encodeRechargeRetryCursor(rechargeRetryState{
		Cursor:        cursor,
		Attempts:      2,
		LastStatus:    "SYNC_FAILED",
		LastError:     "profile sink unavailable",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	profiles := &fakeProfileSink{err: errors.New("profile sink unavailable again")}
	backfiller := &fakeRechargeBackfiller{req: SyncRequest{
		Cursor:        rechargeCursorComplete,
		Subscriptions: []SubscriptionInput{{SourceID: "recharge://subscription/9001", Email: "buyer@example.com", SubscriptionID: "9001", Status: "active"}},
	}}
	deps := &Deps{
		Repo:               store,
		Profiles:           profiles,
		RechargeBackfiller: backfiller,
		Now:                func() time.Time { return now },
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" || store.runs[0].RunMode != "backfill" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeRechargeRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, err, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.ProviderCursor != "cur_1" || retry.Attempts != 3 || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(rechargeRetryInitialDelay*4).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationRejectsDisconnectedSubscriptionRows(t *testing.T) {
	for _, path := range []struct {
		name   string
		handle func(*Deps, http.ResponseWriter, *http.Request)
		url    string
	}{
		{name: "sync", handle: (*Deps).SyncIntegration, url: "/api/v1/subscription-integrations/subscription_1/sync"},
		{name: "backfill", handle: (*Deps).BackfillIntegration, url: "/api/v1/subscription-integrations/subscription_1/backfill"},
	} {
		t.Run(path.name, func(t *testing.T) {
			store := newFakeStore()
			store.integration.Status = "disconnected"
			backfiller := &fakeRechargeBackfiller{req: SyncRequest{Subscriptions: []SubscriptionInput{{SourceID: "recharge://subscription/9001", Email: "buyer@example.com"}}}}
			deps := &Deps{Repo: store, RechargeBackfiller: backfiller}
			rec := httptest.NewRecorder()

			path.handle(deps, rec, subscriptionReq(http.MethodPost, path.url, `{}`))

			if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if backfiller.called || len(store.runs) != 0 {
				t.Fatalf("called=%v runs=%+v", backfiller.called, store.runs)
			}
		})
	}
}

func TestIngestEventRecordsWebhookRun(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:   store,
		Events: &fakeEventSink{},
	}
	rec := httptest.NewRecorder()
	deps.IngestEvent(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/ingest", `{
		"source_id":"e1",
		"email":"vip@example.com",
		"event_name":"shipment.delivered",
		"tracking_number":"trk_123"
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].EventsTracked != 1 {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestIngestEventRejectsDisconnectedSubscriptionRows(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:   store,
		Events: events,
	}
	rec := httptest.NewRecorder()

	deps.IngestEvent(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/ingest", `{
		"source_id":"e1",
		"email":"vip@example.com",
		"event_name":"shipment.delivered"
	}`))

	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(events.events) != 0 || len(store.runs) != 0 {
		t.Fatalf("events=%+v runs=%+v", events.events, store.runs)
	}
}

func TestPauseRejectsDisconnectedSubscriptionRows(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	deps := &Deps{Repo: store}
	rec := httptest.NewRecorder()

	deps.PauseIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/pause", `{}`))

	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.paused || store.integration.Status != "disconnected" {
		t.Fatalf("paused=%v status=%q", store.paused, store.integration.Status)
	}
}

func TestBackfillForcesRunModeAndOversizedPayloadRejected(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:        store,
		Profiles:    &fakeProfileSink{},
		Events:      &fakeEventSink{},
		MaxSyncRows: 1,
	}

	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/backfill", `{
		"run_mode":"manual",
		"subscriptions":[{"email":"one@example.com"}]
	}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" {
		t.Fatalf("runs=%+v", store.runs)
	}

	rec = httptest.NewRecorder()
	deps.SyncIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/sync", `{
		"subscriptions":[{"email":"one@example.com"}],
		"shipments":[{"email":"two@example.com"}]
	}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected oversized rejection, got status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSyncMarksFailedWhenSinkFails(t *testing.T) {
	deps := &Deps{
		Repo:     newFakeStore(),
		Profiles: &fakeProfileSink{err: errors.New("boom")},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, subscriptionReq(http.MethodPost, "/api/v1/subscription-integrations/subscription_1/sync", `{
		"subscriptions":[{"email":"one@example.com"}]
	}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "failed" || out.RowsFailed != 1 {
		t.Fatalf("summary=%+v", out)
	}
}
