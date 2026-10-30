// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	lastInput    IntegrationInput
	paused       bool
	disconnected bool
	provisionErr error
	webhooks     map[string]WebhookClaim
	webhookHash  map[string]string
}

func newFakeStore() *fakeStore {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	return &fakeStore{integration: Integration{
		ID:             "loyalty_1",
		TenantID:       "tenant-1",
		Provider:       ProviderSmile,
		Name:           "Smile store",
		Status:         "connected",
		Scopes:         []string{"customers.read"},
		CredentialsRef: "cred_smile_1",
		Settings:       map[string]any{"shop_domain": "acme.myshopify.com"},
		CreatedAt:      now,
		UpdatedAt:      now,
	}, webhooks: map[string]WebhookClaim{}}
}

func (f *fakeStore) ListIntegrations(context.Context, string) ([]Integration, error) {
	return []Integration{f.integration}, nil
}
func (f *fakeStore) GetIntegration(context.Context, string, string) (*Integration, error) {
	return &f.integration, nil
}
func (f *fakeStore) UpsertIntegration(_ context.Context, tenantID string, in IntegrationInput) (*Integration, error) {
	f.lastInput = in
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
		ID:        "loyalty_ingest_1",
		TenantID:  tenantID,
		Provider:  in.Provider,
		Name:      name,
		Status:    "connected",
		Settings:  map[string]any{"loyalty_ingest_token": token, "ingest_mode": "webhook"},
		CreatedAt: now,
		UpdatedAt: now,
	}
	return &f.integration, nil
}
func (f *fakeStore) RotateIngestToken(_ context.Context, _ string, _ string, token string) (*Integration, error) {
	// Model the repo's WHERE guard: a disconnected or non-ingest row → no match
	// → ErrNotFound (404). (Wrong-id matching is exercised by the router test.)
	if f.integration.Status == "disconnected" ||
		settingString(f.integration.Settings, "loyalty_ingest_token") == "" {
		return nil, ErrNotFound
	}
	f.integration.Settings["loyalty_ingest_token"] = token
	return &f.integration, nil
}
func (f *fakeStore) PauseIntegration(context.Context, string, string) (*Integration, error) {
	f.paused = true
	f.integration.Status = "paused"
	return &f.integration, nil
}
func (f *fakeStore) DisconnectIntegration(context.Context, string, string) error {
	f.disconnected = true
	f.integration.Status = "disconnected"
	return nil
}
func (f *fakeStore) DisconnectIntegrationWithProviderCleanup(_ context.Context, _ string, _ string, cleanup *DisconnectCleanupEvidence) error {
	if err := f.DisconnectIntegration(context.Background(), "", ""); err != nil {
		return err
	}
	if cleanup != nil {
		if f.integration.Settings == nil {
			f.integration.Settings = map[string]any{}
		}
		raw, _ := json.Marshal(cleanup)
		var stored map[string]any
		_ = json.Unmarshal(raw, &stored)
		f.integration.Settings["provider_cleanup"] = stored
	}
	return nil
}
func (f *fakeStore) AcknowledgeProviderCleanup(_ context.Context, _ string, _ string, in ProviderCleanupAcknowledgementInput, acknowledgedAt time.Time) (*Integration, error) {
	if !loyaltyProviderCleanupEligible(f.integration.Provider) || f.integration.Status != "disconnected" {
		return nil, ErrProviderCleanupMissing
	}
	raw, ok := f.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok || raw == nil {
		return nil, ErrProviderCleanupMissing
	}
	raw["status"] = "operator_acknowledged"
	raw["acknowledged_at"] = acknowledgedAt.UTC().Format(time.RFC3339)
	raw["managed_provider_cleanup"] = false
	if in.AcknowledgedBy != "" {
		raw["acknowledged_by"] = in.AcknowledgedBy
	}
	if len(in.CompletedActions) > 0 {
		raw["completed_actions"] = append([]string(nil), in.CompletedActions...)
	}
	if in.Notes != "" {
		raw["operator_notes"] = in.Notes
	}
	return &f.integration, nil
}
func (f *fakeStore) RecordSyncRun(_ context.Context, _ string, _ string, summary SyncSummary, req SyncRequest, started, completed time.Time) (*SyncRun, error) {
	cursor := firstString(summary.Cursor, req.Cursor, f.integration.SyncCursor)
	run := SyncRun{
		ID:              "run_1",
		IntegrationID:   summary.IntegrationID,
		RunMode:         req.RunMode,
		Status:          summary.Status,
		CursorTo:        cursor,
		MembersSeen:     summary.MembersSeen,
		MembersUpserted: summary.MembersUpserted,
		EventsSeen:      summary.EventsSeen,
		EventsTracked:   summary.EventsTracked,
		RowsFailed:      summary.RowsFailed,
		ErrorMessage:    summary.ErrorMessage,
		StartedAt:       started,
		CompletedAt:     &completed,
		CreatedAt:       completed,
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
func (f *fakeStore) FindLoyaltyIntegrationByIngestToken(_ context.Context, provider, token string) (*Integration, error) {
	if f.integration.Provider == strings.TrimSpace(provider) &&
		settingString(f.integration.Settings, "loyalty_ingest_token") == token && token != "" &&
		f.integration.Status != "disconnected" {
		return &f.integration, nil
	}
	return nil, ErrNotFound
}
func (f *fakeStore) FindSmileIntegrationByAccountID(_ context.Context, accountID string) (*Integration, error) {
	if f.integration.Provider != ProviderSmile ||
		f.integration.Status == "disconnected" ||
		(settingString(f.integration.Settings, "account_id") != accountID &&
			settingString(f.integration.Settings, "smile_account_id") != accountID) {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}
func (f *fakeStore) ClaimLoyaltyWebhook(_ context.Context, _ string, integrationID, provider, webhookID, _ string, body []byte) (WebhookClaim, error) {
	if f.webhooks == nil {
		f.webhooks = map[string]WebhookClaim{}
	}
	if f.webhookHash == nil {
		f.webhookHash = map[string]string{}
	}
	key := loyaltyWebhookFakeKey(integrationID, provider, webhookID)
	sum := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(sum[:])
	if stored := f.webhookHash[key]; stored != "" && stored != bodyHash {
		return "", ErrLoyaltyWebhookBodyMismatch
	}
	switch f.webhooks[key] {
	case WebhookProcessed:
		return WebhookProcessed, nil
	case WebhookInProgress:
		return WebhookInProgress, nil
	default:
		f.webhooks[key] = WebhookInProgress
		f.webhookHash[key] = bodyHash
		return WebhookClaimed, nil
	}
}
func (f *fakeStore) MarkLoyaltyWebhookProcessed(_ context.Context, _ string, integrationID, provider, webhookID string) error {
	f.webhooks[loyaltyWebhookFakeKey(integrationID, provider, webhookID)] = WebhookProcessed
	return nil
}
func (f *fakeStore) MarkLoyaltyWebhookFailed(_ context.Context, _ string, integrationID, provider, webhookID string, _ error) error {
	f.webhooks[loyaltyWebhookFakeKey(integrationID, provider, webhookID)] = ""
	return nil
}

func loyaltyWebhookFakeKey(integrationID, provider, webhookID string) string {
	return integrationID + ":" + provider + ":" + webhookID
}

type fakeProfileSink struct {
	members []MemberInput
	err     error
}

func (f *fakeProfileSink) UpsertLoyaltyMember(_ context.Context, _ string, _ string, member MemberInput) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.members = append(f.members, member)
	return "sub_1", nil
}

type fakeEventSink struct {
	events []LoyaltyEventInput
	err    error
}

func (f *fakeEventSink) TrackLoyaltyEvent(_ context.Context, _ string, _ string, event LoyaltyEventInput) (int64, error) {
	if f.err != nil {
		return 0, f.err
	}
	f.events = append(f.events, event)
	return int64(len(f.events)), nil
}

type fakeLoyaltyBackfiller struct {
	req    SyncRequest
	err    error
	called bool
	cursor string
}

func (f *fakeLoyaltyBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.cursor = cursor
	return f.req, f.err
}

func loyaltyReq(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
}

func TestListProvidersIncludesLoyaltyNatives(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{Repo: newFakeStore()}).ListProviders(rec, httptest.NewRequest(http.MethodGet, "/api/v1/loyalty-integrations/providers", nil))

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
		if item.VerificationMode == "" {
			t.Fatalf("provider %q sync metadata = %q/%q", item.Provider, item.SyncModel, item.VerificationMode)
		}
		if item.Provider == ProviderSmile {
			if item.SyncModel != smileSyncModelNative || !strings.Contains(item.VerificationMode, "signed_app_webhooks") {
				t.Fatalf("Smile.io should expose native REST metadata, got %q/%q", item.SyncModel, item.VerificationMode)
			}
			if !containsString(item.Scopes, "customer:read") || !containsString(item.WebhookTopics, "customer/updated") {
				t.Fatalf("Smile.io should expose verified app webhook scopes/topics: %+v/%+v", item.Scopes, item.WebhookTopics)
			}
			if !containsString(item.SyncObjects, "points_transactions") || !containsString(item.SyncObjects, "loyalty_events") || !containsString(item.SyncObjects, "app_webhooks") {
				t.Fatalf("Smile.io should expose native points transaction event objects: %+v", item.SyncObjects)
			}
			if providerFieldByKey(item.OptionalSettings, "page_size").Key == "" ||
				providerFieldByKey(item.OptionalSettings, "webhook_secret_ref").Key == "" ||
				providerFieldByKey(item.OptionalSettings, "account_id").Key == "" {
				t.Fatalf("Smile.io optional fields should expose page_size, account_id, and webhook_secret_ref: %+v", item.OptionalSettings)
			}
			continue
		}
		if isNativeLoyaltyPullerProvider(item.Provider) {
			if item.SyncModel != nativeLoyaltyPullerSyncModel(item.Provider) {
				t.Fatalf("%s sync model = %q, want %q", item.Provider, item.SyncModel, nativeLoyaltyPullerSyncModel(item.Provider))
			}
			if !strings.Contains(item.VerificationMode, "backfill") {
				t.Fatalf("%s should expose native backfill verification posture, got %q", item.Provider, item.VerificationMode)
			}
			if item.Provider != ProviderReferralCandy && len(item.Scopes) == 0 {
				t.Fatalf("%s should advertise implemented read scopes: %+v", item.Provider, item.Scopes)
			}
			if len(item.WebhookTopics) != 0 {
				t.Fatalf("%s should not expose webhook topics before callback adapters are certified: %+v", item.Provider, item.WebhookTopics)
			}
			if providerFieldByKey(item.OptionalSettings, "webhook_secret_ref").Key != "" {
				t.Fatalf("%s should not expose webhook_secret_ref until raw-body verification is wired", item.Provider)
			}
			continue
		}
		if item.SyncModel != loyaltySyncModelIngest {
			t.Fatalf("provider %q sync metadata = %q/%q", item.Provider, item.SyncModel, item.VerificationMode)
		}
		if len(item.Scopes) != 0 || len(item.WebhookTopics) != 0 {
			t.Fatalf("provider %q should not expose unverified scopes/topics: %+v/%+v", item.Provider, item.Scopes, item.WebhookTopics)
		}
		if providerFieldByKey(item.OptionalSettings, "webhook_secret_ref").Key != "" {
			t.Fatalf("provider %q should not expose webhook_secret_ref until raw-body verification is wired", item.Provider)
		}
	}
	for _, provider := range []string{
		ProviderSmile,
		ProviderLoyaltyLion,
		ProviderRivo,
		ProviderReferralCandy,
		ProviderGrowave,
		ProviderMarsello,
		ProviderAntavo,
		ProviderFriendbuy,
		ProviderTalkable,
	} {
		if !seen[provider] {
			t.Fatalf("provider %q missing or unmanaged: %+v", provider, res.Items)
		}
	}
}

func TestCreateGrowaveIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations", `{
		"provider":"growave",
		"settings":{
			"shop_domain":"acme.myshopify.com",
			"credentials_ref":"cred_growave_1",
			"webhook_secret_ref":"cred_growave_webhook_1"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderGrowave || store.lastInput.CredentialsRef != "cred_growave_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["shop_domain"] != "acme.myshopify.com" ||
		store.lastInput.Settings["setup_surface"] != "loyalty_integrations" ||
		store.lastInput.Settings["webhook_secret_ref"] != nil ||
		store.lastInput.Settings["sync_model"] != loyaltySyncModelIngest ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if len(store.lastInput.Scopes) != 0 {
		t.Fatalf("scopes should be empty for loyalty ingest foundations: %+v", store.lastInput.Scopes)
	}
}

func TestCreateReferralCandyIntegrationUsesSignedCredentialShape(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations", `{
		"provider":"referralcandy",
		"settings":{
			"access_id":"acc_123",
			"credentials_ref":"cred_referralcandy_secret_1",
			"campaign_id":"camp_123"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderReferralCandy || store.lastInput.CredentialsRef != "cred_referralcandy_secret_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["access_id"] != "acc_123" ||
		store.lastInput.Settings["campaign_id"] != "camp_123" ||
		store.lastInput.Settings["sync_model"] != referralCandySyncModelNative ||
		store.lastInput.Settings["setup_surface"] != "loyalty_integrations" {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
}

func TestLoyaltyProviderMetadataUsesVendorSpecificAuth(t *testing.T) {
	referralCandy, ok := ProviderSpecByKey(ProviderReferralCandy)
	if !ok {
		t.Fatal("missing ReferralCandy provider spec")
	}
	if referralCandy.AuthMode != "api_signature_ref" ||
		referralCandy.SyncModel != referralCandySyncModelNative ||
		referralCandy.VerificationMode == "" ||
		len(referralCandy.Scopes) != 0 ||
		len(referralCandy.WebhookTopics) != 0 {
		t.Fatalf("ReferralCandy metadata = %+v", referralCandy)
	}
	if !providerFieldByKey(referralCandy.RequiredSettings, "access_id").Required ||
		providerFieldByKey(referralCandy.OptionalSettings, "campaign_id").Required {
		t.Fatalf("ReferralCandy field shape is not access-id-first: required=%+v optional=%+v", referralCandy.RequiredSettings, referralCandy.OptionalSettings)
	}

	loyaltyLion, ok := ProviderSpecByKey(ProviderLoyaltyLion)
	if !ok {
		t.Fatal("missing LoyaltyLion provider spec")
	}
	if loyaltyLion.AuthMode != "api_key_ref" ||
		loyaltyLion.SyncModel != loyaltyLionSyncModelNative ||
		len(loyaltyLion.Scopes) == 0 ||
		len(loyaltyLion.WebhookTopics) != 0 ||
		providerFieldByKey(loyaltyLion.OptionalSettings, "webhook_secret_ref").Key != "" {
		t.Fatalf("LoyaltyLion metadata = %+v", loyaltyLion)
	}
}

func TestCreateIntegrationRequiresCredentialRefAndRejectsRawToken(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations", `{
		"provider":"smile",
		"settings":{"shop_domain":"acme.myshopify.com","api_key":"secret"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("raw token status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations", `{
		"provider":"smile",
		"settings":{
			"shop_domain":"acme.myshopify.com",
			"credentials_ref":"cred_smile_1",
			"page_size":25,
			"webhook_secret_ref":"cred_webhook_should_strip"
		}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "account_id is required") {
		t.Fatalf("missing webhook account_id status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations", `{
		"provider":"smile",
		"settings":{
			"shop_domain":"acme.myshopify.com",
			"credentials_ref":"cred_smile_1",
			"account_id":"304169228",
			"page_size":25,
			"webhook_secret_ref":"cred_webhook_should_strip"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderSmile || store.lastInput.CredentialsRef != "cred_smile_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["api_key"] != nil ||
		store.lastInput.Settings["sync_model"] != smileSyncModelNative ||
		store.lastInput.Settings["verification_mode"] != "smile_api_token_customers_points_transactions_rewards_rest_signed_app_webhooks_pending_cleanup_live_certification" ||
		store.lastInput.Settings["account_id"] != "304169228" ||
		store.lastInput.Settings["webhook_secret_ref"] != "cred_webhook_should_strip" ||
		store.lastInput.Settings["page_size"] != float64(25) ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if !containsString(store.lastInput.Scopes, "customer:read") {
		t.Fatalf("Smile.io scopes should include app webhook/customer read scope: %+v", store.lastInput.Scopes)
	}
}

func providerFieldByKey(fields []ProviderField, key string) ProviderField {
	for _, field := range fields {
		if field.Key == key {
			return field
		}
	}
	return ProviderField{}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func TestSyncIntegrationUpsertsMembersAndEvents(t *testing.T) {
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
	deps.SyncIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/sync", `{
		"cursor":"after-123",
		"members":[{"source_id":"m1","email":"VIP@Example.com","points_balance":1200,"vip_tier":"Gold"}],
		"events":[{"source_id":"e1","email":"vip@example.com","event_name":"loyalty.points_earned","points":50}]
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "completed" || out.MembersUpserted != 1 || out.EventsTracked != 1 || out.RunID == "" {
		t.Fatalf("summary=%+v", out)
	}
	if len(profiles.members) != 1 || profiles.members[0].Email != "vip@example.com" {
		t.Fatalf("members=%+v", profiles.members)
	}
	if len(events.events) != 1 || events.events[0].EventName != "loyalty.points_earned" {
		t.Fatalf("events=%+v", events.events)
	}
}

func TestSyncIntegrationRequiresCanonicalMembersOrEvents(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/sync", `{"cursor":"after-123"}`))

	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "payload_required") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("empty loyalty sync should not record a provider-pull-like run: %+v", store.runs)
	}
}

func TestSyncIntegrationPullsSmileProviderOnEmptyRequest(t *testing.T) {
	store := newFakeStore()
	backfiller := &fakeLoyaltyBackfiller{req: SyncRequest{
		RunMode: "backfill",
		Cursor:  "smile:2",
		Members: []MemberInput{{
			SourceID:      "smile://customer/42",
			Email:         "vip@example.com",
			PointsBalance: 500,
			VIPTier:       "Gold",
		}},
	}}
	deps := &Deps{
		Repo:            store,
		Profiles:        &fakeProfileSink{},
		Events:          &fakeEventSink{},
		SmileBackfiller: backfiller,
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/sync", `{"cursor":"smile:1"}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !backfiller.called || backfiller.cursor != "smile:1" {
		t.Fatalf("provider pull not called with cursor: called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if out.Status != "completed" || out.MembersUpserted != 1 || out.EventsTracked != 0 || out.Cursor != "smile:2" {
		t.Fatalf("summary=%+v", out)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != "smile:2" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationUsesStoredSmileCursorOnEmptyRequest(t *testing.T) {
	store := newFakeStore()
	store.integration.SyncCursor = smileCursorPrefix + "1"
	backfiller := &fakeLoyaltyBackfiller{req: SyncRequest{
		RunMode: "backfill",
		Cursor:  smileCursorPrefix + "2",
		Members: []MemberInput{{
			SourceID:      "smile://customer/42",
			Email:         "vip@example.com",
			PointsBalance: 500,
			VIPTier:       "Gold",
		}},
	}}
	deps := &Deps{
		Repo:            store,
		Profiles:        &fakeProfileSink{},
		Events:          &fakeEventSink{},
		SmileBackfiller: backfiller,
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != smileCursorPrefix+"1" {
		t.Fatalf("called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != smileCursorPrefix+"2" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationSkipsSmileRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := smileCursorPrefix + "1"
	retryCursor := encodeSmileRetryCursor(smileRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeLoyaltyBackfiller{}
	deps := &Deps{
		Repo:            store,
		SmileBackfiller: backfiller,
		Now:             func() time.Time { return now },
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/backfill", `{}`))

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

func TestSyncIntegrationResumesSmileRetryCursorWhenDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := smileCursorPrefix + "1"
	retryCursor := encodeSmileRetryCursor(smileRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeLoyaltyBackfiller{req: SyncRequest{
		RunMode: "backfill",
		Cursor:  smileCursorPrefix + "2",
		Members: []MemberInput{{SourceID: "smile://customer/42", Email: "vip@example.com", PointsBalance: 500}},
	}}
	deps := &Deps{
		Repo:            store,
		Profiles:        &fakeProfileSink{},
		Events:          &fakeEventSink{},
		SmileBackfiller: backfiller,
		Now:             func() time.Time { return now },
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != smileCursorPrefix+"2" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationStoresSmileRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := smileCursorPrefix + "1"
	retryCursor := encodeSmileRetryCursor(smileRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeLoyaltyBackfiller{err: LoyaltyRESTError{StatusCode: http.StatusTooManyRequests, RetryAfter: 2 * time.Minute, Snippet: "still throttled"}}
	deps := &Deps{
		Repo:            store,
		SmileBackfiller: backfiller,
		Now:             func() time.Time { return now },
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/backfill", `{}`))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeSmileRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, err, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 2 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationStoresSmileRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := smileCursorPrefix + "1"
	store := newFakeStore()
	store.integration.SyncCursor = cursor
	backfiller := &fakeLoyaltyBackfiller{req: SyncRequest{
		RunMode: "backfill",
		Cursor:  smileCursorPrefix + "2",
		Members: []MemberInput{{SourceID: "smile://customer/42", Email: "vip@example.com", PointsBalance: 500}},
	}}
	deps := &Deps{
		Repo:            store,
		Profiles:        &fakeProfileSink{err: errors.New("profile sink unavailable")},
		SmileBackfiller: backfiller,
		Now:             func() time.Time { return now },
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "failed" || out.Cursor == smileCursorPrefix+"2" {
		t.Fatalf("summary=%+v", out)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeSmileRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, err, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 1 || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(15*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationPreservesSmileRetryAttemptsOnDueSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := smileCursorPrefix + "1"
	retryCursor := encodeSmileRetryCursor(smileRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "SYNC_FAILED",
		LastError:     "profile sink unavailable",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeLoyaltyBackfiller{req: SyncRequest{
		RunMode: "backfill",
		Cursor:  smileCursorPrefix + "2",
		Members: []MemberInput{{SourceID: "smile://customer/42", Email: "vip@example.com", PointsBalance: 500}},
	}}
	deps := &Deps{
		Repo:            store,
		Profiles:        &fakeProfileSink{err: errors.New("profile sink still unavailable")},
		SmileBackfiller: backfiller,
		Now:             func() time.Time { return now },
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeSmileRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, err, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 2 || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(30*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationRejectsDisconnectedLoyaltyRows(t *testing.T) {
	for _, path := range []struct {
		name   string
		handle func(*Deps, http.ResponseWriter, *http.Request)
		url    string
	}{
		{name: "sync", handle: (*Deps).SyncIntegration, url: "/api/v1/loyalty-integrations/loyalty_1/sync"},
		{name: "backfill", handle: (*Deps).BackfillIntegration, url: "/api/v1/loyalty-integrations/loyalty_1/backfill"},
	} {
		t.Run(path.name, func(t *testing.T) {
			store := newFakeStore()
			store.integration.Status = "disconnected"
			backfiller := &fakeLoyaltyBackfiller{req: SyncRequest{Members: []MemberInput{{SourceID: "smile://customer/42", Email: "vip@example.com"}}}}
			deps := &Deps{Repo: store, SmileBackfiller: backfiller}
			rec := httptest.NewRecorder()

			path.handle(deps, rec, loyaltyReq(http.MethodPost, path.url, `{}`))

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
	deps.IngestEvent(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/ingest", `{
		"source_id":"e1",
		"email":"vip@example.com",
		"event_name":"loyalty.reward_redeemed",
		"reward_name":"Free shipping"
	}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestIngestEventRejectsDisconnectedLoyaltyRows(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:   store,
		Events: events,
	}
	rec := httptest.NewRecorder()

	deps.IngestEvent(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/ingest", `{
		"source_id":"e1",
		"email":"vip@example.com",
		"event_name":"loyalty.reward_redeemed"
	}`))

	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(events.events) != 0 || len(store.runs) != 0 {
		t.Fatalf("events=%+v runs=%+v", events.events, store.runs)
	}
}

func TestPauseRejectsDisconnectedLoyaltyRows(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	deps := &Deps{Repo: store}
	rec := httptest.NewRecorder()

	deps.PauseIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/pause", `{}`))

	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.paused || store.integration.Status != "disconnected" {
		t.Fatalf("paused=%v status=%q", store.paused, store.integration.Status)
	}
}

func TestBackfillIntegrationRecordsBackfillRunMode(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/backfill", `{
		"members":[{"source_id":"m1","email":"vip@example.com"}]
	}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationRecordsPartialFailure(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{err: errors.New("boom")},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/sync", `{
		"members":[{"source_id":"m1","email":"vip@example.com"}]
	}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "failed" || out.RowsFailed != 1 || !strings.Contains(out.ErrorMessage, "boom") {
		t.Fatalf("summary=%+v", out)
	}
}

func TestPauseAndDisconnect(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings["account_id"] = "304169228"
	store.integration.Settings["webhook_secret_ref"] = "vault://integrations/smile/app-client-secret"
	deps := &Deps{
		Repo: store,
		Now:  func() time.Time { return time.Date(2026, 6, 29, 10, 30, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.PauseIntegration(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/pause", `{}`))
	if rec.Code != http.StatusOK || !store.paused {
		t.Fatalf("pause status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.DisconnectIntegration(rec, loyaltyReq(http.MethodDelete, "/api/v1/loyalty-integrations/loyalty_1", ""))
	if rec.Code != http.StatusOK || !store.disconnected || store.integration.Status != "disconnected" {
		t.Fatalf("delete status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		OK              bool                      `json:"ok"`
		ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.OK {
		t.Fatalf("disconnect response ok=false: %+v", out)
	}
	if out.ProviderCleanup.Provider != ProviderSmile ||
		out.ProviderCleanup.Status != "operator_action_required" ||
		out.ProviderCleanup.RecordedAt != "2026-06-29T10:30:00Z" ||
		out.ProviderCleanup.ProviderCleanupPosture != "operator_managed_provider_console" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.AccountID != "304169228" ||
		!out.ProviderCleanup.WebhookSecretRefPresent ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_cleanup_required" ||
		out.ProviderCleanup.CredentialCleanupStatus != "operator_revoke_or_rotate_if_no_longer_used" {
		t.Fatalf("provider cleanup evidence=%+v", out.ProviderCleanup)
	}
	if !containsString(out.ProviderCleanup.PostwaveEffects, "account_id-routed Smile app webhooks no longer resolve this row") {
		t.Fatalf("postwave effects=%+v", out.ProviderCleanup.PostwaveEffects)
	}
	if !containsString(out.ProviderCleanup.ProviderConsoleActions, "remove or disable the Moosewave Smile app webhook target/authorization for this account when app webhooks were enabled") {
		t.Fatalf("provider actions=%+v", out.ProviderCleanup.ProviderConsoleActions)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted in settings: %+v", store.integration.Settings)
	}
	if stored["provider"] != ProviderSmile ||
		stored["status"] != "operator_action_required" ||
		stored["recorded_at"] != "2026-06-29T10:30:00Z" ||
		stored["managed_provider_cleanup"] != false ||
		stored["account_id"] != "304169228" ||
		stored["webhook_cleanup_status"] != "operator_cleanup_required" {
		t.Fatalf("stored provider cleanup=%+v", stored)
	}
}

func TestDisconnectNativeLoyaltyPullerReturnsProviderCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderLoyaltyLion
	store.integration.Settings = map[string]any{
		"site_id":            "site-1",
		"webhook_secret_ref": "vault://loyalty/loyaltylion-webhook",
		"api_secret":         "do-not-copy",
	}
	deps := &Deps{
		Repo: store,
		Now:  func() time.Time { return time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, loyaltyReq(http.MethodDelete, "/api/v1/loyalty-integrations/loyalty_1", ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, "vault://") || strings.Contains(body, "do-not-copy") {
		t.Fatalf("disconnect response leaked secret-like settings: %s", body)
	}
	var out struct {
		OK              bool                      `json:"ok"`
		ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err)
	}
	cleanup := out.ProviderCleanup
	if !out.OK ||
		cleanup.Provider != ProviderLoyaltyLion ||
		cleanup.RecordedAt != "2026-06-29T12:00:00Z" ||
		cleanup.AccountID != "site-1" ||
		!cleanup.WebhookSecretRefPresent ||
		cleanup.ManagedProviderCleanup ||
		cleanup.WebhookCleanupStatus != "operator_cleanup_required" {
		t.Fatalf("cleanup=%+v", cleanup)
	}
	if !containsString(cleanup.PostwaveEffects, "scheduled LoyaltyLion REST pulls exclude disconnected rows") ||
		!containsString(cleanup.ProviderConsoleActions, "revoke or rotate the LoyaltyLion API credentials if they are no longer used") {
		t.Fatalf("cleanup should disclose LoyaltyLion local stop and operator actions: %+v", cleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok || stored["provider"] != ProviderLoyaltyLion || stored["account_id"] != "site-1" {
		t.Fatalf("stored provider cleanup=%+v", store.integration.Settings["provider_cleanup"])
	}
}

func TestAcknowledgeProviderCleanupPersistsSmileOperatorAttestation(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider":                 ProviderSmile,
		"status":                   "operator_action_required",
		"recorded_at":              "2026-06-29T10:30:00Z",
		"managed_provider_cleanup": false,
		"account_id":               "304169228",
	}
	deps := &Deps{
		Repo: store,
		Now:  func() time.Time { return time.Date(2026, 6, 29, 11, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.AcknowledgeProviderCleanup(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/provider-cleanup/acknowledge", `{
		"completed_actions":["api_token_revoked_or_rotated","app_webhook_target_removed_or_disabled","api_token_revoked_or_rotated"],
		"notes":"Verified in Smile console",
		"acknowledged_by":"ops@example.com"
	}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	stored := store.integration.Settings["provider_cleanup"].(map[string]any)
	actions, ok := stored["completed_actions"].([]string)
	if !ok {
		t.Fatalf("completed actions type=%T value=%+v", stored["completed_actions"], stored["completed_actions"])
	}
	if stored["status"] != "operator_acknowledged" ||
		stored["acknowledged_at"] != "2026-06-29T11:00:00Z" ||
		stored["acknowledged_by"] != "ops@example.com" ||
		stored["operator_notes"] != "Verified in Smile console" ||
		stored["managed_provider_cleanup"] != false ||
		stored["recorded_at"] != "2026-06-29T10:30:00Z" ||
		len(actions) != 2 ||
		actions[0] != "api_token_revoked_or_rotated" ||
		actions[1] != "app_webhook_target_removed_or_disabled" {
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
		out.ProviderCleanup["acknowledged_at"] != "2026-06-29T11:00:00Z" ||
		out.ProviderCleanup["managed_provider_cleanup"] != false {
		t.Fatalf("response=%+v", out)
	}
}

func TestAcknowledgeProviderCleanupRejectsConnectedSmile(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderSmile,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/provider-cleanup/acknowledge", `{"notes":"done"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "provider_cleanup_missing") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAcknowledgeProviderCleanupAcceptsNativeLoyaltyPuller(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderLoyaltyLion
	store.integration.Status = "disconnected"
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderLoyaltyLion,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{
		Repo: store,
		Now:  func() time.Time { return time.Date(2026, 6, 29, 12, 30, 0, 0, time.UTC) },
	}).AcknowledgeProviderCleanup(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/provider-cleanup/acknowledge", `{
		"completed_actions":["provider_api_credentials_rotated","provider_webhook_target_or_subscription_removed"],
		"notes":"Verified in LoyaltyLion console"
	}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	stored := store.integration.Settings["provider_cleanup"].(map[string]any)
	if stored["status"] != "operator_acknowledged" ||
		stored["acknowledged_at"] != "2026-06-29T12:30:00Z" ||
		stored["operator_notes"] != "Verified in LoyaltyLion console" ||
		stored["managed_provider_cleanup"] != false {
		t.Fatalf("stored provider cleanup=%+v", stored)
	}
}

func TestAcknowledgeProviderCleanupRequiresRecordedEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/provider-cleanup/acknowledge", `{"notes":"done"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "provider_cleanup_missing") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAcknowledgeProviderCleanupRequiresAttestationEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderSmile,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/provider-cleanup/acknowledge", `{}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "completed_actions or notes is required") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAcknowledgeProviderCleanupValidatesActionKeys(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderSmile,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, loyaltyReq(http.MethodPost, "/api/v1/loyalty-integrations/loyalty_1/provider-cleanup/acknowledge", `{
		"completed_actions":["revoked Smile API token"]
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "unsupported loyalty cleanup action key") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}
