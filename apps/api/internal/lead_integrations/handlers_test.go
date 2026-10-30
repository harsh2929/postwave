// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeStore struct {
	integration  Integration
	integrations []Integration
	runs         []SyncRun
	lastInput    IntegrationInput
	paused       bool
	deleted      bool
	webhooks     map[string]WebhookClaim
	upsertErr    error
	recordErr    error
}

func newFakeStore() *fakeStore {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	return &fakeStore{integration: Integration{
		ID:             "lead_1",
		TenantID:       "tenant-1",
		Provider:       ProviderTypeform,
		Name:           "Typeform lead form",
		Status:         "connected",
		Scopes:         []string{"forms:read"},
		CredentialsRef: "cred_typeform_1",
		Settings:       map[string]any{"form_id": "abc123"},
		CreatedAt:      now,
		UpdatedAt:      now,
	}}
}

func (f *fakeStore) ListIntegrations(context.Context, string) ([]Integration, error) {
	if len(f.integrations) > 0 {
		return f.integrations, nil
	}
	return []Integration{f.integration}, nil
}
func (f *fakeStore) GetIntegration(context.Context, string, string) (*Integration, error) {
	return &f.integration, nil
}
func (f *fakeStore) FindIntegrationByTenantProviderName(_ context.Context, tenantID, provider, name string) (*Integration, error) {
	if tenantID == f.integration.TenantID && provider == f.integration.Provider && name == f.integration.Name {
		return &f.integration, nil
	}
	return nil, ErrNotFound
}
func (f *fakeStore) UpsertIntegration(_ context.Context, tenantID string, in IntegrationInput) (*Integration, error) {
	if f.upsertErr != nil {
		return nil, f.upsertErr
	}
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
func (f *fakeStore) RecordSyncRun(_ context.Context, _ string, _ string, summary SyncSummary, req SyncRequest, started, completed time.Time) (*SyncRun, error) {
	if f.recordErr != nil {
		return nil, f.recordErr
	}
	run := SyncRun{
		ID:                  "run_1",
		IntegrationID:       summary.IntegrationID,
		RunMode:             req.RunMode,
		Status:              summary.Status,
		CursorTo:            summary.Cursor,
		SubmissionsSeen:     summary.SubmissionsSeen,
		SubscribersUpserted: summary.SubscribersUpserted,
		EventsTracked:       summary.EventsTracked,
		RowsFailed:          summary.RowsFailed,
		ErrorMessage:        summary.ErrorMessage,
		StartedAt:           started,
		CompletedAt:         &completed,
		CreatedAt:           completed,
	}
	f.runs = append(f.runs, run)
	return &run, nil
}
func (f *fakeStore) ListRuns(context.Context, string, string, int) ([]SyncRun, error) {
	return f.runs, nil
}
func (f *fakeStore) ClaimWebhook(_ context.Context, _ string, _ string, provider, webhookID, _ string, _ []byte) (WebhookClaim, error) {
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
func (f *fakeStore) MarkWebhookProcessed(_ context.Context, _ string, provider, webhookID string) error {
	if f.webhooks == nil {
		f.webhooks = map[string]WebhookClaim{}
	}
	f.webhooks[provider+":"+webhookID] = WebhookProcessed
	return nil
}
func (f *fakeStore) MarkWebhookFailed(_ context.Context, _ string, provider, webhookID string, _ error) error {
	if f.webhooks == nil {
		f.webhooks = map[string]WebhookClaim{}
	}
	f.webhooks[provider+":"+webhookID] = ""
	return nil
}
func (f *fakeStore) FindIntegrationByProviderFormID(_ context.Context, provider, formID string) (*Integration, error) {
	if provider == f.integration.Provider && formID == settingString(f.integration.Settings, "form_id") {
		return &f.integration, nil
	}
	return nil, ErrNotFound
}
func (f *fakeStore) FindFacebookLeadAdsIntegrationByPageAndForm(_ context.Context, pageID, formID string) (*Integration, error) {
	for _, integration := range f.candidateIntegrations() {
		if integration.Provider == ProviderFacebookLeadAds &&
			strings.EqualFold(pageID, settingString(integration.Settings, "page_id")) &&
			strings.EqualFold(formID, settingString(integration.Settings, "form_id")) {
			return &integration, nil
		}
	}
	return nil, ErrNotFound
}
func (f *fakeStore) FindIntegrationByProviderInstanceID(_ context.Context, provider, instanceID string) (*Integration, error) {
	if provider == f.integration.Provider && instanceID == settingString(f.integration.Settings, "instance_id") {
		return &f.integration, nil
	}
	return nil, ErrNotFound
}
func (f *fakeStore) FindIntegrationByProviderSiteID(_ context.Context, provider, siteID string) (*Integration, error) {
	for _, integration := range f.candidateIntegrations() {
		candidateSiteID := firstString(settingString(integration.Settings, "site_id"), settingString(integration.Settings, "webflow_site_id"), settingString(integration.Settings, "provider_site_id"), settingString(integration.Settings, "site_url"), settingString(integration.Settings, "wordpress_site_url"), settingString(integration.Settings, "provider_site_url"))
		if provider == integration.Provider && strings.EqualFold(strings.TrimRight(siteID, "/"), strings.TrimRight(candidateSiteID, "/")) {
			return &integration, nil
		}
	}
	return nil, ErrNotFound
}
func (f *fakeStore) FindIntegrationByProviderSiteAndForm(_ context.Context, provider, siteID, formID, formElementID string) (*Integration, error) {
	var best *Integration
	bestScore := -1
	for _, integration := range f.candidateIntegrations() {
		candidateSiteID := firstString(settingString(integration.Settings, "site_id"), settingString(integration.Settings, "webflow_site_id"), settingString(integration.Settings, "provider_site_id"), settingString(integration.Settings, "site_url"), settingString(integration.Settings, "wordpress_site_url"), settingString(integration.Settings, "provider_site_url"))
		if provider != integration.Provider || !strings.EqualFold(strings.TrimRight(siteID, "/"), strings.TrimRight(candidateSiteID, "/")) {
			continue
		}
		score := 0
		if filter := firstString(settingString(integration.Settings, "form_id"), settingString(integration.Settings, "webflow_form_id"), settingString(integration.Settings, "provider_form_id"), settingString(integration.Settings, "campaign_id"), settingString(integration.Settings, "campaign"), settingString(integration.Settings, "provider_campaign_id"), settingString(integration.Settings, "bar_id"), settingString(integration.Settings, "hello_bar_id")); filter != "" {
			if !strings.EqualFold(filter, formID) {
				continue
			}
			score += 2
		}
		if filter := firstString(settingString(integration.Settings, "form_element_id"), settingString(integration.Settings, "element_id"), settingString(integration.Settings, "webflow_form_element_id"), settingString(integration.Settings, "provider_form_element_id")); filter != "" {
			if !strings.EqualFold(filter, formElementID) {
				continue
			}
			score++
		}
		candidate := integration
		if score > bestScore || (score == bestScore && candidate.UpdatedAt.After(best.UpdatedAt)) {
			best = &candidate
			bestScore = score
		}
	}
	if best != nil {
		return best, nil
	}
	return nil, ErrNotFound
}

func (f *fakeStore) FindIntegrationByProviderAccountAndCampaign(_ context.Context, provider, accountID, campaignID string) (*Integration, error) {
	for _, integration := range f.candidateIntegrations() {
		candidateAccountID := firstString(settingString(integration.Settings, "account_id"), settingString(integration.Settings, "provider_account_id"))
		if provider != integration.Provider || !strings.EqualFold(accountID, candidateAccountID) {
			continue
		}
		for _, candidateCampaignID := range []string{
			settingString(integration.Settings, "campaign_id"),
			settingString(integration.Settings, "campaign"),
			settingString(integration.Settings, "provider_campaign_id"),
			settingString(integration.Settings, "popup_id"),
			settingString(integration.Settings, "poptin_id"),
			settingString(integration.Settings, "page_id"),
			settingString(integration.Settings, "landing_page_id"),
			settingString(integration.Settings, "landingi_page_id"),
			settingString(integration.Settings, "outgrow_campaign_id"),
			settingString(integration.Settings, "content_id"),
			settingString(integration.Settings, "calculator_id"),
			settingString(integration.Settings, "quiz_id"),
			settingString(integration.Settings, "riddle_id"),
			settingString(integration.Settings, "experience_id"),
		} {
			if strings.EqualFold(campaignID, candidateCampaignID) {
				candidate := integration
				return &candidate, nil
			}
		}
	}
	return nil, ErrNotFound
}

func (f *fakeStore) candidateIntegrations() []Integration {
	if len(f.integrations) > 0 {
		return f.integrations
	}
	return []Integration{f.integration}
}

type fakeProfileSink struct {
	submissions []SubmissionInput
	err         error
}

func (f *fakeProfileSink) UpsertLeadSubmission(_ context.Context, _ string, _ string, submission SubmissionInput) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.submissions = append(f.submissions, submission)
	return "sub_1", nil
}

type fakeEventSink struct {
	submissions []SubmissionInput
	err         error
}

func (f *fakeEventSink) TrackLeadSubmission(_ context.Context, _ string, _ string, submission SubmissionInput) (int64, error) {
	if f.err != nil {
		return 0, f.err
	}
	f.submissions = append(f.submissions, submission)
	return int64(len(f.submissions)), nil
}

type recordingLeadBackfiller struct {
	req         SyncRequest
	err         error
	cursor      string
	integration Integration
	tenantID    string
	called      bool
}

func (f *recordingLeadBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeTypeformBackfiller struct {
	req         SyncRequest
	err         error
	cursor      string
	integration Integration
	tenantID    string
	called      bool
}

func (f *fakeTypeformBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeTypeformCredentialResolver struct {
	creds TypeformCredentials
	err   error
}

func (f fakeTypeformCredentialResolver) ResolveTypeform(context.Context, string, Integration) (TypeformCredentials, error) {
	if f.err != nil {
		return TypeformCredentials{}, f.err
	}
	return f.creds, nil
}

type fakeTypeformWebhookRegistrar struct {
	reconcileSummary TypeformWebhookReconcileSummary
	cleanupSummary   TypeformWebhookCleanupSummary
	reconcileErr     error
	cleanupErr       error
	reconcileCalls   int
	cleanupCalls     int
	lastIntegration  Integration
	lastBaseURL      string
}

func (f *fakeTypeformWebhookRegistrar) ReconcileWebhook(_ context.Context, integration Integration, appBaseURL string) (TypeformWebhookReconcileSummary, error) {
	f.reconcileCalls++
	f.lastIntegration = integration
	f.lastBaseURL = appBaseURL
	if f.reconcileErr != nil {
		return TypeformWebhookReconcileSummary{}, f.reconcileErr
	}
	if f.reconcileSummary.WebhookID == "" {
		f.reconcileSummary = TypeformWebhookReconcileSummary{
			WebhookID:    "typeform_wh_123",
			Tag:          typeformWebhookTag(integration),
			Endpoint:     typeformWebhookEndpoint(appBaseURL),
			EventTypes:   typeformWebhookEventTypes(integration),
			RegisteredAt: time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
			Upserted:     true,
			Verified:     true,
			VerifiedAt:   time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
		}
	}
	return f.reconcileSummary, nil
}

func (f *fakeTypeformWebhookRegistrar) CleanupWebhook(_ context.Context, integration Integration, appBaseURL string) (TypeformWebhookCleanupSummary, error) {
	f.cleanupCalls++
	f.lastIntegration = integration
	f.lastBaseURL = appBaseURL
	if f.cleanupErr != nil {
		return TypeformWebhookCleanupSummary{}, f.cleanupErr
	}
	if f.cleanupSummary.Tag == "" {
		f.cleanupSummary = TypeformWebhookCleanupSummary{
			WebhookID:   settingString(integration.Settings, "typeform_webhook_id"),
			Tag:         typeformWebhookTag(integration),
			Endpoint:    settingString(integration.Settings, "typeform_webhook_endpoint"),
			CleanedUpAt: time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
			Deleted:     true,
		}
	}
	return f.cleanupSummary, nil
}

type fakeWixBackfiller struct {
	req         SyncRequest
	err         error
	cursor      string
	integration Integration
	tenantID    string
	called      bool
}

func (f *fakeWixBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeWixCredentialResolver struct {
	creds WixCredentials
	err   error
}

func (f fakeWixCredentialResolver) ResolveWix(context.Context, string, Integration) (WixCredentials, error) {
	if f.err != nil {
		return WixCredentials{}, f.err
	}
	return f.creds, nil
}

type fakeJotformBackfiller struct {
	req         SyncRequest
	err         error
	cursor      string
	integration Integration
	tenantID    string
	called      bool
}

func (f *fakeJotformBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeJotformCredentialResolver struct {
	creds JotformCredentials
	err   error
}

func (f fakeJotformCredentialResolver) ResolveJotform(context.Context, string, Integration) (JotformCredentials, error) {
	if f.err != nil {
		return JotformCredentials{}, f.err
	}
	return f.creds, nil
}

type fakeJotformWebhookRegistrar struct {
	reconcileSummary JotformWebhookReconcileSummary
	cleanupSummary   JotformWebhookCleanupSummary
	reconcileErr     error
	cleanupErr       error
	reconcileCalls   int
	cleanupCalls     int
	lastIntegration  Integration
	lastBaseURL      string
}

func (f *fakeJotformWebhookRegistrar) ReconcileWebhook(_ context.Context, integration Integration, appBaseURL string) (JotformWebhookReconcileSummary, error) {
	f.reconcileCalls++
	f.lastIntegration = integration
	f.lastBaseURL = appBaseURL
	if f.reconcileErr != nil {
		return JotformWebhookReconcileSummary{}, f.reconcileErr
	}
	if f.reconcileSummary.WebhookID == "" {
		endpoint, _, _ := jotformWebhookURLs(appBaseURL, settingString(integration.Settings, "form_id"), "")
		f.reconcileSummary = JotformWebhookReconcileSummary{
			WebhookID:    "jotform_wh_123",
			Endpoint:     endpoint,
			RegisteredAt: time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
			Created:      true,
		}
	}
	return f.reconcileSummary, nil
}

func (f *fakeJotformWebhookRegistrar) CleanupWebhook(_ context.Context, integration Integration, appBaseURL string) (JotformWebhookCleanupSummary, error) {
	f.cleanupCalls++
	f.lastIntegration = integration
	f.lastBaseURL = appBaseURL
	if f.cleanupErr != nil {
		return JotformWebhookCleanupSummary{}, f.cleanupErr
	}
	if f.cleanupSummary.WebhookID == "" {
		f.cleanupSummary = JotformWebhookCleanupSummary{
			WebhookID:   settingString(integration.Settings, "jotform_webhook_id"),
			Endpoint:    settingString(integration.Settings, "jotform_webhook_endpoint"),
			CleanedUpAt: time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
			Deleted:     true,
		}
	}
	return f.cleanupSummary, nil
}

type fakeWebflowBackfiller struct {
	req         SyncRequest
	err         error
	cursor      string
	integration Integration
	tenantID    string
	called      bool
}

func (f *fakeWebflowBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeWebflowCredentialResolver struct {
	creds WebflowCredentials
	err   error
}

func (f fakeWebflowCredentialResolver) ResolveWebflow(context.Context, string, Integration) (WebflowCredentials, error) {
	if f.err != nil {
		return WebflowCredentials{}, f.err
	}
	return f.creds, nil
}

type fakeWebflowWebhookRegistrar struct {
	reconcileSummary WebflowWebhookReconcileSummary
	cleanupSummary   WebflowWebhookCleanupSummary
	reconcileErr     error
	cleanupErr       error
	reconcileCalls   int
	cleanupCalls     int
	lastIntegration  Integration
	lastBaseURL      string
}

func (f *fakeWebflowWebhookRegistrar) ReconcileWebhook(_ context.Context, integration Integration, appBaseURL string) (WebflowWebhookReconcileSummary, error) {
	f.reconcileCalls++
	f.lastIntegration = integration
	f.lastBaseURL = appBaseURL
	if f.reconcileErr != nil {
		return WebflowWebhookReconcileSummary{}, f.reconcileErr
	}
	if f.reconcileSummary.WebhookID == "" {
		f.reconcileSummary = WebflowWebhookReconcileSummary{
			WebhookID:    "webflow_wh_123",
			Endpoint:     webflowWebhookEndpoint(appBaseURL),
			TriggerType:  "form_submission",
			Filter:       webflowWebhookFilter(integration),
			RegisteredAt: time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
			Created:      true,
		}
	}
	return f.reconcileSummary, nil
}

func (f *fakeWebflowWebhookRegistrar) CleanupWebhook(_ context.Context, integration Integration, appBaseURL string) (WebflowWebhookCleanupSummary, error) {
	f.cleanupCalls++
	f.lastIntegration = integration
	f.lastBaseURL = appBaseURL
	if f.cleanupErr != nil {
		return WebflowWebhookCleanupSummary{}, f.cleanupErr
	}
	if f.cleanupSummary.WebhookID == "" {
		f.cleanupSummary = WebflowWebhookCleanupSummary{
			WebhookID:   settingString(integration.Settings, "webflow_webhook_id"),
			Endpoint:    settingString(integration.Settings, "webflow_webhook_endpoint"),
			CleanedUpAt: time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
			Deleted:     true,
		}
	}
	return f.cleanupSummary, nil
}

type fakeFilloutBackfiller struct {
	req         SyncRequest
	err         error
	cursor      string
	integration Integration
	tenantID    string
	called      bool
}

func (f *fakeFilloutBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeFilloutCredentialResolver struct {
	creds FilloutCredentials
	err   error
}

func (f fakeFilloutCredentialResolver) ResolveFillout(context.Context, string, Integration) (FilloutCredentials, error) {
	if f.err != nil {
		return FilloutCredentials{}, f.err
	}
	return f.creds, nil
}

type fakeTallyBackfiller struct {
	req         SyncRequest
	err         error
	cursor      string
	integration Integration
	tenantID    string
	called      bool
}

func (f *fakeTallyBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeFacebookLeadAdsBackfiller struct {
	req         SyncRequest
	err         error
	cursor      string
	integration Integration
	tenantID    string
	called      bool
}

func (f *fakeFacebookLeadAdsBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeFacebookLeadAdsCredentialResolver struct {
	creds FacebookLeadAdsCredentials
	err   error
}

func (f fakeFacebookLeadAdsCredentialResolver) ResolveFacebookLeadAds(context.Context, string, Integration) (FacebookLeadAdsCredentials, error) {
	if f.err != nil {
		return FacebookLeadAdsCredentials{}, f.err
	}
	return f.creds, nil
}

type fakeFacebookLeadAdsPageSubscriptionRegistrar struct {
	reconcileSummary FacebookLeadAdsPageSubscriptionSummary
	cleanupSummary   FacebookLeadAdsPageSubscriptionCleanupSummary
	reconcileErr     error
	cleanupErr       error
	reconcileCalls   int
	cleanupCalls     int
	lastIntegration  Integration
	lastBaseURL      string
}

func (f *fakeFacebookLeadAdsPageSubscriptionRegistrar) ReconcilePageSubscription(_ context.Context, integration Integration, appBaseURL string) (FacebookLeadAdsPageSubscriptionSummary, error) {
	f.reconcileCalls++
	f.lastIntegration = integration
	f.lastBaseURL = appBaseURL
	if f.reconcileErr != nil {
		return FacebookLeadAdsPageSubscriptionSummary{}, f.reconcileErr
	}
	if f.reconcileSummary.PageID == "" {
		f.reconcileSummary = FacebookLeadAdsPageSubscriptionSummary{
			PageID:       settingString(integration.Settings, "page_id"),
			Fields:       []string{"leadgen"},
			Endpoint:     facebookLeadAdsWebhookEndpoint(appBaseURL),
			Subscribed:   true,
			ReconciledAt: time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
		}
	}
	return f.reconcileSummary, nil
}

func (f *fakeFacebookLeadAdsPageSubscriptionRegistrar) CleanupPageSubscription(_ context.Context, integration Integration, appBaseURL string) (FacebookLeadAdsPageSubscriptionCleanupSummary, error) {
	f.cleanupCalls++
	f.lastIntegration = integration
	f.lastBaseURL = appBaseURL
	if f.cleanupErr != nil {
		return FacebookLeadAdsPageSubscriptionCleanupSummary{}, f.cleanupErr
	}
	if f.cleanupSummary.PageID == "" {
		f.cleanupSummary = FacebookLeadAdsPageSubscriptionCleanupSummary{
			PageID:      firstString(settingString(integration.Settings, "facebook_lead_ads_page_subscription_page_id"), settingString(integration.Settings, "page_id")),
			Fields:      []string{"leadgen"},
			Endpoint:    settingString(integration.Settings, "facebook_lead_ads_page_subscription_endpoint"),
			Deleted:     true,
			CleanedUpAt: time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
		}
	}
	return f.cleanupSummary, nil
}

type fakeGoogleLeadFormsBackfiller struct {
	req         SyncRequest
	err         error
	cursor      string
	integration Integration
	tenantID    string
	called      bool
}

func (f *fakeGoogleLeadFormsBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.tenantID = tenantID
	f.integration = integration
	f.cursor = cursor
	return f.req, f.err
}

type fakeGoogleLeadFormsCredentialResolver struct {
	creds GoogleLeadFormsCredentials
	err   error
}

func (f fakeGoogleLeadFormsCredentialResolver) ResolveGoogleLeadForms(context.Context, string, Integration) (GoogleLeadFormsCredentials, error) {
	if f.err != nil {
		return GoogleLeadFormsCredentials{}, f.err
	}
	return f.creds, nil
}

type fakeFilloutWebhookRegistrar struct {
	reconcileSummary FilloutWebhookReconcileSummary
	cleanupSummary   FilloutWebhookCleanupSummary
	reconcileErr     error
	cleanupErr       error
	reconcileCalls   int
	cleanupCalls     int
	lastIntegration  Integration
	lastBaseURL      string
}

func (f *fakeFilloutWebhookRegistrar) ReconcileWebhook(_ context.Context, integration Integration, appBaseURL string) (FilloutWebhookReconcileSummary, error) {
	f.reconcileCalls++
	f.lastIntegration = integration
	f.lastBaseURL = appBaseURL
	if f.reconcileErr != nil {
		return FilloutWebhookReconcileSummary{}, f.reconcileErr
	}
	if f.reconcileSummary.WebhookID == "" {
		f.reconcileSummary = FilloutWebhookReconcileSummary{
			WebhookID:    "fillout_wh_123",
			Endpoint:     filloutWebhookEndpoint(appBaseURL, settingString(integration.Settings, "form_id")),
			RegisteredAt: time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
			Created:      true,
		}
	}
	return f.reconcileSummary, nil
}

func (f *fakeFilloutWebhookRegistrar) CleanupWebhook(_ context.Context, integration Integration, appBaseURL string) (FilloutWebhookCleanupSummary, error) {
	f.cleanupCalls++
	f.lastIntegration = integration
	f.lastBaseURL = appBaseURL
	if f.cleanupErr != nil {
		return FilloutWebhookCleanupSummary{}, f.cleanupErr
	}
	if f.cleanupSummary.WebhookID == "" {
		f.cleanupSummary = FilloutWebhookCleanupSummary{
			WebhookID:   settingString(integration.Settings, "fillout_webhook_id"),
			Endpoint:    settingString(integration.Settings, "fillout_webhook_endpoint"),
			CleanedUpAt: time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
			Deleted:     true,
		}
	}
	return f.cleanupSummary, nil
}

func leadReq(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
}

func TestListProvidersIncludesLeadCaptureNatives(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{Repo: newFakeStore()}).ListProviders(rec, httptest.NewRequest(http.MethodGet, "/api/v1/lead-integrations/providers", nil))

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
	for _, provider := range []string{
		ProviderTypeform,
		ProviderJotform,
		ProviderGoogleForms,
		ProviderMicrosoftForms,
		ProviderSurveyMonkey,
		ProviderFacebookLeadAds,
		ProviderLinkedInLeadGen,
		ProviderGoogleLeadForms,
		ProviderTikTokLeadGen,
		ProviderSnapLeadAds,
		ProviderRedditLeadGen,
		ProviderPinterestLeads,
		ProviderUnbounce,
		ProviderLeadpages,
		ProviderInstapage,
		ProviderCarrd,
		ProviderPaperform,
		ProviderFormstack,
		ProviderFillout,
		ProviderOptinMonster,
		ProviderPrivy,
		ProviderConvertFlow,
		ProviderSleeknote,
		ProviderWisepops,
		ProviderPoptin,
		ProviderHelloBar,
		ProviderUnstack,
		ProviderLandingi,
		ProviderKickoffLabs,
		ProviderShortStack,
		ProviderFormsite,
		ProviderCognitoForms,
		ProviderNinjaForms,
		ProviderFormidableForms,
		ProviderInteract,
		ProviderOutgrow,
		ProviderRiddle,
		ProviderQualtricsForms,
		ProviderFeathery,
		ProviderFormaloo,
		Provider123FormBuilder,
		ProviderTally,
		ProviderGravityForms,
		ProviderWPForms,
		ProviderWordPress,
		ProviderWebflow,
		ProviderWix,
	} {
		item, ok := seen[provider]
		if !ok || !item.Managed {
			t.Fatalf("provider %q missing or unmanaged: %+v", provider, res.Items)
		}
	}
	squarespace, ok := seen[ProviderSquarespace]
	if !ok {
		t.Fatalf("bridge provider %q missing: %+v", ProviderSquarespace, res.Items)
	}
	if squarespace.Managed || squarespace.RuntimeStatus != "delegated" || squarespace.SyncModel != "bridge_only" {
		t.Fatalf("Squarespace should be bridge-only, got %+v", squarespace)
	}
}

func TestProviderSpecsExposeIngestModelWithoutWebhookSecretClaims(t *testing.T) {
	spec, ok := ProviderSpecByKey(ProviderTypeform)
	if !ok {
		t.Fatal("missing Typeform spec")
	}
	if spec.SyncModel != "typeform_responses_webhook_backfill" || spec.VerificationMode != "typeform_hmac_sha256" {
		t.Fatalf("unexpected Typeform precision metadata: %+v", spec)
	}
	if len(spec.Scopes) == 0 || !containsFold(spec.Scopes, "responses:read") || !containsFold(spec.Scopes, "webhooks:write") {
		t.Fatalf("Typeform should publish provider scopes now that pull/webhook runtime exists: %+v", spec.Scopes)
	}
	if len(spec.WebhookTopics) != 1 || spec.WebhookTopics[0] != "form_response" {
		t.Fatalf("Typeform should publish verified webhook topic, got %+v", spec.WebhookTopics)
	}
	if len(spec.SyncObjects) != 2 || spec.SyncObjects[0] != "forms" || spec.SyncObjects[1] != "responses" {
		t.Fatalf("Typeform should expose provider pull objects, got %+v", spec.SyncObjects)
	}
	hasWebhookSecret := false
	for _, field := range spec.OptionalSettings {
		if field.Key == "webhook_secret_ref" {
			hasWebhookSecret = true
		}
	}
	if !hasWebhookSecret {
		t.Fatalf("Typeform should advertise webhook_secret_ref after raw-body verification wiring: %+v", spec.OptionalSettings)
	}

	wix, ok := ProviderSpecByKey(ProviderWix)
	if !ok {
		t.Fatal("missing Wix spec")
	}
	if wix.SyncModel != "wix_forms_contacts_jwt_webhook_backfill" || wix.VerificationMode != "wix_rs256_jwt_or_shared_secret" {
		t.Fatalf("unexpected Wix precision metadata: %+v", wix)
	}
	if wix.AuthMode != "oauth_app_instance_ref" {
		t.Fatalf("Wix should expose app-instance OAuth auth mode, got %+v", wix.AuthMode)
	}
	if len(wix.Scopes) == 0 || !containsFold(wix.Scopes, "contacts.read") || !containsFold(wix.Scopes, "forms.submissions.read") || !containsFold(wix.Scopes, "manage-your-app") {
		t.Fatalf("Wix should publish provider scopes now that pull/webhook runtime exists: %+v", wix.Scopes)
	}
	hasPublicKeyRef := false
	for _, field := range wix.OptionalSettings {
		if field.Key == "webhook_public_key_ref" {
			hasPublicKeyRef = true
		}
	}
	if !hasPublicKeyRef {
		t.Fatalf("Wix should advertise webhook_public_key_ref after JWT verification wiring: %+v", wix.OptionalSettings)
	}

	jotform, ok := ProviderSpecByKey(ProviderJotform)
	if !ok {
		t.Fatal("missing Jotform spec")
	}
	if jotform.SyncModel != "jotform_submissions_webhook_backfill" || jotform.VerificationMode != "postwave_shared_secret" {
		t.Fatalf("unexpected Jotform precision metadata: %+v", jotform)
	}
	if len(jotform.Scopes) == 0 || !containsFold(jotform.Scopes, "submissions:read") || !containsFold(jotform.Scopes, "webhooks:write") {
		t.Fatalf("Jotform should publish provider scopes now that pull/webhook runtime exists: %+v", jotform.Scopes)
	}
	hasJotformWebhookSecret := false
	for _, field := range jotform.OptionalSettings {
		if field.Key == "webhook_secret_ref" {
			hasJotformWebhookSecret = true
		}
	}
	if !hasJotformWebhookSecret {
		t.Fatalf("Jotform should advertise webhook_secret_ref after shared-secret wiring: %+v", jotform.OptionalSettings)
	}

	webflow, ok := ProviderSpecByKey(ProviderWebflow)
	if !ok {
		t.Fatal("missing Webflow spec")
	}
	if webflow.SyncModel != "webflow_forms_webhook_backfill" || webflow.VerificationMode != "webflow_hmac_sha256" {
		t.Fatalf("unexpected Webflow precision metadata: %+v", webflow)
	}
	if len(webflow.Scopes) == 0 || !containsFold(webflow.Scopes, "forms:read") || !containsFold(webflow.Scopes, "sites:write") {
		t.Fatalf("Webflow should publish provider scopes now that pull/webhook runtime exists: %+v", webflow.Scopes)
	}
	hasWebflowWebhookSecret := false
	for _, field := range webflow.OptionalSettings {
		if field.Key == "webhook_secret_ref" {
			hasWebflowWebhookSecret = true
		}
	}
	if !hasWebflowWebhookSecret {
		t.Fatalf("Webflow should advertise webhook_secret_ref after signature wiring: %+v", webflow.OptionalSettings)
	}

	paperform, ok := ProviderSpecByKey(ProviderPaperform)
	if !ok {
		t.Fatal("missing Paperform spec")
	}
	if paperform.SyncModel != "paperform_submissions_rest_backfill_scheduled_retry" || paperform.VerificationMode != "paperform_submissions_rest_live_certification_pending" {
		t.Fatalf("unexpected Paperform precision metadata: %+v", paperform)
	}
	if len(paperform.Scopes) == 0 || !containsFold(paperform.Scopes, "submissions:read") {
		t.Fatalf("Paperform should publish provider scopes now that REST submissions backfill exists: %+v", paperform.Scopes)
	}
	if len(paperform.WebhookTopics) != 0 {
		t.Fatalf("Paperform should not claim provider webhooks yet, got %+v", paperform.WebhookTopics)
	}
	if len(paperform.SyncObjects) != 2 || paperform.SyncObjects[0] != "forms" || paperform.SyncObjects[1] != "submissions" {
		t.Fatalf("Paperform should expose only the implemented REST pull objects, got %+v", paperform.SyncObjects)
	}
	for _, field := range paperform.OptionalSettings {
		if field.Key == "webhook_secret_ref" {
			t.Fatalf("Paperform should not advertise webhook_secret_ref before provider webhook runtime exists, got %+v", paperform.OptionalSettings)
		}
	}

	formstack, ok := ProviderSpecByKey(ProviderFormstack)
	if !ok {
		t.Fatal("missing Formstack spec")
	}
	if formstack.SyncModel != "formstack_submissions_rest_backfill_scheduled_retry" || formstack.VerificationMode != "formstack_submissions_rest_live_certification_pending" {
		t.Fatalf("unexpected Formstack precision metadata: %+v", formstack)
	}
	if len(formstack.Scopes) == 0 || !containsFold(formstack.Scopes, "submissions:read") {
		t.Fatalf("Formstack should publish provider scopes now that REST submissions backfill exists: %+v", formstack.Scopes)
	}
	if len(formstack.WebhookTopics) != 0 {
		t.Fatalf("Formstack should not claim provider webhooks yet, got %+v", formstack.WebhookTopics)
	}
	if len(formstack.SyncObjects) != 2 || formstack.SyncObjects[0] != "forms" || formstack.SyncObjects[1] != "submissions" {
		t.Fatalf("Formstack should expose only the implemented REST pull objects, got %+v", formstack.SyncObjects)
	}
	for _, field := range formstack.OptionalSettings {
		if field.Key == "webhook_secret_ref" {
			t.Fatalf("Formstack should not advertise webhook_secret_ref before provider webhook runtime exists, got %+v", formstack.OptionalSettings)
		}
	}

	cognitoForms, ok := ProviderSpecByKey(ProviderCognitoForms)
	if !ok {
		t.Fatal("missing Cognito Forms spec")
	}
	if cognitoForms.SyncModel != "cognito_forms_odata_entries_backfill_scheduled_retry" || cognitoForms.VerificationMode != "cognito_forms_odata_rest_live_certification_pending" {
		t.Fatalf("unexpected Cognito Forms precision metadata: %+v", cognitoForms)
	}
	if cognitoForms.AuthMode != "api_key_bearer_ref" {
		t.Fatalf("Cognito Forms should expose Bearer API-key credential refs, got %q", cognitoForms.AuthMode)
	}
	if len(cognitoForms.Scopes) == 0 || !containsFold(cognitoForms.Scopes, "Form:Read") || !containsFold(cognitoForms.Scopes, "Entry:Read") {
		t.Fatalf("Cognito Forms should publish provider scopes now that OData entry backfill exists: %+v", cognitoForms.Scopes)
	}
	if len(cognitoForms.WebhookTopics) != 0 {
		t.Fatalf("Cognito Forms should not claim provider webhooks yet, got %+v", cognitoForms.WebhookTopics)
	}
	if len(cognitoForms.SyncObjects) != 4 || cognitoForms.SyncObjects[0] != "forms" || cognitoForms.SyncObjects[1] != "views" || cognitoForms.SyncObjects[2] != "entries" || cognitoForms.SyncObjects[3] != "schema" {
		t.Fatalf("Cognito Forms should expose only the implemented OData/REST pull objects, got %+v", cognitoForms.SyncObjects)
	}
	for _, field := range cognitoForms.OptionalSettings {
		if field.Key == "webhook_secret_ref" {
			t.Fatalf("Cognito Forms should not advertise webhook_secret_ref before provider webhook runtime exists, got %+v", cognitoForms.OptionalSettings)
		}
	}

	ninjaForms, ok := ProviderSpecByKey(ProviderNinjaForms)
	if !ok {
		t.Fatal("missing Ninja Forms spec")
	}
	if ninjaForms.SyncModel != "ninja_forms_webhook_ingest" || ninjaForms.VerificationMode != "ninja_forms_route_token_webhook_live_certification_pending" {
		t.Fatalf("unexpected Ninja Forms precision metadata: %+v", ninjaForms)
	}
	if ninjaForms.AuthMode != "webhook_route_token_ref" {
		t.Fatalf("Ninja Forms should expose route-token credential refs, got %q", ninjaForms.AuthMode)
	}
	if len(ninjaForms.Scopes) == 0 || !containsFold(ninjaForms.Scopes, "webhooks.configure") || !containsFold(ninjaForms.Scopes, "route_token.verify") {
		t.Fatalf("Ninja Forms should publish webhook action setup scopes now that route-token ingest exists: %+v", ninjaForms.Scopes)
	}
	if len(ninjaForms.WebhookTopics) != 2 || ninjaForms.WebhookTopics[0] != "submission.created" || ninjaForms.WebhookTopics[1] != "webhook.delivery" {
		t.Fatalf("Ninja Forms should publish implemented webhook topics, got %+v", ninjaForms.WebhookTopics)
	}
	if len(ninjaForms.SyncObjects) != 4 || ninjaForms.SyncObjects[0] != "forms" || ninjaForms.SyncObjects[1] != "fields" || ninjaForms.SyncObjects[2] != "submissions" || ninjaForms.SyncObjects[3] != "webhook_actions" {
		t.Fatalf("Ninja Forms should expose the implemented Webhooks action objects, got %+v", ninjaForms.SyncObjects)
	}

	outgrow, ok := ProviderSpecByKey(ProviderOutgrow)
	if !ok {
		t.Fatal("missing Outgrow spec")
	}
	if outgrow.SyncModel != "outgrow_webhook_ingest" || outgrow.VerificationMode != "outgrow_basic_or_route_token_webhook_live_certification_pending" {
		t.Fatalf("unexpected Outgrow precision metadata: %+v", outgrow)
	}
	if outgrow.AuthMode != "webhook_basic_or_route_token_ref" {
		t.Fatalf("Outgrow should expose Basic-or-route-token credential refs, got %q", outgrow.AuthMode)
	}
	if len(outgrow.Scopes) == 0 || !containsFold(outgrow.Scopes, "webhooks.configure") || !containsFold(outgrow.Scopes, "basic_auth.verify") || !containsFold(outgrow.Scopes, "route_token.verify") {
		t.Fatalf("Outgrow should publish webhook setup/auth scopes now that ingest exists: %+v", outgrow.Scopes)
	}
	if len(outgrow.WebhookTopics) != 4 || outgrow.WebhookTopics[0] != "lead.created" || outgrow.WebhookTopics[1] != "visit.created" || outgrow.WebhookTopics[2] != "result.calculated" || outgrow.WebhookTopics[3] != "webhook.delivery" {
		t.Fatalf("Outgrow should publish implemented webhook topics, got %+v", outgrow.WebhookTopics)
	}
	if len(outgrow.SyncObjects) != 8 || outgrow.SyncObjects[0] != "campaigns" || outgrow.SyncObjects[5] != "leads" || outgrow.SyncObjects[6] != "visits" || outgrow.SyncObjects[7] != "webhook_destinations" {
		t.Fatalf("Outgrow should expose the implemented Webhook destination objects, got %+v", outgrow.SyncObjects)
	}

	riddle, ok := ProviderSpecByKey(ProviderRiddle)
	if !ok {
		t.Fatal("missing Riddle spec")
	}
	if riddle.SyncModel != "riddle_webhook_ingest" || riddle.VerificationMode != "riddle_signature_or_route_token_webhook_live_certification_pending" {
		t.Fatalf("unexpected Riddle precision metadata: %+v", riddle)
	}
	if riddle.AuthMode != "webhook_signature_or_route_token_ref" {
		t.Fatalf("Riddle should expose signature-or-route-token credential refs, got %q", riddle.AuthMode)
	}
	if len(riddle.Scopes) == 0 || !containsFold(riddle.Scopes, "webhooks.configure") || !containsFold(riddle.Scopes, "webhook_signature.verify") || !containsFold(riddle.Scopes, "route_token.verify") {
		t.Fatalf("Riddle should publish webhook setup/auth scopes now that ingest exists: %+v", riddle.Scopes)
	}
	if len(riddle.WebhookTopics) != 3 || riddle.WebhookTopics[0] != "lead.created" || riddle.WebhookTopics[1] != "riddle.completed" || riddle.WebhookTopics[2] != "webhook.delivery" {
		t.Fatalf("Riddle should publish implemented webhook topics, got %+v", riddle.WebhookTopics)
	}
	if len(riddle.SyncObjects) != 7 || riddle.SyncObjects[0] != "riddles" || riddle.SyncObjects[5] != "leads" || riddle.SyncObjects[6] != "webhook_destinations" {
		t.Fatalf("Riddle should expose the implemented webhook objects, got %+v", riddle.SyncObjects)
	}

	gravityForms, ok := ProviderSpecByKey(ProviderGravityForms)
	if !ok {
		t.Fatal("missing Gravity Forms spec")
	}
	if gravityForms.SyncModel != "gravity_forms_entries_rest_backfill_scheduled_retry" || gravityForms.VerificationMode != "gravity_forms_entries_rest_live_certification_pending" {
		t.Fatalf("unexpected Gravity Forms precision metadata: %+v", gravityForms)
	}
	if gravityForms.AuthMode != "wordpress_app_password_or_gravity_forms_basic_ref" {
		t.Fatalf("Gravity Forms should expose WordPress/GF Basic credential refs, got %q", gravityForms.AuthMode)
	}
	if len(gravityForms.Scopes) == 0 || !containsFold(gravityForms.Scopes, "entries.read") {
		t.Fatalf("Gravity Forms should publish provider scopes now that REST entries backfill exists: %+v", gravityForms.Scopes)
	}
	if len(gravityForms.WebhookTopics) != 0 {
		t.Fatalf("Gravity Forms should not claim provider webhooks yet, got %+v", gravityForms.WebhookTopics)
	}
	if len(gravityForms.SyncObjects) != 2 || gravityForms.SyncObjects[0] != "forms" || gravityForms.SyncObjects[1] != "entries" {
		t.Fatalf("Gravity Forms should expose only the implemented REST pull objects, got %+v", gravityForms.SyncObjects)
	}
	for _, field := range gravityForms.OptionalSettings {
		if field.Key == "webhook_secret_ref" {
			t.Fatalf("Gravity Forms should not advertise webhook_secret_ref before provider webhook runtime exists, got %+v", gravityForms.OptionalSettings)
		}
	}

	wpforms, ok := ProviderSpecByKey(ProviderWPForms)
	if !ok {
		t.Fatal("missing WPForms spec")
	}
	if wpforms.SyncModel != "wpforms_abilities_api_entry_search_scheduled_retry" || wpforms.VerificationMode != "wpforms_pro_abilities_api_live_certification_pending" {
		t.Fatalf("unexpected WPForms precision metadata: %+v", wpforms)
	}
	if wpforms.AuthMode != "wordpress_application_password_ref" {
		t.Fatalf("WPForms should expose WordPress Application Password credential refs, got %q", wpforms.AuthMode)
	}
	if len(wpforms.Scopes) == 0 || !containsFold(wpforms.Scopes, "view_entries_form_single") {
		t.Fatalf("WPForms should publish provider scopes now that Abilities API entry backfill exists: %+v", wpforms.Scopes)
	}
	if len(wpforms.WebhookTopics) != 0 {
		t.Fatalf("WPForms should not claim provider webhooks yet, got %+v", wpforms.WebhookTopics)
	}
	if len(wpforms.SyncObjects) != 2 || wpforms.SyncObjects[0] != "forms" || wpforms.SyncObjects[1] != "entries" {
		t.Fatalf("WPForms should expose only the implemented Abilities API pull objects, got %+v", wpforms.SyncObjects)
	}
	for _, field := range wpforms.OptionalSettings {
		if field.Key == "webhook_secret_ref" {
			t.Fatalf("WPForms should not advertise webhook_secret_ref before provider webhook runtime exists, got %+v", wpforms.OptionalSettings)
		}
	}

	formidableForms, ok := ProviderSpecByKey(ProviderFormidableForms)
	if !ok {
		t.Fatal("missing Formidable Forms spec")
	}
	if formidableForms.SyncModel != "formidable_forms_entries_rest_backfill_scheduled_retry" || formidableForms.VerificationMode != "formidable_forms_rest_live_certification_pending" {
		t.Fatalf("unexpected Formidable Forms precision metadata: %+v", formidableForms)
	}
	if formidableForms.AuthMode != "wordpress_application_password_or_formidable_api_key_ref" {
		t.Fatalf("Formidable Forms should expose WordPress/App API credential refs, got %q", formidableForms.AuthMode)
	}
	if len(formidableForms.Scopes) == 0 || !containsFold(formidableForms.Scopes, "entries.read") {
		t.Fatalf("Formidable Forms should publish provider scopes now that REST entries backfill exists: %+v", formidableForms.Scopes)
	}
	if len(formidableForms.WebhookTopics) != 0 {
		t.Fatalf("Formidable Forms should not claim provider webhooks yet, got %+v", formidableForms.WebhookTopics)
	}
	if len(formidableForms.SyncObjects) != 3 || formidableForms.SyncObjects[0] != "forms" || formidableForms.SyncObjects[1] != "fields" || formidableForms.SyncObjects[2] != "entries" {
		t.Fatalf("Formidable Forms should expose only the implemented REST pull objects, got %+v", formidableForms.SyncObjects)
	}
	for _, field := range formidableForms.OptionalSettings {
		if field.Key == "webhook_secret_ref" {
			t.Fatalf("Formidable Forms should not advertise webhook_secret_ref before provider webhook runtime exists, got %+v", formidableForms.OptionalSettings)
		}
	}

	fillout, ok := ProviderSpecByKey(ProviderFillout)
	if !ok {
		t.Fatal("missing Fillout spec")
	}
	if fillout.SyncModel != "fillout_submissions_webhook_backfill" || fillout.VerificationMode != "postwave_url_token" {
		t.Fatalf("unexpected Fillout precision metadata: %+v", fillout)
	}
	if len(fillout.Scopes) == 0 || !containsFold(fillout.Scopes, "submissions.read") || !containsFold(fillout.Scopes, "webhooks.write") {
		t.Fatalf("Fillout should publish provider scopes now that pull/webhook runtime exists: %+v", fillout.Scopes)
	}
	hasFilloutWebhookSecret := false
	for _, field := range fillout.OptionalSettings {
		if field.Key == "webhook_secret_ref" {
			hasFilloutWebhookSecret = true
		}
	}
	if !hasFilloutWebhookSecret {
		t.Fatalf("Fillout should advertise webhook_secret_ref after URL-token verification wiring: %+v", fillout.OptionalSettings)
	}

	tally, ok := ProviderSpecByKey(ProviderTally)
	if !ok {
		t.Fatal("missing Tally spec")
	}
	if tally.SyncModel != "tally_submissions_rest_backfill_scheduled_retry" || tally.VerificationMode != "tally_submissions_rest_live_certification_pending" {
		t.Fatalf("unexpected Tally precision metadata: %+v", tally)
	}
	if len(tally.Scopes) == 0 || !containsFold(tally.Scopes, "submissions:read") {
		t.Fatalf("Tally should publish provider scopes now that REST submissions backfill exists: %+v", tally.Scopes)
	}
	if len(tally.WebhookTopics) != 0 {
		t.Fatalf("Tally should not claim provider webhooks yet, got %+v", tally.WebhookTopics)
	}
	if len(tally.SyncObjects) != 2 || tally.SyncObjects[0] != "forms" || tally.SyncObjects[1] != "submissions" {
		t.Fatalf("Tally should expose only the implemented REST pull objects, got %+v", tally.SyncObjects)
	}
	for _, field := range tally.OptionalSettings {
		if field.Key == "webhook_secret_ref" {
			t.Fatalf("Tally should not advertise webhook_secret_ref before provider webhook runtime exists, got %+v", tally.OptionalSettings)
		}
	}

	facebook, ok := ProviderSpecByKey(ProviderFacebookLeadAds)
	if !ok {
		t.Fatal("missing Facebook Lead Ads spec")
	}
	if facebook.SyncModel != "facebook_lead_ads_leads_rest_webhook_backfill" || facebook.VerificationMode != "meta_graph_oauth_ref_hub_signature_sha256" {
		t.Fatalf("unexpected Facebook Lead Ads precision metadata: %+v", facebook)
	}
	if len(facebook.Scopes) == 0 || !containsFold(facebook.Scopes, "leads_retrieval") || !containsFold(facebook.Scopes, "pages_manage_metadata") || !containsFold(facebook.Scopes, "ads_read") {
		t.Fatalf("Facebook Lead Ads should publish provider scopes for lead retrieval and Page subscription management: %+v", facebook.Scopes)
	}
	if !containsFold(facebook.WebhookTopics, "leadgen") {
		t.Fatalf("Facebook Lead Ads should publish leadgen webhooks after signed ingest wiring, got %+v", facebook.WebhookTopics)
	}
	if len(facebook.SyncObjects) != 1 || facebook.SyncObjects[0] != "leads" {
		t.Fatalf("Facebook Lead Ads should expose only the implemented lead pull object, got %+v", facebook.SyncObjects)
	}
	hasFacebookWebhookSecret := false
	for _, field := range facebook.OptionalSettings {
		if field.Key == "webhook_secret_ref" && field.Secret {
			hasFacebookWebhookSecret = true
		}
	}
	if !hasFacebookWebhookSecret {
		t.Fatalf("Facebook Lead Ads should advertise webhook_secret_ref after X-Hub-Signature-256 wiring: %+v", facebook.OptionalSettings)
	}

	googleLeads, ok := ProviderSpecByKey(ProviderGoogleLeadForms)
	if !ok {
		t.Fatal("missing Google Lead Form Extensions spec")
	}
	if googleLeads.SyncModel != "google_lead_forms_google_ads_search_backfill" || googleLeads.VerificationMode != "google_ads_oauth_developer_token_ref" {
		t.Fatalf("unexpected Google Lead Form Extensions precision metadata: %+v", googleLeads)
	}
	if len(googleLeads.Scopes) == 0 || !containsFold(googleLeads.Scopes, "adwords") {
		t.Fatalf("Google Lead Form Extensions should publish Google Ads pull scopes now that Search backfill exists: %+v", googleLeads.Scopes)
	}
	if len(googleLeads.WebhookTopics) != 0 {
		t.Fatalf("Google Lead Form Extensions should not claim lead webhooks yet, got %+v", googleLeads.WebhookTopics)
	}
	if len(googleLeads.SyncObjects) != 1 || googleLeads.SyncObjects[0] != "lead_form_submission_data" {
		t.Fatalf("Google Lead Form Extensions should expose only the implemented Search object, got %+v", googleLeads.SyncObjects)
	}
	for _, field := range googleLeads.OptionalSettings {
		if field.Key == "page_size" {
			t.Fatalf("Google Lead Form Extensions should not advertise deprecated Google Ads page_size, got %+v", googleLeads.OptionalSettings)
		}
	}

	google, ok := ProviderSpecByKey(ProviderGoogleForms)
	if !ok || google.SyncModel != "google_forms_responses_rest_backfill_scheduled_retry" || google.VerificationMode != "google_forms_responses_rest_live_certification_pending" {
		t.Fatalf("Google Forms should expose the implemented Responses API puller slice, got %+v", google)
	}
	if !containsFold(google.Scopes, "forms.body.readonly") || !containsFold(google.Scopes, "forms.responses.readonly") {
		t.Fatalf("Google Forms should publish Forms API read scopes, got %+v", google.Scopes)
	}
	if len(google.WebhookTopics) != 0 {
		t.Fatalf("Google Forms should not claim Pub/Sub watch/webhook ownership yet, got %+v", google.WebhookTopics)
	}

	surveyMonkey, ok := ProviderSpecByKey(ProviderSurveyMonkey)
	if !ok || surveyMonkey.SyncModel != "surveymonkey_responses_bulk_rest_backfill_scheduled_retry" || surveyMonkey.VerificationMode != "surveymonkey_responses_bulk_rest_live_certification_pending" {
		t.Fatalf("SurveyMonkey should expose the implemented bulk Responses API puller slice, got %+v", surveyMonkey)
	}
	if len(surveyMonkey.WebhookTopics) != 0 {
		t.Fatalf("SurveyMonkey should not claim provider-managed webhooks yet, got %+v", surveyMonkey.WebhookTopics)
	}

	unbounce, ok := ProviderSpecByKey(ProviderUnbounce)
	if !ok || unbounce.SyncModel != "unbounce_leads_rest_backfill_scheduled_retry" || unbounce.VerificationMode != "unbounce_leads_rest_live_certification_pending" {
		t.Fatalf("Unbounce should expose the implemented Leads API puller slice, got %+v", unbounce)
	}
	if unbounce.AuthMode != "oauth_or_api_key_ref" {
		t.Fatalf("Unbounce should support OAuth or API-key credential refs, got %q", unbounce.AuthMode)
	}
	if len(unbounce.WebhookTopics) != 0 {
		t.Fatalf("Unbounce should not claim provider-managed webhooks yet, got %+v", unbounce.WebhookTopics)
	}

	leadpages, ok := ProviderSpecByKey(ProviderLeadpages)
	if !ok || leadpages.SyncModel != "leadpages_form_submissions_rest_backfill_scheduled_retry" || leadpages.VerificationMode != "leadpages_form_submissions_live_certification_pending" {
		t.Fatalf("Leadpages should expose the implemented form submissions API puller slice, got %+v", leadpages)
	}
	if leadpages.AuthMode != "bearer_token_ref" {
		t.Fatalf("Leadpages should use Bearer token credential refs, got %q", leadpages.AuthMode)
	}
	if len(leadpages.WebhookTopics) != 0 {
		t.Fatalf("Leadpages should not claim provider-managed webhooks yet, got %+v", leadpages.WebhookTopics)
	}
	if len(leadpages.SyncObjects) != 2 || leadpages.SyncObjects[0] != "forms" || leadpages.SyncObjects[1] != "submissions" {
		t.Fatalf("Leadpages should expose only the implemented REST pull objects, got %+v", leadpages.SyncObjects)
	}

	formBuilder123, ok := ProviderSpecByKey(Provider123FormBuilder)
	if !ok || formBuilder123.SyncModel != "123formbuilder_submissions_rest_backfill_scheduled_retry" || formBuilder123.VerificationMode != "123formbuilder_submissions_live_certification_pending" {
		t.Fatalf("123FormBuilder should expose the implemented REST API v2 submissions puller slice, got %+v", formBuilder123)
	}
	if formBuilder123.AuthMode != "jwt_query_ref_or_login_ref" {
		t.Fatalf("123FormBuilder should use JWT query-token or login credential refs, got %q", formBuilder123.AuthMode)
	}
	if len(formBuilder123.WebhookTopics) != 0 {
		t.Fatalf("123FormBuilder should not claim provider-managed webhooks yet, got %+v", formBuilder123.WebhookTopics)
	}
	if len(formBuilder123.SyncObjects) != 2 || formBuilder123.SyncObjects[0] != "forms" || formBuilder123.SyncObjects[1] != "submissions" {
		t.Fatalf("123FormBuilder should expose only the implemented REST pull objects, got %+v", formBuilder123.SyncObjects)
	}

	carrd, ok := ProviderSpecByKey(ProviderCarrd)
	if !ok || carrd.SyncModel != "carrd_custom_url_form_webhook_ingest" || carrd.VerificationMode != "carrd_custom_url_route_token_live_certification_pending" {
		t.Fatalf("Carrd should expose the implemented Custom URL form receiver slice, got %+v", carrd)
	}
	if carrd.AuthMode != "webhook_route_token_ref" {
		t.Fatalf("Carrd should use route-token credential refs, got %q", carrd.AuthMode)
	}
	if len(carrd.WebhookTopics) != 1 || carrd.WebhookTopics[0] != "form.submitted" {
		t.Fatalf("Carrd should expose the implemented Custom URL form topic, got %+v", carrd.WebhookTopics)
	}
	if len(carrd.SyncObjects) != 3 || carrd.SyncObjects[0] != "sites" || carrd.SyncObjects[1] != "forms" || carrd.SyncObjects[2] != "custom_url_submissions" {
		t.Fatalf("Carrd should expose only the implemented Custom URL receiver objects, got %+v", carrd.SyncObjects)
	}

	optinMonster, ok := ProviderSpecByKey(ProviderOptinMonster)
	if !ok || optinMonster.SyncModel != "optinmonster_webhook_ingest" || optinMonster.VerificationMode != "optinmonster_webhook_route_token_live_certification_pending" {
		t.Fatalf("OptinMonster should expose the implemented Webhook receiver slice, got %+v", optinMonster)
	}
	if optinMonster.AuthMode != "webhook_route_token_ref" {
		t.Fatalf("OptinMonster should use route-token credential refs, got %q", optinMonster.AuthMode)
	}
	if len(optinMonster.WebhookTopics) != 2 || optinMonster.WebhookTopics[0] != "lead.created" || optinMonster.WebhookTopics[1] != "campaign.converted" {
		t.Fatalf("OptinMonster should expose the implemented Webhook topics, got %+v", optinMonster.WebhookTopics)
	}
	if len(optinMonster.SyncObjects) != 4 || optinMonster.SyncObjects[0] != "accounts" || optinMonster.SyncObjects[1] != "campaigns" || optinMonster.SyncObjects[2] != "leads" || optinMonster.SyncObjects[3] != "conversions" {
		t.Fatalf("OptinMonster should expose the implemented Webhook receiver objects, got %+v", optinMonster.SyncObjects)
	}

	privy, ok := ProviderSpecByKey(ProviderPrivy)
	if !ok || privy.SyncModel != "privy_custom_webhook_ingest" || privy.VerificationMode != "privy_basic_auth_custom_webhook_live_certification_pending" {
		t.Fatalf("Privy should expose the implemented custom Webhook receiver slice, got %+v", privy)
	}
	if privy.AuthMode != "basic_auth_ref_webhook" {
		t.Fatalf("Privy should use Basic auth credential refs for custom webhook verification, got %q", privy.AuthMode)
	}
	if len(privy.WebhookTopics) != 3 || privy.WebhookTopics[0] != "signup.created" || privy.WebhookTopics[1] != "contact.created" || privy.WebhookTopics[2] != "coupon.redeemed" {
		t.Fatalf("Privy should expose the implemented custom Webhook topics, got %+v", privy.WebhookTopics)
	}
	if len(privy.SyncObjects) != 6 || privy.SyncObjects[0] != "accounts" || privy.SyncObjects[1] != "campaigns" || privy.SyncObjects[2] != "displays" || privy.SyncObjects[3] != "signups" || privy.SyncObjects[4] != "contacts" || privy.SyncObjects[5] != "coupons" {
		t.Fatalf("Privy should expose the implemented custom Webhook receiver objects, got %+v", privy.SyncObjects)
	}

	convertFlow, ok := ProviderSpecByKey(ProviderConvertFlow)
	if !ok || convertFlow.SyncModel != "convertflow_custom_webhook_ingest" || convertFlow.VerificationMode != "convertflow_route_token_webhook_live_certification_pending" {
		t.Fatalf("ConvertFlow should expose the implemented custom Webhook receiver slice, got %+v", convertFlow)
	}
	if convertFlow.AuthMode != "webhook_route_token_ref" {
		t.Fatalf("ConvertFlow should use route-token credential refs, got %q", convertFlow.AuthMode)
	}
	if len(convertFlow.WebhookTopics) != 4 || convertFlow.WebhookTopics[0] != "fields.submitted" || convertFlow.WebhookTopics[1] != "contact.updated" || convertFlow.WebhookTopics[2] != "cta.converted" || convertFlow.WebhookTopics[3] != "webhook.automation" {
		t.Fatalf("ConvertFlow should expose the implemented custom Webhook topics, got %+v", convertFlow.WebhookTopics)
	}
	if len(convertFlow.SyncObjects) != 6 || convertFlow.SyncObjects[0] != "sites" || convertFlow.SyncObjects[1] != "ctas" || convertFlow.SyncObjects[2] != "forms" || convertFlow.SyncObjects[3] != "contacts" || convertFlow.SyncObjects[4] != "submissions" || convertFlow.SyncObjects[5] != "webhook_automations" {
		t.Fatalf("ConvertFlow should expose the implemented custom Webhook receiver objects, got %+v", convertFlow.SyncObjects)
	}

	sleeknote, ok := ProviderSpecByKey(ProviderSleeknote)
	if !ok || sleeknote.SyncModel != "sleeknote_custom_integration_ingest" || sleeknote.VerificationMode != "sleeknote_route_token_custom_integration_live_certification_pending" {
		t.Fatalf("Sleeknote should expose the implemented custom integration receiver slice, got %+v", sleeknote)
	}
	if sleeknote.AuthMode != "webhook_route_token_ref" {
		t.Fatalf("Sleeknote should use route-token credential refs, got %q", sleeknote.AuthMode)
	}
	if len(sleeknote.WebhookTopics) != 3 || sleeknote.WebhookTopics[0] != "signup.created" || sleeknote.WebhookTopics[1] != "campaign.converted" || sleeknote.WebhookTopics[2] != "custom_integration.delivery" {
		t.Fatalf("Sleeknote should expose the implemented custom integration topics, got %+v", sleeknote.WebhookTopics)
	}
	if len(sleeknote.SyncObjects) != 5 || sleeknote.SyncObjects[0] != "sites" || sleeknote.SyncObjects[1] != "campaigns" || sleeknote.SyncObjects[2] != "forms" || sleeknote.SyncObjects[3] != "signups" || sleeknote.SyncObjects[4] != "custom_integrations" {
		t.Fatalf("Sleeknote should expose the implemented custom integration receiver objects, got %+v", sleeknote.SyncObjects)
	}

	wisepops, ok := ProviderSpecByKey(ProviderWisepops)
	if !ok || wisepops.SyncModel != "wisepops_signed_webhook_ingest" || wisepops.VerificationMode != "wisepops_hmac_sha256_live_certification_pending" {
		t.Fatalf("Wisepops should expose the implemented signed Webhook receiver slice, got %+v", wisepops)
	}
	if wisepops.AuthMode != "api_key_ref_hmac_webhook" {
		t.Fatalf("Wisepops should use API-key refs for HMAC webhook verification, got %q", wisepops.AuthMode)
	}
	if len(wisepops.WebhookTopics) != 3 || wisepops.WebhookTopics[0] != "email.collected" || wisepops.WebhookTopics[1] != "phone.collected" || wisepops.WebhookTopics[2] != "survey.collected" {
		t.Fatalf("Wisepops should expose the implemented signed Webhook topics, got %+v", wisepops.WebhookTopics)
	}
	if len(wisepops.SyncObjects) != 4 || wisepops.SyncObjects[0] != "sites" || wisepops.SyncObjects[1] != "wisepops" || wisepops.SyncObjects[2] != "hooks" || wisepops.SyncObjects[3] != "contacts" {
		t.Fatalf("Wisepops should expose the implemented signed Webhook receiver objects, got %+v", wisepops.SyncObjects)
	}

	poptin, ok := ProviderSpecByKey(ProviderPoptin)
	if !ok || poptin.SyncModel != "poptin_webhook_ingest" || poptin.VerificationMode != "poptin_route_token_webhook_live_certification_pending" {
		t.Fatalf("Poptin should expose the implemented Webhooks receiver slice, got %+v", poptin)
	}
	if poptin.AuthMode != "webhook_route_token_ref" {
		t.Fatalf("Poptin should use route-token credential refs, got %q", poptin.AuthMode)
	}
	if len(poptin.WebhookTopics) != 3 || poptin.WebhookTopics[0] != "lead.created" || poptin.WebhookTopics[1] != "popup.converted" || poptin.WebhookTopics[2] != "webhook.delivery" {
		t.Fatalf("Poptin should expose the implemented Webhooks topics, got %+v", poptin.WebhookTopics)
	}
	if len(poptin.SyncObjects) != 5 || poptin.SyncObjects[0] != "sites" || poptin.SyncObjects[1] != "popups" || poptin.SyncObjects[2] != "forms" || poptin.SyncObjects[3] != "leads" || poptin.SyncObjects[4] != "webhook_integrations" {
		t.Fatalf("Poptin should expose the implemented Webhooks receiver objects, got %+v", poptin.SyncObjects)
	}

	helloBar, ok := ProviderSpecByKey(ProviderHelloBar)
	if !ok || helloBar.SyncModel != "hello_bar_webhook_ingest" || helloBar.VerificationMode != "hello_bar_route_token_webhook_live_certification_pending" {
		t.Fatalf("Hello Bar should expose the implemented Webhook receiver slice, got %+v", helloBar)
	}
	if helloBar.AuthMode != "webhook_route_token_ref" {
		t.Fatalf("Hello Bar should use route-token credential refs, got %q", helloBar.AuthMode)
	}
	if len(helloBar.WebhookTopics) != 4 || helloBar.WebhookTopics[0] != "lead.created" || helloBar.WebhookTopics[1] != "subscriber.created" || helloBar.WebhookTopics[2] != "bar.converted" || helloBar.WebhookTopics[3] != "webhook.delivery" {
		t.Fatalf("Hello Bar should expose the implemented Webhook topics, got %+v", helloBar.WebhookTopics)
	}
	if len(helloBar.SyncObjects) != 5 || helloBar.SyncObjects[0] != "sites" || helloBar.SyncObjects[1] != "bars" || helloBar.SyncObjects[2] != "campaigns" || helloBar.SyncObjects[3] != "subscribers" || helloBar.SyncObjects[4] != "webhook_integrations" {
		t.Fatalf("Hello Bar should expose the implemented Webhook receiver objects, got %+v", helloBar.SyncObjects)
	}

	landingi, ok := ProviderSpecByKey(ProviderLandingi)
	if !ok || landingi.SyncModel != "landingi_webhook_ingest" || landingi.VerificationMode != "landingi_route_token_webhook_live_certification_pending" {
		t.Fatalf("Landingi should expose the implemented Webhook receiver slice, got %+v", landingi)
	}
	if landingi.AuthMode != "webhook_route_token_ref" {
		t.Fatalf("Landingi should use route-token credential refs, got %q", landingi.AuthMode)
	}
	if len(landingi.WebhookTopics) != 3 || landingi.WebhookTopics[0] != "lead.created" || landingi.WebhookTopics[1] != "form.submitted" || landingi.WebhookTopics[2] != "webhook.delivery" {
		t.Fatalf("Landingi should expose the implemented Webhook topics, got %+v", landingi.WebhookTopics)
	}
	if len(landingi.SyncObjects) != 4 || landingi.SyncObjects[0] != "landing_pages" || landingi.SyncObjects[1] != "forms" || landingi.SyncObjects[2] != "leads" || landingi.SyncObjects[3] != "webhook_integrations" {
		t.Fatalf("Landingi should expose the implemented Webhook receiver objects, got %+v", landingi.SyncObjects)
	}

	kickoffLabs, ok := ProviderSpecByKey(ProviderKickoffLabs)
	if !ok || kickoffLabs.SyncModel != "kickofflabs_webhook_ingest" || kickoffLabs.VerificationMode != "kickofflabs_route_token_outbound_webhook_live_certification_pending" {
		t.Fatalf("KickoffLabs should expose the implemented outbound Webhook receiver slice, got %+v", kickoffLabs)
	}
	if kickoffLabs.AuthMode != "webhook_route_token_ref" {
		t.Fatalf("KickoffLabs should use route-token credential refs, got %q", kickoffLabs.AuthMode)
	}
	if len(kickoffLabs.WebhookTopics) != 4 || kickoffLabs.WebhookTopics[0] != "lead.created" || kickoffLabs.WebhookTopics[1] != "referral.created" || kickoffLabs.WebhookTopics[2] != "reward.earned" || kickoffLabs.WebhookTopics[3] != "webhook.delivery" {
		t.Fatalf("KickoffLabs should expose the implemented outbound Webhook topics, got %+v", kickoffLabs.WebhookTopics)
	}
	if len(kickoffLabs.SyncObjects) != 6 || kickoffLabs.SyncObjects[0] != "campaigns" || kickoffLabs.SyncObjects[1] != "pages" || kickoffLabs.SyncObjects[2] != "leads" || kickoffLabs.SyncObjects[3] != "referrals" || kickoffLabs.SyncObjects[4] != "rewards" || kickoffLabs.SyncObjects[5] != "webhook_integrations" {
		t.Fatalf("KickoffLabs should expose the implemented Webhook receiver objects, got %+v", kickoffLabs.SyncObjects)
	}

	shortStack, ok := ProviderSpecByKey(ProviderShortStack)
	if !ok || shortStack.SyncModel != "shortstack_signed_webhook_ingest" || shortStack.VerificationMode != "shortstack_x_ss_signature_live_certification_pending" {
		t.Fatalf("ShortStack should expose the implemented signed Webhook receiver slice, got %+v", shortStack)
	}
	if shortStack.AuthMode != "webhook_secret_ref_hmac_sha1" {
		t.Fatalf("ShortStack should use HMAC webhook-secret credential refs, got %q", shortStack.AuthMode)
	}
	if len(shortStack.WebhookTopics) != 3 || shortStack.WebhookTopics[0] != "entry.created" || shortStack.WebhookTopics[1] != "lead.created" || shortStack.WebhookTopics[2] != "webhook.delivery" {
		t.Fatalf("ShortStack should expose the implemented Webhook topics, got %+v", shortStack.WebhookTopics)
	}
	if len(shortStack.SyncObjects) != 5 || shortStack.SyncObjects[0] != "campaigns" || shortStack.SyncObjects[1] != "forms" || shortStack.SyncObjects[2] != "entries" || shortStack.SyncObjects[3] != "leads" || shortStack.SyncObjects[4] != "webhook_integrations" {
		t.Fatalf("ShortStack should expose the implemented Webhook receiver objects, got %+v", shortStack.SyncObjects)
	}

	formaloo, ok := ProviderSpecByKey(ProviderFormaloo)
	if !ok || formaloo.SyncModel != "formaloo_rows_rest_backfill_scheduled_retry" || formaloo.VerificationMode != "formaloo_rows_live_certification_pending" {
		t.Fatalf("Formaloo should expose the implemented Rows API puller slice, got %+v", formaloo)
	}
	if formaloo.AuthMode != "api_key_secret_jwt_ref" {
		t.Fatalf("Formaloo should use x-api-key plus secret/JWT credential refs, got %q", formaloo.AuthMode)
	}
	if len(formaloo.WebhookTopics) != 0 {
		t.Fatalf("Formaloo should not claim provider-managed webhooks yet, got %+v", formaloo.WebhookTopics)
	}
	if len(formaloo.SyncObjects) != 2 || formaloo.SyncObjects[0] != "forms" || formaloo.SyncObjects[1] != "rows" {
		t.Fatalf("Formaloo should expose only the implemented REST pull objects, got %+v", formaloo.SyncObjects)
	}

	instapage, ok := ProviderSpecByKey(ProviderInstapage)
	if !ok || instapage.SyncModel != "instapage_submissions_rest_backfill_scheduled_retry" || instapage.VerificationMode != "instapage_submissions_rest_live_certification_pending" {
		t.Fatalf("Instapage should expose the implemented submissions API puller slice, got %+v", instapage)
	}
	if instapage.AuthMode != "bearer_token_ref" {
		t.Fatalf("Instapage should use Bearer token credential refs, got %q", instapage.AuthMode)
	}
	if len(instapage.WebhookTopics) != 0 {
		t.Fatalf("Instapage should not claim provider-managed webhooks yet, got %+v", instapage.WebhookTopics)
	}
	if len(instapage.SyncObjects) != 3 || instapage.SyncObjects[0] != "workspaces" || instapage.SyncObjects[1] != "pages" || instapage.SyncObjects[2] != "submissions" {
		t.Fatalf("Instapage should expose only the implemented REST pull objects, got %+v", instapage.SyncObjects)
	}

	feathery, ok := ProviderSpecByKey(ProviderFeathery)
	if !ok || feathery.SyncModel != "feathery_submissions_rest_backfill_scheduled_retry" || feathery.VerificationMode != "feathery_submissions_rest_live_certification_pending" {
		t.Fatalf("Feathery should expose the implemented Submissions API puller slice, got %+v", feathery)
	}
	if len(feathery.WebhookTopics) != 0 {
		t.Fatalf("Feathery should not claim provider-managed webhooks yet, got %+v", feathery.WebhookTopics)
	}
}

func TestCreateOnsiteCaptureLeadProviderIntegrations(t *testing.T) {
	tests := []struct {
		name           string
		provider       string
		credentialsRef string
		settings       string
		assertKey      string
		assertValue    string
	}{
		{
			name:           "optinmonster",
			provider:       ProviderOptinMonster,
			credentialsRef: "cred_optinmonster_1",
			settings:       `"account_id":"acct_123","campaign_id":"campaign_456","site_id":"site_789","credentials_ref":"cred_optinmonster_1"`,
			assertKey:      "campaign_id",
			assertValue:    "campaign_456",
		},
		{
			name:           "privy",
			provider:       ProviderPrivy,
			credentialsRef: "cred_privy_1",
			settings:       `"account_id":"acct_123","campaign_id":"display_456","site_id":"shop_789","credentials_ref":"cred_privy_1"`,
			assertKey:      "campaign_id",
			assertValue:    "display_456",
		},
		{
			name:           "convertflow",
			provider:       ProviderConvertFlow,
			credentialsRef: "cred_convertflow_1",
			settings:       `"account_id":"acct_123","campaign_id":"cta_456","site_id":"site_789","credentials_ref":"cred_convertflow_1"`,
			assertKey:      "campaign_id",
			assertValue:    "cta_456",
		},
		{
			name:           "sleeknote",
			provider:       ProviderSleeknote,
			credentialsRef: "cred_sleeknote_1",
			settings:       `"account_id":"acct_123","campaign_id":"campaign_456","site_id":"site_789","credentials_ref":"cred_sleeknote_1"`,
			assertKey:      "account_id",
			assertValue:    "acct_123",
		},
		{
			name:           "wisepops",
			provider:       ProviderWisepops,
			credentialsRef: "cred_wisepops_1",
			settings:       `"account_id":"acct_123","campaign_id":"campaign_456","site_id":"site_789","credentials_ref":"cred_wisepops_1"`,
			assertKey:      "site_id",
			assertValue:    "site_789",
		},
		{
			name:           "poptin",
			provider:       ProviderPoptin,
			credentialsRef: "cred_poptin_1",
			settings:       `"account_id":"acct_123","popup_id":"popup_456","site_id":"site_789","credentials_ref":"cred_poptin_1"`,
			assertKey:      "popup_id",
			assertValue:    "popup_456",
		},
		{
			name:           "hello bar",
			provider:       ProviderHelloBar,
			credentialsRef: "cred_hello_bar_1",
			settings:       `"site_id":"site_123","campaign_id":"bar_456","account_id":"acct_789","credentials_ref":"cred_hello_bar_1"`,
			assertKey:      "campaign_id",
			assertValue:    "bar_456",
		},
		{
			name:           "unstack",
			provider:       ProviderUnstack,
			credentialsRef: "cred_unstack_1",
			settings:       `"site_id":"site_123","form_id":"form_456","workspace_id":"workspace_789","credentials_ref":"cred_unstack_1"`,
			assertKey:      "form_id",
			assertValue:    "form_456",
		},
		{
			name:           "landingi",
			provider:       ProviderLandingi,
			credentialsRef: "cred_landingi_1",
			settings:       `"account_id":"acct_123","page_id":"page_456","form_id":"form_789","credentials_ref":"cred_landingi_1"`,
			assertKey:      "page_id",
			assertValue:    "page_456",
		},
		{
			name:           "kickofflabs",
			provider:       ProviderKickoffLabs,
			credentialsRef: "cred_kickofflabs_1",
			settings:       `"account_id":"acct_123","campaign_id":"campaign_456","page_id":"page_789","credentials_ref":"cred_kickofflabs_1"`,
			assertKey:      "campaign_id",
			assertValue:    "campaign_456",
		},
		{
			name:           "shortstack",
			provider:       ProviderShortStack,
			credentialsRef: "cred_shortstack_1",
			settings:       `"account_id":"acct_123","campaign_id":"contest_456","form_id":"form_789","credentials_ref":"cred_shortstack_1"`,
			assertKey:      "campaign_id",
			assertValue:    "contest_456",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeStore()
			deps := &Deps{Repo: store}

			rec := httptest.NewRecorder()
			deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
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
				store.lastInput.Settings["setup_surface"] != "lead_integrations" ||
				store.lastInput.Settings["managed_by_postwave"] != true {
				t.Fatalf("settings=%+v", store.lastInput.Settings)
			}
		})
	}
}

func TestCreateAdvancedFormLeadProviderIntegrations(t *testing.T) {
	tests := []struct {
		name           string
		provider       string
		credentialsRef string
		settings       string
		assertKey      string
		assertValue    string
	}{
		{
			name:           "formsite",
			provider:       ProviderFormsite,
			credentialsRef: "cred_formsite_1",
			settings:       `"api_base_url":"https://fs1.formsite.com/api/v2","account_id":"acct_123","form_id":"formsite_456","folder_id":"folder_789","credentials_ref":"cred_formsite_1"`,
			assertKey:      "form_id",
			assertValue:    "formsite_456",
		},
		{
			name:           "cognito forms",
			provider:       ProviderCognitoForms,
			credentialsRef: "cred_cognito_forms_1",
			settings:       `"organization_id":"org_123","form_id":"456","view_id":"789","credentials_ref":"cred_cognito_forms_1"`,
			assertKey:      "view_id",
			assertValue:    "789",
		},
		{
			name:           "ninja forms",
			provider:       ProviderNinjaForms,
			credentialsRef: "cred_ninja_forms_1",
			settings:       `"site_url":"https://example.com","form_id":"newsletter","plugin_namespace":"ninja-forms/v1","credentials_ref":"cred_ninja_forms_1"`,
			assertKey:      "site_url",
			assertValue:    "https://example.com",
		},
		{
			name:           "formidable forms",
			provider:       ProviderFormidableForms,
			credentialsRef: "cred_formidable_forms_1",
			settings:       `"site_url":"https://example.com","form_id":"contact-us","plugin_namespace":"frm/v2","credentials_ref":"cred_formidable_forms_1"`,
			assertKey:      "form_id",
			assertValue:    "contact-us",
		},
		{
			name:           "interact",
			provider:       ProviderInteract,
			credentialsRef: "cred_interact_1",
			settings:       `"account_id":"acct_123","quiz_id":"quiz_456","campaign_id":"campaign_789","credentials_ref":"cred_interact_1"`,
			assertKey:      "quiz_id",
			assertValue:    "quiz_456",
		},
		{
			name:           "outgrow",
			provider:       ProviderOutgrow,
			credentialsRef: "cred_outgrow_1",
			settings:       `"account_id":"acct_123","campaign_id":"calculator_456","quiz_id":"quiz_789","credentials_ref":"cred_outgrow_1"`,
			assertKey:      "campaign_id",
			assertValue:    "calculator_456",
		},
		{
			name:           "riddle",
			provider:       ProviderRiddle,
			credentialsRef: "cred_riddle_1",
			settings:       `"account_id":"acct_123","quiz_id":"riddle_456","campaign_id":"campaign_789","credentials_ref":"cred_riddle_1"`,
			assertKey:      "quiz_id",
			assertValue:    "riddle_456",
		},
		{
			name:           "qualtrics forms",
			provider:       ProviderQualtricsForms,
			credentialsRef: "cred_qualtrics_forms_1",
			settings:       `"brand_id":"brand_123","survey_id":"SV_456","directory_id":"directory_789","credentials_ref":"cred_qualtrics_forms_1"`,
			assertKey:      "survey_id",
			assertValue:    "SV_456",
		},
		{
			name:           "feathery",
			provider:       ProviderFeathery,
			credentialsRef: "cred_feathery_1",
			settings:       `"workspace_id":"workspace_123","form_id":"form_456","environment":"production","credentials_ref":"cred_feathery_1"`,
			assertKey:      "workspace_id",
			assertValue:    "workspace_123",
		},
		{
			name:           "formaloo",
			provider:       ProviderFormaloo,
			credentialsRef: "cred_formaloo_1",
			settings:       `"workspace_id":"workspace_123","form_id":"form_456","folder_id":"folder_789","credentials_ref":"cred_formaloo_1"`,
			assertKey:      "form_id",
			assertValue:    "form_456",
		},
		{
			name:           "123formbuilder",
			provider:       Provider123FormBuilder,
			credentialsRef: "cred_123formbuilder_1",
			settings:       `"account_id":"acct_123","form_id":"form_456","folder_id":"folder_789","credentials_ref":"cred_123formbuilder_1"`,
			assertKey:      "account_id",
			assertValue:    "acct_123",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeStore()
			deps := &Deps{Repo: store}

			rec := httptest.NewRecorder()
			deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
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
				store.lastInput.Settings["setup_surface"] != "lead_integrations" ||
				store.lastInput.Settings["managed_by_postwave"] != true {
				t.Fatalf("settings=%+v", store.lastInput.Settings)
			}
		})
	}
}

func TestCreateLandingPageLeadProviderIntegrations(t *testing.T) {
	tests := []struct {
		name           string
		provider       string
		credentialsRef string
		settings       string
		assertKey      string
		assertValue    string
	}{
		{
			name:           "unbounce",
			provider:       ProviderUnbounce,
			credentialsRef: "cred_unbounce_1",
			settings:       `"page_id":"page_123","client_id":"client_456","form_id":"form_789","credentials_ref":"cred_unbounce_1"`,
			assertKey:      "page_id",
			assertValue:    "page_123",
		},
		{
			name:           "leadpages",
			provider:       ProviderLeadpages,
			credentialsRef: "cred_leadpages_1",
			settings:       `"account_id":"acct_123","page_id":"page_456","form_id":"form_789","credentials_ref":"cred_leadpages_1"`,
			assertKey:      "account_id",
			assertValue:    "acct_123",
		},
		{
			name:           "instapage",
			provider:       ProviderInstapage,
			credentialsRef: "cred_instapage_1",
			settings:       `"workspace_id":"workspace_123","page_id":"page_456","form_id":"form_789","credentials_ref":"cred_instapage_1"`,
			assertKey:      "workspace_id",
			assertValue:    "workspace_123",
		},
		{
			name:           "carrd",
			provider:       ProviderCarrd,
			credentialsRef: "cred_carrd_1",
			settings:       `"site_id":"site_123","form_id":"newsletter","credentials_ref":"cred_carrd_1"`,
			assertKey:      "site_id",
			assertValue:    "site_123",
		},
		{
			name:           "paperform",
			provider:       ProviderPaperform,
			credentialsRef: "cred_paperform_1",
			settings:       `"form_id":"paperform_123","account_id":"acct_456","credentials_ref":"cred_paperform_1"`,
			assertKey:      "form_id",
			assertValue:    "paperform_123",
		},
		{
			name:           "formstack",
			provider:       ProviderFormstack,
			credentialsRef: "cred_formstack_1",
			settings:       `"form_id":"formstack_123","folder_id":"folder_456","credentials_ref":"cred_formstack_1"`,
			assertKey:      "form_id",
			assertValue:    "formstack_123",
		},
		{
			name:           "fillout",
			provider:       ProviderFillout,
			credentialsRef: "cred_fillout_1",
			settings:       `"form_id":"fillout_123","workspace_id":"workspace_456","credentials_ref":"cred_fillout_1"`,
			assertKey:      "form_id",
			assertValue:    "fillout_123",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeStore()
			deps := &Deps{Repo: store}

			rec := httptest.NewRecorder()
			deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
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
				store.lastInput.Settings["setup_surface"] != "lead_integrations" ||
				store.lastInput.Settings["managed_by_postwave"] != true {
				t.Fatalf("settings=%+v", store.lastInput.Settings)
			}
		})
	}
}

func TestCreatePaidLeadProviderIntegrations(t *testing.T) {
	tests := []struct {
		name           string
		provider       string
		credentialsRef string
		settings       string
		assertKey      string
		assertValue    string
	}{
		{
			name:           "google lead form extensions",
			provider:       ProviderGoogleLeadForms,
			credentialsRef: "cred_google_leads_1",
			settings:       `"customer_id":"1234567890","lead_form_asset_id":"asset_123","campaign_id":"campaign_456","credentials_ref":"cred_google_leads_1"`,
			assertKey:      "lead_form_asset_id",
			assertValue:    "asset_123",
		},
		{
			name:           "tiktok lead generation",
			provider:       ProviderTikTokLeadGen,
			credentialsRef: "cred_tiktok_leads_1",
			settings:       `"advertiser_id":"advertiser_123","form_id":"form_456","campaign_id":"campaign_789","credentials_ref":"cred_tiktok_leads_1"`,
			assertKey:      "advertiser_id",
			assertValue:    "advertiser_123",
		},
		{
			name:           "snap lead ads",
			provider:       ProviderSnapLeadAds,
			credentialsRef: "cred_snap_leads_1",
			settings:       `"ad_account_id":"adacct_123","form_id":"form_456","organization_id":"org_789","credentials_ref":"cred_snap_leads_1"`,
			assertKey:      "ad_account_id",
			assertValue:    "adacct_123",
		},
		{
			name:           "reddit lead gen",
			provider:       ProviderRedditLeadGen,
			credentialsRef: "cred_reddit_leads_1",
			settings:       `"ad_account_id":"t2_ads_123","form_id":"form_456","campaign_id":"camp_789","credentials_ref":"cred_reddit_leads_1"`,
			assertKey:      "ad_account_id",
			assertValue:    "t2_ads_123",
		},
		{
			name:           "pinterest lead ads",
			provider:       ProviderPinterestLeads,
			credentialsRef: "cred_pinterest_leads_1",
			settings:       `"ad_account_id":"549755885175","form_id":"form_456","campaign_id":"camp_789","credentials_ref":"cred_pinterest_leads_1"`,
			assertKey:      "ad_account_id",
			assertValue:    "549755885175",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := newFakeStore()
			deps := &Deps{Repo: store}

			rec := httptest.NewRecorder()
			deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
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
				store.lastInput.Settings["setup_surface"] != "lead_integrations" ||
				store.lastInput.Settings["managed_by_postwave"] != true {
				t.Fatalf("settings=%+v", store.lastInput.Settings)
			}
		})
	}
}

func TestCreateFacebookLeadAdsIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"facebook-lead-ads",
		"settings":{
			"page_id":"page_123",
			"form_id":"form_456",
			"ad_account_id":"act_789",
			"credentials_ref":"cred_meta_leads_1",
			"webhook_secret_ref":"cred_meta_leads_webhook_1",
			"default_tags":"facebook,paid-lead"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderFacebookLeadAds || store.lastInput.CredentialsRef != "cred_meta_leads_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["page_id"] != "page_123" ||
		store.lastInput.Settings["form_id"] != "form_456" ||
		store.lastInput.Settings["setup_surface"] != "lead_integrations" ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
}

func TestCreateFacebookLeadAdsIntegrationReconcilesManagedPageSubscription(t *testing.T) {
	store := newFakeStore()
	registrar := &fakeFacebookLeadAdsPageSubscriptionRegistrar{}
	deps := &Deps{
		Repo:                             store,
		FacebookLeadAdsPageSubscriptions: registrar,
		PublicBaseURL:                    "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"facebook-lead-ads",
		"settings":{
			"page_id":"page_123",
			"form_id":"form_456",
			"credentials_ref":"cred_meta_leads_1",
			"webhook_secret_ref":"cred_meta_leads_webhook_1"
		}
	}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.reconcileCalls != 1 || registrar.lastBaseURL != "https://app.postwave.test" {
		t.Fatalf("registrar calls=%d base=%q", registrar.reconcileCalls, registrar.lastBaseURL)
	}
	if registrar.lastIntegration.Settings["page_id"] != "page_123" || registrar.lastIntegration.Settings["form_id"] != "form_456" {
		t.Fatalf("registrar integration=%+v", registrar.lastIntegration)
	}
	settings := store.lastInput.Settings
	if settings["facebook_lead_ads_page_subscription_page_id"] != "page_123" ||
		settings["facebook_lead_ads_page_subscription_endpoint"] != "https://app.postwave.test/api/public/lead-integrations/facebook-lead-ads/webhooks" ||
		settings["facebook_lead_ads_page_subscription_subscribed"] != true ||
		settings["facebook_lead_ads_page_subscription_managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", settings)
	}
	fields, ok := settings["facebook_lead_ads_page_subscription_fields"].([]string)
	if !ok || len(fields) != 1 || fields[0] != "leadgen" {
		t.Fatalf("subscription fields=%T %+v", settings["facebook_lead_ads_page_subscription_fields"], settings)
	}
	if strings.Contains(fmt.Sprint(settings["facebook_lead_ads_page_subscription_endpoint"]), "secret") {
		t.Fatalf("saved endpoint must not contain signing secret: %+v", settings)
	}
}

func TestCreateFacebookLeadAdsIntegrationReusesExistingSubscriptionMetadataForReconcile(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFacebookLeadAds
	store.integration.Name = "Facebook Lead Ads page_123"
	store.integration.CredentialsRef = "cred_meta_leads_1"
	store.integration.Settings = map[string]any{
		"page_id":         "page_123",
		"form_id":         "form_456",
		"credentials_ref": "cred_meta_leads_1",
		"facebook_lead_ads_page_subscription_page_id":             "page_123",
		"facebook_lead_ads_page_subscription_managed_by_postwave": true,
	}
	registrar := &fakeFacebookLeadAdsPageSubscriptionRegistrar{}
	deps := &Deps{
		Repo:                             store,
		FacebookLeadAdsPageSubscriptions: registrar,
		PublicBaseURL:                    "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"facebook-lead-ads",
		"settings":{
			"page_id":"page_123",
			"form_id":"form_456",
			"credentials_ref":"cred_meta_leads_2",
			"default_tags":"launch"
		}
	}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.lastIntegration.Settings["facebook_lead_ads_page_subscription_page_id"] != "page_123" {
		t.Fatalf("registrar did not receive existing subscription metadata: %+v", registrar.lastIntegration.Settings)
	}
	if store.lastInput.Settings["facebook_lead_ads_page_subscription_page_id"] != "page_123" ||
		store.lastInput.Settings["credentials_ref"] != "cred_meta_leads_2" ||
		store.lastInput.Settings["default_tags"] != "launch" {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
}

func TestCreateFacebookLeadAdsIntegrationStopsWhenPageSubscriptionFails(t *testing.T) {
	store := newFakeStore()
	registrar := &fakeFacebookLeadAdsPageSubscriptionRegistrar{reconcileErr: errors.New("meta page subscription failed")}
	deps := &Deps{
		Repo:                             store,
		FacebookLeadAdsPageSubscriptions: registrar,
		PublicBaseURL:                    "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"facebook-lead-ads",
		"settings":{
			"page_id":"page_123",
			"form_id":"form_456",
			"credentials_ref":"cred_meta_leads_1"
		}
	}`))

	if rec.Code != http.StatusBadGateway || store.lastInput.Provider != "" {
		t.Fatalf("status=%d body=%s input=%+v", rec.Code, rec.Body.String(), store.lastInput)
	}
	if registrar.reconcileCalls != 1 {
		t.Fatalf("reconcile calls=%d", registrar.reconcileCalls)
	}
}

func TestCreateLinkedInLeadGenIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"linkedin-lead-gen",
		"settings":{
			"ad_account_id":"urn:li:sponsoredAccount:123",
			"form_id":"urn:li:leadGenForm:456",
			"organization_id":"urn:li:organization:789",
			"credentials_ref":"cred_linkedin_leads_1",
			"webhook_secret_ref":"cred_linkedin_leads_webhook_1"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderLinkedInLeadGen || store.lastInput.CredentialsRef != "cred_linkedin_leads_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["ad_account_id"] != "urn:li:sponsoredAccount:123" ||
		store.lastInput.Settings["form_id"] != "urn:li:leadGenForm:456" ||
		store.lastInput.Settings["setup_surface"] != "lead_integrations" ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
}

func TestCreateTallyIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"tally",
		"settings":{
			"form_id":"form_123",
			"credentials_ref":"cred_tally_1",
			"webhook_secret_ref":"cred_tally_webhook_1",
			"default_tags":"tally,newsletter"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderTally || store.lastInput.CredentialsRef != "cred_tally_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["form_id"] != "form_123" ||
		store.lastInput.Settings["setup_surface"] != "lead_integrations" ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["webhook_secret_ref"] != nil {
		t.Fatalf("Tally should strip unverified webhook_secret_ref until webhook runtime exists: %+v", store.lastInput.Settings)
	}
}

func TestCreateSurveyMonkeyIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"surveymonkey",
		"settings":{
			"survey_id":"survey_123",
			"collector_id":"collector_456",
			"credentials_ref":"cred_surveymonkey_1",
			"webhook_secret_ref":"cred_surveymonkey_webhook_1"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderSurveyMonkey || store.lastInput.CredentialsRef != "cred_surveymonkey_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["survey_id"] != "survey_123" ||
		store.lastInput.Settings["setup_surface"] != "lead_integrations" ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["webhook_secret_ref"] != nil {
		t.Fatalf("SurveyMonkey should strip unverified webhook_secret_ref until webhook runtime exists: %+v", store.lastInput.Settings)
	}
}

func TestCreateCognitoFormsIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"cognito-forms",
		"settings":{
			"organization_id":"org_123",
			"form_id":"123",
			"view_id":"456",
			"credentials_ref":"cred_cognito_1",
			"default_tags":"cognito,newsletter",
			"webhook_secret_ref":"raw-unverified-webhook-ref"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderCognitoForms || store.lastInput.CredentialsRef != "cred_cognito_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["form_id"] != "123" ||
		store.lastInput.Settings["view_id"] != "456" ||
		store.lastInput.Settings["setup_surface"] != "lead_integrations" ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["webhook_secret_ref"] != nil {
		t.Fatalf("Cognito Forms should strip unverified webhook_secret_ref until webhook runtime exists: %+v", store.lastInput.Settings)
	}
}

func TestCreateWPFormsIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"wpforms",
		"settings":{
			"site_url":"https://example.com",
			"form_id":"123",
			"credentials_ref":"cred_wpforms_1",
			"default_tags":"wpforms,newsletter",
			"webhook_secret_ref":"raw-unverified-webhook-ref"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderWPForms || store.lastInput.CredentialsRef != "cred_wpforms_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["site_url"] != "https://example.com" ||
		store.lastInput.Settings["form_id"] != "123" ||
		store.lastInput.Settings["setup_surface"] != "lead_integrations" {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["webhook_secret_ref"] != nil {
		t.Fatalf("WPForms should strip unverified webhook_secret_ref until webhook runtime exists: %+v", store.lastInput.Settings)
	}
}

func TestCreateNinjaFormsIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"ninja-forms",
		"settings":{
			"site_url":"https://example.com",
			"form_id":"newsletter",
			"credentials_ref":"cred_ninja_forms_1",
			"default_tags":"ninja,newsletter",
			"webhook_secret_ref":"raw-unverified-webhook-ref"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderNinjaForms || store.lastInput.CredentialsRef != "cred_ninja_forms_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["site_url"] != "https://example.com" ||
		store.lastInput.Settings["form_id"] != "newsletter" ||
		store.lastInput.Settings["setup_surface"] != "lead_integrations" ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["webhook_secret_ref"] != nil {
		t.Fatalf("Ninja Forms should strip unverified webhook_secret_ref while using credentials_ref route-token auth: %+v", store.lastInput.Settings)
	}
}

func TestCreateFormidableFormsIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"formidable-forms",
		"settings":{
			"site_url":"https://example.com",
			"form_id":"40",
			"credentials_ref":"cred_formidable_1",
			"default_tags":"formidable,newsletter",
			"webhook_secret_ref":"raw-unverified-webhook-ref"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderFormidableForms || store.lastInput.CredentialsRef != "cred_formidable_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["site_url"] != "https://example.com" ||
		store.lastInput.Settings["form_id"] != "40" ||
		store.lastInput.Settings["setup_surface"] != "lead_integrations" {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["webhook_secret_ref"] != nil {
		t.Fatalf("Formidable Forms should strip unverified webhook_secret_ref until webhook runtime exists: %+v", store.lastInput.Settings)
	}
}

func TestCreateGravityFormsIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"gravity-forms",
		"settings":{
			"site_url":"https://example.com",
			"form_id":"123",
			"credentials_ref":"cred_gravity_1",
			"default_tags":"gravity,newsletter",
			"webhook_secret_ref":"raw-unverified-webhook-ref"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderGravityForms || store.lastInput.CredentialsRef != "cred_gravity_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["site_url"] != "https://example.com" ||
		store.lastInput.Settings["form_id"] != "123" ||
		store.lastInput.Settings["setup_surface"] != "lead_integrations" ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["webhook_secret_ref"] != nil {
		t.Fatalf("Gravity Forms should strip unverified webhook_secret_ref until webhook runtime exists: %+v", store.lastInput.Settings)
	}
}

func TestCreateWixIntegrationKeepsVerifiedWebhookRefs(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"wix",
		"settings":{
			"site_id":"site_123",
			"instance_id":"instance_456",
			"form_id":"form_789",
			"credentials_ref":"cred_wix_1",
			"webhook_public_key_ref":"cred_wix_public_key_1",
			"webhook_secret_ref":"cred_wix_bridge_secret_1"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderWix || store.lastInput.CredentialsRef != "cred_wix_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["instance_id"] != "instance_456" ||
		store.lastInput.Settings["webhook_public_key_ref"] != "cred_wix_public_key_1" ||
		store.lastInput.Settings["webhook_secret_ref"] != "cred_wix_bridge_secret_1" {
		t.Fatalf("verified Wix refs should be persisted: %+v", store.lastInput.Settings)
	}
}

func TestCreateJotformIntegrationKeepsVerifiedWebhookRefs(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"jotform",
		"settings":{
			"form_id":"form_123",
			"credentials_ref":"cred_jotform_1",
			"webhook_secret_ref":"cred_jotform_webhook_1",
			"api_region":"eu"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderJotform || store.lastInput.CredentialsRef != "cred_jotform_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["form_id"] != "form_123" ||
		store.lastInput.Settings["webhook_secret_ref"] != "cred_jotform_webhook_1" ||
		store.lastInput.Settings["api_region"] != "eu" {
		t.Fatalf("verified Jotform refs/settings should be persisted: %+v", store.lastInput.Settings)
	}
}

func TestCreateWebflowIntegrationKeepsVerifiedWebhookRefs(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"webflow",
		"settings":{
			"site_id":"site_123",
			"form_id":"form_456",
			"credentials_ref":"cred_webflow_1",
			"webhook_secret_ref":"cred_webflow_webhook_1",
			"form_element_id":"element_789"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderWebflow || store.lastInput.CredentialsRef != "cred_webflow_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["site_id"] != "site_123" ||
		store.lastInput.Settings["form_id"] != "form_456" ||
		store.lastInput.Settings["webhook_secret_ref"] != "cred_webflow_webhook_1" ||
		store.lastInput.Settings["form_element_id"] != "element_789" {
		t.Fatalf("verified Webflow refs/settings should be persisted: %+v", store.lastInput.Settings)
	}
}

func TestCreateIntegrationRequiresCredentialRefAndRejectsRawToken(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"typeform",
		"settings":{"form_id":"abc123","access_token":"secret"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("raw token status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"typeform",
		"settings":{"form_id":"abc123","credentials_ref":"Bearer raw-provider-token"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("raw credential ref status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"typeform",
		"settings":{
			"form_id":"abc123",
			"credentials_ref":"cred_typeform_1",
			"provider_cleanup":{"status":"spoofed","webhook_secret_ref":"vault://ignore"}
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderTypeform || store.lastInput.CredentialsRef != "cred_typeform_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["access_token"] != nil || store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["provider_cleanup"] != nil || strings.Contains(rec.Body.String(), "provider_cleanup") {
		t.Fatalf("create should strip caller-supplied provider cleanup evidence: settings=%+v body=%s", store.lastInput.Settings, rec.Body.String())
	}
}

func TestCreateTypeformIntegrationKeepsVerifiedWebhookCredentialRefs(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"typeform",
		"settings":{
			"form_id":"abc123",
			"credentials_ref":"cred_typeform_1",
			"webhook_secret_ref":"cred_typeform_webhook_1",
			"signing_secret_ref":"cred_typeform_signing_1"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Settings["webhook_secret_ref"] != "cred_typeform_webhook_1" ||
		store.lastInput.Settings["signing_secret_ref"] != "cred_typeform_signing_1" {
		t.Fatalf("verified Typeform webhook refs should be persisted: %+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["credentials_ref"] != "cred_typeform_1" {
		t.Fatalf("credential reference should remain, settings=%+v", store.lastInput.Settings)
	}
}

func TestCreateTypeformIntegrationRegistersManagedWebhook(t *testing.T) {
	store := newFakeStore()
	registrar := &fakeTypeformWebhookRegistrar{}
	deps := &Deps{
		Repo:             store,
		TypeformWebhooks: registrar,
		PublicBaseURL:    "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"typeform",
		"settings":{
			"form_id":"abc123",
			"credentials_ref":"cred_typeform_1",
			"webhook_secret_ref":"cred_typeform_webhook_1",
			"webhook_tag":"postwave-prod"
		}
	}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.reconcileCalls != 1 || registrar.lastBaseURL != "https://app.postwave.test" {
		t.Fatalf("registrar calls=%d base=%q", registrar.reconcileCalls, registrar.lastBaseURL)
	}
	settings := store.lastInput.Settings
	if settings["typeform_webhook_id"] != "typeform_wh_123" ||
		settings["typeform_webhook_tag"] != "postwave-prod" ||
		settings["typeform_webhook_endpoint"] != "https://app.postwave.test/api/public/lead-integrations/typeform/webhooks" ||
		settings["typeform_webhook_verified"] != true ||
		settings["typeform_webhook_verified_at"] != "2026-06-16T10:00:00Z" ||
		settings["typeform_webhook_managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", settings)
	}
	if strings.Contains(fmt.Sprint(settings["typeform_webhook_endpoint"]), "secret") {
		t.Fatalf("saved endpoint must not contain signing secret: %+v", settings)
	}
}

func TestCreateTypeformIntegrationRollsBackManagedWebhookWhenUpsertFails(t *testing.T) {
	store := newFakeStore()
	store.upsertErr = errors.New("database unavailable")
	registrar := &fakeTypeformWebhookRegistrar{}
	deps := &Deps{
		Repo:             store,
		TypeformWebhooks: registrar,
		PublicBaseURL:    "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"typeform",
		"name":"Rollback Typeform",
		"settings":{
			"form_id":"abc123",
			"credentials_ref":"cred_typeform_1",
			"webhook_secret_ref":"cred_typeform_webhook_1",
			"webhook_tag":"postwave-prod"
		}
	}`))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.reconcileCalls != 1 || registrar.cleanupCalls != 1 {
		t.Fatalf("reconcile calls=%d cleanup calls=%d", registrar.reconcileCalls, registrar.cleanupCalls)
	}
	if registrar.lastBaseURL != "https://app.postwave.test" ||
		registrar.lastIntegration.Settings["typeform_webhook_tag"] != "postwave-prod" ||
		registrar.lastIntegration.Settings["typeform_webhook_id"] != "typeform_wh_123" {
		t.Fatalf("rollback integration=%+v base=%q", registrar.lastIntegration, registrar.lastBaseURL)
	}
	if store.lastInput.Provider != "" {
		t.Fatalf("failed upsert should not persist input: %+v", store.lastInput)
	}
}

func TestCreateFilloutIntegrationRollsBackManagedWebhookWhenUpsertFails(t *testing.T) {
	store := newFakeStore()
	store.upsertErr = errors.New("database unavailable")
	registrar := &fakeFilloutWebhookRegistrar{}
	deps := &Deps{
		Repo:            store,
		FilloutWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"fillout",
		"name":"Rollback Fillout",
		"settings":{
			"form_id":"form_123",
			"credentials_ref":"cred_fillout_1",
			"webhook_secret_ref":"cred_fillout_webhook_1"
		}
	}`))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.reconcileCalls != 1 || registrar.cleanupCalls != 1 {
		t.Fatalf("reconcile calls=%d cleanup calls=%d", registrar.reconcileCalls, registrar.cleanupCalls)
	}
	if registrar.lastBaseURL != "https://app.postwave.test" ||
		registrar.lastIntegration.Settings["fillout_webhook_id"] != "fillout_wh_123" ||
		registrar.lastIntegration.Settings["fillout_webhook_endpoint"] != "https://app.postwave.test/api/public/lead-integrations/fillout/webhooks?form_id=form_123" {
		t.Fatalf("rollback integration=%+v base=%q", registrar.lastIntegration, registrar.lastBaseURL)
	}
	if store.lastInput.Provider != "" {
		t.Fatalf("failed upsert should not persist input: %+v", store.lastInput)
	}
}

func TestCreateJotformIntegrationRollsBackManagedWebhookWhenUpsertFails(t *testing.T) {
	store := newFakeStore()
	store.upsertErr = errors.New("database unavailable")
	registrar := &fakeJotformWebhookRegistrar{}
	deps := &Deps{
		Repo:            store,
		JotformWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"jotform",
		"name":"Rollback Jotform",
		"settings":{
			"form_id":"form_123",
			"credentials_ref":"cred_jotform_1",
			"webhook_secret_ref":"cred_jotform_webhook_1"
		}
	}`))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.reconcileCalls != 1 || registrar.cleanupCalls != 1 {
		t.Fatalf("reconcile calls=%d cleanup calls=%d", registrar.reconcileCalls, registrar.cleanupCalls)
	}
	if registrar.lastBaseURL != "https://app.postwave.test" ||
		registrar.lastIntegration.Settings["jotform_webhook_id"] != "jotform_wh_123" ||
		registrar.lastIntegration.Settings["jotform_webhook_endpoint"] != "https://app.postwave.test/api/public/lead-integrations/jotform/webhooks?form_id=form_123" {
		t.Fatalf("rollback integration=%+v base=%q", registrar.lastIntegration, registrar.lastBaseURL)
	}
	if store.lastInput.Provider != "" {
		t.Fatalf("failed upsert should not persist input: %+v", store.lastInput)
	}
}

