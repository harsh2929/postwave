// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

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
	integration Integration
	runs        []SyncRun
	lastInput   IntegrationInput
	lastIngest  IngestProvisionInput
}

func newFakeStore() *fakeStore {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	return &fakeStore{integration: Integration{
		ID:             "analytics_1",
		TenantID:       "tenant-1",
		Provider:       ProviderSegment,
		Name:           "Segment source",
		Status:         "connected",
		Scopes:         []string{"track.write"},
		CredentialsRef: "cred_segment_1",
		Settings:       map[string]any{"source_id": "src_123"},
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
	f.lastIngest = in
	tokenKey := analyticsIngestTokenSetting(in.Provider)
	f.integration.TenantID = tenantID
	f.integration.Provider = in.Provider
	if name := in.Name; name != "" {
		f.integration.Name = name
	} else {
		f.integration.Name = in.Provider + " (webhook ingest)"
	}
	f.integration.Status = "connected"
	f.integration.Settings = map[string]any{tokenKey: token}
	return &f.integration, nil
}
func (f *fakeStore) RotateIngestToken(_ context.Context, _ string, _ string, token string) (*Integration, error) {
	tokenKey := analyticsIngestTokenSetting(f.integration.Provider)
	if f.integration.Settings == nil {
		f.integration.Settings = map[string]any{}
	}
	f.integration.Settings[tokenKey] = token
	return &f.integration, nil
}
func (f *fakeStore) PauseIntegration(context.Context, string, string) (*Integration, error) {
	f.integration.Status = "paused"
	return &f.integration, nil
}
func (f *fakeStore) DisconnectIntegration(context.Context, string, string) error {
	f.integration.Status = "disconnected"
	return nil
}
func (f *fakeStore) DisconnectIntegrationWithProviderCleanup(_ context.Context, _ string, _ string, cleanup map[string]any) error {
	f.integration.Status = "disconnected"
	if f.integration.Settings == nil {
		f.integration.Settings = map[string]any{}
	}
	f.integration.Settings["provider_cleanup"] = cleanup
	return nil
}
func (f *fakeStore) AcknowledgeProviderCleanup(_ context.Context, _ string, _ string, in ProviderCleanupAcknowledgementInput, acknowledgedAt time.Time) (*Integration, error) {
	if f.integration.Settings == nil || f.integration.Settings["provider_cleanup"] == nil {
		return nil, ErrNotFound
	}
	cleanup, _ := f.integration.Settings["provider_cleanup"].(map[string]any)
	if cleanup == nil {
		cleanup = map[string]any{}
	}
	cleanup["status"] = "operator_acknowledged"
	cleanup["acknowledged_at"] = acknowledgedAt.UTC().Format(time.RFC3339)
	cleanup["completed_actions"] = append([]string(nil), in.CompletedActions...)
	cleanup["operator_notes"] = in.Notes
	f.integration.Settings["provider_cleanup"] = cleanup
	return &f.integration, nil
}
func (f *fakeStore) RecordSyncRun(_ context.Context, _ string, _ string, summary SyncSummary, req SyncRequest, started, completed time.Time) (*SyncRun, error) {
	run := SyncRun{
		ID:               "run_1",
		IntegrationID:    summary.IntegrationID,
		RunMode:          req.RunMode,
		Status:           summary.Status,
		CursorTo:         summary.Cursor,
		ProfilesSeen:     summary.ProfilesSeen,
		ProfilesUpserted: summary.ProfilesUpserted,
		EventsSeen:       summary.EventsSeen,
		EventsTracked:    summary.EventsTracked,
		RowsFailed:       summary.RowsFailed,
		ErrorMessage:     summary.ErrorMessage,
		StartedAt:        started,
		CompletedAt:      &completed,
		CreatedAt:        completed,
	}
	f.runs = append(f.runs, run)
	return &run, nil
}
func (f *fakeStore) ListRuns(context.Context, string, string, int) ([]SyncRun, error) {
	return f.runs, nil
}

type fakeProfileSink struct {
	profiles []ProfileInput
	err      error
}

func (f *fakeProfileSink) UpsertAnalyticsProfile(_ context.Context, _ string, _ string, profile ProfileInput) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.profiles = append(f.profiles, profile)
	return "sub_1", nil
}

type fakeEventSink struct {
	events []EventInput
	err    error
}

func (f *fakeEventSink) TrackAnalyticsEvent(_ context.Context, _ string, _ string, event EventInput) (int64, error) {
	if f.err != nil {
		return 0, f.err
	}
	f.events = append(f.events, event)
	return int64(len(f.events)), nil
}

func analyticsReq(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
}

func hasString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

type fakeAnalyticsBackfiller struct {
	calls int
	req   SyncRequest
	err   error
}

func (f *fakeAnalyticsBackfiller) BackfillPage(context.Context, string, Integration, string) (SyncRequest, error) {
	f.calls++
	return f.req, f.err
}

func providerFieldKeys(fields []ProviderField) []string {
	out := make([]string, 0, len(fields))
	for _, field := range fields {
		out = append(out, field.Key)
	}
	return out
}

func equalStrings(values []string, expected ...string) bool {
	if len(values) != len(expected) {
		return false
	}
	for i := range values {
		if values[i] != expected[i] {
			return false
		}
	}
	return true
}

func TestListProvidersIncludesAnalyticsAndCDPNatives(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{Repo: newFakeStore()}).ListProviders(rec, httptest.NewRequest(http.MethodGet, "/api/v1/analytics-integrations/providers", nil))

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
		ProviderGA4,
		ProviderGoogleTagManager,
		ProviderSegment,
		ProviderRudderStack,
		ProviderMixpanel,
		ProviderAmplitude,
		ProviderPostHog,
		ProviderHeap,
		ProviderHotjar,
		ProviderFullStory,
		ProviderPlausible,
		ProviderFathomAnalytics,
		ProviderMatomo,
		ProviderAdobeAnalytics,
		ProviderLookerStudio,
		ProviderLooker,
		ProviderTableau,
		ProviderPowerBI,
		ProviderMode,
		ProviderMetabase,
		ProviderSisense,
		ProviderKissmetrics,
		ProviderWoopra,
		ProviderChartMogul,
		ProviderBaremetrics,
		ProviderProfitWell,
		ProviderTripleWhale,
		ProviderNorthbeam,
		ProviderDaasity,
		ProviderGlew,
		ProviderPeelInsights,
	} {
		if !seen[provider] {
			t.Fatalf("provider %q missing or unmanaged: %+v", provider, res.Items)
		}
	}
}

