// SPDX-License-Identifier: AGPL-3.0-only
package marketing_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeStore struct {
	integration       Integration
	runs              []SyncRun
	lastInput         IntegrationInput
	paused            bool
	disconnected      bool
	upsertErr         error
	oauthStates       map[string]KlaviyoOAuthState
	lastOAuthState    KlaviyoOAuthState
	credentialSecrets map[string]string
	deletedRefs       []string
}

func newFakeStore() *fakeStore {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	return &fakeStore{integration: Integration{
		ID:             "marketing_1",
		TenantID:       "tenant-1",
		Provider:       ProviderKlaviyo,
		Name:           "Klaviyo",
		Status:         "connected",
		Scopes:         []string{"profiles:read"},
		CredentialsRef: "cred_klaviyo_1",
		Settings:       map[string]any{"account_id": "acct_123"},
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
	if f.upsertErr != nil {
		return nil, f.upsertErr
	}
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
		raw, _ := json.Marshal(cleanup)
		stored := map[string]any{}
		_ = json.Unmarshal(raw, &stored)
		f.integration.Settings["provider_cleanup"] = stored
	}
	return nil
}
func (f *fakeStore) AcknowledgeProviderCleanup(_ context.Context, _ string, _ string, in ProviderCleanupAcknowledgementInput, acknowledgedAt time.Time) (*Integration, error) {
	if f.integration.Provider != ProviderKlaviyo || f.integration.Status != "disconnected" || f.integration.Settings["provider_cleanup"] == nil {
		return nil, ErrProviderCleanupMissing
	}
	cleanup, _ := f.integration.Settings["provider_cleanup"].(map[string]any)
	if cleanup == nil {
		cleanup = map[string]any{}
	}
	cleanup["status"] = "operator_acknowledged"
	cleanup["acknowledged_at"] = acknowledgedAt.UTC().Format(time.RFC3339)
	if strings.TrimSpace(in.AcknowledgedBy) != "" {
		cleanup["acknowledged_by"] = strings.TrimSpace(in.AcknowledgedBy)
	}
	if len(in.CompletedActions) > 0 {
		cleanup["completed_actions"] = append([]string(nil), in.CompletedActions...)
	}
	if strings.TrimSpace(in.Notes) != "" {
		cleanup["operator_notes"] = strings.TrimSpace(in.Notes)
	}
	f.integration.Settings["provider_cleanup"] = cleanup
	return &f.integration, nil
}
func (f *fakeStore) RecordSyncRun(_ context.Context, _ string, _ string, summary SyncSummary, req SyncRequest, started, completed time.Time) (*SyncRun, error) {
	run := SyncRun{
		ID:            "run_1",
		IntegrationID: summary.IntegrationID,
		RunMode:       req.RunMode,
		Status:        summary.Status,
		CursorTo:      summary.Cursor,
		ProfilesSeen:  summary.ProfilesSeen,
		EventsSeen:    summary.EventsSeen,
		ListsSeen:     summary.ListsSeen,
		RowsFailed:    summary.RowsFailed,
		ErrorMessage:  summary.ErrorMessage,
		Metadata:      summary.Metadata,
		StartedAt:     started,
		CompletedAt:   &completed,
		CreatedAt:     completed,
	}
	f.runs = append(f.runs, run)
	f.integration.SyncCursor = firstString(summary.Cursor, req.Cursor, f.integration.SyncCursor)
	f.integration.LastSyncAt = &completed
	f.integration.ErrorMessage = summary.ErrorMessage
	return &run, nil
}
func (f *fakeStore) ListRuns(context.Context, string, string, int) ([]SyncRun, error) {
	return f.runs, nil
}
func (f *fakeStore) CreateKlaviyoOAuthState(_ context.Context, state KlaviyoOAuthState) (string, error) {
	if f.oauthStates == nil {
		f.oauthStates = map[string]KlaviyoOAuthState{}
	}
	f.lastOAuthState = state
	token := "state_test"
	f.oauthStates[token] = state
	return token, nil
}
func (f *fakeStore) ConsumeKlaviyoOAuthState(_ context.Context, token string) (KlaviyoOAuthState, error) {
	state, ok := f.oauthStates[token]
	if !ok {
		return KlaviyoOAuthState{}, ErrNotFound
	}
	delete(f.oauthStates, token)
	return state, nil
}
func (f *fakeStore) GetKlaviyoCredentialSecret(_ context.Context, _ string, ref string) (string, error) {
	if f.credentialSecrets == nil {
		return "", ErrNotFound
	}
	raw, ok := f.credentialSecrets[ref]
	if !ok {
		return "", ErrNotFound
	}
	return raw, nil
}
func (f *fakeStore) PutKlaviyoCredentialSecret(_ context.Context, _ string, ref string, creds KlaviyoCredentials) error {
	if f.credentialSecrets == nil {
		f.credentialSecrets = map[string]string{}
	}
	f.credentialSecrets[ref] = klaviyoStoredCredentialJSON(creds)
	return nil
}
func (f *fakeStore) DeleteKlaviyoCredentialSecret(_ context.Context, _ string, ref string) error {
	f.deletedRefs = append(f.deletedRefs, ref)
	delete(f.credentialSecrets, ref)
	return nil
}

func marketingReq(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
}

func TestKlaviyoOAuthAvailabilityUsesPublicBaseURL(t *testing.T) {
	deps := &Deps{
		Repo:          newFakeStore(),
		PublicBaseURL: "https://api.postwave.test",
		KlaviyoOAuth: KlaviyoOAuthConfig{
			ClientID:     "client_1",
			ClientSecret: "secret_1",
		},
	}
	rec := httptestRecorder()
	deps.KlaviyoOAuthAvailability(rec, marketingReq(http.MethodGet, "/api/v1/marketing-integrations/klaviyo/oauth/availability", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["available"] != true || body["callback_url"] != "https://api.postwave.test/api/v1/marketing-integrations/klaviyo/oauth/callback" || body["pkce"] != true {
		t.Fatalf("body=%+v", body)
	}
}

func TestKlaviyoOAuthStartStoresPKCEStateAndRedirects(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo: store,
		KlaviyoOAuth: KlaviyoOAuthConfig{
			ClientID:     "client_1",
			ClientSecret: "secret_1",
			RedirectURL:  "https://api.postwave.test/api/v1/marketing-integrations/klaviyo/oauth/callback",
			Scopes:       []string{"profiles:read", "profiles:write"},
		},
		Now: func() time.Time { return time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC) },
	}
	rec := httptestRecorder()
	deps.KlaviyoOAuthStart(rec, marketingReq(http.MethodGet, "/api/v1/marketing-integrations/klaviyo/oauth/start?name=Klaviyo+EU&redirect_to=https://app.postwave.test/integrations&klaviyo_webhook_topics=profile.created", ""))
	if rec.Code != http.StatusFound {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	location := rec.Header().Get("Location")
	u, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if u.Scheme != "https" || u.Host != "www.klaviyo.com" || u.Path != "/oauth/authorize" {
		t.Fatalf("location=%s", location)
	}
	if q.Get("response_type") != "code" || q.Get("client_id") != "client_1" || q.Get("state") != "state_test" || q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" {
		t.Fatalf("query=%v", q)
	}
	if store.lastOAuthState.IntegrationName != "Klaviyo EU" || store.lastOAuthState.CodeVerifier == "" || store.lastOAuthState.Settings["klaviyo_webhook_topics"] != "profile.created" {
		t.Fatalf("state=%+v", store.lastOAuthState)
	}
}

func TestKlaviyoOAuthCallbackStoresManagedCredential(t *testing.T) {
	store := newFakeStore()
	store.oauthStates = map[string]KlaviyoOAuthState{
		"state_test": {
			TenantID:        "tenant-1",
			IntegrationName: "Klaviyo OAuth",
			RedirectURI:     "https://api.postwave.test/api/v1/marketing-integrations/klaviyo/oauth/callback",
			CodeVerifier:    "verifier_1",
			Scopes:          []string{"profiles:read", "profiles:write"},
			Settings:        map[string]any{"account_id": "acct_1"},
			ExpiresAt:       time.Now().Add(time.Minute),
		},
	}
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/oauth/token" {
			t.Fatalf("path=%s", r.URL.Path)
		}
		user, pass, ok := r.BasicAuth()
		if !ok || user != "client_1" || pass != "secret_1" {
			t.Fatalf("basic auth %q/%q ok=%v", user, pass, ok)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Form.Get("grant_type") != "authorization_code" || r.Form.Get("code") != "code_1" || r.Form.Get("code_verifier") != "verifier_1" {
			t.Fatalf("form=%v", r.Form)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"oauth_access","refresh_token":"oauth_refresh","token_type":"Bearer","expires_in":3600,"scope":"profiles:read profiles:write"}`))
	}))
	defer tokenServer.Close()

	deps := &Deps{
		Repo: store,
		KlaviyoOAuth: KlaviyoOAuthConfig{
			ClientID:     "client_1",
			ClientSecret: "secret_1",
			RedirectURL:  "https://api.postwave.test/api/v1/marketing-integrations/klaviyo/oauth/callback",
			OAuthBaseURL: tokenServer.URL,
		},
		KlaviyoOAuthClient: KlaviyoOAuthClient{OAuthBaseURL: tokenServer.URL},
		Now:                func() time.Time { return time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC) },
	}
	rec := httptestRecorder()
	deps.KlaviyoOAuthCallback(rec, httptest.NewRequest(http.MethodGet, "/api/v1/marketing-integrations/klaviyo/oauth/callback?state=state_test&code=code_1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.HasPrefix(store.lastInput.CredentialsRef, klaviyoStoredCredentialPrefix) {
		t.Fatalf("credentials_ref=%q", store.lastInput.CredentialsRef)
	}
	if store.lastInput.Settings["klaviyo_oauth_managed_by_postwave"] != true || store.lastInput.Settings["klaviyo_auth_mode"] != "oauth_public_app" {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	creds, err := parseKlaviyoCredentialSecret(store.credentialSecrets[store.lastInput.CredentialsRef])
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "oauth_access" || creds.RefreshToken != "oauth_refresh" || creds.ClientID != "client_1" || creds.AccountID != "acct_1" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestKlaviyoOAuthDisconnectRevokesAndDeletesManagedCredential(t *testing.T) {
	store := newFakeStore()
	ref := klaviyoStoredCredentialPrefix + "stored"
	store.integration.CredentialsRef = ref
	store.credentialSecrets = map[string]string{
		ref: klaviyoStoredCredentialJSON(KlaviyoCredentials{
			AccessToken:  "oauth_access",
			RefreshToken: "oauth_refresh",
			ClientID:     "client_1",
			ClientSecret: "secret_1",
		}),
	}
	revoked := []string{}
	revokeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/oauth/revoke" {
			t.Fatalf("path=%s", r.URL.Path)
		}
		user, pass, ok := r.BasicAuth()
		if !ok || user != "client_1" || pass != "secret_1" {
			t.Fatalf("basic auth %q/%q ok=%v", user, pass, ok)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		revoked = append(revoked, r.Form.Get("token"))
		w.WriteHeader(http.StatusOK)
	}))
	defer revokeServer.Close()

	deps := &Deps{
		Repo:               store,
		KlaviyoOAuthClient: KlaviyoOAuthClient{OAuthBaseURL: revokeServer.URL},
		KlaviyoOAuth:       KlaviyoOAuthConfig{OAuthBaseURL: revokeServer.URL},
		KlaviyoCredentials: &KlaviyoSecretsCredentialResolver{Store: store},
		Now:                func() time.Time { return time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC) },
	}
	rec := httptestRecorder()
	deps.DisconnectIntegration(rec, marketingReq(http.MethodDelete, "/api/v1/marketing-integrations/marketing_1", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Join(revoked, ",") != "oauth_access,oauth_refresh" {
		t.Fatalf("revoked=%v", revoked)
	}
	if len(store.deletedRefs) != 1 || store.deletedRefs[0] != ref {
		t.Fatalf("deleted=%v", store.deletedRefs)
	}
	cleanup, _ := store.integration.Settings["provider_cleanup"].(map[string]any)
	if cleanup["credential_cleanup_status"] != "postwave_managed_klaviyo_oauth_revoked" {
		t.Fatalf("cleanup=%+v", cleanup)
	}
}

func providerFieldPresent(fields []ProviderField, key string) bool {
	for _, field := range fields {
		if field.Key == key {
			return true
		}
	}
	return false
}

func providerFieldByKey(fields []ProviderField, key string) (ProviderField, bool) {
	for _, field := range fields {
		if field.Key == key {
			return field, true
		}
	}
	return ProviderField{}, false
}

func providerStringPresent(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

type fakeKlaviyoWebhookRegistrar struct {
	reconcileSummary KlaviyoWebhookReconcileSummary
	cleanupSummary   KlaviyoWebhookCleanupSummary
	reconcileErr     error
	cleanupErr       error
	reconcileCalls   int
	cleanupCalls     int
	lastIntegration  Integration
	lastBaseURL      string
}

func (f *fakeKlaviyoWebhookRegistrar) ReconcileWebhook(_ context.Context, integration Integration, appBaseURL string) (KlaviyoWebhookReconcileSummary, error) {
	f.reconcileCalls++
	f.lastIntegration = integration
	f.lastBaseURL = appBaseURL
	if f.reconcileErr != nil {
		return KlaviyoWebhookReconcileSummary{}, f.reconcileErr
	}
	if f.reconcileSummary.WebhookID == "" {
		f.reconcileSummary = KlaviyoWebhookReconcileSummary{
			WebhookID:    "klaviyo_wh_123",
			WebhookToken: firstString(settingString(integration.Settings, "klaviyo_webhook_token"), "generated_token_123"),
			Name:         "Moosewave Klaviyo system webhook",
			Endpoint:     strings.TrimRight(appBaseURL, "/") + "/api/public/marketing-integrations/klaviyo/webhooks/generated_token_123",
			Topics:       []string{"event:klaviyo.sent_sms"},
			RegisteredAt: time.Date(2026, 6, 30, 12, 30, 0, 0, time.UTC),
			Created:      true,
			Verified:     true,
			VerifiedAt:   time.Date(2026, 6, 30, 12, 30, 0, 0, time.UTC),
		}
	}
	return f.reconcileSummary, nil
}

func (f *fakeKlaviyoWebhookRegistrar) CleanupWebhook(_ context.Context, integration Integration, appBaseURL string) (KlaviyoWebhookCleanupSummary, error) {
	f.cleanupCalls++
	f.lastIntegration = integration
	f.lastBaseURL = appBaseURL
	if f.cleanupErr != nil {
		return KlaviyoWebhookCleanupSummary{}, f.cleanupErr
	}
	if f.cleanupSummary.WebhookID == "" && !f.cleanupSummary.Skipped && !f.cleanupSummary.NotFound {
		f.cleanupSummary = KlaviyoWebhookCleanupSummary{
			WebhookID: firstString(settingString(integration.Settings, "klaviyo_webhook_id"), "klaviyo_wh_123"),
			WebhookToken: firstString(
				settingString(integration.Settings, "klaviyo_webhook_token"),
				"generated_token_123",
			),
			Endpoint:    firstString(settingString(integration.Settings, "klaviyo_webhook_endpoint"), strings.TrimRight(appBaseURL, "/")+"/api/public/marketing-integrations/klaviyo/webhooks/generated_token_123"),
			Topics:      []string{"event:klaviyo.sent_sms"},
			CleanedUpAt: time.Date(2026, 6, 30, 12, 35, 0, 0, time.UTC),
			Deleted:     true,
		}
	}
	return f.cleanupSummary, nil
}

func TestProviderSpecsExposeKlaviyoNativeFoundation(t *testing.T) {
	spec, ok := ProviderSpecByKey(ProviderKlaviyo)
	if !ok {
		t.Fatal("missing Klaviyo spec")
	}
	if spec.RuntimeStatus != "partial" || spec.SyncModel != klaviyoSyncModelNativeFoundation || spec.AuthMode != "klaviyo_private_api_key_ref_or_oauth_public_app" {
		t.Fatalf("spec=%+v", spec)
	}
	if len(spec.RequiredSettings) != 1 || spec.RequiredSettings[0].Key != "credentials_ref" || !spec.RequiredSettings[0].Secret {
		t.Fatalf("required settings=%+v", spec.RequiredSettings)
	}
}

func TestProviderSpecsExposeMarketingProviderBatch(t *testing.T) {
	cases := map[string]string{
		ProviderMailchimp:       mailchimpSyncModelNativeFoundation,
		ProviderActiveCampaign:  activeCampaignSyncModelNativeFoundation,
		ProviderCustomerIO:      customerIOSyncModelNativeFoundation,
		ProviderBrevo:           brevoSyncModelNativeFoundation,
		ProviderConvertKit:      convertKitSyncModelNativeFoundation,
		ProviderSubstack:        substackSyncModelNativeFoundation,
		ProviderBeehiiv:         beehiivSyncModelNativeFoundation,
		ProviderMailerLite:      mailerLiteSyncModelNativeFoundation,
		ProviderSendy:           sendySyncModelNativeFoundation,
		ProviderConstantContact: constantContactSyncModelNativeFoundation,
		ProviderAWeber:          aweberSyncModelNativeFoundation,
		ProviderDrip:            dripSyncModelNativeFoundation,
		ProviderCampaignMonitor: campaignMonitorSyncModelNativeFoundation,
		ProviderOmnisend:        omnisendSyncModelNativeFoundation,
		ProviderLoops:           loopsSyncModelNativeFoundation,
	}
	for provider, syncModel := range cases {
		t.Run(provider, func(t *testing.T) {
			spec, ok := ProviderSpecByKey(provider)
			if !ok {
				t.Fatalf("missing provider spec for %s", provider)
			}
			if spec.RuntimeStatus != "partial" || spec.SyncModel != syncModel || spec.DocsURL == "" {
				t.Fatalf("unexpected spec=%+v", spec)
			}
			if len(spec.RequiredSettings) == 0 || spec.RequiredSettings[0].Key != "credentials_ref" || !spec.RequiredSettings[0].Secret {
				t.Fatalf("required settings should start with secret credentials_ref: %+v", spec.RequiredSettings)
			}
			if provider == ProviderActiveCampaign && !providerFieldPresent(spec.RequiredSettings, "api_url") {
				t.Fatalf("ActiveCampaign should require api_url, got %+v", spec.RequiredSettings)
			}
			if provider == ProviderCustomerIO && providerStringPresent(spec.Capabilities, "automation_triggers") {
				t.Fatalf("Customer.io workflow definitions are rebuild evidence, not runtime automation triggers: %+v", spec.Capabilities)
			}
			if provider == ProviderCustomerIO {
				for _, scope := range []string{"design_studio:read", "optouts:read", "object_types:read"} {
					if !providerStringPresent(spec.Scopes, scope) {
						t.Fatalf("Customer.io read inventory is missing %q: %+v", scope, spec.Scopes)
					}
				}
			}
		})
	}
}

func TestCustomerIOProviderRowValidatesRegionAndWorkspaceMetadata(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	for name, body := range map[string]string{
		"invalid region":       `{"provider":"customerio","credentials_ref":"vault://customerio/app","settings":{"region":"apac","workspace_id":"9001"}}`,
		"uppercase region":     `{"provider":"customerio","credentials_ref":"vault://customerio/app","settings":{"region":"EU","workspace_id":"9001"}}`,
		"nonnumeric workspace": `{"provider":"customerio","credentials_ref":"vault://customerio/app","settings":{"region":"eu","workspace_id":"workspace-name"}}`,
		"overlong workspace":   `{"provider":"customerio","credentials_ref":"vault://customerio/app","settings":{"region":"eu","workspace_id":"` + strings.Repeat("9", 65) + `"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			deps.CreateIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations", body))
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
		})
	}

	workspaceID := strings.Repeat("9", 64)
	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations", `{"provider":"customerio","credentials_ref":"vault://customerio/app","settings":{"region":"eu","workspace_id":"`+workspaceID+`"}}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Settings["region"] != "eu" || store.lastInput.Settings["workspace_id"] != workspaceID {
		t.Fatalf("Customer.io metadata=%+v", store.lastInput.Settings)
	}
}