func TestCreateWebflowIntegrationRollsBackManagedWebhookWhenUpsertFails(t *testing.T) {
	store := newFakeStore()
	store.upsertErr = errors.New("database unavailable")
	registrar := &fakeWebflowWebhookRegistrar{}
	deps := &Deps{
		Repo:            store,
		WebflowWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"webflow",
		"name":"Rollback Webflow",
		"settings":{
			"site_id":"site_123",
			"form_id":"form_456",
			"credentials_ref":"cred_webflow_1",
			"webhook_secret_ref":"cred_webflow_webhook_1"
		}
	}`))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.reconcileCalls != 1 || registrar.cleanupCalls != 1 {
		t.Fatalf("reconcile calls=%d cleanup calls=%d", registrar.reconcileCalls, registrar.cleanupCalls)
	}
	if registrar.lastBaseURL != "https://app.postwave.test" ||
		registrar.lastIntegration.Settings["webflow_webhook_id"] != "webflow_wh_123" ||
		registrar.lastIntegration.Settings["webflow_webhook_endpoint"] != "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks" {
		t.Fatalf("rollback integration=%+v base=%q", registrar.lastIntegration, registrar.lastBaseURL)
	}
	if store.lastInput.Provider != "" {
		t.Fatalf("failed upsert should not persist input: %+v", store.lastInput)
	}
}

func TestCreateFacebookLeadAdsIntegrationRollsBackManagedPageSubscriptionWhenUpsertFails(t *testing.T) {
	store := newFakeStore()
	store.upsertErr = errors.New("database unavailable")
	registrar := &fakeFacebookLeadAdsPageSubscriptionRegistrar{}
	deps := &Deps{
		Repo:                             store,
		FacebookLeadAdsPageSubscriptions: registrar,
		PublicBaseURL:                    "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"facebook-lead-ads",
		"name":"Rollback Facebook Lead Ads",
		"settings":{
			"page_id":"page_123",
			"form_id":"form_456",
			"credentials_ref":"cred_meta_leads_1",
			"webhook_secret_ref":"cred_meta_leads_webhook_1"
		}
	}`))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.reconcileCalls != 1 || registrar.cleanupCalls != 1 {
		t.Fatalf("reconcile calls=%d cleanup calls=%d", registrar.reconcileCalls, registrar.cleanupCalls)
	}
	if registrar.lastBaseURL != "https://app.postwave.test" ||
		registrar.lastIntegration.Settings["facebook_lead_ads_page_subscription_page_id"] != "page_123" ||
		registrar.lastIntegration.Settings["facebook_lead_ads_page_subscription_endpoint"] != "https://app.postwave.test/api/public/lead-integrations/facebook-lead-ads/webhooks" {
		t.Fatalf("rollback integration=%+v base=%q", registrar.lastIntegration, registrar.lastBaseURL)
	}
	if store.lastInput.Provider != "" {
		t.Fatalf("failed upsert should not persist input: %+v", store.lastInput)
	}
}