func TestAnalyticsProviderMetadataUsesIngestFoundation(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{Repo: newFakeStore()}).ListProviders(rec, httptest.NewRequest(http.MethodGet, "/api/v1/analytics-integrations/providers", nil))

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
	for provider, item := range seen {
		if analyticsProviderCleanupEligible(provider) {
			if item.SyncModel == analyticsSyncModelIngest || item.VerificationMode == "postwave_ingest_token" {
				t.Fatalf("%s should expose its native puller posture, not the canonical ingest foundation: %+v", provider, item)
			}
			if !equalStrings(item.Capabilities, "profiles") ||
				!equalStrings(item.SyncObjects, "profiles") ||
				len(item.WebhookTopics) != 0 ||
				hasString(providerFieldKeys(item.OptionalSettings), "webhook_secret_ref") {
				t.Fatalf("%s puller should claim only implemented profile-puller objects and no webhooks: %+v", provider, item)
			}
			continue
		}
		if item.SyncModel != analyticsSyncModelIngest || item.VerificationMode != "postwave_ingest_token" {
			t.Fatalf("%s should expose the canonical ingest foundation posture: %+v", provider, item)
		}
		if len(item.Scopes) != 0 ||
			!equalStrings(item.Capabilities, "profiles", "events") ||
			!equalStrings(item.SyncObjects, "profiles", "events") ||
			len(item.WebhookTopics) != 0 ||
			hasString(providerFieldKeys(item.OptionalSettings), "webhook_secret_ref") {
			t.Fatalf("%s should not claim provider scopes, report objects, or webhook setup at foundation stage: %+v", provider, item)
		}
	}
	gtm := seen[ProviderGoogleTagManager]
	if gtm.AuthMode != "oauth_ref" || hasString(gtm.Scopes, "events.write") || hasString(gtm.SyncObjects, "data_layer_events") {
		t.Fatalf("GTM metadata should model Tag Manager API container management, not event ingestion: %+v", gtm)
	}
	segment := seen[ProviderSegment]
	if hasString(segment.SyncObjects, "webhooks") || len(segment.WebhookTopics) != 0 || hasString(providerFieldKeys(segment.OptionalSettings), "webhook_secret_ref") {
		t.Fatalf("Segment should not advertise provider webhook management until handlers exist: %+v", segment)
	}
}