func TestBeehiivProviderSpecMatchesMigrationBoundaries(t *testing.T) {
	spec, ok := ProviderSpecByKey(ProviderBeehiiv)
	if !ok {
		t.Fatal("missing beehiiv provider spec")
	}

	for _, forbidden := range []string{"automation_triggers", "paid_subscriptions"} {
		if providerStringPresent(spec.Capabilities, forbidden) {
			t.Fatalf("beehiiv must not advertise unsupported capability %q: %+v", forbidden, spec.Capabilities)
		}
	}
	if providerFieldPresent(spec.OptionalSettings, "stripe_account_id") {
		t.Fatalf("beehiiv must not expose an unsupported Stripe setting: %+v", spec.OptionalSettings)
	}

	publication, ok := providerFieldByKey(spec.OptionalSettings, "publication_id")
	if !ok {
		t.Fatal("beehiiv publication_id setting is missing")
	}
	publicationHelp := strings.ToLower(publication.Help)
	for _, want := range []string{"exactly one", "multi-publication", "explicit publication id", "no chooser"} {
		if !strings.Contains(publicationHelp, want) {
			t.Fatalf("beehiiv publication help must disclose %q: %q", want, publication.Help)
		}
	}
	account, ok := providerFieldByKey(spec.OptionalSettings, "account_id")
	if !ok || !strings.Contains(strings.ToLower(account.Help), "publication selector") {
		t.Fatalf("beehiiv account_id must be documented as a compatibility publication selector: %+v", account)
	}
	migrationJob, ok := providerFieldByKey(spec.OptionalSettings, "migration_job_id")
	if !ok || strings.Contains(strings.ToLower(migrationJob.Help), "paid-subscription") {
		t.Fatalf("beehiiv migration_job_id must not claim paid-subscription evidence: %+v", migrationJob)
	}

	for _, want := range []string{"identify:read", "newsletter_lists:read", "condition_sets:read", "custom_fields:read"} {
		if !providerStringPresent(spec.Scopes, want) {
			t.Fatalf("beehiiv source scope missing %q: %+v", want, spec.Scopes)
		}
	}
	for _, want := range []string{"newsletter_list_subscription_history", "segment_membership_snapshots", "custom_field_definitions", "automation_rebuild_tasks", "campaign_archive", "premium_membership_metadata"} {
		if !providerStringPresent(spec.SyncObjects, want) {
			t.Fatalf("beehiiv sync objects missing %q: %+v", want, spec.SyncObjects)
		}
	}
	for _, forbidden := range []string{"automations", "paid_subscriptions", "paid_subscriptions_stripe_connect"} {
		if providerStringPresent(spec.SyncObjects, forbidden) {
			t.Fatalf("beehiiv sync objects must not claim %q: %+v", forbidden, spec.SyncObjects)
		}
	}
}