func TestCreateJotformIntegrationDoesNotRollBackReusedProviderWebhookWhenUpsertFails(t *testing.T) {
	store := newFakeStore()
	store.upsertErr = errors.New("database unavailable")
	registrar := &fakeJotformWebhookRegistrar{reconcileSummary: JotformWebhookReconcileSummary{
		WebhookID:    "jotform_existing_wh",
		Endpoint:     "https://app.postwave.test/api/public/lead-integrations/jotform/webhooks/form_123",
		RegisteredAt: time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
		Reused:       true,
	}}
	deps := &Deps{
		Repo:            store,
		JotformWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"jotform",
		"name":"Rollback Reused Jotform",
		"settings":{
			"form_id":"form_123",
			"credentials_ref":"cred_jotform_1",
			"webhook_secret_ref":"cred_jotform_webhook_1"
		}
	}`))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.reconcileCalls != 1 || registrar.cleanupCalls != 0 {
		t.Fatalf("reconcile calls=%d cleanup calls=%d", registrar.reconcileCalls, registrar.cleanupCalls)
	}
	if store.lastInput.Provider != "" {
		t.Fatalf("failed upsert should not persist input: %+v", store.lastInput)
	}
}

func TestCreateTypeformIntegrationMergesExistingWebhookMetadataBeforeRegistration(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderTypeform
	store.integration.Name = "Typeform abc123"
	store.integration.CredentialsRef = "cred_typeform_1"
	store.integration.Settings = map[string]any{
		"form_id":                   "abc123",
		"credentials_ref":           "cred_typeform_1",
		"typeform_webhook_id":       "typeform_wh_existing",
		"typeform_webhook_tag":      "postwave-prod",
		"typeform_webhook_endpoint": "https://app.postwave.test/api/public/lead-integrations/typeform/webhooks",
	}
	registrar := &fakeTypeformWebhookRegistrar{
		reconcileSummary: TypeformWebhookReconcileSummary{
			WebhookID:    "typeform_wh_existing",
			Tag:          "postwave-prod",
			Endpoint:     "https://app.postwave.test/api/public/lead-integrations/typeform/webhooks",
			EventTypes:   map[string]bool{"form_response": true},
			RegisteredAt: time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
			Upserted:     true,
		},
	}
	deps := &Deps{
		Repo:             store,
		TypeformWebhooks: registrar,
		PublicBaseURL:    "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"typeform",
		"settings":{
			"form_id":"abc123",
			"credentials_ref":"cred_typeform_2",
			"default_tags":"launch"
		}
	}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.lastIntegration.Settings["typeform_webhook_id"] != "typeform_wh_existing" {
		t.Fatalf("registrar did not receive existing webhook metadata: %+v", registrar.lastIntegration.Settings)
	}
	if store.lastInput.Settings["typeform_webhook_id"] != "typeform_wh_existing" ||
		store.lastInput.Settings["credentials_ref"] != "cred_typeform_2" ||
		store.lastInput.Settings["default_tags"] != "launch" {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
}

func TestCreateBridgeOnlySquarespaceIntegrationRejected(t *testing.T) {
	deps := &Deps{Repo: newFakeStore()}
	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"squarespace",
		"settings":{"site_id":"site_123","credentials_ref":"cred_squarespace_bridge_1"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "bridge-only") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestCreateFilloutIntegrationRegistersManagedWebhook(t *testing.T) {
	store := newFakeStore()
	registrar := &fakeFilloutWebhookRegistrar{}
	deps := &Deps{
		Repo:            store,
		FilloutWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"fillout",
		"settings":{
			"form_id":"form_123",
			"credentials_ref":"cred_fillout_1",
			"webhook_secret_ref":"cred_fillout_webhook_1"
		}
	}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.reconcileCalls != 1 || registrar.lastBaseURL != "https://app.postwave.test" {
		t.Fatalf("registrar calls=%d base=%q", registrar.reconcileCalls, registrar.lastBaseURL)
	}
	settings := store.lastInput.Settings
	if settings["fillout_webhook_id"] != "fillout_wh_123" ||
		settings["fillout_webhook_endpoint"] != "https://app.postwave.test/api/public/lead-integrations/fillout/webhooks?form_id=form_123" ||
		settings["fillout_webhook_managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", settings)
	}
	if strings.Contains(fmt.Sprint(settings["fillout_webhook_endpoint"]), "token=") {
		t.Fatalf("saved endpoint must not contain webhook token: %+v", settings)
	}
}

func TestCreateFilloutIntegrationReusesExistingWebhookMetadataForRegistration(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFillout
	store.integration.Name = "Fillout form_123"
	store.integration.CredentialsRef = "cred_fillout_1"
	store.integration.Settings = map[string]any{
		"form_id":                  "form_123",
		"credentials_ref":          "cred_fillout_1",
		"fillout_webhook_id":       "fillout_wh_existing",
		"fillout_webhook_endpoint": "https://app.postwave.test/api/public/lead-integrations/fillout/webhooks?form_id=form_123",
	}
	registrar := &fakeFilloutWebhookRegistrar{
		reconcileSummary: FilloutWebhookReconcileSummary{
			WebhookID:    "fillout_wh_existing",
			Endpoint:     "https://app.postwave.test/api/public/lead-integrations/fillout/webhooks?form_id=form_123",
			RegisteredAt: time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
			Reused:       true,
		},
	}
	deps := &Deps{
		Repo:            store,
		FilloutWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"fillout",
		"settings":{
			"form_id":"form_123",
			"credentials_ref":"cred_fillout_2",
			"default_tags":"launch"
		}
	}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.lastIntegration.Settings["fillout_webhook_id"] != "fillout_wh_existing" {
		t.Fatalf("registrar did not receive existing webhook metadata: %+v", registrar.lastIntegration.Settings)
	}
	if store.lastInput.Settings["fillout_webhook_id"] != "fillout_wh_existing" ||
		store.lastInput.Settings["credentials_ref"] != "cred_fillout_2" ||
		store.lastInput.Settings["default_tags"] != "launch" {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
}

func TestCreateJotformIntegrationRegistersManagedWebhook(t *testing.T) {
	store := newFakeStore()
	registrar := &fakeJotformWebhookRegistrar{}
	deps := &Deps{
		Repo:            store,
		JotformWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"jotform",
		"settings":{
			"form_id":"form_123",
			"credentials_ref":"cred_jotform_1",
			"webhook_secret_ref":"cred_jotform_webhook_1"
		}
	}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.reconcileCalls != 1 || registrar.lastBaseURL != "https://app.postwave.test" {
		t.Fatalf("registrar calls=%d base=%q", registrar.reconcileCalls, registrar.lastBaseURL)
	}
	settings := store.lastInput.Settings
	if settings["jotform_webhook_id"] != "jotform_wh_123" ||
		settings["jotform_webhook_endpoint"] != "https://app.postwave.test/api/public/lead-integrations/jotform/webhooks?form_id=form_123" ||
		settings["jotform_webhook_managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", settings)
	}
	if strings.Contains(fmt.Sprint(settings["jotform_webhook_endpoint"]), "token=") {
		t.Fatalf("saved endpoint must not contain webhook token: %+v", settings)
	}
}

func TestCreateJotformIntegrationReusesExistingWebhookMetadataForRegistration(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderJotform
	store.integration.Name = "Jotform form_123"
	store.integration.CredentialsRef = "cred_jotform_1"
	store.integration.Settings = map[string]any{
		"form_id":                  "form_123",
		"credentials_ref":          "cred_jotform_1",
		"jotform_webhook_id":       "jotform_wh_existing",
		"jotform_webhook_endpoint": "https://app.postwave.test/api/public/lead-integrations/jotform/webhooks?form_id=form_123",
	}
	registrar := &fakeJotformWebhookRegistrar{
		reconcileSummary: JotformWebhookReconcileSummary{
			WebhookID:    "jotform_wh_existing",
			Endpoint:     "https://app.postwave.test/api/public/lead-integrations/jotform/webhooks?form_id=form_123",
			RegisteredAt: time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
			Reused:       true,
		},
	}
	deps := &Deps{
		Repo:            store,
		JotformWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"jotform",
		"settings":{
			"form_id":"form_123",
			"credentials_ref":"cred_jotform_2",
			"default_tags":"launch"
		}
	}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.lastIntegration.Settings["jotform_webhook_id"] != "jotform_wh_existing" {
		t.Fatalf("registrar did not receive existing webhook metadata: %+v", registrar.lastIntegration.Settings)
	}
	if store.lastInput.Settings["jotform_webhook_id"] != "jotform_wh_existing" ||
		store.lastInput.Settings["credentials_ref"] != "cred_jotform_2" ||
		store.lastInput.Settings["default_tags"] != "launch" {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
}

func TestCreateWebflowIntegrationRegistersManagedWebhook(t *testing.T) {
	store := newFakeStore()
	registrar := &fakeWebflowWebhookRegistrar{}
	deps := &Deps{
		Repo:            store,
		WebflowWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"webflow",
		"settings":{
			"site_id":"site_123",
			"form_name":"Newsletter",
			"credentials_ref":"cred_webflow_1",
			"webhook_secret_ref":"cred_webflow_webhook_1"
		}
	}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.reconcileCalls != 1 || registrar.lastBaseURL != "https://app.postwave.test" {
		t.Fatalf("registrar calls=%d base=%q", registrar.reconcileCalls, registrar.lastBaseURL)
	}
	settings := store.lastInput.Settings
	if settings["webflow_webhook_id"] != "webflow_wh_123" ||
		settings["webflow_webhook_endpoint"] != "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks" ||
		settings["webflow_webhook_trigger_type"] != "form_submission" ||
		settings["webflow_webhook_managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", settings)
	}
	filter, _ := settings["webflow_webhook_filter"].(map[string]any)
	if filter["name"] != "Newsletter" {
		t.Fatalf("filter=%+v settings=%+v", filter, settings)
	}
	if strings.Contains(fmt.Sprint(settings["webflow_webhook_endpoint"]), "secret") {
		t.Fatalf("saved endpoint must not contain signing secret: %+v", settings)
	}
}

func TestCreateWebflowIntegrationReusesExistingWebhookMetadataForRegistration(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderWebflow
	store.integration.Name = "Webflow site_123"
	store.integration.CredentialsRef = "cred_webflow_1"
	store.integration.Settings = map[string]any{
		"site_id":                  "site_123",
		"credentials_ref":          "cred_webflow_1",
		"webflow_webhook_id":       "webflow_wh_existing",
		"webflow_webhook_endpoint": "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks",
	}
	registrar := &fakeWebflowWebhookRegistrar{
		reconcileSummary: WebflowWebhookReconcileSummary{
			WebhookID:    "webflow_wh_existing",
			Endpoint:     "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks",
			TriggerType:  "form_submission",
			RegisteredAt: time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
			Reused:       true,
		},
	}
	deps := &Deps{
		Repo:            store,
		WebflowWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"webflow",
		"settings":{
			"site_id":"site_123",
			"credentials_ref":"cred_webflow_2",
			"default_tags":"launch"
		}
	}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if registrar.lastIntegration.Settings["webflow_webhook_id"] != "webflow_wh_existing" {
		t.Fatalf("registrar did not receive existing webhook metadata: %+v", registrar.lastIntegration.Settings)
	}
	if store.lastInput.Settings["webflow_webhook_id"] != "webflow_wh_existing" ||
		store.lastInput.Settings["credentials_ref"] != "cred_webflow_2" ||
		store.lastInput.Settings["default_tags"] != "launch" {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
}

func TestCreateWebflowIntegrationPersistsWebhookRepairEvidence(t *testing.T) {
	store := newFakeStore()
	registrar := &fakeWebflowWebhookRegistrar{
		reconcileSummary: WebflowWebhookReconcileSummary{
			WebhookID:         "webflow_wh_repaired",
			Endpoint:          "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks",
			TriggerType:       "form_submission",
			RegisteredAt:      time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC),
			Reused:            true,
			Repaired:          true,
			RepairReason:      "stored_webhook_not_found",
			PreviousWebhookID: "webflow_wh_stale",
		},
	}
	deps := &Deps{
		Repo:            store,
		WebflowWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations", `{
		"provider":"webflow",
		"settings":{
			"site_id":"site_123",
			"credentials_ref":"cred_webflow_1"
		}
	}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	settings := store.lastInput.Settings
	if settings["webflow_webhook_id"] != "webflow_wh_repaired" ||
		settings["webflow_webhook_repaired"] != true ||
		settings["webflow_webhook_repair_reason"] != "stored_webhook_not_found" ||
		settings["webflow_webhook_previous_id"] != "webflow_wh_stale" ||
		settings["webflow_webhook_reconciled_at"] != "2026-06-16T10:00:00Z" {
		t.Fatalf("settings=%+v", settings)
	}
}