func TestCreateGrowthRevenueAnalyticsIntegrations(t *testing.T) {
	tests := []struct {
		name           string
		provider       string
		credentialsRef string
		settings       string
		assertKey      string
		assertValue    string
	}{
		{
			name:           "kissmetrics",
			provider:       ProviderKissmetrics,
			credentialsRef: "cred_kissmetrics_1",
			settings:       `"product_id":"product_123","environment":"production","credentials_ref":"cred_kissmetrics_1"`,
			assertKey:      "product_id",
			assertValue:    "product_123",
		},
		{
			name:           "woopra",
			provider:       ProviderWoopra,
			credentialsRef: "cred_woopra_1",
			settings:       `"project_id":"project_123","domain":"example.com","credentials_ref":"cred_woopra_1"`,
			assertKey:      "project_id",
			assertValue:    "project_123",
		},
		{
			name:           "chartmogul",
			provider:       ProviderChartMogul,
			credentialsRef: "cred_chartmogul_1",
			settings:       `"data_source_uuid":"ds_123","account_uuid":"account_456","credentials_ref":"cred_chartmogul_1"`,
			assertKey:      "data_source_uuid",
			assertValue:    "ds_123",
		},
		{
			name:           "baremetrics",
			provider:       ProviderBaremetrics,
			credentialsRef: "cred_baremetrics_1",
			settings:       `"source_id":"source_123","account_id":"account_456","credentials_ref":"cred_baremetrics_1"`,
			assertKey:      "source_id",
			assertValue:    "source_123",
		},
		{
			name:           "profitwell",
			provider:       ProviderProfitWell,
			credentialsRef: "cred_profitwell_1",
			settings:       `"account_id":"account_123","product_id":"product_456","credentials_ref":"cred_profitwell_1"`,
			assertKey:      "account_id",
			assertValue:    "account_123",
		},
		{
			name:           "triple whale",
			provider:       ProviderTripleWhale,
			credentialsRef: "cred_triple_whale_1",
			settings:       `"shop_domain":"acme.myshopify.com","pixel_id":"pixel_123","credentials_ref":"cred_triple_whale_1"`,
			assertKey:      "shop_domain",
			assertValue:    "acme.myshopify.com",
		},
		{
			name:           "northbeam",
			provider:       ProviderNorthbeam,
			credentialsRef: "cred_northbeam_1",
			settings:       `"account_id":"account_123","pixel_id":"pixel_456","credentials_ref":"cred_northbeam_1"`,
			assertKey:      "account_id",
			assertValue:    "account_123",
		},
		{
			name:           "daasity",
			provider:       ProviderDaasity,
			credentialsRef: "cred_daasity_1",
			settings:       `"workspace_id":"workspace_123","model_id":"model_456","credentials_ref":"cred_daasity_1"`,
			assertKey:      "workspace_id",
			assertValue:    "workspace_123",
		},
		{
			name:           "glew",
			provider:       ProviderGlew,
			credentialsRef: "cred_glew_1",
			settings:       `"store_id":"store_123","shop_domain":"acme.example.com","credentials_ref":"cred_glew_1"`,
			assertKey:      "store_id",
			assertValue:    "store_123",
		},
		{
			name:           "peel insights",
			provider:       ProviderPeelInsights,
			credentialsRef: "cred_peel_insights_1",
			settings:       `"store_id":"store_123","shop_domain":"acme.myshopify.com","credentials_ref":"cred_peel_insights_1"`,
			assertKey:      "shop_domain",
			assertValue:    "acme.myshopify.com",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeStore()
			deps := &Deps{Repo: store}

			rec := httptest.NewRecorder()
			deps.CreateIntegration(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations", `{
				"provider":"`+tt.provider+`",
				"settings":{`+tt.settings+`}
			}`))
			if rec.Code != http.StatusCreated {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if store.lastInput.Provider != tt.provider || store.lastInput.CredentialsRef != tt.credentialsRef {
				t.Fatalf("input=%+v", store.lastInput)
			}
			if store.lastInput.Settings[tt.assertKey] != tt.assertValue ||
				store.lastInput.Settings["setup_surface"] != "analytics_integrations" ||
				store.lastInput.Settings["managed_by_postwave"] != true {
				t.Fatalf("settings=%+v", store.lastInput.Settings)
			}
		})
	}
}

func TestCreateReportingBIIntegrations(t *testing.T) {
	tests := []struct {
		name           string
		provider       string
		credentialsRef string
		settings       string
		assertKey      string
		assertValue    string
	}{
		{
			name:           "fathom analytics",
			provider:       ProviderFathomAnalytics,
			credentialsRef: "cred_fathom_1",
			settings:       `"site_id":"site_123","site_domain":"example.com","credentials_ref":"cred_fathom_1"`,
			assertKey:      "site_id",
			assertValue:    "site_123",
		},
		{
			name:           "matomo",
			provider:       ProviderMatomo,
			credentialsRef: "cred_matomo_1",
			settings:       `"site_id":"42","host":"https://matomo.example.com","segment_id":"segment_123","credentials_ref":"cred_matomo_1"`,
			assertKey:      "host",
			assertValue:    "https://matomo.example.com",
		},
		{
			name:           "adobe analytics",
			provider:       ProviderAdobeAnalytics,
			credentialsRef: "cred_adobe_analytics_1",
			settings:       `"company_id":"company_123","report_suite_id":"rsid_456","global_company_id":"global_789","credentials_ref":"cred_adobe_analytics_1"`,
			assertKey:      "report_suite_id",
			assertValue:    "rsid_456",
		},
		{
			name:           "looker studio",
			provider:       ProviderLookerStudio,
			credentialsRef: "cred_looker_studio_1",
			settings:       `"data_source_id":"ds_123","report_id":"report_456","credentials_ref":"cred_looker_studio_1"`,
			assertKey:      "data_source_id",
			assertValue:    "ds_123",
		},
		{
			name:           "looker",
			provider:       ProviderLooker,
			credentialsRef: "cred_looker_1",
			settings:       `"instance_url":"https://looker.example.com","model_id":"commerce","dashboard_id":"dash_123","credentials_ref":"cred_looker_1"`,
			assertKey:      "instance_url",
			assertValue:    "https://looker.example.com",
		},
		{
			name:           "tableau",
			provider:       ProviderTableau,
			credentialsRef: "cred_tableau_1",
			settings:       `"site_id":"site_123","server_url":"https://tableau.example.com","workbook_id":"workbook_456","credentials_ref":"cred_tableau_1"`,
			assertKey:      "server_url",
			assertValue:    "https://tableau.example.com",
		},
		{
			name:           "power bi",
			provider:       ProviderPowerBI,
			credentialsRef: "cred_power_bi_1",
			settings:       `"workspace_id":"workspace_123","dataset_id":"dataset_456","report_id":"report_789","credentials_ref":"cred_power_bi_1"`,
			assertKey:      "dataset_id",
			assertValue:    "dataset_456",
		},
		{
			name:           "mode",
			provider:       ProviderMode,
			credentialsRef: "cred_mode_1",
			settings:       `"workspace_id":"workspace_123","report_id":"report_456","collection_id":"collection_789","credentials_ref":"cred_mode_1"`,
			assertKey:      "workspace_id",
			assertValue:    "workspace_123",
		},
		{
			name:           "metabase",
			provider:       ProviderMetabase,
			credentialsRef: "cred_metabase_1",
			settings:       `"instance_url":"https://metabase.example.com","database_id":"db_123","collection_id":"collection_456","credentials_ref":"cred_metabase_1"`,
			assertKey:      "instance_url",
			assertValue:    "https://metabase.example.com",
		},
		{
			name:           "sisense",
			provider:       ProviderSisense,
			credentialsRef: "cred_sisense_1",
			settings:       `"instance_url":"https://sisense.example.com","dashboard_id":"dash_123","datamodel_id":"model_456","credentials_ref":"cred_sisense_1"`,
			assertKey:      "datamodel_id",
			assertValue:    "model_456",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeStore()
			deps := &Deps{Repo: store}

			rec := httptest.NewRecorder()
			deps.CreateIntegration(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations", `{
				"provider":"`+tt.provider+`",
				"settings":{`+tt.settings+`}
			}`))
			if rec.Code != http.StatusCreated {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if store.lastInput.Provider != tt.provider || store.lastInput.CredentialsRef != tt.credentialsRef {
				t.Fatalf("input=%+v", store.lastInput)
			}
			if store.lastInput.Settings[tt.assertKey] != tt.assertValue ||
				store.lastInput.Settings["setup_surface"] != "analytics_integrations" ||
				store.lastInput.Settings["managed_by_postwave"] != true {
				t.Fatalf("settings=%+v", store.lastInput.Settings)
			}
		})
	}
}

func TestCreatePostHogIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations", `{
		"provider":"posthog",
		"settings":{
			"project_id":"project_123",
			"host":"https://app.posthog.com",
			"credentials_ref":"cred_posthog_1",
			"webhook_secret_ref":"cred_posthog_webhook_1"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderPostHog || store.lastInput.CredentialsRef != "cred_posthog_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if !hasString(store.lastInput.Scopes, "persons:read") || store.lastInput.Settings["webhook_secret_ref"] != nil {
		t.Fatalf("PostHog puller create should persist read scopes but no fake webhook secret refs: input=%+v settings=%+v", store.lastInput, store.lastInput.Settings)
	}
	if store.lastInput.Settings["project_id"] != "project_123" ||
		store.lastInput.Settings["setup_surface"] != "analytics_integrations" ||
		store.lastInput.Settings["managed_by_postwave"] != true ||
		store.lastInput.Settings["sync_model"] != postHogSyncModelPuller {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
}

func TestCreateIntegrationRequiresCredentialRefAndRejectsRawToken(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations", `{
		"provider":"segment",
		"settings":{"source_id":"src_123","write_key":"secret"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("raw token status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations", `{
		"provider":"segment",
		"settings":{"source_id":"src_123","credentials_ref":"cred_segment_1"}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderSegment || store.lastInput.CredentialsRef != "cred_segment_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["write_key"] != nil || store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations", `{
		"provider":"segment",
		"settings":{"source_id":"src_123","credentials_ref":"Bearer raw-provider-token"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("raw-looking credentials_ref status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestCreateIntegrationStripsUnverifiedWebhookCredentialRefs(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations", `{
		"provider":"posthog",
		"settings":{
			"project_id":"project_123",
			"credentials_ref":"cred_posthog_1",
			"webhook_secret_ref":"cred_posthog_webhook_1",
			"webhook_token_ref":"cred_posthog_webhook_2",
			"signing_secret_ref":"cred_posthog_webhook_3",
			"signature_secret_ref":"cred_posthog_webhook_4",
			"verification_token_ref":"cred_posthog_webhook_5"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	for _, key := range []string{"webhook_secret_ref", "webhook_token_ref", "signing_secret_ref", "signature_secret_ref", "verification_token_ref"} {
		if store.lastInput.Settings[key] != nil {
			t.Fatalf("%s should be stripped until provider raw-body verification is wired: settings=%+v", key, store.lastInput.Settings)
		}
	}
	if store.lastInput.Settings["credentials_ref"] != "cred_posthog_1" {
		t.Fatalf("credential reference should be preserved: settings=%+v", store.lastInput.Settings)
	}
}

func TestSyncIntegrationUpsertsProfilesAndTracksEvents(t *testing.T) {
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
	deps.SyncIntegration(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/analytics_1/sync", `{
		"cursor":"after-123",
		"profiles":[{"source_id":"p1","email":"VIP@Example.com","user_id":"u1","traits":{"plan":"pro"}}],
		"events":[{"source_id":"e1","email":"vip@example.com","event_name":"Product Viewed","properties":{"sku":"coffee"}}]
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "completed" || out.ProfilesUpserted != 1 || out.EventsTracked != 1 || out.RunID == "" {
		t.Fatalf("summary=%+v", out)
	}
	if len(profiles.profiles) != 1 || profiles.profiles[0].Email != "vip@example.com" {
		t.Fatalf("profiles=%+v", profiles.profiles)
	}
	if len(events.events) != 1 || events.events[0].EventName != "Product Viewed" {
		t.Fatalf("events=%+v", events.events)
	}
}

func TestSyncIntegrationRequiresCanonicalAnalyticsRows(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
		Events:   &fakeEventSink{},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/analytics_1/sync", `{"cursor":"after-123"}`))

	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "payload_required") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("empty analytics sync should not record a provider-pull-like run: %+v", store.runs)
	}
}

func TestSyncIntegrationRejectsDisconnectedBeforeProviderPull(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderPostHog
	store.integration.Status = "disconnected"
	store.integration.Settings = map[string]any{"project_id": "project_123"}
	backfiller := &fakeAnalyticsBackfiller{req: SyncRequest{Profiles: []ProfileInput{{Email: "one@example.com"}}, Cursor: postHogCursorComplete}}
	deps := &Deps{
		Repo:              store,
		Profiles:          &fakeProfileSink{},
		PostHogBackfiller: backfiller,
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/analytics_1/sync", `{}`))

	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.calls != 0 || len(store.runs) != 0 {
		t.Fatalf("disconnected row should block provider calls and run writes; calls=%d runs=%+v", backfiller.calls, store.runs)
	}
}

func TestAnalyticsPullerRetryCursorHonorsRetryAfter(t *testing.T) {
	now := time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderPostHog
	store.integration.Settings = map[string]any{"project_id": "project_123"}
	backfiller := &fakeAnalyticsBackfiller{err: AnalyticsRESTError{StatusCode: http.StatusTooManyRequests, RetryAfter: 17 * time.Minute, Snippet: "slow down"}}
	deps := &Deps{
		Repo:              store,
		PostHogBackfiller: backfiller,
		Now:               func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/analytics_1/sync", `{}`))

	if rec.Code != http.StatusBadGateway || len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("status=%d body=%s runs=%+v", rec.Code, rec.Body.String(), store.runs)
	}
	retry, ok, err := decodeAnalyticsProviderRetryCursor(ProviderPostHog, store.runs[0].CursorTo)
	if !ok || err != nil {
		t.Fatalf("decode retry ok=%v err=%v cursor=%q", ok, err, store.runs[0].CursorTo)
	}
	if retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(17*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationSkipsNotDueAnalyticsRetryCursor(t *testing.T) {
	now := time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
	retryCursor := encodeAnalyticsProviderRetryCursor(ProviderPostHog, analyticsProviderRetryState{
		Cursor:        "posthog:https://example.test/next",
		Attempts:      1,
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
		LastStatus:    "BACKFILL_FAILED",
	})
	store := newFakeStore()
	store.integration.Provider = ProviderPostHog
	store.integration.SyncCursor = retryCursor
	store.integration.Status = "error"
	store.integration.ErrorMessage = "provider throttled"
	store.integration.Settings = map[string]any{"project_id": "project_123"}
	backfiller := &fakeAnalyticsBackfiller{req: SyncRequest{Profiles: []ProfileInput{{Email: "one@example.com"}}, Cursor: postHogCursorComplete}}
	deps := &Deps{
		Repo:              store,
		Profiles:          &fakeProfileSink{},
		PostHogBackfiller: backfiller,
		Now:               func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/analytics_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var summary SyncSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &summary); err != nil || summary.Status != "deferred" || summary.Cursor != retryCursor {
		t.Fatal("not-due retry must report deferred instead of a completed import")
	}
	if _, err := deps.backfillPageOnce(context.Background(), "tenant-1", &store.integration, ""); err != nil {
		t.Fatal(err)
	}
	if backfiller.calls != 0 || len(store.runs) != 0 || store.integration.Status != "error" || store.integration.ErrorMessage != "provider throttled" || store.integration.SyncCursor != retryCursor {
		t.Fatalf("not-due retry should preserve cursor without provider call; calls=%d runs=%+v", backfiller.calls, store.runs)
	}
}

func TestDisconnectAnalyticsPullerReturnsAndPersistsProviderCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderPostHog
	store.integration.Settings = map[string]any{"project_id": "project_123"}
	deps := &Deps{Repo: store, Now: func() time.Time { return time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC) }}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, analyticsReq(http.MethodDelete, "/api/v1/analytics-integrations/analytics_1", ``))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	cleanup, _ := out["provider_cleanup"].(map[string]any)
	if cleanup["provider"] != ProviderPostHog || cleanup["provider_scope_type"] != "posthog_project" || cleanup["provider_scope_id"] != "project_123" {
		t.Fatalf("cleanup=%+v", cleanup)
	}
	if store.integration.Status != "disconnected" || store.integration.Settings["provider_cleanup"] == nil {
		t.Fatalf("cleanup not persisted: integration=%+v", store.integration)
	}
}

func TestAcknowledgeAnalyticsProviderCleanupMergesEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderPostHog
	store.integration.Status = "disconnected"
	store.integration.Settings = map[string]any{
		"provider_cleanup": analyticsDisconnectCleanupEvidence(Integration{Provider: ProviderPostHog, Settings: map[string]any{"project_id": "project_123"}}, time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)),
	}
	deps := &Deps{Repo: store, Now: func() time.Time { return time.Date(2026, 7, 3, 13, 0, 0, 0, time.UTC) }}

	rec := httptest.NewRecorder()
	deps.AcknowledgeProviderCleanup(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/analytics_1/provider-cleanup/acknowledge", `{
		"completed_actions":["provider_api_credentials_rotated"],
		"notes":"Credential revoked in provider console"
	}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	cleanup := store.integration.Settings["provider_cleanup"].(map[string]any)
	if cleanup["status"] != "operator_acknowledged" || cleanup["operator_notes"] != "Credential revoked in provider console" {
		t.Fatalf("cleanup=%+v", cleanup)
	}
}

func TestIngestEventRecordsWebhookRun(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:   store,
		Events: &fakeEventSink{},
	}
	rec := httptest.NewRecorder()
	deps.IngestEvent(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/analytics_1/ingest", `{
		"source_id":"e1",
		"email":"vip@example.com",
		"event_name":"Checkout Started"
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].EventsTracked != 1 {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestBackfillForcesRunModeAndSinkFailureFailsRun(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
	}

	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/analytics_1/backfill", `{
		"run_mode":"manual",
		"profiles":[{"email":"one@example.com"}]
	}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" {
		t.Fatalf("runs=%+v", store.runs)
	}

	deps = &Deps{
		Repo:     newFakeStore(),
		Profiles: &fakeProfileSink{err: errors.New("boom")},
	}
	rec = httptest.NewRecorder()
	deps.SyncIntegration(rec, analyticsReq(http.MethodPost, "/api/v1/analytics-integrations/analytics_1/sync", `{
		"profiles":[{"email":"one@example.com"}]
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