func TestSubstackProviderSpecDoesNotAdvertiseBillingRuntime(t *testing.T) {
	spec, ok := ProviderSpecByKey(ProviderSubstack)
	if !ok {
		t.Fatal("missing Substack provider spec")
	}
	for _, forbidden := range []string{"paid_subscriptions", "paid_subscriptions:read", "paid_subscriptions_stripe_connect"} {
		if providerStringPresent(spec.Capabilities, forbidden) || providerStringPresent(spec.Scopes, forbidden) || providerStringPresent(spec.SyncObjects, forbidden) {
			t.Fatalf("Substack must not advertise unsupported billing runtime %q: %+v", forbidden, spec)
		}
	}
	if providerFieldPresent(spec.OptionalSettings, "stripe_account_id") {
		t.Fatalf("Substack must not accept an unbound Stripe account ID: %+v", spec.OptionalSettings)
	}
}

func TestListIntegrationsHidesDisconnectedRows(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.ListIntegrations(rec, marketingReq(http.MethodGet, "/api/v1/marketing-integrations", ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Items []Integration `json:"items"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if len(out.Items) != 0 {
		t.Fatalf("disconnected rows should be hidden from list response: %+v", out.Items)
	}
}

func TestCreateIntegrationRequiresCredentialRefAndRejectsRawSecrets(t *testing.T) {
	deps := &Deps{Repo: newFakeStore()}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations", `{
		"provider":"klaviyo",
		"settings":{"api_key":"pk_raw"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations", `{
		"provider":"klaviyo",
		"settings":{"account_id":"acct_123"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "credentials_ref") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations", `{
		"provider":"klaviyo",
		"credentials_ref":"Bearer raw-token",
		"settings":{"account_id":"acct_123"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("raw-looking ref status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations", `{
		"provider":"klaviyo",
		"credentials_ref":"cred_klaviyo_main",
		"status":"disconnected",
		"settings":{"account_id":"acct_123"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "reserved for the disconnect lifecycle") {
		t.Fatalf("disconnected status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations", `{
		"provider":"activecampaign",
		"credentials_ref":"cred_activecampaign_main",
		"settings":{"account_id":"acct_123"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "api_url") {
		t.Fatalf("missing activecampaign api_url status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations", `{
		"provider":"constant-contact",
		"credentials_ref":"vault://marketing/constant-contact",
		"settings":{"csv_path":"/tmp/constant-contact.csv"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("raw csv path status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestCreateIntegrationStoresNativeProviderRowMetadata(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations", `{
		"provider":"klaviyo",
		"name":"Klaviyo main",
		"credentials_ref":"cred_klaviyo_main",
		"settings":{"account_id":"acct_123","credential_ref":"strip_me","provider_cleanup":{"status":"spoofed"}}
	}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderKlaviyo || store.lastInput.CredentialsRef != "cred_klaviyo_main" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["setup_surface"] != "marketing_integrations" ||
		store.lastInput.Settings["sync_model"] != klaviyoSyncModelNativeFoundation ||
		store.lastInput.Settings["native_data_plane"] != "klaviyo_json_api_profiles_segments_source_events" ||
		store.lastInput.Settings["delegated_data_plane"] != nil ||
		store.lastInput.Settings["credential_ref"] != nil ||
		store.lastInput.Settings["provider_cleanup"] != nil {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
}

func TestCreateKlaviyoIntegrationRegistersManagedWebhook(t *testing.T) {
	store := newFakeStore()
	registrar := &fakeKlaviyoWebhookRegistrar{}
	deps := &Deps{
		Repo:            store,
		KlaviyoWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations", `{
		"provider":"klaviyo",
		"name":"Klaviyo main",
		"credentials_ref":"cred_klaviyo_main",
		"settings":{
			"account_id":"acct_123",
			"klaviyo_webhook_secret_ref":"vault://klaviyo/webhook",
			"klaviyo_webhook_topics":["event:klaviyo.sent_sms"]
		}
	}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.reconcileCalls != 1 || registrar.lastBaseURL != "https://app.postwave.test" {
		t.Fatalf("registrar calls=%d base=%q", registrar.reconcileCalls, registrar.lastBaseURL)
	}
	settings := store.lastInput.Settings
	if settings["klaviyo_webhook_id"] != "klaviyo_wh_123" ||
		settings["klaviyo_webhook_token"] != "generated_token_123" ||
		settings["klaviyo_webhook_endpoint"] != "https://app.postwave.test/api/public/marketing-integrations/klaviyo/webhooks/generated_token_123" ||
		settings["klaviyo_webhook_secret_ref"] != "vault://klaviyo/webhook" ||
		settings["klaviyo_webhook_verified"] != true ||
		settings["klaviyo_webhook_managed_by_postwave"] != true ||
		settings["provider_cleanup"] != nil {
		t.Fatalf("settings=%+v", settings)
	}
}

func TestCreateKlaviyoIntegrationRollsBackManagedWebhookWhenUpsertFails(t *testing.T) {
	store := newFakeStore()
	store.upsertErr = errors.New("database unavailable")
	registrar := &fakeKlaviyoWebhookRegistrar{}
	deps := &Deps{
		Repo:            store,
		KlaviyoWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations", `{
		"provider":"klaviyo",
		"name":"Klaviyo rollback",
		"credentials_ref":"cred_klaviyo_main",
		"settings":{
			"account_id":"acct_123",
			"klaviyo_webhook_secret_ref":"vault://klaviyo/webhook",
			"klaviyo_webhook_topics":["event:klaviyo.sent_sms"]
		}
	}`))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.reconcileCalls != 1 || registrar.cleanupCalls != 1 {
		t.Fatalf("reconcile calls=%d cleanup calls=%d", registrar.reconcileCalls, registrar.cleanupCalls)
	}
	if registrar.lastIntegration.Settings["klaviyo_webhook_id"] != "klaviyo_wh_123" {
		t.Fatalf("rollback integration=%+v", registrar.lastIntegration)
	}
	if store.lastInput.Provider != "" {
		t.Fatalf("failed upsert should not persist input: %+v", store.lastInput)
	}
}

func TestCreateIntegrationStoresProviderSpecificNativeMetadata(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations", `{
		"provider":"activecampaign",
		"name":"AC main",
		"credentials_ref":"cred_activecampaign_main",
		"settings":{"api_url":"https://example.api-us1.com/api/3","source_event_cursor":"contact_cursor","api_key":"raw"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("raw activecampaign key status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations", `{
		"provider":"activecampaign",
		"name":"AC main",
		"credentials_ref":"cred_activecampaign_main",
		"settings":{"api_url":"https://example.api-us1.com/api/3","source_event_cursor":"contact_cursor"}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderActiveCampaign ||
		store.lastInput.Settings["sync_model"] != activeCampaignSyncModelNativeFoundation ||
		store.lastInput.Settings["delegated_data_plane"] != "activecampaign_migration_api_v3_source_events" ||
		store.lastInput.Settings["api_url"] != "https://example.api-us1.com/api/3" {
		t.Fatalf("input=%+v settings=%+v", store.lastInput, store.lastInput.Settings)
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations", `{
		"provider":"mailerlite",
		"name":"MailerLite main",
		"credentials_ref":"vault://marketing/mailerlite",
		"settings":{"workspace_id":"workspace_123","import_cursor":"subscribers:200"}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("mailerlite status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderMailerLite ||
		store.lastInput.Settings["sync_model"] != mailerLiteSyncModelNativeFoundation ||
		store.lastInput.Settings["delegated_data_plane"] != "mailerlite_migration_connect_api" ||
		store.lastInput.Settings["workspace_id"] != "workspace_123" {
		t.Fatalf("mailerlite input=%+v settings=%+v", store.lastInput, store.lastInput.Settings)
	}
}

func TestSyncAndBackfillRecordDelegatedPartialRunMetadata(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings["migration_job_id"] = "job_import_123"
	store.integration.Settings["source_event_job_id"] = "job_events_123"
	store.integration.Settings["poll_interval_seconds"] = 900
	deps := &Deps{
		Repo: store,
		Now:  func() time.Time { return time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations/marketing_1/backfill", `{
		"metadata":{
			"source_event_cursor":"profile_cursor_abc",
			"source_event_high_watermark":"2026-06-30T11:55:00Z"
		}
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "partial" || !strings.HasPrefix(out.Cursor, klaviyoDelegatedHandoffCursorPrefix) || !strings.Contains(out.ErrorMessage, "delegated") {
		t.Fatalf("summary=%+v", out)
	}
	handoff, ok := decodeKlaviyoDelegatedHandoffCursor(out.Cursor)
	if !ok {
		t.Fatalf("cursor is not a Klaviyo handoff cursor: %q", out.Cursor)
	}
	if handoff.RunMode != "backfill" ||
		handoff.MigrationJobID != "job_import_123" ||
		handoff.SourceEventJobID != "job_events_123" ||
		handoff.SourceEventCursor != "profile_cursor_abc" ||
		handoff.SourceEventHighWatermark != "2026-06-30T11:55:00Z" ||
		handoff.Revision != klaviyoDefaultAPIRevision ||
		handoff.PollIntervalSeconds != 900 ||
		handoff.Attempt != 1 ||
		handoff.SourceEventsEndpoint == "" ||
		handoff.BackfillEndpoint == "" {
		t.Fatalf("handoff=%+v", handoff)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].Metadata["native_provider_row"] != true {
		t.Fatalf("runs=%+v", store.runs)
	}
	handoffMeta, ok := store.runs[0].Metadata["delegated_handoff"].(map[string]any)
	if !ok || handoffMeta["source_event_cursor"] != "profile_cursor_abc" || handoffMeta["migration_job_id"] != "job_import_123" || store.runs[0].Metadata["provider_row_retry_cursor"] != true {
		t.Fatalf("metadata=%+v", store.runs[0].Metadata)
	}
	if store.integration.SyncCursor != out.Cursor {
		t.Fatalf("sync cursor was not persisted by fake store: %q != %q", store.integration.SyncCursor, out.Cursor)
	}
}

func TestSyncRecordsProviderSpecificHandoffCursors(t *testing.T) {
	t.Run("import only provider", func(t *testing.T) {
		store := newFakeStore()
		store.integration.Provider = ProviderCustomerIO
		store.integration.Name = "Customer.io"
		store.integration.Settings = map[string]any{"migration_job_id": "job_customerio_123"}
		deps := &Deps{
			Repo: store,
			Now:  func() time.Time { return time.Date(2026, 6, 30, 13, 0, 0, 0, time.UTC) },
		}

		rec := httptest.NewRecorder()
		deps.BackfillIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations/marketing_1/backfill", `{
			"metadata":{"import_cursor":"customer_cursor_abc"}
		}`))
		if rec.Code != http.StatusAccepted {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		var out SyncSummary
		if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(out.Cursor, "customerio_handoff:") {
			t.Fatalf("cursor=%q", out.Cursor)
		}
		handoff, ok := decodeDelegatedHandoffCursor(out.Cursor, ProviderCustomerIO)
		if !ok || handoff.ImportCursor != "customer_cursor_abc" || handoff.SourceEventsEndpoint != "" || handoff.MigrationJobID != "job_customerio_123" {
			t.Fatalf("handoff=%+v ok=%v", handoff, ok)
		}
		if len(store.runs) != 1 || store.runs[0].Metadata["provider"] != ProviderCustomerIO || store.runs[0].Metadata["delegated_to"] != "customerio_migration_app_api" {
			t.Fatalf("runs=%+v", store.runs)
		}
	})

	t.Run("hyphenated import provider", func(t *testing.T) {
		store := newFakeStore()
		store.integration.Provider = ProviderConstantContact
		store.integration.Name = "Constant Contact"
		store.integration.Settings = map[string]any{"migration_job_id": "job_constant_contact_123"}
		deps := &Deps{
			Repo: store,
			Now:  func() time.Time { return time.Date(2026, 6, 30, 13, 2, 0, 0, time.UTC) },
		}

		rec := httptest.NewRecorder()
		deps.BackfillIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations/marketing_1/backfill", `{
			"metadata":{"constant_contact_import_cursor":"csv:400"}
		}`))
		if rec.Code != http.StatusAccepted {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		var out SyncSummary
		if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(out.Cursor, "constant-contact_handoff:") {
			t.Fatalf("cursor=%q", out.Cursor)
		}
		handoff, ok := decodeDelegatedHandoffCursor(out.Cursor, ProviderConstantContact)
		if !ok || handoff.ImportCursor != "csv:400" || handoff.SourceEventsEndpoint != "" || handoff.MigrationJobID != "job_constant_contact_123" {
			t.Fatalf("handoff=%+v ok=%v", handoff, ok)
		}
		if len(store.runs) != 1 || store.runs[0].Metadata["provider"] != ProviderConstantContact || store.runs[0].Metadata["delegated_to"] != "constant_contact_migration_csv_export" {
			t.Fatalf("runs=%+v", store.runs)
		}
	})

	t.Run("source event provider", func(t *testing.T) {
		store := newFakeStore()
		store.integration.Provider = ProviderActiveCampaign
		store.integration.Name = "ActiveCampaign"
		store.integration.Settings = map[string]any{"source_event_job_id": "job_ac_events_123"}
		deps := &Deps{
			Repo: store,
			Now:  func() time.Time { return time.Date(2026, 6, 30, 13, 5, 0, 0, time.UTC) },
		}

		rec := httptest.NewRecorder()
		deps.SyncIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations/marketing_1/sync", `{
			"cursor":"contact_cursor_abc"
		}`))
		if rec.Code != http.StatusAccepted {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		var out SyncSummary
		if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(out.Cursor, "activecampaign_handoff:") {
			t.Fatalf("cursor=%q", out.Cursor)
		}
		handoff, ok := decodeDelegatedHandoffCursor(out.Cursor, ProviderActiveCampaign)
		if !ok || handoff.SourceEventCursor != "contact_cursor_abc" || !strings.Contains(handoff.SourceEventsEndpoint, "/activecampaign/source-events") || handoff.ImportCursor != "" {
			t.Fatalf("handoff=%+v ok=%v", handoff, ok)
		}
		if len(store.runs) != 1 || store.runs[0].Metadata["provider"] != ProviderActiveCampaign || store.runs[0].Metadata["sync_model"] != activeCampaignSyncModelNativeFoundation {
			t.Fatalf("runs=%+v", store.runs)
		}
	})
}

func TestSyncRetryHandoffCursorPreservesPreviousSourceEventEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.SyncCursor = encodeKlaviyoDelegatedHandoffCursor(klaviyoDelegatedHandoffCursor{
		Version:                  klaviyoDelegatedHandoffCursorVersion,
		Provider:                 ProviderKlaviyo,
		CursorType:               "delegated_source_event_handoff",
		RunMode:                  "manual",
		DelegatedTo:              "klaviyo_migration_json_api_source_events",
		SourceEventCursor:        "old_profile_cursor",
		SourceEventHighWatermark: "2026-06-30T10:00:00Z",
		Attempt:                  2,
	})
	deps := &Deps{
		Repo: store,
		Now:  func() time.Time { return time.Date(2026, 6, 30, 12, 5, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations/marketing_1/sync", `{
		"run_mode":"retry",
		"metadata":{"source_event_cursor":"new_profile_cursor"}
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	handoff, ok := decodeKlaviyoDelegatedHandoffCursor(out.Cursor)
	if !ok {
		t.Fatalf("cursor is not a Klaviyo handoff cursor: %q", out.Cursor)
	}
	if handoff.RunMode != "retry" ||
		handoff.Attempt != 3 ||
		handoff.SourceEventCursor != "new_profile_cursor" ||
		handoff.PreviousCursor != "old_profile_cursor" ||
		handoff.SourceEventHighWatermark != "2026-06-30T10:00:00Z" {
		t.Fatalf("handoff=%+v", handoff)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "retry" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncRawRequestCursorBecomesSourceEventHandoffCursor(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo: store,
		Now:  func() time.Time { return time.Date(2026, 6, 30, 12, 10, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations/marketing_1/sync", `{
		"cursor":"raw_source_event_cursor",
		"metadata":{"source_event_job_id":"job_events_456"}
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	handoff, ok := decodeKlaviyoDelegatedHandoffCursor(out.Cursor)
	if !ok {
		t.Fatalf("cursor is not a Klaviyo handoff cursor: %q", out.Cursor)
	}
	if handoff.SourceEventCursor != "raw_source_event_cursor" || handoff.SourceEventJobID != "job_events_456" || handoff.Attempt != 1 {
		t.Fatalf("handoff=%+v", handoff)
	}
}

func TestDisconnectReturnsAndPersistsCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo: store,
		Now:  func() time.Time { return time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, marketingReq(http.MethodDelete, "/api/v1/marketing-integrations/marketing_1", ""))

	if rec.Code != http.StatusOK || !store.disconnected {
		t.Fatalf("status=%d body=%s disconnected=%v", rec.Code, rec.Body.String(), store.disconnected)
	}
	if cleanup, ok := store.integration.Settings["provider_cleanup"].(map[string]any); !ok || cleanup["provider"] != ProviderKlaviyo {
		t.Fatalf("settings=%+v", store.integration.Settings)
	}
}

func TestDisconnectKlaviyoIntegrationCleansManagedWebhook(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings = map[string]any{
		"account_id":                          "acct_123",
		"klaviyo_webhook_id":                  "klaviyo_wh_123",
		"klaviyo_webhook_token":               "generated_token_123",
		"klaviyo_webhook_endpoint":            "https://app.postwave.test/api/public/marketing-integrations/klaviyo/webhooks/generated_token_123",
		"klaviyo_webhook_topics":              []string{"event:klaviyo.sent_sms"},
		"klaviyo_webhook_secret_ref":          "vault://klaviyo/webhook",
		"klaviyo_webhook_managed_by_postwave": true,
	}
	registrar := &fakeKlaviyoWebhookRegistrar{}
	deps := &Deps{
		Repo:            store,
		KlaviyoWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, marketingReq(http.MethodDelete, "/api/v1/marketing-integrations/marketing_1", ""))

	if rec.Code != http.StatusOK || !store.disconnected {
		t.Fatalf("status=%d body=%s disconnected=%v", rec.Code, rec.Body.String(), store.disconnected)
	}
	if registrar.cleanupCalls != 1 || registrar.lastIntegration.Settings["klaviyo_webhook_id"] != "klaviyo_wh_123" {
		t.Fatalf("registrar calls=%d integration=%+v", registrar.cleanupCalls, registrar.lastIntegration)
	}
	var out struct {
		OK              bool                      `json:"ok"`
		ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.OK ||
		out.ProviderCleanup.Status != "provider_cleanup_completed" ||
		out.ProviderCleanup.ProviderCleanupPosture != "postwave_managed_provider_api" ||
		!out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderWebhookID != "klaviyo_wh_123" ||
		out.ProviderCleanup.WebhookCleanupStatus != "provider_deleted" ||
		!out.ProviderCleanup.WebhookSecretRefPresent {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok || stored["provider"] != ProviderKlaviyo || stored["managed_provider_cleanup"] != true {
		t.Fatalf("stored cleanup=%+v settings=%+v", stored, store.integration.Settings)
	}
}

func TestAcknowledgeProviderCleanupPersistsKlaviyoOperatorAttestation(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.Settings = map[string]any{
		"account_id": "acct_123",
		"provider_cleanup": map[string]any{
			"provider":                 ProviderKlaviyo,
			"status":                   "operator_action_required",
			"recorded_at":              "2026-06-30T11:00:00Z",
			"managed_provider_cleanup": true,
			"provider_scope_id":        "acct_123",
		},
	}
	deps := &Deps{
		Repo: store,
		Now:  func() time.Time { return time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.AcknowledgeProviderCleanup(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations/marketing_1/provider-cleanup/acknowledge", `{
		"completed_actions":["private_api_key_revoked_or_rotated","manual_or_duplicate_webhooks_audited","private_api_key_revoked_or_rotated"],
		"notes":"Verified in Klaviyo account",
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
		stored["acknowledged_at"] != "2026-06-30T12:00:00Z" ||
		stored["acknowledged_by"] != "ops@example.com" ||
		stored["operator_notes"] != "Verified in Klaviyo account" ||
		stored["managed_provider_cleanup"] != true ||
		stored["recorded_at"] != "2026-06-30T11:00:00Z" ||
		len(actions) != 2 ||
		actions[0] != "private_api_key_revoked_or_rotated" ||
		actions[1] != "manual_or_duplicate_webhooks_audited" {
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
		out.ProviderCleanup["acknowledged_at"] != "2026-06-30T12:00:00Z" ||
		out.ProviderCleanup["managed_provider_cleanup"] != true {
		t.Fatalf("response=%+v", out)
	}
}

func TestAcknowledgeProviderCleanupRejectsConnectedKlaviyo(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderKlaviyo,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations/marketing_1/provider-cleanup/acknowledge", `{"notes":"done"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "provider_cleanup_missing") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAcknowledgeProviderCleanupRejectsNonKlaviyo(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderMailchimp
	store.integration.Status = "disconnected"
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderMailchimp,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations/marketing_1/provider-cleanup/acknowledge", `{"notes":"done"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "provider_cleanup_missing") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAcknowledgeProviderCleanupRequiresRecordedEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations/marketing_1/provider-cleanup/acknowledge", `{"notes":"done"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "provider_cleanup_missing") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAcknowledgeProviderCleanupRequiresAttestationEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderKlaviyo,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations/marketing_1/provider-cleanup/acknowledge", `{}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "completed_actions or notes is required") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAcknowledgeProviderCleanupValidatesKlaviyoActionKeys(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderKlaviyo,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations/marketing_1/provider-cleanup/acknowledge", `{
		"completed_actions":["revoked Klaviyo API key"]
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "unsupported Klaviyo cleanup action key") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestPauseAndSyncRejectDisconnectedRows(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.PauseIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations/marketing_1/pause", `{}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") || store.paused {
		t.Fatalf("pause status=%d body=%s paused=%v", rec.Code, rec.Body.String(), store.paused)
	}

	rec = httptest.NewRecorder()
	deps.SyncIntegration(rec, marketingReq(http.MethodPost, "/api/v1/marketing-integrations/marketing_1/sync", `{}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") || len(store.runs) != 0 {
		t.Fatalf("sync status=%d body=%s runs=%+v", rec.Code, rec.Body.String(), store.runs)
	}
}