func TestSyncIntegrationUpsertsSubmissionsAndEvents(t *testing.T) {
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
	deps.SyncIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/sync", `{
		"cursor":"after-123",
		"submissions":[{"source_id":"r1","email":"Lead@Example.com","first_name":"Ada","form_id":"abc123"}]
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "completed" || out.SubscribersUpserted != 1 || out.EventsTracked != 1 || out.RunID == "" {
		t.Fatalf("summary=%+v", out)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("submissions=%+v", profiles.submissions)
	}
	if len(events.submissions) != 1 || events.submissions[0].FormID != "abc123" {
		t.Fatalf("events=%+v", events.submissions)
	}
}

func TestSyncIntegrationRequiresCanonicalSubmissions(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
		Events:   &fakeEventSink{},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/sync", `{"cursor":"after-123"}`))

	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "payload_required") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("empty lead sync should not record a provider-pull-like run: %+v", store.runs)
	}
}

func TestSyncIntegrationUsesTypeformBackfillerForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.SyncCursor = encodeTypeformCursor("previous-token")
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &fakeTypeformBackfiller{req: SyncRequest{
		Cursor:      typeformCursorComplete,
		Submissions: []SubmissionInput{{SourceID: "typeform://response/abc123/r1", Email: "lead@example.com", FormID: "abc123"}},
	}}
	deps := &Deps{
		Repo:               store,
		Profiles:           profiles,
		Events:             events,
		TypeformBackfiller: backfiller,
		Now:                func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != encodeTypeformCursor("previous-token") {
		t.Fatalf("backfiller called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != typeformCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationStoresTypeformRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeTypeformCursor("resp_1")
	store := newFakeStore()
	store.integration.SyncCursor = cursor
	backfiller := &fakeTypeformBackfiller{err: TypeformRateLimitError{
		Path:       "/forms/abc123/responses",
		StatusCode: http.StatusTooManyRequests,
		RetryAfter: 2 * time.Minute,
		Snippet:    "slow down",
	}}
	deps := &Deps{
		Repo:               store,
		TypeformBackfiller: backfiller,
		Now:                func() time.Time { return now },
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("backfiller called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" || store.runs[0].RunMode != "backfill" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeTypeformRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.runs[0].CursorTo, ok, err)
	}
	if retry.Cursor != cursor || retry.After != "resp_1" || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationSkipsTypeformRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeTypeformCursor("resp_1")
	retryCursor := encodeTypeformRetryCursor(typeformRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeTypeformBackfiller{}
	deps := &Deps{
		Repo:               store,
		TypeformBackfiller: backfiller,
		Now:                func() time.Time { return now },
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.called {
		t.Fatalf("backfiller should not be called before retry is due")
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].SubmissionsSeen != 0 || store.runs[0].CursorTo != retryCursor {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationResumesTypeformRetryCursorWhenDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeTypeformCursor("resp_1")
	retryCursor := encodeTypeformRetryCursor(typeformRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &fakeTypeformBackfiller{req: SyncRequest{
		Cursor:      typeformCursorComplete,
		Submissions: []SubmissionInput{{SourceID: "typeform://response/abc123/resp_2", Email: "lead@example.com", FormID: "abc123"}},
	}}
	deps := &Deps{
		Repo:               store,
		Profiles:           profiles,
		Events:             events,
		TypeformBackfiller: backfiller,
		Now:                func() time.Time { return now },
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("backfiller called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != typeformCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationPreservesTypeformRetryAttemptsOnDueBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeTypeformCursor("resp_1")
	retryCursor := encodeTypeformRetryCursor(typeformRetryState{
		Cursor:        cursor,
		Attempts:      2,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeTypeformBackfiller{err: TypeformRateLimitError{
		Path:       "/forms/abc123/responses",
		StatusCode: http.StatusTooManyRequests,
		RetryAfter: 2 * time.Minute,
		Snippet:    "still slow",
	}}
	deps := &Deps{
		Repo:               store,
		TypeformBackfiller: backfiller,
		Now:                func() time.Time { return now },
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("backfiller called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" || store.runs[0].RunMode != "backfill" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeTypeformRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.runs[0].CursorTo, ok, err)
	}
	if retry.Cursor != cursor || retry.After != "resp_1" || retry.Attempts != 3 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationStoresTypeformRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeTypeformCursor("resp_1")
	store := newFakeStore()
	store.integration.SyncCursor = cursor
	profiles := &fakeProfileSink{err: errors.New("profile sink unavailable")}
	backfiller := &fakeTypeformBackfiller{req: SyncRequest{
		Cursor:      typeformCursorComplete,
		Submissions: []SubmissionInput{{SourceID: "typeform://response/abc123/resp_2", Email: "lead@example.com", FormID: "abc123"}},
	}}
	deps := &Deps{
		Repo:               store,
		Profiles:           profiles,
		TypeformBackfiller: backfiller,
		Now:                func() time.Time { return now },
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("backfiller called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" || store.runs[0].RunMode != "backfill" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeTypeformRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.runs[0].CursorTo, ok, err)
	}
	if retry.Cursor != cursor || retry.After != "resp_1" || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(typeformRetryInitialDelay).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationPreservesTypeformRetryAttemptsOnDueSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeTypeformCursor("resp_1")
	retryCursor := encodeTypeformRetryCursor(typeformRetryState{
		Cursor:        cursor,
		Attempts:      2,
		LastStatus:    "SYNC_FAILED",
		LastError:     "profile sink unavailable",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	profiles := &fakeProfileSink{err: errors.New("profile sink unavailable again")}
	backfiller := &fakeTypeformBackfiller{req: SyncRequest{
		Cursor:      typeformCursorComplete,
		Submissions: []SubmissionInput{{SourceID: "typeform://response/abc123/resp_2", Email: "lead@example.com", FormID: "abc123"}},
	}}
	deps := &Deps{
		Repo:               store,
		Profiles:           profiles,
		TypeformBackfiller: backfiller,
		Now:                func() time.Time { return now },
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("backfiller called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" || store.runs[0].RunMode != "backfill" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeTypeformRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.runs[0].CursorTo, ok, err)
	}
	if retry.Cursor != cursor || retry.After != "resp_1" || retry.Attempts != 3 || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(typeformRetryInitialDelay*4).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationPreservesWebflowRetryAttemptsOnDueBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := encodeWebflowCursor(webflowCursorState{Offset: 100})
	retryCursor := encodeWebflowRetryCursor(webflowRetryState{
		Cursor:        cursor,
		Attempts:      2,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.Provider = ProviderWebflow
	store.integration.Name = "Webflow lead form"
	store.integration.CredentialsRef = "cred_webflow_1"
	store.integration.Settings = map[string]any{"site_id": "site_123", "credentials_ref": "cred_webflow_1"}
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeWebflowBackfiller{err: webflowHTTPStatusError{
		Path:       "/v2/sites/site_123/form_submissions",
		StatusCode: http.StatusTooManyRequests,
		RetryAfter: 2 * time.Minute,
		Body:       "still slow",
	}}
	deps := &Deps{
		Repo:              store,
		WebflowBackfiller: backfiller,
		Now:               func() time.Time { return now },
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("backfiller called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" || store.runs[0].RunMode != "backfill" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeWebflowRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.runs[0].CursorTo, ok, err)
	}
	if retry.Cursor != cursor || retry.Offset != 100 || retry.Attempts != 3 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

type leadRetryParityCase struct {
	provider       string
	baseCursor     string
	completeCursor string
	retryCursor    func(string, time.Time) string
	assign         func(*Deps, *recordingLeadBackfiller)
}

func leadRetryParityCases() []leadRetryParityCase {
	return []leadRetryParityCase{
		{
			provider:       ProviderTypeform,
			baseCursor:     encodeTypeformCursor("resp_1"),
			completeCursor: typeformCursorComplete,
			retryCursor: func(cursor string, next time.Time) string {
				return encodeTypeformRetryCursor(typeformRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.TypeformBackfiller = backfiller },
		},
		{
			provider:       ProviderSurveyMonkey,
			baseCursor:     encodeSurveyMonkeyCursor(surveyMonkeyCursorState{NextURL: "https://api.surveymonkey.com/v3/surveys/survey_123/responses/bulk?page=100", Since: "2026-06-01T00:00:00Z"}),
			completeCursor: surveyMonkeyCursorComplete,
			retryCursor: func(cursor string, next time.Time) string {
				return encodeSurveyMonkeyRetryCursor(surveyMonkeyRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.SurveyMonkeyBackfiller = backfiller },
		},
		{
			provider:       ProviderUnbounce,
			baseCursor:     encodeUnbounceCursor(unbounceCursorState{Offset: 100, Since: "2026-06-01T00:00:00.000Z"}),
			completeCursor: unbounceCursorComplete,
			retryCursor: func(cursor string, next time.Time) string {
				return encodeUnbounceRetryCursor(unbounceRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.UnbounceBackfiller = backfiller },
		},
		{
			provider:       ProviderLeadpages,
			baseCursor:     encodeLeadpagesCursor(leadpagesCursorState{NextCursor: "cursor_2", LastSubmittedAt: "2026-07-02T12:00:00Z", LastID: "sub_1"}),
			completeCursor: encodeLeadpagesCursor(leadpagesCursorState{LastSubmittedAt: "2026-07-03T12:00:00Z", LastID: "sub_2"}),
			retryCursor: func(cursor string, next time.Time) string {
				return encodeLeadpagesRetryCursor(leadpagesRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.LeadpagesBackfiller = backfiller },
		},
		{
			provider:       Provider123FormBuilder,
			baseCursor:     encodeFormBuilder123Cursor(formBuilder123CursorState{FormID: "form_123", Page: 2, LastID: "123", LastSubmittedAt: "2026-07-02T12:00:00Z"}),
			completeCursor: encodeFormBuilder123Cursor(formBuilder123CursorState{FormID: "form_123", LastID: "124", LastSubmittedAt: "2026-07-03T12:00:00Z"}),
			retryCursor: func(cursor string, next time.Time) string {
				return encodeFormBuilder123RetryCursor(formBuilder123RetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.FormBuilder123Backfiller = backfiller },
		},
		{
			provider:       ProviderFormaloo,
			baseCursor:     encodeFormalooCursor(formalooCursorState{FormSlug: "form_123", Page: 2, LastSubmittedAt: "2026-07-02T12:00:00Z", LastSlug: "row_1"}),
			completeCursor: encodeFormalooCursor(formalooCursorState{FormSlug: "form_123", LastSubmittedAt: "2026-07-03T12:00:00Z", LastSlug: "row_2"}),
			retryCursor: func(cursor string, next time.Time) string {
				return encodeFormalooRetryCursor(formalooRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.FormalooBackfiller = backfiller },
		},
		{
			provider:       ProviderInstapage,
			baseCursor:     encodeInstapageCursor(instapageCursorState{NextPageToken: "token_2", Since: 1781517600}),
			completeCursor: instapageCursorComplete,
			retryCursor: func(cursor string, next time.Time) string {
				return encodeInstapageRetryCursor(instapageRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.InstapageBackfiller = backfiller },
		},
		{
			provider:       ProviderGravityForms,
			baseCursor:     encodeGravityFormsCursor(gravityFormsCursorState{Offset: 100, TotalCount: 200}),
			completeCursor: encodeGravityFormsCursor(gravityFormsCursorState{Offset: 200, TotalCount: 200}),
			retryCursor: func(cursor string, next time.Time) string {
				return encodeGravityFormsRetryCursor(gravityFormsRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.GravityFormsBackfiller = backfiller },
		},
		{
			provider:       ProviderWPForms,
			baseCursor:     encodeWPFormsCursor(wpformsCursorState{Page: 2, TotalPages: 4, TotalCount: 200}),
			completeCursor: encodeWPFormsCursor(wpformsCursorState{Page: 5, TotalPages: 4, TotalCount: 200}),
			retryCursor: func(cursor string, next time.Time) string {
				return encodeWPFormsRetryCursor(wpformsRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.WPFormsBackfiller = backfiller },
		},
		{
			provider:       ProviderFormidableForms,
			baseCursor:     encodeFormidableFormsCursor(formidableFormsCursorState{Page: 2, TotalPages: 4, TotalCount: 200}),
			completeCursor: encodeFormidableFormsCursor(formidableFormsCursorState{Page: 5, TotalPages: 4, TotalCount: 200}),
			retryCursor: func(cursor string, next time.Time) string {
				return encodeFormidableFormsRetryCursor(formidableFormsRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.FormidableFormsBackfiller = backfiller },
		},
		{
			provider:       ProviderWix,
			baseCursor:     encodeWixBackfillCursor(wixBackfillState{Object: "submissions", Cursor: "cursor_1"}),
			completeCursor: wixCursorComplete,
			retryCursor: func(cursor string, next time.Time) string {
				return encodeWixRetryCursor(wixRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.WixBackfiller = backfiller },
		},
		{
			provider:       ProviderJotform,
			baseCursor:     encodeJotformCursor(jotformCursorState{Offset: 100}),
			completeCursor: jotformCursorComplete,
			retryCursor: func(cursor string, next time.Time) string {
				return encodeJotformRetryCursor(jotformRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.JotformBackfiller = backfiller },
		},
		{
			provider:       ProviderWebflow,
			baseCursor:     encodeWebflowCursor(webflowCursorState{Offset: 100}),
			completeCursor: webflowCursorComplete,
			retryCursor: func(cursor string, next time.Time) string {
				return encodeWebflowRetryCursor(webflowRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.WebflowBackfiller = backfiller },
		},
		{
			provider:       ProviderPaperform,
			baseCursor:     encodePaperformCursor(paperformCursorState{Skip: 100}),
			completeCursor: paperformCursorComplete,
			retryCursor: func(cursor string, next time.Time) string {
				return encodePaperformRetryCursor(paperformRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.PaperformBackfiller = backfiller },
		},
		{
			provider:       ProviderFormstack,
			baseCursor:     encodeFormstackCursor(formstackCursorState{Page: 100}),
			completeCursor: formstackCursorComplete,
			retryCursor: func(cursor string, next time.Time) string {
				return encodeFormstackRetryCursor(formstackRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.FormstackBackfiller = backfiller },
		},
		{
			provider:       ProviderCognitoForms,
			baseCursor:     encodeCognitoFormsCursor(cognitoFormsCursorState{FormID: "123", ViewID: "456", LastID: "100", TotalCount: 200}),
			completeCursor: encodeCognitoFormsCursor(cognitoFormsCursorState{FormID: "123", ViewID: "456", LastID: "200", TotalCount: 200}),
			retryCursor: func(cursor string, next time.Time) string {
				return encodeCognitoFormsRetryCursor(cognitoFormsRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.CognitoFormsBackfiller = backfiller },
		},
		{
			provider:       ProviderFeathery,
			baseCursor:     encodeFeatheryCursor(featheryCursorState{NextURL: "https://api.feathery.io/api/form/submission/?page=100", Since: "2026-06-01T00:00:00Z"}),
			completeCursor: featheryCursorComplete,
			retryCursor: func(cursor string, next time.Time) string {
				return encodeFeatheryRetryCursor(featheryRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.FeatheryBackfiller = backfiller },
		},
		{
			provider:       ProviderFillout,
			baseCursor:     encodeFilloutCursor(filloutCursorState{Offset: 100}),
			completeCursor: filloutCursorComplete,
			retryCursor: func(cursor string, next time.Time) string {
				return encodeFilloutRetryCursor(filloutRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.FilloutBackfiller = backfiller },
		},
		{
			provider:       ProviderTally,
			baseCursor:     encodeTallyCursor(tallyCursorState{Page: 100}),
			completeCursor: tallyCursorComplete,
			retryCursor: func(cursor string, next time.Time) string {
				return encodeTallyRetryCursor(tallyRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) { deps.TallyBackfiller = backfiller },
		},
		{
			provider:       ProviderFacebookLeadAds,
			baseCursor:     encodeFacebookLeadAdsCursor("after_1"),
			completeCursor: facebookLeadAdsCursorComplete,
			retryCursor: func(cursor string, next time.Time) string {
				return encodeFacebookLeadAdsRetryCursor(facebookLeadAdsRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) {
				deps.FacebookLeadAdsBackfiller = backfiller
			},
		},
		{
			provider:       ProviderGoogleLeadForms,
			baseCursor:     encodeGoogleLeadFormsWatermarkCursor("2026-06-28 09:00:00+05:30", "lead_0"),
			completeCursor: googleLeadFormsCursorComplete,
			retryCursor: func(cursor string, next time.Time) string {
				return encodeGoogleLeadFormsRetryCursor(googleLeadFormsRetryState{Cursor: cursor, Attempts: 1, LastStatus: "BACKFILL_FAILED", LastError: "provider throttled", NextAttemptAt: next.Format(time.RFC3339)})
			},
			assign: func(deps *Deps, backfiller *recordingLeadBackfiller) {
				deps.GoogleLeadFormsBackfiller = backfiller
			},
		},
	}
}

func configureLeadRetryParityIntegration(store *fakeStore, tc leadRetryParityCase, cursor string) {
	store.integration.Provider = tc.provider
	store.integration.Name = tc.provider + " lead form"
	store.integration.CredentialsRef = "cred_" + strings.NewReplacer("-", "_", " ", "_").Replace(tc.provider)
	store.integration.Settings = map[string]any{
		"credentials_ref": store.integration.CredentialsRef,
		"form_id":         "form_123",
		"survey_id":       "survey_123",
		"site_id":         "site_123",
		"site_url":        "https://example.com",
		"page_id":         "page_123",
		"view_id":         "456",
		"workspace_id":    "workspace_123",
		"customer_id":     "1234567890",
	}
	store.integration.SyncCursor = cursor
}

func decodeLeadRetryCursorForTest(t *testing.T, provider, cursor string) (string, string) {
	t.Helper()
	switch provider {
	case ProviderTypeform:
		retry, ok, err := decodeTypeformRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Typeform retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderSurveyMonkey:
		retry, ok, err := decodeSurveyMonkeyRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode SurveyMonkey retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderUnbounce:
		retry, ok, err := decodeUnbounceRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Unbounce retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderLeadpages:
		retry, ok, err := decodeLeadpagesRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Leadpages retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case Provider123FormBuilder:
		retry, ok, err := decodeFormBuilder123RetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode 123FormBuilder retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderFormaloo:
		retry, ok, err := decodeFormalooRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Formaloo retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderInstapage:
		retry, ok, err := decodeInstapageRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Instapage retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderGravityForms:
		retry, ok, err := decodeGravityFormsRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Gravity Forms retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderWPForms:
		retry, ok, err := decodeWPFormsRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode WPForms retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderFormidableForms:
		retry, ok, err := decodeFormidableFormsRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Formidable Forms retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderWix:
		retry, ok, err := decodeWixRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Wix retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderJotform:
		retry, ok, err := decodeJotformRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Jotform retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderWebflow:
		retry, ok, err := decodeWebflowRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Webflow retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderPaperform:
		retry, ok, err := decodePaperformRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Paperform retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderFormstack:
		retry, ok, err := decodeFormstackRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Formstack retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderCognitoForms:
		retry, ok, err := decodeCognitoFormsRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Cognito Forms retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderFeathery:
		retry, ok, err := decodeFeatheryRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Feathery retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderFillout:
		retry, ok, err := decodeFilloutRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Fillout retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderTally:
		retry, ok, err := decodeTallyRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Tally retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderFacebookLeadAds:
		retry, ok, err := decodeFacebookLeadAdsRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Facebook Lead Ads retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	case ProviderGoogleLeadForms:
		retry, ok, err := decodeGoogleLeadFormsRetryCursor(cursor)
		if err != nil || !ok {
			t.Fatalf("decode Google Lead Form Extensions retry cursor ok=%v err=%v cursor=%q", ok, err, cursor)
		}
		return retry.Cursor, retry.LastStatus
	default:
		t.Fatalf("unsupported provider %q", provider)
		return "", ""
	}
}

func TestSyncIntegrationSkipsLeadProviderRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	for _, tc := range leadRetryParityCases() {
		t.Run(tc.provider, func(t *testing.T) {
			retryCursor := tc.retryCursor(tc.baseCursor, now.Add(time.Hour))
			store := newFakeStore()
			configureLeadRetryParityIntegration(store, tc, retryCursor)
			backfiller := &recordingLeadBackfiller{}
			deps := &Deps{Repo: store, Now: func() time.Time { return now }}
			tc.assign(deps, backfiller)
			rec := httptest.NewRecorder()

			deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

			if rec.Code != http.StatusAccepted {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if backfiller.called {
				t.Fatalf("backfiller should not be called before retry is due")
			}
			if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].SubmissionsSeen != 0 || store.runs[0].CursorTo != retryCursor {
				t.Fatalf("runs=%+v", store.runs)
			}
		})
	}
}

func TestSyncIntegrationResumesLeadProviderRetryCursorWhenDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	for _, tc := range leadRetryParityCases() {
		t.Run(tc.provider, func(t *testing.T) {
			retryCursor := tc.retryCursor(tc.baseCursor, now.Add(-time.Minute))
			store := newFakeStore()
			configureLeadRetryParityIntegration(store, tc, retryCursor)
			profiles := &fakeProfileSink{}
			events := &fakeEventSink{}
			backfiller := &recordingLeadBackfiller{req: SyncRequest{
				Cursor:      tc.completeCursor,
				Submissions: []SubmissionInput{{SourceID: tc.provider + "://submission/sub_1", Email: "lead@example.com", FormID: "form_123"}},
			}}
			deps := &Deps{Repo: store, Profiles: profiles, Events: events, Now: func() time.Time { return now }}
			tc.assign(deps, backfiller)
			rec := httptest.NewRecorder()

			deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

			if rec.Code != http.StatusAccepted {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if !backfiller.called || backfiller.cursor != tc.baseCursor {
				t.Fatalf("backfiller called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, tc.baseCursor)
			}
			if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
				t.Fatalf("profiles=%+v", profiles.submissions)
			}
			if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != tc.completeCursor {
				t.Fatalf("runs=%+v", store.runs)
			}
		})
	}
}

func TestSyncIntegrationStoresLeadProviderRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	for _, tc := range leadRetryParityCases() {
		t.Run(tc.provider, func(t *testing.T) {
			store := newFakeStore()
			configureLeadRetryParityIntegration(store, tc, tc.baseCursor)
			backfiller := &recordingLeadBackfiller{err: errors.New("provider throttled")}
			deps := &Deps{Repo: store, Now: func() time.Time { return now }}
			tc.assign(deps, backfiller)
			rec := httptest.NewRecorder()

			deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

			if rec.Code != http.StatusBadGateway {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if !backfiller.called || backfiller.cursor != tc.baseCursor {
				t.Fatalf("backfiller called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, tc.baseCursor)
			}
			if len(store.runs) != 1 || store.runs[0].Status != "failed" || store.runs[0].RunMode != "backfill" {
				t.Fatalf("runs=%+v", store.runs)
			}
			cursor, status := decodeLeadRetryCursorForTest(t, tc.provider, store.runs[0].CursorTo)
			if cursor != tc.baseCursor || status != "BACKFILL_FAILED" {
				t.Fatalf("retry cursor=%q status=%q want cursor=%q BACKFILL_FAILED", cursor, status, tc.baseCursor)
			}
		})
	}
}

func TestSyncIntegrationStoresLeadProviderRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	for _, tc := range leadRetryParityCases() {
		t.Run(tc.provider, func(t *testing.T) {
			store := newFakeStore()
			configureLeadRetryParityIntegration(store, tc, tc.baseCursor)
			profiles := &fakeProfileSink{err: errors.New("profile sink unavailable")}
			backfiller := &recordingLeadBackfiller{req: SyncRequest{
				Cursor:      tc.completeCursor,
				Submissions: []SubmissionInput{{SourceID: tc.provider + "://submission/sub_1", Email: "lead@example.com", FormID: "form_123"}},
			}}
			deps := &Deps{Repo: store, Profiles: profiles, Now: func() time.Time { return now }}
			tc.assign(deps, backfiller)
			rec := httptest.NewRecorder()

			deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

			if rec.Code != http.StatusAccepted {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if !backfiller.called || backfiller.cursor != tc.baseCursor {
				t.Fatalf("backfiller called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, tc.baseCursor)
			}
			if len(store.runs) != 1 || store.runs[0].Status != "failed" || store.runs[0].RunMode != "backfill" {
				t.Fatalf("runs=%+v", store.runs)
			}
			cursor, status := decodeLeadRetryCursorForTest(t, tc.provider, store.runs[0].CursorTo)
			if cursor != tc.baseCursor || status != "SYNC_FAILED" {
				t.Fatalf("retry cursor=%q status=%q want cursor=%q SYNC_FAILED", cursor, status, tc.baseCursor)
			}
		})
	}
}

func TestLeadProviderRetryHelpersPreserveProviderCursorState(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	for _, tc := range leadRetryParityCases() {
		t.Run(tc.provider, func(t *testing.T) {
			dueRetry := tc.retryCursor(tc.baseCursor, now.Add(-time.Minute))
			effective, notDue, err := leadProviderEffectiveCursor(tc.provider, dueRetry, now)
			if err != nil {
				t.Fatal(err)
			}
			if notDue || effective != tc.baseCursor {
				t.Fatalf("effective=%q notDue=%v want %q false", effective, notDue, tc.baseCursor)
			}

			futureRetry := tc.retryCursor(tc.baseCursor, now.Add(time.Hour))
			effective, notDue, err = leadProviderEffectiveCursor(tc.provider, futureRetry, now)
			if err != nil {
				t.Fatal(err)
			}
			if !notDue || effective != tc.baseCursor {
				t.Fatalf("effective=%q notDue=%v want %q true", effective, notDue, tc.baseCursor)
			}
			if base := leadProviderRetryBaseCursor(tc.provider, futureRetry); base != tc.baseCursor {
				t.Fatalf("base=%q want %q", base, tc.baseCursor)
			}

			retryCursor, ok := leadProviderBackfillRetryCursor(tc.provider, tc.baseCursor, "BACKFILL_FAILED", errors.New("provider throttled"), now)
			if !ok {
				t.Fatalf("retry cursor not supported for %s", tc.provider)
			}
			cursor, status := decodeLeadRetryCursorForTest(t, tc.provider, retryCursor)
			if cursor != tc.baseCursor || status != "BACKFILL_FAILED" {
				t.Fatalf("retry cursor=%q status=%q want %q BACKFILL_FAILED", cursor, status, tc.baseCursor)
			}
		})
	}
}

func TestLeadBulkBackfillsSkipDisconnectedRows(t *testing.T) {
	for _, tc := range []struct {
		name     string
		provider string
		run      func(*fakeStore) (called bool, pages int, cursor string, err error)
	}{
		{
			name:     "typeform",
			provider: ProviderTypeform,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &fakeTypeformBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := TypeformBulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
		{
			name:     "wix",
			provider: ProviderWix,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &fakeWixBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := WixBulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
		{
			name:     "jotform",
			provider: ProviderJotform,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &fakeJotformBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := JotformBulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
		{
			name:     "instapage",
			provider: ProviderInstapage,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &recordingLeadBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := InstapageBulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
		{
			name:     "leadpages",
			provider: ProviderLeadpages,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &recordingLeadBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := LeadpagesBulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
		{
			name:     "123formbuilder",
			provider: Provider123FormBuilder,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &recordingLeadBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := FormBuilder123BulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
		{
			name:     "formaloo",
			provider: ProviderFormaloo,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &recordingLeadBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := FormalooBulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
		{
			name:     "gravity_forms",
			provider: ProviderGravityForms,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &recordingLeadBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := GravityFormsBulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
		{
			name:     "wpforms",
			provider: ProviderWPForms,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &recordingLeadBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := WPFormsBulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
		{
			name:     "formidable_forms",
			provider: ProviderFormidableForms,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &recordingLeadBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := FormidableFormsBulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
		{
			name:     "cognito_forms",
			provider: ProviderCognitoForms,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &recordingLeadBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := CognitoFormsBulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
		{
			name:     "webflow",
			provider: ProviderWebflow,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &fakeWebflowBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := WebflowBulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
		{
			name:     "fillout",
			provider: ProviderFillout,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &fakeFilloutBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := FilloutBulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
		{
			name:     "tally",
			provider: ProviderTally,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &fakeTallyBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := TallyBulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
		{
			name:     "facebook_lead_ads",
			provider: ProviderFacebookLeadAds,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &fakeFacebookLeadAdsBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := FacebookLeadAdsBulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
		{
			name:     "google_lead_forms",
			provider: ProviderGoogleLeadForms,
			run: func(store *fakeStore) (bool, int, string, error) {
				backfiller := &fakeGoogleLeadFormsBackfiller{req: SyncRequest{Submissions: subs("lead@example.com")}}
				summary, err := GoogleLeadFormsBulkBackfillRunner{Deps: &Deps{Repo: store}, Backfiller: backfiller}.Run(context.Background(), "tenant-1", "lead_1", "")
				return backfiller.called, summary.Pages, summary.Cursor, err
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeStore()
			store.integration.Provider = tc.provider
			store.integration.Status = "disconnected"
			store.integration.SyncCursor = "stored-cursor"

			called, pages, cursor, err := tc.run(store)
			if err != nil {
				t.Fatal(err)
			}
			if called || pages != 0 || cursor != "stored-cursor" {
				t.Fatalf("called=%v pages=%d cursor=%q", called, pages, cursor)
			}
			if len(store.runs) != 0 {
				t.Fatalf("disconnected scheduled backfill should not record runs: %+v", store.runs)
			}
		})
	}
}

func TestSyncIntegrationUsesWixBackfillerForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderWix
	store.integration.Name = "Wix lead form"
	store.integration.CredentialsRef = "cred_wix_1"
	store.integration.Settings = map[string]any{"site_id": "site_123", "instance_id": "instance_456", "form_id": "form_789", "credentials_ref": "cred_wix_1"}
	store.integration.SyncCursor = encodeWixBackfillCursor(wixBackfillState{Object: "submissions", Cursor: "cursor_1"})
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &fakeWixBackfiller{req: SyncRequest{
		Cursor:      wixCursorComplete,
		Submissions: []SubmissionInput{{SourceID: "wix://submission/form_789/sub_1", Email: "lead@example.com", FormID: "form_789"}},
	}}
	deps := &Deps{
		Repo:          store,
		Profiles:      profiles,
		Events:        events,
		WixBackfiller: backfiller,
		Now:           func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != encodeWixBackfillCursor(wixBackfillState{Object: "submissions", Cursor: "cursor_1"}) {
		t.Fatalf("backfiller called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != wixCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationUsesJotformBackfillerForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderJotform
	store.integration.Name = "Jotform lead form"
	store.integration.CredentialsRef = "cred_jotform_1"
	store.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_jotform_1"}
	store.integration.SyncCursor = encodeJotformCursor(jotformCursorState{Offset: 100})
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &fakeJotformBackfiller{req: SyncRequest{
		Cursor:      jotformCursorComplete,
		Submissions: []SubmissionInput{{SourceID: "jotform://submission/form_123/sub_1", Email: "lead@example.com", FormID: "form_123"}},
	}}
	deps := &Deps{
		Repo:              store,
		Profiles:          profiles,
		Events:            events,
		JotformBackfiller: backfiller,
		Now:               func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != encodeJotformCursor(jotformCursorState{Offset: 100}) {
		t.Fatalf("backfiller called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != jotformCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationUsesWebflowBackfillerForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderWebflow
	store.integration.Name = "Webflow site"
	store.integration.CredentialsRef = "cred_webflow_1"
	store.integration.Settings = map[string]any{"site_id": "site_123", "form_id": "form_456", "credentials_ref": "cred_webflow_1"}
	store.integration.SyncCursor = encodeWebflowCursor(webflowCursorState{Offset: 100})
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &fakeWebflowBackfiller{req: SyncRequest{
		Cursor:      webflowCursorComplete,
		Submissions: []SubmissionInput{{SourceID: "webflow://submission/site_123/sub_1", Email: "lead@example.com", FormID: "form_456"}},
	}}
	deps := &Deps{
		Repo:              store,
		Profiles:          profiles,
		Events:            events,
		WebflowBackfiller: backfiller,
		Now:               func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != encodeWebflowCursor(webflowCursorState{Offset: 100}) {
		t.Fatalf("backfiller called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != webflowCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationUsesFilloutBackfillerForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFillout
	store.integration.Name = "Fillout form"
	store.integration.CredentialsRef = "cred_fillout_1"
	store.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_fillout_1"}
	store.integration.SyncCursor = encodeFilloutCursor(filloutCursorState{Offset: 100})
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &fakeFilloutBackfiller{req: SyncRequest{
		Cursor:      filloutCursorComplete,
		Submissions: []SubmissionInput{{SourceID: "fillout://submission/form_123/sub_1", Email: "lead@example.com", FormID: "form_123"}},
	}}
	deps := &Deps{
		Repo:              store,
		Profiles:          profiles,
		Events:            events,
		FilloutBackfiller: backfiller,
		Now:               func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != encodeFilloutCursor(filloutCursorState{Offset: 100}) {
		t.Fatalf("backfiller called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != filloutCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationUsesTallyBackfillerForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderTally
	store.integration.Name = "Tally form"
	store.integration.CredentialsRef = "cred_tally_1"
	store.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_tally_1"}
	store.integration.SyncCursor = encodeTallyCursor(tallyCursorState{Page: 100})
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &fakeTallyBackfiller{req: SyncRequest{
		Cursor:      tallyCursorComplete,
		Submissions: []SubmissionInput{{SourceID: "tally://submission/form_123/sub_1", Email: "lead@example.com", FormID: "form_123"}},
	}}
	deps := &Deps{
		Repo:            store,
		Profiles:        profiles,
		Events:          events,
		TallyBackfiller: backfiller,
		Now:             func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != encodeTallyCursor(tallyCursorState{Page: 100}) {
		t.Fatalf("backfiller called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != tallyCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationUsesFacebookLeadAdsBackfillerForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFacebookLeadAds
	store.integration.Name = "Facebook lead form"
	store.integration.CredentialsRef = "cred_meta_leads_1"
	store.integration.Settings = map[string]any{"page_id": "page_123", "form_id": "form_456", "credentials_ref": "cred_meta_leads_1"}
	store.integration.SyncCursor = encodeFacebookLeadAdsCursor("after_1")
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &fakeFacebookLeadAdsBackfiller{req: SyncRequest{
		Cursor:      facebookLeadAdsCursorComplete,
		Submissions: []SubmissionInput{{SourceID: "facebook-lead-ads://lead/lead_1", Email: "lead@example.com", FormID: "form_456"}},
	}}
	deps := &Deps{
		Repo:                      store,
		Profiles:                  profiles,
		Events:                    events,
		FacebookLeadAdsBackfiller: backfiller,
		Now:                       func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != encodeFacebookLeadAdsCursor("after_1") {
		t.Fatalf("backfiller called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(events.submissions) != 1 || events.submissions[0].SourceID != "facebook-lead-ads://lead/lead_1" {
		t.Fatalf("events=%+v", events.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != facebookLeadAdsCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestFacebookLeadAdsWebhookChallengeReturnsHubChallenge(t *testing.T) {
	deps := &Deps{
		Repo:                              newFakeStore(),
		FacebookLeadAdsWebhookVerifyToken: "verify_token_123",
	}
	req := httptest.NewRequest(http.MethodGet, "/api/public/lead-integrations/facebook-lead-ads/webhooks?hub.mode=subscribe&hub.verify_token=verify_token_123&hub.challenge=challenge_456", nil)
	rec := httptest.NewRecorder()

	deps.FacebookLeadAdsWebhookChallenge(rec, req)

	if rec.Code != http.StatusOK || rec.Body.String() != "challenge_456" {
		t.Fatalf("status=%d body=%q", rec.Code, rec.Body.String())
	}
}

func TestFacebookLeadAdsWebhookRejectsBadChallengeToken(t *testing.T) {
	deps := &Deps{
		Repo:                              newFakeStore(),
		FacebookLeadAdsWebhookVerifyToken: "verify_token_123",
	}
	req := httptest.NewRequest(http.MethodGet, "/api/public/lead-integrations/facebook-lead-ads/webhooks?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge_456", nil)
	rec := httptest.NewRecorder()

	deps.FacebookLeadAdsWebhookChallenge(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestFacebookLeadAdsWebhookVerifiesSignatureFetchesLeadAndIngests(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFacebookLeadAds
	store.integration.Name = "Facebook lead form"
	store.integration.CredentialsRef = "cred_meta_leads_1"
	store.integration.Settings = map[string]any{"page_id": "page_123", "form_id": "form_456", "credentials_ref": "cred_meta_leads_1"}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	fetches := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetches++
		if r.URL.Path != "/lead_1" || r.Header.Get("Authorization") != "Bearer token_123" {
			t.Fatalf("unexpected Graph request path/auth=%q %q", r.URL.Path, r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id":"lead_1",
			"created_time":"2026-06-16T10:00:00+0000",
			"form_id":"form_456",
			"campaign_name":"Summer Launch",
			"field_data":[
				{"name":"email","values":["Lead@Example.com"]},
				{"name":"first_name","values":["Ada"]}
			]
		}`))
	}))
	defer server.Close()
	deps := &Deps{
		Repo:                       store,
		Profiles:                   profiles,
		Events:                     events,
		FacebookLeadAdsCredentials: fakeFacebookLeadAdsCredentialResolver{creds: FacebookLeadAdsCredentials{AccessToken: "token_123", AppSecret: "app_secret_123", APIBaseURL: server.URL}},
		Now:                        func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	body := facebookLeadAdsWebhookTestBody("lead_1")
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/facebook-lead-ads/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Hub-Signature-256", signFacebookLeadAdsWebhookTest("app_secret_123", body))
	rec := httptest.NewRecorder()

	deps.FacebookLeadAdsWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if fetches != 1 {
		t.Fatalf("fetches=%d", fetches)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" || profiles.submissions[0].FirstName != "Ada" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(events.submissions) != 1 || events.submissions[0].Fields["facebook_lead_ads_webhook_leadgen_id"] != "lead_1" {
		t.Fatalf("events=%+v", events.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks["facebook-lead-ads:page:page_123:form:form_456:lead:lead_1"] != WebhookProcessed {
		t.Fatalf("webhook state=%+v", store.webhooks)
	}
}

func TestFacebookLeadAdsWebhookReplayUsesDurableClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFacebookLeadAds
	store.integration.Settings = map[string]any{"page_id": "page_123", "form_id": "form_456", "credentials_ref": "cred_meta_leads_1"}
	profiles := &fakeProfileSink{}
	fetches := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fetches++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"lead_1","form_id":"form_456","field_data":[{"name":"email","values":["Lead@Example.com"]}]}`))
	}))
	defer server.Close()
	deps := &Deps{
		Repo:                       store,
		Profiles:                   profiles,
		FacebookLeadAdsCredentials: fakeFacebookLeadAdsCredentialResolver{creds: FacebookLeadAdsCredentials{AccessToken: "token_123", AppSecret: "app_secret_123", APIBaseURL: server.URL}},
	}
	body := facebookLeadAdsWebhookTestBody("lead_1")
	for i, wantStatus := range []int{http.StatusAccepted, http.StatusOK} {
		req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/facebook-lead-ads/webhooks", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Hub-Signature-256", signFacebookLeadAdsWebhookTest("app_secret_123", body))
		rec := httptest.NewRecorder()
		deps.FacebookLeadAdsWebhook(rec, req)
		if rec.Code != wantStatus {
			t.Fatalf("attempt %d status=%d want %d body=%s", i+1, rec.Code, wantStatus, rec.Body.String())
		}
	}
	if fetches != 1 || len(profiles.submissions) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not duplicate work, fetches=%d profiles=%d runs=%d", fetches, len(profiles.submissions), len(store.runs))
	}
}

func TestFacebookLeadAdsWebhookInProgressClaimReturnsRetry(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFacebookLeadAds
	store.integration.Settings = map[string]any{"page_id": "page_123", "form_id": "form_456", "credentials_ref": "cred_meta_leads_1"}
	store.webhooks = map[string]WebhookClaim{"facebook-lead-ads:page:page_123:form:form_456:lead:lead_busy": WebhookInProgress}
	deps := &Deps{
		Repo:                       store,
		Profiles:                   &fakeProfileSink{},
		FacebookLeadAdsCredentials: fakeFacebookLeadAdsCredentialResolver{creds: FacebookLeadAdsCredentials{AccessToken: "token_123", AppSecret: "app_secret_123", APIBaseURL: "https://graph.example.test"}},
	}
	body := facebookLeadAdsWebhookTestBody("lead_busy")
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/facebook-lead-ads/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Hub-Signature-256", signFacebookLeadAdsWebhookTest("app_secret_123", body))
	rec := httptest.NewRecorder()

	deps.FacebookLeadAdsWebhook(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "10" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestFacebookLeadAdsWebhookRejectsBadSignature(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFacebookLeadAds
	store.integration.Settings = map[string]any{"page_id": "page_123", "form_id": "form_456", "credentials_ref": "cred_meta_leads_1"}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                       store,
		Profiles:                   profiles,
		FacebookLeadAdsCredentials: fakeFacebookLeadAdsCredentialResolver{creds: FacebookLeadAdsCredentials{AccessToken: "token_123", AppSecret: "app_secret_123"}},
	}
	body := facebookLeadAdsWebhookTestBody("lead_1")
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/facebook-lead-ads/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Hub-Signature-256", signFacebookLeadAdsWebhookTest("wrong_secret", body))
	rec := httptest.NewRecorder()

	deps.FacebookLeadAdsWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 || len(store.runs) != 0 || len(store.webhooks) != 0 {
		t.Fatalf("bad signatures should not ingest or claim, profiles=%+v runs=%+v webhooks=%+v", profiles.submissions, store.runs, store.webhooks)
	}
}

func TestFacebookLeadAdsWebhookRecordRunFailureMarksWebhookFailed(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFacebookLeadAds
	store.integration.Settings = map[string]any{"page_id": "page_123", "form_id": "form_456", "credentials_ref": "cred_meta_leads_1"}
	store.recordErr = errors.New("record run failed")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"lead_1","form_id":"form_456","field_data":[{"name":"email","values":["Lead@Example.com"]}]}`))
	}))
	defer server.Close()
	deps := &Deps{
		Repo:                       store,
		Profiles:                   &fakeProfileSink{},
		FacebookLeadAdsCredentials: fakeFacebookLeadAdsCredentialResolver{creds: FacebookLeadAdsCredentials{AccessToken: "token_123", AppSecret: "app_secret_123", APIBaseURL: server.URL}},
	}
	body := facebookLeadAdsWebhookTestBody("lead_1")
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/facebook-lead-ads/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Hub-Signature-256", signFacebookLeadAdsWebhookTest("app_secret_123", body))
	rec := httptest.NewRecorder()

	deps.FacebookLeadAdsWebhook(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if got, ok := store.webhooks["facebook-lead-ads:page:page_123:form:form_456:lead:lead_1"]; !ok || got != "" {
		t.Fatalf("webhook should be marked retryable failed, state=%+v", store.webhooks)
	}
}

func facebookLeadAdsWebhookTestBody(leadID string) []byte {
	return []byte(fmt.Sprintf(`{
		"object":"page",
		"entry":[{
			"id":"page_123",
			"changes":[{
				"field":"leadgen",
				"value":{"leadgen_id":%q,"page_id":"page_123","form_id":"form_456"}
			}]
		}]
	}`, leadID))
}

func TestSyncIntegrationUsesGoogleLeadFormsBackfillerForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGoogleLeadForms
	store.integration.Name = "Google lead form"
	store.integration.CredentialsRef = "cred_google_leads_1"
	store.integration.Settings = map[string]any{"customer_id": "1234567890", "lead_form_asset_id": "111", "credentials_ref": "cred_google_leads_1"}
	store.integration.SyncCursor = encodeGoogleLeadFormsWatermarkCursor("2026-06-28 09:00:00+05:30", "lead_0")
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &fakeGoogleLeadFormsBackfiller{req: SyncRequest{
		Cursor:      googleLeadFormsCursorComplete,
		Submissions: []SubmissionInput{{SourceID: "google-lead-form-extensions://lead/lead_1", Email: "lead@example.com", FormID: "111"}},
	}}
	deps := &Deps{
		Repo:                      store,
		Profiles:                  profiles,
		Events:                    events,
		GoogleLeadFormsBackfiller: backfiller,
		Now:                       func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != encodeGoogleLeadFormsWatermarkCursor("2026-06-28 09:00:00+05:30", "lead_0") {
		t.Fatalf("backfiller called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(events.submissions) != 1 || events.submissions[0].SourceID != "google-lead-form-extensions://lead/lead_1" {
		t.Fatalf("events=%+v", events.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != googleLeadFormsCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestIngestSubmissionRecordsWebhookRun(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
		Events:   &fakeEventSink{},
	}
	rec := httptest.NewRecorder()
	deps.IngestSubmission(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/ingest", `{
		"source_id":"r1",
		"email":"lead@example.com",
		"form_id":"abc123"
	}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestTypeformWebhookVerifiesSignatureAndIngestsSubmission(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_typeform_webhook_1"
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		Events:              events,
		TypeformCredentials: fakeTypeformCredentialResolver{creds: TypeformCredentials{AccessToken: "token", WebhookSecret: "whsec_123"}},
		Now:                 func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	body := []byte(`{
		"event_id":"evt_1",
		"event_type":"form_response",
		"form_response":{
			"form_id":"abc123",
			"token":"resp_1",
			"submitted_at":"2026-06-16T10:00:00Z",
			"definition":{"id":"abc123","title":"Newsletter","fields":[
				{"id":"email_field","ref":"email","title":"Email","type":"email"},
				{"id":"name_field","ref":"first_name","title":"First name","type":"short_text"}
			]},
			"answers":[
				{"field":{"id":"email_field","ref":"email","type":"email"},"type":"email","email":"Lead@Example.com"},
				{"field":{"id":"name_field","ref":"first_name","type":"short_text"},"type":"text","text":"Ada"}
			]
		}
	}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/typeform/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Typeform-Signature", signTypeformTestPayload("whsec_123", body))
	rec := httptest.NewRecorder()

	deps.TypeformWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" || profiles.submissions[0].FirstName != "Ada" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(events.submissions) != 1 || events.submissions[0].Fields["typeform_event_id"] != "evt_1" {
		t.Fatalf("events=%+v", events.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks["typeform:form:abc123:delivery:evt_1"] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestTypeformWebhookReplayUsesDurableClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_typeform_webhook_1"
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		Events:              events,
		TypeformCredentials: fakeTypeformCredentialResolver{creds: TypeformCredentials{AccessToken: "token", WebhookSecret: "whsec_123"}},
		Now:                 func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	body := typeformWebhookTestBody("evt_replay")

	for i, wantStatus := range []int{http.StatusAccepted, http.StatusOK} {
		req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/typeform/webhooks", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Typeform-Signature", signTypeformTestPayload("whsec_123", body))
		rec := httptest.NewRecorder()
		deps.TypeformWebhook(rec, req)
		if rec.Code != wantStatus {
			t.Fatalf("attempt %d status=%d want %d body=%s", i+1, rec.Code, wantStatus, rec.Body.String())
		}
	}
	if len(profiles.submissions) != 1 || len(events.submissions) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not duplicate work, profiles=%d events=%d runs=%d", len(profiles.submissions), len(events.submissions), len(store.runs))
	}
	if store.webhooks["typeform:form:abc123:delivery:evt_replay"] != WebhookProcessed {
		t.Fatalf("webhook state=%+v", store.webhooks)
	}
}

func TestTypeformWebhookMissingEventIDUsesStableResponseClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_typeform_webhook_1"
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		Events:              events,
		TypeformCredentials: fakeTypeformCredentialResolver{creds: TypeformCredentials{AccessToken: "token", WebhookSecret: "whsec_123"}},
		Now:                 func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	payload := func(attempt int) []byte {
		return []byte(fmt.Sprintf(`{
			"event_type":"form_response",
			"delivery_attempt":%d,
			"form_response":{
				"form_id":"abc123",
				"token":"resp_1",
				"submitted_at":"2026-06-16T10:00:00Z",
				"definition":{"id":"abc123","title":"Newsletter","fields":[
					{"id":"email_field","ref":"email","title":"Email","type":"email"}
				]},
				"answers":[
					{"field":{"id":"email_field","ref":"email","type":"email"},"type":"email","email":"Lead@Example.com"}
				]
			}
		}`, attempt))
	}

	for i, body := range [][]byte{payload(1), payload(2)} {
		req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/typeform/webhooks", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Typeform-Signature", signTypeformTestPayload("whsec_123", body))
		rec := httptest.NewRecorder()
		deps.TypeformWebhook(rec, req)
		wantStatus := http.StatusAccepted
		if i == 1 {
			wantStatus = http.StatusOK
		}
		if rec.Code != wantStatus {
			t.Fatalf("attempt %d status=%d want %d body=%s", i+1, rec.Code, wantStatus, rec.Body.String())
		}
	}
	if len(profiles.submissions) != 1 || len(events.submissions) != 1 || len(store.runs) != 1 {
		t.Fatalf("stable fallback should not duplicate work, profiles=%d events=%d runs=%d", len(profiles.submissions), len(events.submissions), len(store.runs))
	}
	for key, claim := range store.webhooks {
		if !strings.HasPrefix(key, "typeform:form:abc123:delivery:typeform_stable_") || claim != WebhookProcessed {
			t.Fatalf("unexpected webhook claim %q=%q in %+v", key, claim, store.webhooks)
		}
	}
}

func TestTypeformWebhookInProgressClaimReturnsRetry(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_typeform_webhook_1"
	store.webhooks = map[string]WebhookClaim{"typeform:form:abc123:delivery:evt_busy": WebhookInProgress}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		TypeformCredentials: fakeTypeformCredentialResolver{creds: TypeformCredentials{AccessToken: "token", WebhookSecret: "whsec_123"}},
	}
	body := typeformWebhookTestBody("evt_busy")
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/typeform/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Typeform-Signature", signTypeformTestPayload("whsec_123", body))
	rec := httptest.NewRecorder()

	deps.TypeformWebhook(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "10" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if len(profiles.submissions) != 0 || len(store.runs) != 0 {
		t.Fatalf("in-progress replay should not ingest, profiles=%+v runs=%+v", profiles.submissions, store.runs)
	}
}

func TestTypeformWebhookRecordRunFailureMarksWebhookFailed(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings["webhook_secret_ref"] = "cred_typeform_webhook_1"
	store.recordErr = errors.New("record run failed")
	deps := &Deps{
		Repo:                store,
		Profiles:            &fakeProfileSink{},
		Events:              &fakeEventSink{},
		TypeformCredentials: fakeTypeformCredentialResolver{creds: TypeformCredentials{AccessToken: "token", WebhookSecret: "whsec_123"}},
	}
	body := typeformWebhookTestBody("evt_record")
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/typeform/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Typeform-Signature", signTypeformTestPayload("whsec_123", body))
	rec := httptest.NewRecorder()

	deps.TypeformWebhook(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if got, ok := store.webhooks["typeform:form:abc123:delivery:evt_record"]; !ok || got != "" {
		t.Fatalf("webhook should be marked retryable failed, state=%+v", store.webhooks)
	}
}

func typeformWebhookTestBody(eventID string) []byte {
	return []byte(fmt.Sprintf(`{
		"event_id":%q,
		"event_type":"form_response",
		"form_response":{
			"form_id":"abc123",
			"token":"resp_1",
			"submitted_at":"2026-06-16T10:00:00Z",
			"definition":{"id":"abc123","title":"Newsletter","fields":[
				{"id":"email_field","ref":"email","title":"Email","type":"email"},
				{"id":"name_field","ref":"first_name","title":"First name","type":"short_text"}
			]},
			"answers":[
				{"field":{"id":"email_field","ref":"email","type":"email"},"type":"email","email":"Lead@Example.com"},
				{"field":{"id":"name_field","ref":"first_name","type":"short_text"},"type":"text","text":"Ada"}
			]
		}
	}`, eventID))
}

func TestTypeformWebhookRejectsBadSignature(t *testing.T) {
	store := newFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		TypeformCredentials: fakeTypeformCredentialResolver{creds: TypeformCredentials{AccessToken: "token", WebhookSecret: "whsec_123"}},
	}
	body := []byte(`{"event_id":"evt_1","event_type":"form_response","form_response":{"form_id":"abc123","token":"resp_1"}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/typeform/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Typeform-Signature", "sha256=bad")
	rec := httptest.NewRecorder()

	deps.TypeformWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 || len(store.runs) != 0 {
		t.Fatalf("should not ingest bad signatures, submissions=%+v runs=%+v", profiles.submissions, store.runs)
	}
}

func TestJotformWebhookVerifiesSecretAndIngestsSubmission(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderJotform
	store.integration.CredentialsRef = "cred_jotform_1"
	store.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_jotform_1", "webhook_secret_ref": "cred_jotform_webhook_1"}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		Events:   events,
		JotformCredentials: fakeJotformCredentialResolver{creds: JotformCredentials{
			APIKey:        "api_123",
			WebhookSecret: "jotform_secret",
		}},
		Now: func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	body := `formID=form_123&submissionID=sub_123&created_at=2026-06-16+10%3A00%3A00&email=Lead%40Example.com&first_name=Ada&company=Moosewave`
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/jotform/webhooks?token=jotform_secret", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()

	deps.JotformWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" || profiles.submissions[0].FirstName != "Ada" || profiles.submissions[0].Company != "Moosewave" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(events.submissions) != 1 || events.submissions[0].Fields["jotform_webhook_raw"] == nil {
		t.Fatalf("events=%+v", events.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestJotformWebhookRejectsBadSecret(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderJotform
	store.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_jotform_1"}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:               store,
		Profiles:           profiles,
		JotformCredentials: fakeJotformCredentialResolver{creds: JotformCredentials{APIKey: "api_123", WebhookSecret: "jotform_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/jotform/webhooks?token=wrong", strings.NewReader(`{"formID":"form_123","submissionID":"sub_123","email":"lead@example.com"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.JotformWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 || len(store.runs) != 0 {
		t.Fatalf("should not ingest bad Jotform secrets, profiles=%+v runs=%+v", profiles.submissions, store.runs)
	}
}

func TestWebflowWebhookVerifiesSignatureAndIngestsSubmission(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderWebflow
	store.integration.CredentialsRef = "cred_webflow_1"
	store.integration.Settings = map[string]any{"site_id": "site_123", "form_id": "form_456", "credentials_ref": "cred_webflow_1", "webhook_secret_ref": "cred_webflow_webhook_1"}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		Events:   events,
		WebflowCredentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{
			AccessToken:   "wf_token",
			WebhookSecret: "wf_secret",
		}},
		Now: func() time.Time { return now },
	}
	body := webflowWebhookTestBody("sub_123", "form_456", "element_789")
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/webflow/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-webflow-timestamp", timestamp)
	req.Header.Set("x-webflow-signature", signWebflowTestPayload("wf_secret", timestamp, body))
	rec := httptest.NewRecorder()

	deps.WebflowWebhook(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" || profiles.submissions[0].FirstName != "Ada" || profiles.submissions[0].Company != "Moosewave" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(events.submissions) != 1 || events.submissions[0].Fields["webflow_webhook_raw"] == nil {
		t.Fatalf("events=%+v", events.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.webhooks[ProviderWebflow+":site:site_123:form:form_456:submission:sub_123"] != WebhookProcessed {
		t.Fatalf("webhook claim state=%+v", store.webhooks)
	}
}

func TestWebflowWebhookReplayUsesDurableClaim(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderWebflow
	store.integration.CredentialsRef = "cred_webflow_1"
	store.integration.Settings = map[string]any{"site_id": "site_123", "form_id": "form_456", "credentials_ref": "cred_webflow_1", "webhook_secret_ref": "cred_webflow_webhook_1"}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		Events:   events,
		WebflowCredentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{
			AccessToken:   "wf_token",
			WebhookSecret: "wf_secret",
		}},
		Now: func() time.Time { return now },
	}
	body := webflowWebhookTestBody("sub_replay", "form_456", "element_789")
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)

	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/webflow/webhooks", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-webflow-timestamp", timestamp)
		req.Header.Set("x-webflow-signature", signWebflowTestPayload("wf_secret", timestamp, body))
		rec := httptest.NewRecorder()
		deps.WebflowWebhook(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if len(profiles.submissions) != 1 || len(events.submissions) != 1 || len(store.runs) != 1 {
		t.Fatalf("replay should not duplicate work, profiles=%d events=%d runs=%d", len(profiles.submissions), len(events.submissions), len(store.runs))
	}
	if store.webhooks[ProviderWebflow+":site:site_123:form:form_456:submission:sub_replay"] != WebhookProcessed {
		t.Fatalf("webhook state=%+v", store.webhooks)
	}
}

func TestWebflowWebhookReplayWithoutProviderIDUsesStableSubmissionClaim(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderWebflow
	store.integration.CredentialsRef = "cred_webflow_1"
	store.integration.Settings = map[string]any{"site_id": "site_123", "form_id": "form_456", "credentials_ref": "cred_webflow_1", "webhook_secret_ref": "cred_webflow_webhook_1"}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		Events:   events,
		WebflowCredentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{
			AccessToken:   "wf_token",
			WebhookSecret: "wf_secret",
		}},
		Now: func() time.Time { return now },
	}
	body1 := []byte(`{
		"triggerType":"form_submission",
		"deliveryAttempt":1,
		"payload":{
			"siteId":"site_123",
			"formId":"form_456",
			"formElementId":"element_789",
			"displayName":"Newsletter",
			"dateSubmitted":"2026-06-16T10:00:00Z",
			"formResponse":{"Email":"Lead@Example.com","First Name":"Ada","Company":"Moosewave"}
		}
	}`)
	body2 := []byte(`{
		"triggerType":"form_submission",
		"deliveryAttempt":2,
		"payload":{
			"siteId":"site_123",
			"formId":"form_456",
			"formElementId":"element_789",
			"displayName":"Newsletter",
			"dateSubmitted":"2026-06-16T10:00:00Z",
			"formResponse":{"Email":"Lead@Example.com","First Name":"Ada","Company":"Moosewave"}
		}
	}`)
	payload, err := decodeWebflowWebhookPayload(body1)
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	expectedWebhookKey := ProviderWebflow + ":" + webflowWebhookID(payload, webflowWebhookDeliveryID(payload))
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)

	for i, body := range [][]byte{body1, body2} {
		req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/webflow/webhooks", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-webflow-timestamp", timestamp)
		req.Header.Set("x-webflow-signature", signWebflowTestPayload("wf_secret", timestamp, body))
		rec := httptest.NewRecorder()
		deps.WebflowWebhook(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("attempt %d status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	if len(profiles.submissions) != 1 || len(events.submissions) != 1 || len(store.runs) != 1 {
		t.Fatalf("stable replay should not duplicate work, profiles=%d events=%d runs=%d", len(profiles.submissions), len(events.submissions), len(store.runs))
	}
	if store.webhooks[expectedWebhookKey] != WebhookProcessed {
		t.Fatalf("webhook state=%+v expected key %q", store.webhooks, expectedWebhookKey)
	}
}

func TestWebflowWebhookInProgressClaimReturnsRetry(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderWebflow
	store.integration.CredentialsRef = "cred_webflow_1"
	store.integration.Settings = map[string]any{"site_id": "site_123", "form_id": "form_456", "credentials_ref": "cred_webflow_1", "webhook_secret_ref": "cred_webflow_webhook_1"}
	store.webhooks = map[string]WebhookClaim{ProviderWebflow + ":site:site_123:form:form_456:submission:sub_busy": WebhookInProgress}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:               store,
		Profiles:           profiles,
		WebflowCredentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{AccessToken: "wf_token", WebhookSecret: "wf_secret"}},
		Now:                func() time.Time { return now },
	}
	body := webflowWebhookTestBody("sub_busy", "form_456", "element_789")
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/webflow/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-webflow-timestamp", timestamp)
	req.Header.Set("x-webflow-signature", signWebflowTestPayload("wf_secret", timestamp, body))
	rec := httptest.NewRecorder()

	deps.WebflowWebhook(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "10" {
		t.Fatalf("status=%d retry-after=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if len(profiles.submissions) != 0 || len(store.runs) != 0 {
		t.Fatalf("in-progress replay should not ingest, profiles=%+v runs=%+v", profiles.submissions, store.runs)
	}
}

func TestWebflowWebhookRecordRunFailureMarksWebhookFailed(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderWebflow
	store.integration.CredentialsRef = "cred_webflow_1"
	store.integration.Settings = map[string]any{"site_id": "site_123", "form_id": "form_456", "credentials_ref": "cred_webflow_1", "webhook_secret_ref": "cred_webflow_webhook_1"}
	store.recordErr = errors.New("record run failed")
	deps := &Deps{
		Repo:               store,
		Profiles:           &fakeProfileSink{},
		Events:             &fakeEventSink{},
		WebflowCredentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{AccessToken: "wf_token", WebhookSecret: "wf_secret"}},
		Now:                func() time.Time { return now },
	}
	body := webflowWebhookTestBody("sub_record", "form_456", "element_789")
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/webflow/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-webflow-timestamp", timestamp)
	req.Header.Set("x-webflow-signature", signWebflowTestPayload("wf_secret", timestamp, body))
	rec := httptest.NewRecorder()

	deps.WebflowWebhook(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if got, ok := store.webhooks[ProviderWebflow+":site:site_123:form:form_456:submission:sub_record"]; !ok || got != "" {
		t.Fatalf("webhook should be marked retryable failed, state=%+v", store.webhooks)
	}
}

func TestWebflowWebhookRoutesSharedSiteToMatchingForm(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	store := newFakeStore()
	base := store.integration
	base.Provider = ProviderWebflow
	base.CredentialsRef = "cred_webflow_1"
	base.Settings = map[string]any{"site_id": "site_123", "credentials_ref": "cred_webflow_1", "webhook_secret_ref": "cred_webflow_webhook_1"}
	generic := base
	generic.ID = "lead_webflow_generic"
	generic.UpdatedAt = now.Add(2 * time.Hour)
	wrongForm := base
	wrongForm.ID = "lead_webflow_wrong"
	wrongForm.Settings = map[string]any{"site_id": "site_123", "form_id": "other_form", "credentials_ref": "cred_webflow_1", "webhook_secret_ref": "cred_webflow_webhook_1"}
	wrongForm.UpdatedAt = now.Add(3 * time.Hour)
	matchingForm := base
	matchingForm.ID = "lead_webflow_match"
	matchingForm.Settings = map[string]any{"site_id": "site_123", "form_id": "form_456", "credentials_ref": "cred_webflow_1", "webhook_secret_ref": "cred_webflow_webhook_1"}
	matchingForm.UpdatedAt = now.Add(-time.Hour)
	store.integrations = []Integration{generic, wrongForm, matchingForm}
	deps := &Deps{
		Repo:               store,
		Profiles:           &fakeProfileSink{},
		Events:             &fakeEventSink{},
		WebflowCredentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{AccessToken: "wf_token", WebhookSecret: "wf_secret"}},
		Now:                func() time.Time { return now },
	}
	body := webflowWebhookTestBody("sub_route", "form_456", "element_789")
	timestamp := strconv.FormatInt(now.UnixMilli(), 10)
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/webflow/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-webflow-timestamp", timestamp)
	req.Header.Set("x-webflow-signature", signWebflowTestPayload("wf_secret", timestamp, body))
	rec := httptest.NewRecorder()

	deps.WebflowWebhook(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].IntegrationID != "lead_webflow_match" {
		t.Fatalf("expected matching form integration run, runs=%+v", store.runs)
	}
}

func TestWebflowWebhookRejectsBadSignature(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Provider = ProviderWebflow
	store.integration.Settings = map[string]any{"site_id": "site_123", "credentials_ref": "cred_webflow_1"}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:               store,
		Profiles:           profiles,
		WebflowCredentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{AccessToken: "wf_token", WebhookSecret: "wf_secret"}},
		Now:                func() time.Time { return now },
	}
	body := []byte(`{"triggerType":"form_submission","payload":{"id":"sub_123","siteId":"site_123","formResponse":{"Email":"lead@example.com"}}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/webflow/webhooks", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-webflow-timestamp", strconv.FormatInt(now.UnixMilli(), 10))
	req.Header.Set("x-webflow-signature", "bad")
	rec := httptest.NewRecorder()

	deps.WebflowWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 || len(store.runs) != 0 {
		t.Fatalf("should not ingest bad Webflow signatures, profiles=%+v runs=%+v", profiles.submissions, store.runs)
	}
}

func TestVerifyWebflowWebhookSignatureAcceptsSecondsAndBase64(t *testing.T) {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	body := []byte(`{"triggerType":"form_submission","payload":{"siteId":"site_123","formResponse":{"Email":"lead@example.com"}}}`)
	timestamp := strconv.FormatInt(now.Unix(), 10)
	mac := hmac.New(sha256.New, []byte("wf_secret"))
	mac.Write([]byte(timestamp + ":"))
	mac.Write(body)
	signature := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	if err := VerifyWebflowWebhookSignature("wf_secret", body, timestamp, "v1="+signature, now); err != nil {
		t.Fatalf("valid seconds/base64 Webflow signature rejected: %v", err)
	}
}

func TestFilloutWebhookVerifiesSecretAndIngestsSubmission(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFillout
	store.integration.CredentialsRef = "cred_fillout_1"
	store.integration.Settings = map[string]any{"form_id": "form_123", "form_name": "Newsletter", "credentials_ref": "cred_fillout_1", "webhook_secret_ref": "cred_fillout_webhook_1"}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		Events:   events,
		FilloutCredentials: fakeFilloutCredentialResolver{creds: FilloutCredentials{
			AccessToken:   "fillout_token",
			WebhookSecret: "fillout_secret",
		}},
		Now: func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	body := `{
		"submissionId":"sub_123",
		"submissionTime":"2026-06-16T10:00:00Z",
		"questions":[
			{"id":"q_email","name":"Email","type":"EmailInput","value":"Lead@Example.com"},
			{"id":"q_first","name":"First name","type":"ShortAnswer","value":"Ada"},
			{"id":"q_company","name":"Company","type":"ShortAnswer","value":"Moosewave"}
		],
		"urlParameters":[{"id":"utm_source","name":"utm_source","type":"Hidden","value":"launch"}]
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/fillout/webhooks?form_id=form_123&token=fillout_secret", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.FilloutWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" || profiles.submissions[0].FirstName != "Ada" || profiles.submissions[0].Company != "Moosewave" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(events.submissions) != 1 || events.submissions[0].Fields["fillout_webhook_raw"] == nil || events.submissions[0].Fields["fillout_url_parameter.utm_source"] != "launch" {
		t.Fatalf("events=%+v", events.submissions)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].CursorTo != "fillout-webhook-sub_123" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestFilloutWebhookRejectsBadSecret(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFillout
	store.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_fillout_1"}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:               store,
		Profiles:           profiles,
		FilloutCredentials: fakeFilloutCredentialResolver{creds: FilloutCredentials{AccessToken: "fillout_token", WebhookSecret: "fillout_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/fillout/webhooks?form_id=form_123&token=wrong", strings.NewReader(`{"submissionId":"sub_123","questions":[{"name":"Email","type":"EmailInput","value":"lead@example.com"}]}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.FilloutWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 || len(store.runs) != 0 {
		t.Fatalf("should not ingest bad Fillout secrets, profiles=%+v runs=%+v", profiles.submissions, store.runs)
	}
}

func signWebflowTestPayload(secret, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + ":"))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func webflowWebhookTestBody(submissionID, formID, elementID string) []byte {
	return []byte(fmt.Sprintf(`{
		"triggerType":"form_submission",
		"payload":{
			"id":%q,
			"siteId":"site_123",
			"formId":%q,
			"formElementId":%q,
			"displayName":"Newsletter",
			"dateSubmitted":"2026-06-16T10:00:00Z",
			"formResponse":{
				"Email":"Lead@Example.com",
				"First Name":"Ada",
				"Company":"Moosewave"
			}
		}
	}`, submissionID, formID, elementID))
}

func signTypeformTestPayload(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func TestBackfillIntegrationRecordsBackfillRunMode(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
		Events:   &fakeEventSink{},
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{
		"submissions":[{"source_id":"r1","email":"lead@example.com"}]
	}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationRejectsDisconnectedRows(t *testing.T) {
	for _, tc := range []struct {
		name string
		call func(*Deps, *httptest.ResponseRecorder)
	}{
		{
			name: "sync",
			call: func(deps *Deps, rec *httptest.ResponseRecorder) {
				deps.SyncIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/sync", `{
					"submissions":[{"source_id":"r1","email":"lead@example.com"}]
				}`))
			},
		},
		{
			name: "backfill",
			call: func(deps *Deps, rec *httptest.ResponseRecorder) {
				deps.BackfillIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/backfill", `{
					"submissions":[{"source_id":"r1","email":"lead@example.com"}]
				}`))
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeStore()
			store.integration.Status = "disconnected"
			deps := &Deps{Repo: store, Profiles: &fakeProfileSink{}, Events: &fakeEventSink{}}

			rec := httptest.NewRecorder()
			tc.call(deps, rec)

			if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if len(store.runs) != 0 {
				t.Fatalf("disconnected sync/backfill should not record runs: %+v", store.runs)
			}
		})
	}
}

func TestSyncIntegrationRecordsPartialFailure(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{err: errors.New("boom")},
		Events:   &fakeEventSink{},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/sync", `{
		"submissions":[{"source_id":"r1","email":"lead@example.com"}]
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
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.PauseIntegration(rec, leadReq(http.MethodPost, "/api/v1/lead-integrations/lead_1/pause", `{}`))
	if rec.Code != http.StatusOK || !store.paused {
		t.Fatalf("pause status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))
	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDisconnectTypeformIntegrationCleansManagedWebhook(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderTypeform
	store.integration.CredentialsRef = "cred_typeform_1"
	store.integration.Settings = map[string]any{
		"form_id":                   "abc123",
		"credentials_ref":           "cred_typeform_1",
		"typeform_webhook_id":       "typeform_wh_123",
		"typeform_webhook_tag":      "postwave-prod",
		"typeform_webhook_endpoint": "https://app.postwave.test/api/public/lead-integrations/typeform/webhooks",
	}
	registrar := &fakeTypeformWebhookRegistrar{}
	deps := &Deps{
		Repo:             store,
		TypeformWebhooks: registrar,
		PublicBaseURL:    "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if registrar.cleanupCalls != 1 || registrar.lastIntegration.Settings["typeform_webhook_tag"] != "postwave-prod" {
		t.Fatalf("registrar calls=%d integration=%+v", registrar.cleanupCalls, registrar.lastIntegration)
	}
}

func TestDisconnectTypeformIntegrationCleansWhenOnlyManagedWebhookEvidenceExists(t *testing.T) {
	cases := []map[string]any{
		{"form_id": "abc123", "credentials_ref": "cred_typeform_1", "typeform_webhook_id": "typeform_wh_123"},
		{"form_id": "abc123", "credentials_ref": "cred_typeform_1", "webhook_tag": "postwave-prod"},
		{"form_id": "abc123", "credentials_ref": "cred_typeform_1", "typeform_webhook_managed_by_postwave": true},
	}
	for _, settings := range cases {
		t.Run(fmt.Sprint(settings), func(t *testing.T) {
			store := newFakeStore()
			store.integration.Provider = ProviderTypeform
			store.integration.CredentialsRef = "cred_typeform_1"
			store.integration.Settings = settings
			registrar := &fakeTypeformWebhookRegistrar{}
			deps := &Deps{
				Repo:             store,
				TypeformWebhooks: registrar,
				PublicBaseURL:    "https://app.postwave.test",
			}

			rec := httptest.NewRecorder()
			deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

			if rec.Code != http.StatusOK || !store.deleted {
				t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
			}
			if registrar.cleanupCalls != 1 {
				t.Fatalf("cleanup calls=%d", registrar.cleanupCalls)
			}
		})
	}
}

func TestDisconnectTypeformIntegrationStopsWhenWebhookCleanupFails(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderTypeform
	store.integration.CredentialsRef = "cred_typeform_1"
	store.integration.Settings = map[string]any{
		"form_id":              "abc123",
		"credentials_ref":      "cred_typeform_1",
		"typeform_webhook_tag": "postwave-prod",
	}
	registrar := &fakeTypeformWebhookRegistrar{cleanupErr: errors.New("typeform webhook delete failed")}
	deps := &Deps{
		Repo:             store,
		TypeformWebhooks: registrar,
		PublicBaseURL:    "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusBadGateway || store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if registrar.cleanupCalls != 1 {
		t.Fatalf("cleanup calls=%d", registrar.cleanupCalls)
	}
}

func TestDisconnectFilloutIntegrationCleansManagedWebhook(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFillout
	store.integration.CredentialsRef = "cred_fillout_1"
	store.integration.Settings = map[string]any{
		"form_id":                  "form_123",
		"credentials_ref":          "cred_fillout_1",
		"fillout_webhook_id":       "fillout_wh_123",
		"fillout_webhook_endpoint": "https://app.postwave.test/api/public/lead-integrations/fillout/webhooks?form_id=form_123",
	}
	registrar := &fakeFilloutWebhookRegistrar{}
	deps := &Deps{
		Repo:            store,
		FilloutWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if registrar.cleanupCalls != 1 || registrar.lastIntegration.Settings["fillout_webhook_id"] != "fillout_wh_123" {
		t.Fatalf("registrar calls=%d integration=%+v", registrar.cleanupCalls, registrar.lastIntegration)
	}
}

func TestDisconnectFilloutIntegrationStopsWhenWebhookCleanupFails(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFillout
	store.integration.CredentialsRef = "cred_fillout_1"
	store.integration.Settings = map[string]any{
		"form_id":            "form_123",
		"credentials_ref":    "cred_fillout_1",
		"fillout_webhook_id": "fillout_wh_123",
	}
	registrar := &fakeFilloutWebhookRegistrar{cleanupErr: errors.New("fillout webhook delete failed")}
	deps := &Deps{
		Repo:            store,
		FilloutWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusBadGateway || store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if registrar.cleanupCalls != 1 {
		t.Fatalf("cleanup calls=%d", registrar.cleanupCalls)
	}
}

func TestDisconnectJotformIntegrationCleansManagedWebhook(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderJotform
	store.integration.CredentialsRef = "cred_jotform_1"
	store.integration.Settings = map[string]any{
		"form_id":                  "form_123",
		"credentials_ref":          "cred_jotform_1",
		"jotform_webhook_id":       "jotform_wh_123",
		"jotform_webhook_endpoint": "https://app.postwave.test/api/public/lead-integrations/jotform/webhooks?form_id=form_123",
	}
	registrar := &fakeJotformWebhookRegistrar{}
	deps := &Deps{
		Repo:            store,
		JotformWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if registrar.cleanupCalls != 1 || registrar.lastIntegration.Settings["jotform_webhook_id"] != "jotform_wh_123" {
		t.Fatalf("registrar calls=%d integration=%+v", registrar.cleanupCalls, registrar.lastIntegration)
	}
}

func TestDisconnectJotformIntegrationStopsWhenWebhookCleanupFails(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderJotform
	store.integration.CredentialsRef = "cred_jotform_1"
	store.integration.Settings = map[string]any{
		"form_id":            "form_123",
		"credentials_ref":    "cred_jotform_1",
		"jotform_webhook_id": "jotform_wh_123",
	}
	registrar := &fakeJotformWebhookRegistrar{cleanupErr: errors.New("jotform webhook delete failed")}
	deps := &Deps{
		Repo:            store,
		JotformWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusBadGateway || store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if registrar.cleanupCalls != 1 {
		t.Fatalf("cleanup calls=%d", registrar.cleanupCalls)
	}
}

func TestDisconnectWebflowIntegrationCleansManagedWebhook(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderWebflow
	store.integration.CredentialsRef = "cred_webflow_1"
	store.integration.Settings = map[string]any{
		"site_id":                  "site_123",
		"credentials_ref":          "cred_webflow_1",
		"webflow_webhook_id":       "webflow_wh_123",
		"webflow_webhook_endpoint": "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks",
	}
	registrar := &fakeWebflowWebhookRegistrar{}
	deps := &Deps{
		Repo:            store,
		WebflowWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if registrar.cleanupCalls != 1 || registrar.lastIntegration.Settings["webflow_webhook_id"] != "webflow_wh_123" {
		t.Fatalf("registrar calls=%d integration=%+v", registrar.cleanupCalls, registrar.lastIntegration)
	}
}

func TestDisconnectWebflowIntegrationReturnsAndPersistsProviderCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderWebflow
	store.integration.CredentialsRef = "cred_webflow_1"
	store.integration.Settings = map[string]any{
		"site_id":                  "site_123",
		"credentials_ref":          "cred_webflow_1",
		"webhook_secret_ref":       "cred_webflow_webhook_1",
		"webflow_webhook_id":       "webflow_wh_123",
		"webflow_webhook_endpoint": "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks",
		"provider_cleanup":         map[string]any{"status": "stale"},
	}
	registrar := &fakeWebflowWebhookRegistrar{cleanupSummary: WebflowWebhookCleanupSummary{
		WebhookID:         "webflow_wh_123",
		Endpoint:          "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks",
		CleanedUpAt:       time.Date(2026, 6, 29, 13, 0, 0, 0, time.UTC),
		Deleted:           true,
		CleanupReason:     "stored_id",
		PreviousWebhookID: "webflow_wh_old",
	}}
	deps := &Deps{
		Repo:            store,
		WebflowWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	var out struct {
		OK              bool                      `json:"ok"`
		ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.OK ||
		out.ProviderCleanup.Provider != ProviderWebflow ||
		out.ProviderCleanup.Status != "provider_cleanup_completed" ||
		out.ProviderCleanup.ProviderCleanupPosture != "postwave_managed_provider_api" ||
		!out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderScopeType != "webflow_site_id" ||
		out.ProviderCleanup.ProviderScopeID != "site_123" ||
		out.ProviderCleanup.ProviderWebhookID != "webflow_wh_123" ||
		out.ProviderCleanup.PreviousProviderWebhookID != "webflow_wh_old" ||
		!out.ProviderCleanup.CredentialRefPresent ||
		!out.ProviderCleanup.WebhookSecretRefPresent ||
		out.ProviderCleanup.WebhookCleanupStatus != "provider_deleted" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	foundEvidence := false
	for _, item := range out.ProviderCleanup.ProviderCleanupEvidence {
		if item == "provider reported the managed webhook cleanup completed" {
			foundEvidence = true
		}
	}
	if !foundEvidence {
		t.Fatalf("cleanup evidence=%+v", out.ProviderCleanup.ProviderCleanupEvidence)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["provider"] != ProviderWebflow ||
		stored["status"] != "provider_cleanup_completed" ||
		stored["provider_webhook_id"] != "webflow_wh_123" ||
		stored["previous_provider_webhook_id"] != "webflow_wh_old" ||
		stored["managed_provider_cleanup"] != true {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func TestDisconnectWebflowIntegrationPersistsSkippedProviderCleanupWhenFallbackLookupFails(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderWebflow
	store.integration.CredentialsRef = "cred_webflow_1"
	store.integration.Settings = map[string]any{
		"site_id":                  "site_123",
		"credentials_ref":          "cred_webflow_1",
		"webhook_secret_ref":       "cred_webflow_webhook_1",
		"webflow_webhook_id":       "webflow_wh_missing",
		"webflow_webhook_endpoint": "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks",
	}
	registrar := &fakeWebflowWebhookRegistrar{cleanupSummary: WebflowWebhookCleanupSummary{
		WebhookID:     "webflow_wh_missing",
		Endpoint:      "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks",
		CleanedUpAt:   time.Date(2026, 6, 29, 13, 0, 0, 0, time.UTC),
		NotFound:      true,
		Skipped:       true,
		SkipReason:    "fallback_lookup_failed",
		CleanupReason: "stored_id_not_found_fallback_lookup_failed",
	}}
	deps := &Deps{
		Repo:            store,
		WebflowWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	var out struct {
		OK              bool                      `json:"ok"`
		ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.OK ||
		out.ProviderCleanup.Status != "provider_cleanup_skipped" ||
		out.ProviderCleanup.WebhookCleanupStatus != "provider_cleanup_skipped" ||
		out.ProviderCleanup.ProviderWebhookID != "webflow_wh_missing" ||
		out.ProviderCleanup.SkipReason != "fallback_lookup_failed" ||
		out.ProviderCleanup.CleanupReason != "stored_id_not_found_fallback_lookup_failed" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["status"] != "provider_cleanup_skipped" ||
		stored["webhook_cleanup_status"] != "provider_cleanup_skipped" ||
		stored["skip_reason"] != "fallback_lookup_failed" ||
		stored["cleanup_reason"] != "stored_id_not_found_fallback_lookup_failed" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func TestDisconnectWebflowIntegrationCleansManagedWebhookWithoutStoredID(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderWebflow
	store.integration.CredentialsRef = "cred_webflow_1"
	store.integration.Settings = map[string]any{
		"site_id":                             "site_123",
		"credentials_ref":                     "cred_webflow_1",
		"webflow_webhook_endpoint":            "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks",
		"webflow_webhook_managed_by_postwave": true,
	}
	registrar := &fakeWebflowWebhookRegistrar{}
	deps := &Deps{
		Repo:            store,
		WebflowWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if registrar.cleanupCalls != 1 || registrar.lastIntegration.Settings["webflow_webhook_endpoint"] == "" {
		t.Fatalf("registrar calls=%d integration=%+v", registrar.cleanupCalls, registrar.lastIntegration)
	}
}

func TestDisconnectWebflowIntegrationStopsWhenWebhookCleanupFails(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderWebflow
	store.integration.CredentialsRef = "cred_webflow_1"
	store.integration.Settings = map[string]any{
		"site_id":            "site_123",
		"credentials_ref":    "cred_webflow_1",
		"webflow_webhook_id": "webflow_wh_123",
	}
	registrar := &fakeWebflowWebhookRegistrar{cleanupErr: errors.New("webflow webhook delete failed")}
	deps := &Deps{
		Repo:            store,
		WebflowWebhooks: registrar,
		PublicBaseURL:   "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusBadGateway || store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if registrar.cleanupCalls != 1 {
		t.Fatalf("cleanup calls=%d", registrar.cleanupCalls)
	}
}

func TestDisconnectFacebookLeadAdsIntegrationCleansManagedPageSubscription(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFacebookLeadAds
	store.integration.CredentialsRef = "cred_meta_leads_1"
	store.integration.Settings = map[string]any{
		"page_id":         "page_123",
		"form_id":         "form_456",
		"credentials_ref": "cred_meta_leads_1",
		"facebook_lead_ads_page_subscription_page_id":             "page_123",
		"facebook_lead_ads_page_subscription_endpoint":            "https://app.postwave.test/api/public/lead-integrations/facebook-lead-ads/webhooks",
		"facebook_lead_ads_page_subscription_managed_by_postwave": true,
	}
	registrar := &fakeFacebookLeadAdsPageSubscriptionRegistrar{}
	deps := &Deps{
		Repo:                             store,
		FacebookLeadAdsPageSubscriptions: registrar,
		PublicBaseURL:                    "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if registrar.cleanupCalls != 1 ||
		registrar.lastIntegration.Settings["facebook_lead_ads_page_subscription_page_id"] != "page_123" ||
		registrar.lastBaseURL != "https://app.postwave.test" {
		t.Fatalf("registrar calls=%d base=%q integration=%+v", registrar.cleanupCalls, registrar.lastBaseURL, registrar.lastIntegration)
	}
}

func TestDisconnectFacebookLeadAdsIntegrationSkipsUnmanagedPageSubscriptionCleanup(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFacebookLeadAds
	store.integration.CredentialsRef = "cred_meta_leads_1"
	store.integration.Settings = map[string]any{
		"page_id":         "page_123",
		"form_id":         "form_456",
		"credentials_ref": "cred_meta_leads_1",
	}
	registrar := &fakeFacebookLeadAdsPageSubscriptionRegistrar{}
	deps := &Deps{
		Repo:                             store,
		FacebookLeadAdsPageSubscriptions: registrar,
		PublicBaseURL:                    "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if registrar.cleanupCalls != 0 {
		t.Fatalf("cleanup calls=%d", registrar.cleanupCalls)
	}
	if strings.Contains(rec.Body.String(), "provider_cleanup") || store.integration.Settings["provider_cleanup"] != nil {
		t.Fatalf("unmanaged disconnect should not return provider cleanup evidence: body=%s settings=%+v", rec.Body.String(), store.integration.Settings)
	}
}

func TestDisconnectGoogleLeadFormsReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderGoogleLeadForms
	store.integration.CredentialsRef = "cred_google_leads_1"
	store.integration.Settings = map[string]any{
		"customer_id":        "1234567890",
		"lead_form_asset_id": "111",
		"campaign_id":        "222",
		"login_customer_id":  "9998887777",
		"credentials_ref":    "cred_google_leads_1",
		"provider_cleanup":   map[string]any{"status": "stale"},
	}
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	var out struct {
		ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if out.ProviderCleanup.Provider != ProviderGoogleLeadForms ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderCleanupPosture != "operator_managed_provider_console" ||
		out.ProviderCleanup.ProviderScopeID != "1234567890" ||
		out.ProviderCleanup.WebhookCleanupStatus != "provider_cleanup_not_applicable" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["status"] != "provider_cleanup_operator_managed" ||
		stored["managed_provider_cleanup"] != false ||
		stored["provider_scope_id"] != "1234567890" ||
		stored["webhook_cleanup_status"] != "provider_cleanup_not_applicable" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func TestDisconnectPaperformReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderPaperform
	store.integration.CredentialsRef = "cred_paperform_1"
	store.integration.Settings = map[string]any{
		"form_id":          "form_123",
		"form_name":        "Newsletter",
		"credentials_ref":  "cred_paperform_1",
		"provider_cleanup": map[string]any{"status": "stale"},
	}
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	var out struct {
		ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if out.ProviderCleanup.Provider != ProviderPaperform ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderCleanupPosture != "operator_managed_provider_console" ||
		out.ProviderCleanup.ProviderScopeType != "paperform_form_id" ||
		out.ProviderCleanup.ProviderScopeID != "form_123" ||
		out.ProviderCleanup.WebhookCleanupStatus != "provider_cleanup_not_applicable" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["status"] != "provider_cleanup_operator_managed" ||
		stored["managed_provider_cleanup"] != false ||
		stored["provider_scope_id"] != "form_123" ||
		stored["webhook_cleanup_status"] != "provider_cleanup_not_applicable" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func TestDisconnectLeadpagesReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderLeadpages
	store.integration.CredentialsRef = "cred_leadpages_1"
	store.integration.Settings = map[string]any{
		"form_id":          "form_123",
		"page_id":          "page_456",
		"credentials_ref":  "cred_leadpages_1",
		"provider_cleanup": map[string]any{"status": "stale"},
	}
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	var out struct {
		ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if out.ProviderCleanup.Provider != ProviderLeadpages ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderCleanupPosture != "operator_managed_provider_console" ||
		out.ProviderCleanup.ProviderScopeType != "leadpages_form_id" ||
		out.ProviderCleanup.ProviderScopeID != "form_123" ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_review_dashboard_webhooks" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["status"] != "provider_cleanup_operator_managed" ||
		stored["managed_provider_cleanup"] != false ||
		stored["provider_scope_id"] != "form_123" ||
		stored["webhook_cleanup_status"] != "operator_review_dashboard_webhooks" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func TestDisconnectFormstackReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFormstack
	store.integration.CredentialsRef = "cred_formstack_1"
	store.integration.Settings = map[string]any{
		"form_id":          "123",
		"form_name":        "Newsletter",
		"credentials_ref":  "cred_formstack_1",
		"provider_cleanup": map[string]any{"status": "stale"},
	}
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	var out struct {
		ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if out.ProviderCleanup.Provider != ProviderFormstack ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderCleanupPosture != "operator_managed_provider_console" ||
		out.ProviderCleanup.ProviderScopeType != "formstack_form_id" ||
		out.ProviderCleanup.ProviderScopeID != "123" ||
		out.ProviderCleanup.WebhookCleanupStatus != "provider_cleanup_not_applicable" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["status"] != "provider_cleanup_operator_managed" ||
		stored["managed_provider_cleanup"] != false ||
		stored["provider_scope_id"] != "123" ||
		stored["webhook_cleanup_status"] != "provider_cleanup_not_applicable" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func TestDisconnectTallyReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderTally
	store.integration.CredentialsRef = "cred_tally_1"
	store.integration.Settings = map[string]any{
		"form_id":          "form_123",
		"form_name":        "Newsletter",
		"credentials_ref":  "cred_tally_1",
		"provider_cleanup": map[string]any{"status": "stale"},
	}
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	var out struct {
		ProviderCleanup DisconnectCleanupEvidence `json:"provider_cleanup"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if out.ProviderCleanup.Provider != ProviderTally ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderCleanupPosture != "operator_managed_provider_console" ||
		out.ProviderCleanup.ProviderScopeType != "tally_form_id" ||
		out.ProviderCleanup.ProviderScopeID != "form_123" ||
		out.ProviderCleanup.WebhookCleanupStatus != "provider_cleanup_not_applicable" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["status"] != "provider_cleanup_operator_managed" ||
		stored["managed_provider_cleanup"] != false ||
		stored["provider_scope_id"] != "form_123" ||
		stored["webhook_cleanup_status"] != "provider_cleanup_not_applicable" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func TestDisconnectFacebookLeadAdsIntegrationStopsWhenPageSubscriptionCleanupFails(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderFacebookLeadAds
	store.integration.CredentialsRef = "cred_meta_leads_1"
	store.integration.Settings = map[string]any{
		"page_id":         "page_123",
		"form_id":         "form_456",
		"credentials_ref": "cred_meta_leads_1",
		"facebook_lead_ads_page_subscription_page_id": "page_123",
	}
	registrar := &fakeFacebookLeadAdsPageSubscriptionRegistrar{cleanupErr: errors.New("meta page subscription delete failed")}
	deps := &Deps{
		Repo:                             store,
		FacebookLeadAdsPageSubscriptions: registrar,
		PublicBaseURL:                    "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, leadReq(http.MethodDelete, "/api/v1/lead-integrations/lead_1", ""))

	if rec.Code != http.StatusBadGateway || store.deleted {
		t.Fatalf("delete status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if registrar.cleanupCalls != 1 {
		t.Fatalf("cleanup calls=%d", registrar.cleanupCalls)
	}
}
