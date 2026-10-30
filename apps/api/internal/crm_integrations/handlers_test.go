// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

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

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeStore struct {
	integration                     Integration
	runs                            []SyncRun
	lastInput                       IntegrationInput
	upsertErr                       error
	paused                          bool
	deleted                         bool
	disconnectCleanup               *DisconnectCleanupEvidence
	webhookClaim                    WebhookClaim
	webhookClaimErr                 error
	webhookClaimCount               int
	lastWebhookTenantID             string
	lastWebhookIntegrationID        string
	lastWebhookProvider             string
	lastWebhookID                   string
	lastWebhookTopic                string
	lastWebhookBody                 []byte
	webhookHashes                   map[string]string
	webhookStatuses                 map[string]WebhookClaim
	webhookProcessed                bool
	webhookFailed                   bool
	markWebhookProcessedErr         error
	markWebhookFailedErr            error
	lastWebhookProcessedID          string
	lastWebhookFailedID             string
	hubSpotLookupErr                error
	hubSpotSecrets                  map[string]string
	hubSpotOAuthStates              map[string]HubSpotOAuthState
	deletedHubSpotCredentialSecret  string
	salesforceSecrets               map[string]string
	deletedSalesforceCredentialRef  string
	zohoSecrets                     map[string]string
	deletedZohoCredentialRef        string
	dynamics365Secrets              map[string]string
	deletedDynamics365CredentialRef string
	keapSecrets                     map[string]string
	deletedKeapCredentialRef        string
	highLevelSecrets                map[string]string
	deletedHighLevelCredentialRef   string
	lastRecordedRequestCursor       string
	getIntegrationCalls             int
	getIntegrationHook              func(*fakeStore, int)
}

func newFakeStore() *fakeStore {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	return &fakeStore{integration: Integration{
		ID:             "crm_1",
		TenantID:       "tenant-1",
		Provider:       ProviderHubSpot,
		Name:           "HubSpot 123",
		Status:         "connected",
		Scopes:         []string{"crm.objects.contacts.read"},
		CredentialsRef: "cred_hubspot_1",
		Settings:       map[string]any{"portal_id": "123"},
		CreatedAt:      now,
		UpdatedAt:      now,
	}}
}

func (f *fakeStore) ListIntegrations(context.Context, string) ([]Integration, error) {
	return []Integration{f.integration}, nil
}
func (f *fakeStore) GetIntegration(context.Context, string, string) (*Integration, error) {
	f.getIntegrationCalls++
	if f.getIntegrationHook != nil {
		f.getIntegrationHook(f, f.getIntegrationCalls)
	}
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
func (f *fakeStore) CreateHubSpotOAuthState(_ context.Context, state HubSpotOAuthState) (string, error) {
	if f.hubSpotOAuthStates == nil {
		f.hubSpotOAuthStates = map[string]HubSpotOAuthState{}
	}
	token := "hubspot-state"
	f.hubSpotOAuthStates[token] = state
	return token, nil
}
func (f *fakeStore) ConsumeHubSpotOAuthState(_ context.Context, stateToken string) (HubSpotOAuthState, error) {
	state, ok := f.hubSpotOAuthStates[stateToken]
	if !ok {
		return HubSpotOAuthState{}, ErrNotFound
	}
	delete(f.hubSpotOAuthStates, stateToken)
	return state, nil
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
	if err := f.DisconnectIntegration(context.Background(), "", ""); err != nil {
		return err
	}
	f.disconnectCleanup = cleanup
	if cleanup != nil {
		if f.integration.Settings == nil {
			f.integration.Settings = map[string]any{}
		}
		payload, _ := json.Marshal(cleanup)
		stored := map[string]any{}
		_ = json.Unmarshal(payload, &stored)
		f.integration.Settings["provider_cleanup"] = stored
	}
	return nil
}
func (f *fakeStore) RecordSyncRun(_ context.Context, _ string, _ string, summary SyncSummary, req SyncRequest, started, completed time.Time) (*SyncRun, error) {
	f.lastRecordedRequestCursor = req.Cursor
	run := SyncRun{
		ID:               "run_1",
		IntegrationID:    summary.IntegrationID,
		RunMode:          req.RunMode,
		Status:           summary.Status,
		CursorTo:         summary.Cursor,
		ContactsSeen:     summary.ContactsSeen,
		ContactsUpserted: summary.ContactsUpserted,
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
func (f *fakeStore) ClaimWebhook(_ context.Context, tenantID, integrationID, provider, webhookID, topic string, body []byte) (WebhookClaim, error) {
	f.webhookClaimCount++
	f.lastWebhookTenantID = tenantID
	f.lastWebhookIntegrationID = integrationID
	f.lastWebhookProvider = provider
	f.lastWebhookID = webhookID
	f.lastWebhookTopic = topic
	f.lastWebhookBody = append([]byte(nil), body...)
	if f.webhookClaimErr != nil {
		return "", f.webhookClaimErr
	}
	if f.webhookClaim != "" {
		return f.webhookClaim, nil
	}
	key := crmWebhookFakeKey(integrationID, provider, webhookID)
	sum := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(sum[:])
	if f.webhookHashes == nil {
		f.webhookHashes = map[string]string{}
	}
	if f.webhookStatuses == nil {
		f.webhookStatuses = map[string]WebhookClaim{}
	}
	if existing := f.webhookHashes[key]; existing != "" && existing != bodyHash {
		return "", ErrCRMWebhookBodyMismatch
	}
	f.webhookHashes[key] = bodyHash
	switch f.webhookStatuses[key] {
	case WebhookProcessed:
		return WebhookProcessed, nil
	case WebhookInProgress:
		return WebhookInProgress, nil
	}
	f.webhookStatuses[key] = WebhookInProgress
	return WebhookClaimed, nil
}
func (f *fakeStore) MarkWebhookProcessed(_ context.Context, _, integrationID, provider string, webhookID string) error {
	f.webhookProcessed = true
	f.lastWebhookProcessedID = webhookID
	if f.markWebhookProcessedErr != nil {
		return f.markWebhookProcessedErr
	}
	if f.webhookStatuses == nil {
		f.webhookStatuses = map[string]WebhookClaim{}
	}
	f.webhookStatuses[crmWebhookFakeKey(integrationID, provider, webhookID)] = WebhookProcessed
	return nil
}
func (f *fakeStore) MarkWebhookFailed(_ context.Context, _, integrationID, provider string, webhookID string, _ error) error {
	f.webhookFailed = true
	f.lastWebhookFailedID = webhookID
	if f.markWebhookFailedErr != nil {
		return f.markWebhookFailedErr
	}
	if f.webhookStatuses == nil {
		f.webhookStatuses = map[string]WebhookClaim{}
	}
	f.webhookStatuses[crmWebhookFakeKey(integrationID, provider, webhookID)] = ""
	return nil
}

func crmWebhookFakeKey(integrationID, provider, webhookID string) string {
	return integrationID + ":" + provider + ":" + webhookID
}
func (f *fakeStore) FindPipedriveIntegrationByWebhookID(_ context.Context, webhookID string) (*Integration, error) {
	if !strings.EqualFold(f.integration.Status, "connected") && !strings.EqualFold(f.integration.Status, "active") {
		return nil, ErrNotFound
	}
	if settingString(f.integration.Settings, "pipedrive_webhook_id") == webhookID {
		return &f.integration, nil
	}
	for _, id := range hubSpotStringListSetting(f.integration.Settings, "pipedrive_webhook_ids") {
		if id == webhookID {
			return &f.integration, nil
		}
	}
	return nil, ErrNotFound
}

func (f *fakeStore) FindHubSpotIntegrationByAppAndPortalID(_ context.Context, appID, portalID string) (*Integration, error) {
	if f.hubSpotLookupErr != nil {
		return nil, f.hubSpotLookupErr
	}
	if !strings.EqualFold(f.integration.Status, "connected") && !strings.EqualFold(f.integration.Status, "active") {
		return nil, ErrNotFound
	}
	if !hubSpotOAuthWebhookCapable(f.integration) || settingString(f.integration.Settings, "hubspot_app_id") != appID {
		return nil, ErrNotFound
	}
	if portalID != "" && (settingString(f.integration.Settings, "hubspot_portal_id") == portalID || settingString(f.integration.Settings, "portal_id") == portalID) {
		return &f.integration, nil
	}
	return nil, ErrNotFound
}
func (f *fakeStore) FindSMSIntegrationByWebhookToken(_ context.Context, provider, token string) (*Integration, error) {
	if !strings.EqualFold(f.integration.Status, "connected") && !strings.EqualFold(f.integration.Status, "active") {
		return nil, ErrNotFound
	}
	if f.integration.Provider != provider {
		return nil, ErrNotFound
	}
	if token != "" && (settingString(f.integration.Settings, "webhook_route_token") == token || settingString(f.integration.Settings, provider+"_webhook_route_token") == token) {
		return &f.integration, nil
	}
	return nil, ErrNotFound
}
func (f *fakeStore) FindCloseIntegrationByWebhookToken(_ context.Context, token string) (*Integration, error) {
	if !strings.EqualFold(f.integration.Status, "connected") && !strings.EqualFold(f.integration.Status, "active") {
		return nil, ErrNotFound
	}
	if f.integration.Provider != ProviderClose {
		return nil, ErrNotFound
	}
	if token != "" && (settingString(f.integration.Settings, "webhook_route_token") == token || settingString(f.integration.Settings, "close_webhook_route_token") == token) {
		return &f.integration, nil
	}
	return nil, ErrNotFound
}
func (f *fakeStore) FindCopperIntegrationByWebhookToken(_ context.Context, token string) (*Integration, error) {
	if !strings.EqualFold(f.integration.Status, "connected") && !strings.EqualFold(f.integration.Status, "active") {
		return nil, ErrNotFound
	}
	if f.integration.Provider != ProviderCopper {
		return nil, ErrNotFound
	}
	if token != "" && (settingString(f.integration.Settings, "webhook_route_token") == token || settingString(f.integration.Settings, "copper_webhook_route_token") == token) {
		return &f.integration, nil
	}
	return nil, ErrNotFound
}
func (f *fakeStore) FindFreshsalesIntegrationByWebhookToken(_ context.Context, token string) (*Integration, error) {
	if !strings.EqualFold(f.integration.Status, "connected") && !strings.EqualFold(f.integration.Status, "active") {
		return nil, ErrNotFound
	}
	if f.integration.Provider != ProviderFreshsales {
		return nil, ErrNotFound
	}
	if token != "" && (settingString(f.integration.Settings, "webhook_route_token") == token || settingString(f.integration.Settings, "freshsales_webhook_route_token") == token) {
		return &f.integration, nil
	}
	return nil, ErrNotFound
}
func (f *fakeStore) FindHighLevelIntegrationByWebhookToken(_ context.Context, token string) (*Integration, error) {
	if !strings.EqualFold(f.integration.Status, "connected") && !strings.EqualFold(f.integration.Status, "active") {
		return nil, ErrNotFound
	}
	if f.integration.Provider != ProviderHighLevel {
		return nil, ErrNotFound
	}
	if token != "" && (settingString(f.integration.Settings, "webhook_route_token") == token || settingString(f.integration.Settings, "highlevel_webhook_route_token") == token) {
		return &f.integration, nil
	}
	return nil, ErrNotFound
}
func (f *fakeStore) GetHubSpotCredentialSecret(_ context.Context, _, ref string) (string, error) {
	if f.hubSpotSecrets == nil {
		return "", ErrNotFound
	}
	raw, ok := f.hubSpotSecrets[ref]
	if !ok {
		return "", ErrNotFound
	}
	return raw, nil
}
func (f *fakeStore) PutHubSpotCredentialSecret(_ context.Context, _ string, ref string, creds HubSpotCredentials) error {
	if f.hubSpotSecrets == nil {
		f.hubSpotSecrets = map[string]string{}
	}
	f.hubSpotSecrets[ref] = hubSpotStoredCredentialJSON(creds)
	return nil
}
func (f *fakeStore) DeleteHubSpotCredentialSecret(_ context.Context, _ string, ref string) error {
	f.deletedHubSpotCredentialSecret = ref
	if f.hubSpotSecrets != nil {
		delete(f.hubSpotSecrets, ref)
	}
	return nil
}
func (f *fakeStore) GetSalesforceCredentialSecret(_ context.Context, _, ref string) (string, error) {
	if f.salesforceSecrets == nil {
		return "", ErrNotFound
	}
	raw, ok := f.salesforceSecrets[ref]
	if !ok {
		return "", ErrNotFound
	}
	return raw, nil
}
func (f *fakeStore) PutSalesforceCredentialSecret(_ context.Context, _ string, ref string, creds SalesforceCredentials) error {
	if f.salesforceSecrets == nil {
		f.salesforceSecrets = map[string]string{}
	}
	f.salesforceSecrets[ref] = salesforceStoredCredentialJSON(creds)
	return nil
}
func (f *fakeStore) DeleteSalesforceCredentialSecret(_ context.Context, _ string, ref string) error {
	f.deletedSalesforceCredentialRef = ref
	if f.salesforceSecrets != nil {
		delete(f.salesforceSecrets, ref)
	}
	return nil
}
func (f *fakeStore) GetZohoCredentialSecret(_ context.Context, _, ref string) (string, error) {
	if f.zohoSecrets == nil {
		return "", ErrNotFound
	}
	raw, ok := f.zohoSecrets[ref]
	if !ok {
		return "", ErrNotFound
	}
	return raw, nil
}
func (f *fakeStore) PutZohoCredentialSecret(_ context.Context, _ string, ref string, creds ZohoCredentials) error {
	if f.zohoSecrets == nil {
		f.zohoSecrets = map[string]string{}
	}
	f.zohoSecrets[ref] = zohoStoredCredentialJSON(creds)
	return nil
}
func (f *fakeStore) DeleteZohoCredentialSecret(_ context.Context, _ string, ref string) error {
	f.deletedZohoCredentialRef = ref
	if f.zohoSecrets != nil {
		delete(f.zohoSecrets, ref)
	}
	return nil
}
func (f *fakeStore) GetDynamics365CredentialSecret(_ context.Context, _, ref string) (string, error) {
	if f.dynamics365Secrets == nil {
		return "", ErrNotFound
	}
	raw, ok := f.dynamics365Secrets[ref]
	if !ok {
		return "", ErrNotFound
	}
	return raw, nil
}
func (f *fakeStore) PutDynamics365CredentialSecret(_ context.Context, _ string, ref string, creds Dynamics365Credentials) error {
	if f.dynamics365Secrets == nil {
		f.dynamics365Secrets = map[string]string{}
	}
	f.dynamics365Secrets[ref] = dynamics365StoredCredentialJSON(creds)
	return nil
}
func (f *fakeStore) DeleteDynamics365CredentialSecret(_ context.Context, _ string, ref string) error {
	f.deletedDynamics365CredentialRef = ref
	if f.dynamics365Secrets != nil {
		delete(f.dynamics365Secrets, ref)
	}
	return nil
}
func (f *fakeStore) GetKeapCredentialSecret(_ context.Context, _, ref string) (string, error) {
	if f.keapSecrets == nil {
		return "", ErrNotFound
	}
	raw, ok := f.keapSecrets[ref]
	if !ok {
		return "", ErrNotFound
	}
	return raw, nil
}
func (f *fakeStore) PutKeapCredentialSecret(_ context.Context, _ string, ref string, creds KeapCredentials) error {
	if f.keapSecrets == nil {
		f.keapSecrets = map[string]string{}
	}
	f.keapSecrets[ref] = keapStoredCredentialJSON(creds)
	return nil
}
func (f *fakeStore) DeleteKeapCredentialSecret(_ context.Context, _ string, ref string) error {
	f.deletedKeapCredentialRef = ref
	if f.keapSecrets != nil {
		delete(f.keapSecrets, ref)
	}
	return nil
}
func (f *fakeStore) GetHighLevelCredentialSecret(_ context.Context, _, ref string) (string, error) {
	if f.highLevelSecrets == nil {
		return "", ErrNotFound
	}
	raw, ok := f.highLevelSecrets[ref]
	if !ok {
		return "", ErrNotFound
	}
	return raw, nil
}
func (f *fakeStore) PutHighLevelCredentialSecret(_ context.Context, _ string, ref string, creds HighLevelCredentials) error {
	if f.highLevelSecrets == nil {
		f.highLevelSecrets = map[string]string{}
	}
	f.highLevelSecrets[ref] = highLevelStoredCredentialJSON(creds)
	return nil
}
func (f *fakeStore) DeleteHighLevelCredentialSecret(_ context.Context, _ string, ref string) error {
	f.deletedHighLevelCredentialRef = ref
	if f.highLevelSecrets != nil {
		delete(f.highLevelSecrets, ref)
	}
	return nil
}

type fakeProfileSink struct {
	contacts []ContactInput
	err      error
}

func (f *fakeProfileSink) UpsertCRMContact(_ context.Context, _ string, _ Integration, contact ContactInput) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.contacts = append(f.contacts, contact)
	return "sub_1", nil
}

type fakeCRMListMembershipSink struct {
	added              []fakeCRMListMembership
	removed            []fakeCRMListMembership
	providerAdded      []CRMNativeListMembershipSeen
	providerRemoved    []CRMNativeListMembershipSeen
	scansBegun         []CRMNativeListMembershipScan
	scansCompleted     []CRMNativeListMembershipScan
	err                error
	removeErr          error
	beginScanErr       error
	completeScanErr    error
	completedScanCount int
	contactRemoved     []fakeCRMContactMembershipRemoval
	contactRemoveErr   error
}

type fakeCRMListMembership struct {
	TenantID     string
	ListID       string
	SubscriberID string
	Email        string
}

type fakeCRMContactMembershipRemoval struct {
	TenantID      string
	IntegrationID string
	Provider      string
	SubscriberID  string
}

func (f *fakeCRMListMembershipSink) AddCRMContactToList(_ context.Context, tenantID, listID, subscriberID, email string) error {
	if f.err != nil {
		return f.err
	}
	f.added = append(f.added, fakeCRMListMembership{
		TenantID:     tenantID,
		ListID:       listID,
		SubscriberID: subscriberID,
		Email:        email,
	})
	return nil
}

func (f *fakeCRMListMembershipSink) RemoveCRMContactFromList(_ context.Context, tenantID, listID, subscriberID, email string) (bool, error) {
	if f.removeErr != nil {
		return false, f.removeErr
	}
	f.removed = append(f.removed, fakeCRMListMembership{
		TenantID:     tenantID,
		ListID:       listID,
		SubscriberID: subscriberID,
		Email:        email,
	})
	return true, nil
}

func (f *fakeCRMListMembershipSink) AddProviderCRMContactToList(ctx context.Context, tenantID string, seen CRMNativeListMembershipSeen) error {
	f.providerAdded = append(f.providerAdded, seen)
	return f.AddCRMContactToList(ctx, tenantID, seen.NativeListID, seen.SubscriberID, seen.Email)
}

func (f *fakeCRMListMembershipSink) RemoveProviderCRMContactFromList(ctx context.Context, tenantID string, seen CRMNativeListMembershipSeen) (bool, error) {
	f.providerRemoved = append(f.providerRemoved, seen)
	return f.RemoveCRMContactFromList(ctx, tenantID, seen.NativeListID, seen.SubscriberID, seen.Email)
}

func (f *fakeCRMListMembershipSink) RemoveProviderCRMContactMemberships(
	_ context.Context,
	tenantID, integrationID, provider, subscriberID string,
) (int, error) {
	if f.contactRemoveErr != nil {
		return 0, f.contactRemoveErr
	}
	f.contactRemoved = append(f.contactRemoved, fakeCRMContactMembershipRemoval{
		TenantID:      tenantID,
		IntegrationID: integrationID,
		Provider:      provider,
		SubscriberID:  subscriberID,
	})
	return 1, nil
}

func (f *fakeCRMListMembershipSink) BeginProviderCRMListMembershipScan(_ context.Context, _ string, scan CRMNativeListMembershipScan) error {
	if f.beginScanErr != nil {
		return f.beginScanErr
	}
	f.scansBegun = append(f.scansBegun, scan)
	return nil
}

func (f *fakeCRMListMembershipSink) CompleteProviderCRMListMembershipScan(_ context.Context, _ string, scan CRMNativeListMembershipScan) (int, error) {
	if f.completeScanErr != nil {
		return 0, f.completeScanErr
	}
	f.scansCompleted = append(f.scansCompleted, scan)
	return f.completedScanCount, nil
}

type fakeEventSink struct {
	events []EventInput
	err    error
}

func (f *fakeEventSink) TrackCRMEvent(_ context.Context, _ string, _ string, event EventInput) (int64, error) {
	if f.err != nil {
		return 0, f.err
	}
	f.events = append(f.events, event)
	return int64(len(f.events)), nil
}

type fakeCRMBackfiller struct {
	req         SyncRequest
	err         error
	gotTenant   string
	gotCursor   string
	gotProvider string
	afterCall   func()
}

func (f *fakeCRMBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.gotTenant = tenantID
	f.gotCursor = cursor
	f.gotProvider = integration.Provider
	if f.afterCall != nil {
		f.afterCall()
	}
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	return f.req, nil
}

func setCRMRESTBackfiller(t *testing.T, deps *Deps, provider string, backfiller *fakeCRMBackfiller) {
	t.Helper()
	switch provider {
	case ProviderZohoCRM:
		deps.ZohoBackfiller = backfiller
	case ProviderDynamics365:
		deps.Dynamics365Backfiller = backfiller
	case ProviderKeap:
		deps.KeapBackfiller = backfiller
	default:
		t.Fatalf("unsupported provider %q", provider)
	}
}

func crmRESTTestBaseCursor(t *testing.T, provider string) string {
	t.Helper()
	switch provider {
	case ProviderZohoCRM:
		return encodeZohoCursor(zohoCursorState{Object: "contacts", Page: 2})
	case ProviderDynamics365:
		return encodeDynamics365Cursor(dynamics365CursorState{Object: "contacts", NextLink: "https://org.crm.dynamics.com/api/data/v9.2/contacts?$skiptoken=10"})
	case ProviderKeap:
		return encodeKeapCursor(keapCursorState{Object: "contacts", PageToken: "page-100"})
	default:
		t.Fatalf("unsupported provider %q", provider)
		return ""
	}
}

func crmRESTTestNextCursor(t *testing.T, provider string) string {
	t.Helper()
	switch provider {
	case ProviderZohoCRM:
		return encodeZohoCursor(zohoCursorState{Object: "leads", Page: 1})
	case ProviderDynamics365:
		return encodeDynamics365Cursor(dynamics365CursorState{Object: "leads"})
	case ProviderKeap:
		return encodeKeapCursor(keapCursorState{Object: "contacts", PageToken: "page-200"})
	default:
		t.Fatalf("unsupported provider %q", provider)
		return ""
	}
}

func crmRESTTestSourceID(t *testing.T, provider string) string {
	t.Helper()
	switch provider {
	case ProviderZohoCRM:
		return "zoho://contact/554023000000310003"
	case ProviderDynamics365:
		return "dynamics365://contact/00000000-0000-0000-0000-000000000123"
	case ProviderKeap:
		return "keap://contact/123"
	default:
		t.Fatalf("unsupported provider %q", provider)
		return ""
	}
}

func crmRESTTestRetryCursor(t *testing.T, provider, cursor, status string, nextAttemptAt time.Time) string {
	t.Helper()
	switch provider {
	case ProviderZohoCRM:
		return encodeZohoRetryCursor(zohoRetryState{Cursor: cursor, Attempts: 1, LastStatus: status, LastError: "provider throttled", NextAttemptAt: nextAttemptAt.UTC().Format(time.RFC3339)})
	case ProviderDynamics365:
		return encodeDynamics365RetryCursor(dynamics365RetryState{Cursor: cursor, Attempts: 1, LastStatus: status, LastError: "provider throttled", NextAttemptAt: nextAttemptAt.UTC().Format(time.RFC3339)})
	case ProviderKeap:
		return encodeKeapRetryCursor(keapRetryState{Cursor: cursor, Attempts: 1, LastStatus: status, LastError: "provider throttled", NextAttemptAt: nextAttemptAt.UTC().Format(time.RFC3339)})
	default:
		t.Fatalf("unsupported provider %q", provider)
		return ""
	}
}

func crmRESTTestProviderError(t *testing.T, provider string, retryAfter time.Duration) error {
	t.Helper()
	switch provider {
	case ProviderZohoCRM:
		return ZohoRESTError{Path: "/crm/v8/Contacts", StatusCode: http.StatusTooManyRequests, RetryAfter: retryAfter, Snippet: "slow down"}
	case ProviderDynamics365:
		return Dynamics365RESTError{Path: "/api/data/v9.2/contacts", StatusCode: http.StatusTooManyRequests, RetryAfter: retryAfter, Snippet: "slow down"}
	case ProviderKeap:
		return KeapRESTError{Path: "/v2/contacts", StatusCode: http.StatusTooManyRequests, RetryAfter: retryAfter, Snippet: "slow down"}
	default:
		t.Fatalf("unsupported provider %q", provider)
		return nil
	}
}

func assertCRMRESTRetryCursor(t *testing.T, provider, got, wantCursor, wantStatus, wantNextAttemptAt string) {
	t.Helper()
	switch provider {
	case ProviderZohoCRM:
		retry, ok, err := decodeZohoRetryCursor(got)
		if err != nil || !ok {
			t.Fatalf("retry cursor=%q ok=%v err=%v", got, ok, err)
		}
		if retry.Cursor != wantCursor || retry.LastStatus != wantStatus || retry.NextAttemptAt != wantNextAttemptAt {
			t.Fatalf("retry=%+v", retry)
		}
	case ProviderDynamics365:
		retry, ok, err := decodeDynamics365RetryCursor(got)
		if err != nil || !ok {
			t.Fatalf("retry cursor=%q ok=%v err=%v", got, ok, err)
		}
		if retry.Cursor != wantCursor || retry.LastStatus != wantStatus || retry.NextAttemptAt != wantNextAttemptAt {
			t.Fatalf("retry=%+v", retry)
		}
	case ProviderKeap:
		retry, ok, err := decodeKeapRetryCursor(got)
		if err != nil || !ok {
			t.Fatalf("retry cursor=%q ok=%v err=%v", got, ok, err)
		}
		if retry.Cursor != wantCursor || retry.LastStatus != wantStatus || retry.NextAttemptAt != wantNextAttemptAt {
			t.Fatalf("retry=%+v", retry)
		}
	default:
		t.Fatalf("unsupported provider %q", provider)
	}
}

func crmReq(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
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

func fieldKeys(fields []ProviderField) []string {
	out := make([]string, 0, len(fields))
	for _, field := range fields {
		out = append(out, field.Key)
	}
	return out
}

func TestListProvidersIncludesHubSpot(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{Repo: newFakeStore()}).ListProviders(rec, httptest.NewRequest(http.MethodGet, "/api/v1/crm/providers", nil))

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
		ProviderHubSpot,
		ProviderSalesforce,
		ProviderPipedrive,
		ProviderZohoCRM,
		ProviderDynamics365,
		ProviderKeap,
		ProviderClose,
		ProviderCopper,
		ProviderFreshsales,
		ProviderHighLevel,
		ProviderPostscript,
		ProviderAttentive,
	} {
		if !seen[provider] {
			t.Fatalf("provider %q missing or unmanaged: %+v", provider, res.Items)
		}
	}
}

func TestCRMOAuthAvailabilityExposesAvailableAlias(t *testing.T) {
	deps := Deps{Repo: newFakeStore(), PublicBaseURL: "https://postwave.test"}
	router := chi.NewRouter()
	router.Get("/api/v1/crm/{provider}/oauth/availability", deps.CRMOAuthAvailability)
	cases := []struct {
		name     string
		startURL string
	}{
		{"hubspot", "/api/v1/crm/hubspot/oauth/start"},
		{"pipedrive", "/api/v1/crm/pipedrive/oauth/start"},
		{"salesforce", "/api/v1/crm/salesforce/oauth/start"},
		{"zoho", "/api/v1/crm/zoho/oauth/start"},
		{"dynamics365", "/api/v1/crm/dynamics365/oauth/start"},
		{"keap", "/api/v1/crm/keap/oauth/start"},
		{"gohighlevel", "/api/v1/crm/gohighlevel/oauth/start"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/crm/"+tc.name+"/oauth/availability", nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			var out map[string]any
			if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
				t.Fatal(err)
			}
			if out["available"] != out["configured"] {
				t.Fatalf("available/configured mismatch: %+v", out)
			}
			if out["requires_session"] != true || out["start_url"] != tc.startURL {
				t.Fatalf("availability payload=%+v", out)
			}
		})
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/crm/unsupported/oauth/availability", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "crm_oauth_provider_not_found") {
		t.Fatalf("unsupported provider: status=%d body=%q", rec.Code, rec.Body.String())
	}
}

func TestCRMOAuthProviderCallbacksAreMountedOnPublicRouter(t *testing.T) {
	deps := &Deps{Repo: newFakeStore()}
	authenticated := chi.NewRouter()
	MountRoutes(authenticated, deps)
	browserPublic := chi.NewRouter()
	MountOAuthCallbackRoutes(browserPublic, deps)
	providerPublic := chi.NewRouter()
	MountPublicRoutes(providerPublic, deps)

	hasRoute := func(router chi.Router, method, path string) bool {
		found := false
		if err := chi.Walk(router, func(gotMethod, gotPath string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
			if gotMethod == method && gotPath == path {
				found = true
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return found
	}

	for _, route := range []struct {
		method string
		path   string
		public chi.Router
	}{
		{http.MethodGet, "/api/v1/crm/{provider}/oauth/callback", browserPublic},
		{http.MethodDelete, "/api/v1/crm/pipedrive/oauth/callback", providerPublic},
	} {
		if hasRoute(authenticated, route.method, route.path) {
			t.Fatalf("provider callback %s %s must not require Moosewave tenant authentication", route.method, route.path)
		}
		if !hasRoute(route.public, route.method, route.path) {
			t.Fatalf("provider callback %s %s is not mounted on the public router", route.method, route.path)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/crm/unsupported/oauth/callback", nil)
	rec := httptest.NewRecorder()
	browserPublic.ServeHTTP(rec, req)
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("OAuth callback cache policy=%q, want no-store", rec.Header().Get("Cache-Control"))
	}
}

func TestCRMProviderMetadataDescribesPostwaveImportFoundation(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{Repo: newFakeStore()}).ListProviders(rec, httptest.NewRequest(http.MethodGet, "/api/v1/crm/providers", nil))

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
		if item.Provider == ProviderHubSpot {
			if item.SyncModel != hubSpotSyncModelContactsREST || item.VerificationMode != "hubspot_oauth_contacts_list_memberships_deal_events_webhooks_scheduled_retry_pending_live_certification" {
				t.Fatalf("HubSpot should expose the native contacts/OAuth/webhook runtime, got %+v", item)
			}
			if !hasString(item.SyncObjects, "contacts") || !hasString(item.SyncObjects, "list_memberships") || !hasString(item.SyncObjects, "deal_events") || !hasString(item.SyncObjects, "oauth_app_webhooks") {
				t.Fatalf("HubSpot should expose contact pulls, list memberships, deal events, and OAuth-app webhooks: %+v", item.SyncObjects)
			}
			if item.WebhookMode != "managed_oauth_install_only" || item.AuthMode != "private_app_ref_or_managed_oauth" {
				t.Fatalf("HubSpot should distinguish polling-only private apps from OAuth app webhooks: %+v", item)
			}
			if !hasString(item.Capabilities, "profiles") || !hasString(item.Capabilities, "events") || !hasString(item.Capabilities, "lists") {
				t.Fatalf("HubSpot should expose profiles, deal events, and configured list evidence: %+v", item.Capabilities)
			}
			if !hasString(item.Scopes, "crm.objects.contacts.read") || !hasString(item.Scopes, "crm.objects.deals.read") || !hasString(item.Scopes, "crm.objects.companies.read") || !hasString(item.Scopes, "crm.lists.read") || !hasString(item.Scopes, "oauth") || !hasString(item.WebhookTopics, "contact.propertyChange") {
				t.Fatalf("HubSpot scopes/topics should disclose OAuth contact webhooks: %+v", item)
			}
			for _, key := range []string{"sync_list_memberships", "membership_list_ids", "sync_deals", "deal_page_size", "deal_properties", "company_properties"} {
				if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
					t.Fatalf("HubSpot should expose optional setting %q: %+v", key, item.OptionalSettings)
				}
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "webhook_secret_ref"); ok {
				t.Fatalf("HubSpot app-level webhooks should not expose per-tenant webhook_secret_ref: %+v", item.OptionalSettings)
			}
			continue
		}
		if item.Provider == ProviderSalesforce {
			if item.SyncModel != salesforceSyncModelSOQL || item.VerificationMode != "salesforce_connected_app_soql_contacts_leads_campaign_members_tasks_live_certification_pending" {
				t.Fatalf("Salesforce should expose the native SOQL puller, got %+v", item)
			}
			if !hasString(item.SyncObjects, "contacts") || !hasString(item.SyncObjects, "leads") || !hasString(item.SyncObjects, "campaign_members") || !hasString(item.SyncObjects, "tasks") || len(item.SyncObjects) != 4 {
				t.Fatalf("Salesforce should expose built contact/lead/campaign-member/task sync objects for now: %+v", item.SyncObjects)
			}
			if !hasString(item.Capabilities, "profiles") || !hasString(item.Capabilities, "events") {
				t.Fatalf("Salesforce capabilities should expose profile and event fanout: %+v", item.Capabilities)
			}
			if !hasString(item.Scopes, "api") || len(item.WebhookTopics) != 0 {
				t.Fatalf("Salesforce scopes/topics should be precise before CDC/webhooks land: %+v", item)
			}
			continue
		}
		if item.Provider == ProviderPipedrive {
			if item.SyncModel != pipedriveSyncModelPersonsDealsOrgsActivitiesREST || item.VerificationMode != "pipedrive_oauth_persons_deals_organizations_activities_webhooks_pending_live_certification" {
				t.Fatalf("Pipedrive should expose the native persons/deals/organizations/activities/webhooks slice, got %+v", item)
			}
			if !hasString(item.SyncObjects, "persons") || !hasString(item.SyncObjects, "deals") || !hasString(item.SyncObjects, "organizations") || !hasString(item.SyncObjects, "activities") || !hasString(item.SyncObjects, "webhooks") || len(item.SyncObjects) != 5 {
				t.Fatalf("Pipedrive should expose built persons/deals/organizations/activities/webhook sync objects: %+v", item.SyncObjects)
			}
			if !hasString(item.Scopes, "contacts:read") || !hasString(item.Scopes, "deals:read") || !hasString(item.Scopes, "activities:read") || !hasString(item.Scopes, "webhooks:full") {
				t.Fatalf("Pipedrive scopes should cover persons, deals, activities, and managed webhooks: %+v", item.Scopes)
			}
			if !hasString(item.WebhookTopics, "change.person") || !hasString(item.WebhookTopics, "change.deal") || !hasString(item.WebhookTopics, "change.organization") || !hasString(item.WebhookTopics, "change.activity") || len(item.WebhookTopics) != 12 {
				t.Fatalf("Pipedrive webhook topics should cover person/deal/organization/activity changes: %+v", item.WebhookTopics)
			}
			continue
		}
		if item.Provider == ProviderZohoCRM {
			if item.SyncModel != zohoSyncModelRecordsREST || item.VerificationMode != "zoho_oauth_v8_contacts_leads_scheduled_retry_pending_notifications_accounts_deals_activities_cleanup_certification" {
				t.Fatalf("Zoho should expose the native V8 contacts/leads puller, got %+v", item)
			}
			if !hasString(item.SyncObjects, "contacts") || !hasString(item.SyncObjects, "leads") || len(item.SyncObjects) != 2 {
				t.Fatalf("Zoho should expose built contacts/leads sync objects for now: %+v", item.SyncObjects)
			}
			if !hasString(item.Scopes, "ZohoCRM.modules.Contacts.READ") || !hasString(item.Scopes, "ZohoCRM.modules.Leads.READ") || len(item.WebhookTopics) != 0 {
				t.Fatalf("Zoho scopes/topics should be precise before notifications runtime lands: %+v", item)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "notification_token_ref"); ok {
				t.Fatalf("Zoho should not expose notification_token_ref before Notification API runtime lands: %+v", item.OptionalSettings)
			}
			continue
		}
		if item.Provider == ProviderDynamics365 {
			if item.SyncModel != dynamics365SyncModelDataverseREST || item.VerificationMode != "dataverse_oauth_contacts_leads_scheduled_retry_pending_change_tracking_lists_opportunities_activities_cleanup_certification" {
				t.Fatalf("Dynamics should expose the native Dataverse contacts/leads puller, got %+v", item)
			}
			if !hasString(item.SyncObjects, "contacts") || !hasString(item.SyncObjects, "leads") || len(item.SyncObjects) != 2 {
				t.Fatalf("Dynamics should expose built contacts/leads sync objects for now: %+v", item.SyncObjects)
			}
			if !hasString(item.Scopes, "{environment_url}/user_impersonation") || len(item.WebhookTopics) != 0 {
				t.Fatalf("Dynamics scopes/topics should be precise before change tracking/webhook runtime lands: %+v", item)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "webhook_auth_ref"); ok {
				t.Fatalf("Dynamics should not expose webhook_auth_ref before Dataverse webhook runtime lands: %+v", item.OptionalSettings)
			}
			continue
		}
		if item.Provider == ProviderKeap {
			if item.SyncModel != keapSyncModelContactsREST || item.VerificationMode != "keap_rest_v2_contacts_scheduled_retry_pending_tags_campaigns_orders_webhooks_cleanup_certification" {
				t.Fatalf("Keap should expose the native REST v2 contacts puller, got %+v", item)
			}
			if !hasString(item.SyncObjects, "contacts") || len(item.SyncObjects) != 1 {
				t.Fatalf("Keap should only expose built contact sync objects for now: %+v", item.SyncObjects)
			}
			if !hasString(item.Scopes, "full") || len(item.WebhookTopics) != 0 {
				t.Fatalf("Keap scopes/topics should be precise before webhook runtime lands: %+v", item)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "webhook_secret_ref"); ok {
				t.Fatalf("Keap should not expose webhook_secret_ref before REST Hooks/runtime lands: %+v", item.OptionalSettings)
			}
			continue
		}
		if item.Provider == ProviderClose {
			if item.SyncModel != closeSyncModelContactsREST || item.VerificationMode != "close_api_key_contacts_rest_signed_route_token_webhooks_scheduled_retry_cleanup_pending_live_certification" {
				t.Fatalf("Close should expose the native contacts/webhook runtime, got %+v", item)
			}
			if !hasString(item.SyncObjects, "contacts") || !hasString(item.SyncObjects, "webhook_events") || !hasString(item.SyncObjects, "opportunity_events") {
				t.Fatalf("Close should expose built contact and webhook event sync objects: %+v", item.SyncObjects)
			}
			if !hasString(item.Scopes, "contacts.read") || !hasString(item.Scopes, "webhooks.receive") || !hasString(item.WebhookTopics, "contact.updated") || !hasString(item.WebhookTopics, "opportunity.updated") {
				t.Fatalf("Close scopes/topics should disclose signed webhook runtime: %+v", item)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "webhook_route_token"); !ok {
				t.Fatalf("Close should expose webhook_route_token for signed webhook routing: %+v", item.OptionalSettings)
			}
			continue
		}
		if item.Provider == ProviderCopper {
			if item.SyncModel != copperSyncModelPeopleREST || item.VerificationMode != "copper_api_key_people_companies_opportunities_projects_activities_rest_route_token_webhooks_scheduled_retry_cleanup_pending_live_certification" {
				t.Fatalf("Copper should expose the native people/company/opportunity/project/activity puller and route-token webhook runtime, got %+v", item)
			}
			if !hasString(item.SyncObjects, "people") || !hasString(item.SyncObjects, "company_contacts") || !hasString(item.SyncObjects, "opportunity_events") || !hasString(item.SyncObjects, "project_events") || !hasString(item.SyncObjects, "activity_events") || !hasString(item.SyncObjects, "webhook_events") {
				t.Fatalf("Copper should expose built people, company, opportunity, project, activity, and webhook sync objects: %+v", item.SyncObjects)
			}
			if !hasString(item.Scopes, "people.read") || !hasString(item.Scopes, "companies.read") || !hasString(item.Scopes, "opportunities.read") || !hasString(item.Scopes, "projects.read") || !hasString(item.Scopes, "activities.read") || !hasString(item.Scopes, "webhooks.receive") || !hasString(item.WebhookTopics, "person.updated") || !hasString(item.WebhookTopics, "company.updated") || !hasString(item.WebhookTopics, "opportunity.updated") || !hasString(item.WebhookTopics, "project.updated") || !hasString(item.WebhookTopics, "activity.updated") {
				t.Fatalf("Copper scopes/topics should disclose built route-token webhook runtime: %+v", item)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "webhook_route_token"); !ok {
				t.Fatalf("Copper should expose webhook_route_token for route-token webhook routing: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "webhook_secret_ref"); ok {
				t.Fatalf("Copper should not expose raw webhook_secret_ref for the route-token runtime: %+v", item.OptionalSettings)
			}
			continue
		}
		if item.Provider == ProviderFreshsales {
			if item.SyncModel != freshsalesSyncModelContactsREST || item.VerificationMode != "freshsales_api_key_contacts_accounts_deals_contact_deal_account_targeted_sales_activities_tasks_route_token_workflow_webhooks_scheduled_retry_cleanup_pending_live_certification" {
				t.Fatalf("Freshsales should expose the native contacts/account/deal/activity/task puller and route-token workflow webhook runtime, got %+v", item)
			}
			if !hasString(item.SyncObjects, "contacts") || !hasString(item.SyncObjects, "account_contacts") || !hasString(item.SyncObjects, "deal_events") || !hasString(item.SyncObjects, "activity_events") || !hasString(item.SyncObjects, "task_events") || !hasString(item.SyncObjects, "webhook_events") || len(item.SyncObjects) != 6 {
				t.Fatalf("Freshsales should expose built contact, account-contact, deal event, activity event, task event, and webhook event sync objects for now: %+v", item.SyncObjects)
			}
			if !hasString(item.Scopes, "contacts.read") || !hasString(item.Scopes, "accounts.read") || !hasString(item.Scopes, "deals.read") || !hasString(item.Scopes, "activities.read") || !hasString(item.Scopes, "tasks.read") || !hasString(item.Scopes, "webhooks.receive") || !hasString(item.WebhookTopics, "contact.updated") || hasString(item.WebhookTopics, "deal.updated") {
				t.Fatalf("Freshsales scopes/topics should disclose only the built workflow contact webhook runtime: %+v", item)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "account_view_id"); !ok {
				t.Fatalf("Freshsales should expose account_view_id for account-contact enrichment: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "deal_view_id"); !ok {
				t.Fatalf("Freshsales should expose deal_view_id for deal event backfill: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "sync_sales_activities"); !ok {
				t.Fatalf("Freshsales should expose sync_sales_activities for activity event backfill: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "sync_tasks"); !ok {
				t.Fatalf("Freshsales should expose sync_tasks for task event backfill: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "webhook_route_token"); !ok {
				t.Fatalf("Freshsales should expose webhook_route_token for workflow webhook routing: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "webhook_secret_ref"); ok {
				t.Fatalf("Freshsales should not expose raw webhook_secret_ref for the route-token runtime: %+v", item.OptionalSettings)
			}
			continue
		}
		if item.Provider == ProviderHighLevel {
			if item.SyncModel != highLevelSyncModelContactsREST || item.VerificationMode != "highlevel_oauth_contacts_opportunities_calendars_appointments_conversations_rest_route_token_webhooks_scheduled_retry_cleanup_pending_live_certification" {
				t.Fatalf("HighLevel should expose the native scheduled contacts, opt-in object puller, and route-token webhook runtime, got %+v", item)
			}
			if !hasString(item.SyncObjects, "contacts") || !hasString(item.SyncObjects, "opportunity_events") || !hasString(item.SyncObjects, "calendars") || !hasString(item.SyncObjects, "appointment_events") || !hasString(item.SyncObjects, "conversation_events") || !hasString(item.SyncObjects, "webhook_events") {
				t.Fatalf("HighLevel should expose built contact, opt-in object, and webhook sync objects: %+v", item.SyncObjects)
			}
			if !hasString(item.Scopes, "contacts.readonly") || !hasString(item.Scopes, "opportunities.readonly") || !hasString(item.Scopes, "calendars/events.readonly") || !hasString(item.Scopes, "conversations.readonly") || !hasString(item.Scopes, "conversations/message.readonly") || !hasString(item.Scopes, "webhooks.receive") || !hasString(item.WebhookTopics, "contact.updated") || !hasString(item.WebhookTopics, "opportunity.updated") || !hasString(item.WebhookTopics, "appointment.updated") || !hasString(item.WebhookTopics, "conversation.updated") || !hasString(item.WebhookTopics, "message.created") {
				t.Fatalf("HighLevel scopes/topics should disclose opt-in REST pulls and route-token webhook runtime: %+v", item)
			}
			for _, key := range []string{"sync_opportunities", "sync_calendars", "sync_appointments", "sync_conversations"} {
				if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
					t.Fatalf("HighLevel should expose %s for opt-in object pulls: %+v", key, item.OptionalSettings)
				}
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "webhook_route_token"); !ok {
				t.Fatalf("HighLevel should expose webhook_route_token for route-token webhook routing: %+v", item.OptionalSettings)
			}
			if _, ok := providerFieldByKey(item.OptionalSettings, "webhook_secret_ref"); ok {
				t.Fatalf("HighLevel should not expose raw webhook_secret_ref for the route-token runtime: %+v", item.OptionalSettings)
			}
			continue
		}
		if item.Provider == ProviderPostscript {
			if item.SyncModel != postscriptSyncModelSubscribersREST || item.VerificationMode != "postscript_sms_subscribers_rest_phone_identity_route_token_signed_webhooks_scheduled_retry_cleanup_pending_live_certification" {
				t.Fatalf("Postscript should expose the native SMS subscriber puller, got %+v", item)
			}
			if !hasString(item.SyncObjects, "subscribers") || !hasString(item.SyncObjects, "webhook_events") {
				t.Fatalf("Postscript should expose built subscriber and webhook sync objects: %+v", item.SyncObjects)
			}
			if !hasString(item.Scopes, "subscribers.read") || !hasString(item.Scopes, "webhooks.receive") || !hasString(item.WebhookTopics, "shop.subscriber.opt_in") {
				t.Fatalf("Postscript scopes/topics should disclose signed webhook runtime: %+v", item)
			}
			for _, key := range []string{"api_base_url", "page_size", "default_tags", "list_ids", "webhook_route_token"} {
				if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
					t.Fatalf("Postscript should expose optional setting %q: %+v", key, item.OptionalSettings)
				}
			}
			continue
		}
		if item.Provider == ProviderAttentive {
			if item.SyncModel != attentiveSyncModelSubscribersREST || item.VerificationMode != "attentive_sms_subscribers_rest_phone_identity_route_token_hmac_webhooks_scheduled_retry_cleanup_pending_live_certification" {
				t.Fatalf("Attentive should expose the native SMS subscriber puller, got %+v", item)
			}
			if !hasString(item.SyncObjects, "subscribers") || !hasString(item.SyncObjects, "webhook_events") {
				t.Fatalf("Attentive should expose built subscriber and webhook sync objects: %+v", item.SyncObjects)
			}
			if !hasString(item.Scopes, "subscribers.read") || !hasString(item.Scopes, "webhooks.receive") || !hasString(item.WebhookTopics, "sms.subscribed") {
				t.Fatalf("Attentive scopes/topics should disclose HMAC webhook runtime: %+v", item)
			}
			for _, key := range []string{"api_base_url", "page_size", "default_tags", "list_ids", "webhook_route_token"} {
				if _, ok := providerFieldByKey(item.OptionalSettings, key); !ok {
					t.Fatalf("Attentive should expose optional setting %q: %+v", key, item.OptionalSettings)
				}
			}
			continue
		}
		if item.SyncModel != crmSyncModelImport {
			t.Fatalf("%s sync model = %q, want %q", item.Provider, item.SyncModel, crmSyncModelImport)
		}
		if item.VerificationMode == "" {
			t.Fatalf("%s missing verification mode", item.Provider)
		}
		if len(item.Scopes) != 0 || len(item.WebhookTopics) != 0 {
			t.Fatalf("%s should not expose provider scopes/topics before provider workers land: %+v", item.Provider, item)
		}
		if len(item.SyncObjects) != 2 || !hasString(item.SyncObjects, "contacts") || !hasString(item.SyncObjects, "events") {
			t.Fatalf("%s should expose only canonical CRM import objects before provider workers land: %+v", item.Provider, item.SyncObjects)
		}
		for _, key := range []string{"webhook_auth_ref", "webhook_secret_ref", "webhook_signature_ref", "notification_channel_id", "notification_token_ref"} {
			if _, ok := providerFieldByKey(item.OptionalSettings, key); ok {
				t.Fatalf("%s should not expose %s until raw provider callbacks are verified: %+v", item.Provider, key, item.OptionalSettings)
			}
		}
	}
	pipedrive := seen[ProviderPipedrive]
	if pipedrive.AuthMode != "managed_oauth_or_api_token_ref" {
		t.Fatalf("Pipedrive should model API-token or OAuth credential refs, got %+v", pipedrive)
	}
	dynamics := seen[ProviderDynamics365]
	if !hasString(fieldKeys(dynamics.RequiredSettings), "environment_url") || !hasString(fieldKeys(dynamics.OptionalSettings), "page_size") {
		t.Fatalf("Dynamics should require the Dataverse environment URL and expose page sizing, got required=%+v optional=%+v", dynamics.RequiredSettings, dynamics.OptionalSettings)
	}
}

func TestCreateKeapIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations", `{
		"provider":"keap",
		"settings":{
			"account_id":"keap_123",
			"credentials_ref":"cred_keap_1",
			"webhook_secret_ref":"cred_keap_webhook_1"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderKeap || store.lastInput.CredentialsRef != "cred_keap_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["account_id"] != "keap_123" ||
		store.lastInput.Settings["setup_surface"] != "crm_integrations" ||
		store.lastInput.Settings["sync_model"] != keapSyncModelContactsREST ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["webhook_secret_ref"] != nil || !hasString(store.lastInput.Scopes, "full") {
		t.Fatalf("provider callback settings should be stripped and Keap scope should be set: input=%+v settings=%+v", store.lastInput, store.lastInput.Settings)
	}
}

func TestCreateCloseIntegrationPreservesRouteTokenAndStripsRawWebhookSecret(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations", `{
		"provider":"close",
		"name":"Close Sales",
		"settings":{
			"organization_id":"orga_1",
			"credentials_ref":"cred_close_1",
			"webhook_route_token":"route_close_1",
			"webhook_signature_ref":"should_strip"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderClose || store.lastInput.CredentialsRef != "cred_close_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["setup_surface"] != "crm_integrations" ||
		store.lastInput.Settings["sync_model"] != closeSyncModelContactsREST ||
		store.lastInput.Settings["verification_mode"] != "close_api_key_contacts_rest_signed_route_token_webhooks_scheduled_retry_cleanup_pending_live_certification" ||
		store.lastInput.Settings["managed_by_postwave"] != true ||
		store.lastInput.Settings["webhook_route_token"] != "route_close_1" ||
		store.lastInput.Settings["webhook_signature_ref"] != nil {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if !hasString(store.lastInput.Scopes, "contacts.read") || !hasString(store.lastInput.Scopes, "webhooks.receive") {
		t.Fatalf("scopes=%+v", store.lastInput.Scopes)
	}
}

func TestCreatePostscriptIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations", `{
		"provider":"postscript",
		"name":"Postscript SMS",
		"settings":{
			"credentials_ref":"cred_postscript_1",
			"page_size":250,
			"webhook_route_token":"route_ps_1",
			"webhook_secret_ref":"should_strip"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderPostscript || store.lastInput.CredentialsRef != "cred_postscript_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["setup_surface"] != "crm_integrations" ||
		store.lastInput.Settings["sync_model"] != postscriptSyncModelSubscribersREST ||
		store.lastInput.Settings["verification_mode"] != "postscript_sms_subscribers_rest_phone_identity_route_token_signed_webhooks_scheduled_retry_cleanup_pending_live_certification" ||
		store.lastInput.Settings["managed_by_postwave"] != true ||
		store.lastInput.Settings["webhook_route_token"] != "route_ps_1" ||
		store.lastInput.Settings["webhook_secret_ref"] != nil {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if !hasString(store.lastInput.Scopes, "subscribers.read") {
		t.Fatalf("scopes=%+v", store.lastInput.Scopes)
	}
}

func TestCreateAttentiveIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations", `{
		"provider":"attentive",
		"name":"Attentive SMS",
		"settings":{
			"credential_ref":"cred_attentive_1",
			"page_size":500,
			"attentive_webhook_route_token":"route_att_1",
			"webhook_signature_ref":"should_strip"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderAttentive || store.lastInput.CredentialsRef != "cred_attentive_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["setup_surface"] != "crm_integrations" ||
		store.lastInput.Settings["sync_model"] != attentiveSyncModelSubscribersREST ||
		store.lastInput.Settings["verification_mode"] != "attentive_sms_subscribers_rest_phone_identity_route_token_hmac_webhooks_scheduled_retry_cleanup_pending_live_certification" ||
		store.lastInput.Settings["managed_by_postwave"] != true ||
		store.lastInput.Settings["attentive_webhook_route_token"] != "route_att_1" ||
		store.lastInput.Settings["credential_ref"] != nil ||
		store.lastInput.Settings["webhook_signature_ref"] != nil {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if !hasString(store.lastInput.Scopes, "subscribers.read") {
		t.Fatalf("scopes=%+v", store.lastInput.Scopes)
	}
}

func TestCreateZohoCRMIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations", `{
		"provider":"zoho-crm",
		"settings":{
			"organization_id":"zoho-org-1",
			"credentials_ref":"cred_zoho_1",
			"data_center":"us"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderZohoCRM || store.lastInput.CredentialsRef != "cred_zoho_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["organization_id"] != "zoho-org-1" ||
		store.lastInput.Settings["setup_surface"] != "crm_integrations" ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
}

func TestCreateDynamics365Integration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations", `{
		"provider":"microsoft-dynamics-365",
		"settings":{
			"environment_url":"https://org.crm.dynamics.com",
			"credentials_ref":"cred_dynamics_1",
			"tenant_id":"tenant-123"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderDynamics365 || store.lastInput.CredentialsRef != "cred_dynamics_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["environment_url"] != "https://org.crm.dynamics.com" ||
		store.lastInput.Settings["setup_surface"] != "crm_integrations" ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
}

func TestCreateIntegrationRequiresCredentialRefAndRejectsRawToken(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations", `{
		"provider":"hubspot",
		"settings":{"portal_id":"123","private_app_token":"secret"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("raw token status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations", `{
		"provider":"hubspot",
		"settings":{"portal_id":"123","credentials_ref":"sk_live_1234567890abcdef1234567890abcdef"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("raw-looking credential ref status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations", `{
		"provider":"hubspot",
		"settings":{"portal_id":"123","credentials_ref":"cred_hubspot_1"}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderHubSpot || store.lastInput.CredentialsRef != "cred_hubspot_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["private_app_token"] != nil ||
		store.lastInput.Settings["managed_by_postwave"] != true ||
		store.lastInput.Settings["hubspot_auth_mode"] != "private_app" ||
		store.lastInput.Settings["hubspot_webhook_mode"] != "polling_only" {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
}

func TestHubSpotOAuthCallbackStoresCanonicalAndLegacyPortalID(t *testing.T) {
	now := time.Date(2026, 6, 28, 11, 0, 0, 0, time.UTC)
	var tokenRequestSeen, tokenInfoSeen bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case hubSpotOAuthTokenPath:
			tokenRequestSeen = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "hs-access",
				"refresh_token": "hs-refresh",
				"expires_in":    3600,
				"scope":         "crm.objects.contacts.read oauth",
			})
		case hubSpotOAuthTokenInfoPath + "hs-access":
			tokenInfoSeen = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"hub_id":     12345678,
				"app_id":     777,
				"hub_domain": "example.hubspotpagebuilder.com",
				"scopes":     []string{"crm.objects.contacts.read", "oauth"},
			})
		default:
			t.Fatalf("unexpected HubSpot OAuth request %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	store := newFakeStore()
	store.hubSpotOAuthStates = map[string]HubSpotOAuthState{
		"state-1": {
			TenantID:        "tenant-1",
			IntegrationName: "HubSpot OAuth",
			RedirectURI:     "https://app.example/callback",
			Scopes:          []string{"crm.objects.contacts.read", "oauth"},
			Settings:        map[string]any{"list_id": "default-list"},
		},
	}
	deps := &Deps{
		Repo: store,
		HubSpotOAuth: HubSpotOAuthConfig{
			ClientID:     "cid",
			ClientSecret: "csecret",
			RedirectURL:  "https://app.example/callback",
			OAuthBaseURL: srv.URL,
			AppID:        "777",
		},
		HubSpotOAuthClient: HubSpotOAuthClient{HTTPClient: srv.Client(), OAuthBaseURL: srv.URL, Now: func() time.Time { return now }},
		Now:                func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/crm/hubspot/oauth/callback?state=state-1&code=the-code", nil)
	deps.HubSpotOAuthCallback(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !tokenRequestSeen || !tokenInfoSeen {
		t.Fatalf("expected token and token-info requests, token=%v info=%v", tokenRequestSeen, tokenInfoSeen)
	}
	if store.lastInput.Settings["portal_id"] != "12345678" || store.lastInput.Settings["hubspot_portal_id"] != "12345678" {
		t.Fatalf("settings should include canonical and legacy portal ids: %+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["hubspot_auth_mode"] != "managed_oauth" ||
		store.lastInput.Settings["hubspot_webhook_mode"] != "app_level_oauth_install" {
		t.Fatalf("OAuth settings should be webhook-capable: %+v", store.lastInput.Settings)
	}
	if store.lastInput.CredentialsRef == "" || !strings.HasPrefix(store.lastInput.CredentialsRef, hubSpotStoredCredentialPrefix) {
		t.Fatalf("credentials_ref = %q", store.lastInput.CredentialsRef)
	}
	if _, ok := store.hubSpotSecrets[store.lastInput.CredentialsRef]; !ok {
		t.Fatalf("stored credential secret missing for %q", store.lastInput.CredentialsRef)
	}
}

func TestHubSpotOAuthStartPreservesBackfillSettings(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo: store,
		HubSpotOAuth: HubSpotOAuthConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
			RedirectURL:  "https://app.postwave.test/api/v1/crm/hubspot/oauth/callback",
			AuthorizeURL: "https://app.hubspot.test/oauth/authorize",
		},
	}
	req := crmReq(http.MethodGet, "/api/v1/crm/hubspot/oauth/start?name=HubSpot+Deals&sync_list_memberships=true&membership_list_ids=456,789&membership_page_size=50&sync_deals=true&deal_page_size=40&deal_properties=dealtype&company_properties=industry", "")
	rec := httptest.NewRecorder()

	deps.HubSpotOAuthStart(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	state := store.hubSpotOAuthStates["hubspot-state"]
	if state.TenantID != "tenant-1" || state.IntegrationName != "HubSpot Deals" {
		t.Fatalf("state identity = %+v", state)
	}
	for key, want := range map[string]string{
		"sync_list_memberships": "true",
		"membership_list_ids":   "456,789",
		"membership_page_size":  "50",
		"sync_deals":            "true",
		"deal_page_size":        "40",
		"deal_properties":       "dealtype",
		"company_properties":    "industry",
	} {
		if got := settingString(state.Settings, key); got != want {
			t.Fatalf("state setting %s=%q want %q in %+v", key, got, want, state.Settings)
		}
	}
	for _, scope := range []string{"crm.objects.contacts.read", "crm.objects.deals.read", "crm.objects.companies.read", "crm.lists.read", "oauth"} {
		if !hasString(state.Scopes, scope) {
			t.Fatalf("state scopes missing %q: %+v", scope, state.Scopes)
		}
	}
	location := rec.Header().Get("Location")
	if !strings.Contains(location, "state=hubspot-state") || !strings.Contains(location, "crm.objects.deals.read") || !strings.Contains(location, "crm.objects.companies.read") {
		t.Fatalf("unexpected authorize redirect %q", location)
	}
}

func TestSyncIntegrationUpsertsContactsAndEvents(t *testing.T) {
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
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{
		"cursor":"after-123",
		"contacts":[{"source_id":"c1","email":"Buyer@Example.com","first_name":"Ada"}],
		"events":[{"email":"buyer@example.com","event_name":"hubspot_deal_stage_changed"}]
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "completed" || out.ContactsUpserted != 1 || out.EventsTracked != 1 || out.RunID == "" {
		t.Fatalf("summary=%+v", out)
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Email != "buyer@example.com" {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	if len(events.events) != 1 || events.events[0].EventName != "hubspot_deal_stage_changed" {
		t.Fatalf("events=%+v", events.events)
	}
}

func TestSyncIntegrationMaterializesMappedHubSpotListMembership(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings = map[string]any{
		"portal_id":             "123",
		"list_membership_map":   map[string]any{"456": "00000000-0000-0000-0000-000000000456"},
		"sync_list_memberships": true,
	}
	profiles := &fakeProfileSink{}
	lists := &fakeCRMListMembershipSink{}
	deps := &Deps{
		Repo:            store,
		Profiles:        profiles,
		ListMemberships: lists,
		Events:          &fakeEventSink{},
		Now:             func() time.Time { return time.Date(2026, 6, 29, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{
		"contacts":[{
			"source_id":"hubspot://contact/101",
			"email":"Member@Example.com",
			"list_ids":["456"],
			"properties":{"hubspot_proven_list_ids":["456"]}
		}]
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "completed" || out.ContactsUpserted != 1 || out.RowsFailed != 0 {
		t.Fatalf("summary=%+v", out)
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Email != "member@example.com" {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	if len(lists.added) != 1 {
		t.Fatalf("list memberships=%+v", lists.added)
	}
	got := lists.added[0]
	if got.TenantID != "tenant-1" || got.ListID != "00000000-0000-0000-0000-000000000456" || got.SubscriberID != "sub_1" || got.Email != "member@example.com" {
		t.Fatalf("list membership=%+v", got)
	}
	if len(lists.providerAdded) != 1 {
		t.Fatalf("provider owner evidence=%+v", lists.providerAdded)
	}
	owner := lists.providerAdded[0]
	if owner.IntegrationID != "crm_1" || owner.Provider != ProviderHubSpot || owner.ProviderSegmentType != "hubspot_list" || owner.ProviderListID != "456" || owner.NativeListID != "00000000-0000-0000-0000-000000000456" || owner.ProviderMemberID != "hubspot://contact/101" || owner.Email != "member@example.com" {
		t.Fatalf("provider owner evidence=%+v", owner)
	}
}

func TestSyncIntegrationDoesNotMaterializeDefaultHubSpotListID(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings = map[string]any{
		"portal_id":           "123",
		"list_id":             "456",
		"list_membership_map": map[string]string{"456": "00000000-0000-0000-0000-000000000456"},
	}
	lists := &fakeCRMListMembershipSink{}
	deps := &Deps{
		Repo:            store,
		Profiles:        &fakeProfileSink{},
		ListMemberships: lists,
		Events:          &fakeEventSink{},
		Now:             func() time.Time { return time.Date(2026, 6, 29, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{
		"contacts":[{"source_id":"hubspot://contact/101","email":"member@example.com","list_ids":["456"]}]
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(lists.added) != 0 {
		t.Fatalf("default list IDs should stay metadata-only, memberships=%+v", lists.added)
	}
}

func TestExecuteSyncCompletesMappedHubSpotListScanAfterSuccessfulPage(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings = map[string]any{
		"portal_id":           "123",
		"list_membership_map": map[string]any{"456": "00000000-0000-0000-0000-000000000456"},
	}
	lists := &fakeCRMListMembershipSink{}
	deps := &Deps{
		Repo:            store,
		Profiles:        &fakeProfileSink{},
		ListMemberships: lists,
		Events:          &fakeEventSink{},
		Now:             func() time.Time { return time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC) },
	}
	req := SyncRequest{
		Contacts: []ContactInput{{
			SourceID:   "hubspot://contact/101",
			Email:      "member@example.com",
			ListIDs:    []string{"456"},
			Properties: map[string]any{"hubspot_proven_list_ids": []string{"456"}},
		}},
		Cursor: hubSpotCursorComplete,
		nativeListMembershipScans: []CRMNativeListMembershipScan{{
			Provider:            ProviderHubSpot,
			ProviderSegmentType: "hubspot_list",
			ProviderListID:      "456",
			NativeListID:        "00000000-0000-0000-0000-000000000456",
			Start:               true,
			Complete:            true,
		}},
		nativeListMembershipManaged: true,
	}

	summary := deps.executeSync(context.Background(), "tenant-1", &store.integration, req)

	if summary.Status != "completed" || summary.RowsFailed != 0 || summary.ContactsUpserted != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if len(lists.scansBegun) != 1 || len(lists.scansCompleted) != 1 {
		t.Fatalf("scan begin/complete=%+v/%+v", lists.scansBegun, lists.scansCompleted)
	}
	if lists.scansBegun[0].IntegrationID != "crm_1" || !lists.scansBegun[0].Start || lists.scansBegun[0].ProviderListID != "456" {
		t.Fatalf("begin scan=%+v", lists.scansBegun[0])
	}
	if lists.scansCompleted[0].IntegrationID != "crm_1" || !lists.scansCompleted[0].Complete || lists.scansCompleted[0].NativeListID != "00000000-0000-0000-0000-000000000456" {
		t.Fatalf("complete scan=%+v", lists.scansCompleted[0])
	}
	if len(lists.providerAdded) != 1 || lists.providerAdded[0].ProviderSegmentType != "hubspot_list" || lists.providerAdded[0].ProviderListID != "456" {
		t.Fatalf("provider owner evidence=%+v", lists.providerAdded)
	}
}

func TestExecuteSyncTreatsStaleHubSpotContactAsIgnoredWithoutMembershipWrite(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderHubSpot
	store.integration.Settings = map[string]any{
		"list_membership_map": map[string]any{"456": "00000000-0000-0000-0000-000000000456"},
	}
	profiles := &fakeProfileSink{err: ErrCRMContactSourceRevisionStale}
	lists := &fakeCRMListMembershipSink{}
	deps := &Deps{
		Repo:            store,
		Profiles:        profiles,
		ListMemberships: lists,
		Events:          &fakeEventSink{},
	}

	summary := deps.executeSync(context.Background(), "tenant-1", &store.integration, SyncRequest{
		Contacts: []ContactInput{{
			SourceID:   "hubspot://contact/101",
			Email:      "stale@example.com",
			ListIDs:    []string{"456"},
			Properties: map[string]any{"hubspot_proven_list_ids": []string{"456"}},
		}},
	})

	if summary.Status != "completed" ||
		summary.RowsFailed != 0 ||
		summary.ContactsSeen != 1 ||
		summary.ContactsUpserted != 0 {
		t.Fatalf("summary=%+v", summary)
	}
	if len(lists.added) != 0 || len(lists.providerAdded) != 0 {
		t.Fatalf("stale contact wrote memberships: added=%+v provider=%+v", lists.added, lists.providerAdded)
	}
}

func TestSyncIntegrationMarksPartialWhenHubSpotListMembershipFails(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings = map[string]any{
		"portal_id":           "123",
		"list_membership_map": map[string]string{"456": "00000000-0000-0000-0000-000000000456"},
	}
	profiles := &fakeProfileSink{}
	lists := &fakeCRMListMembershipSink{err: errors.New("list write failed")}
	deps := &Deps{
		Repo:            store,
		Profiles:        profiles,
		ListMemberships: lists,
		Events:          &fakeEventSink{},
		Now:             func() time.Time { return time.Date(2026, 6, 29, 10, 0, 0, 0, time.UTC) },
	}

	summary := deps.executeSync(context.Background(), "tenant-1", &store.integration, SyncRequest{Contacts: []ContactInput{{
		SourceID:   "hubspot://contact/101",
		Email:      "member@example.com",
		ListIDs:    []string{"456"},
		Properties: map[string]any{"hubspot_proven_list_ids": []string{"456"}},
	}}})

	if summary.Status != "partial" || summary.ContactsUpserted != 1 || summary.RowsFailed != 1 || !strings.Contains(summary.ErrorMessage, "list write failed") {
		t.Fatalf("summary=%+v", summary)
	}
	if len(profiles.contacts) != 1 {
		t.Fatalf("profile should still be upserted, contacts=%+v", profiles.contacts)
	}
}

func TestSyncIntegrationMaterializesMappedSalesforceCampaignMember(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderSalesforce
	store.integration.Settings = map[string]any{
		"org_id":                  "00Dxx0000000001",
		"campaign_membership_map": map[string]any{"701xx000000001": "00000000-0000-0000-0000-000000070101"},
	}
	events := &fakeEventSink{}
	lists := &fakeCRMListMembershipSink{}
	deps := &Deps{
		Repo:            store,
		Profiles:        &fakeProfileSink{},
		Events:          events,
		ListMemberships: lists,
		Now:             func() time.Time { return time.Date(2026, 6, 29, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{
		"events":[{
			"source_id":"salesforce://campaign-member/00vxx000001",
			"email":"Buyer@Example.com",
			"event_name":"crm.campaign_member.updated",
			"properties":{"crm_provider_list_id":"701xx000000001"}
		}]
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "completed" || out.EventsTracked != 1 || out.RowsFailed != 0 {
		t.Fatalf("summary=%+v", out)
	}
	if len(events.events) != 1 || events.events[0].Email != "buyer@example.com" {
		t.Fatalf("events=%+v", events.events)
	}
	if len(lists.added) != 1 {
		t.Fatalf("list memberships=%+v", lists.added)
	}
	got := lists.added[0]
	if got.TenantID != "tenant-1" || got.ListID != "00000000-0000-0000-0000-000000070101" || got.SubscriberID != "" || got.Email != "buyer@example.com" {
		t.Fatalf("list membership=%+v", got)
	}
	if len(lists.providerAdded) != 1 {
		t.Fatalf("provider owner evidence=%+v", lists.providerAdded)
	}
	owner := lists.providerAdded[0]
	if owner.IntegrationID != "crm_1" || owner.Provider != ProviderSalesforce || owner.ProviderSegmentType != "salesforce_campaign" || owner.ProviderListID != "701xx000000001" || owner.NativeListID != "00000000-0000-0000-0000-000000070101" || owner.ProviderMemberID != "salesforce://campaign-member/00vxx000001" || owner.Email != "buyer@example.com" {
		t.Fatalf("provider owner evidence=%+v", owner)
	}
	if len(lists.removed) != 0 {
		t.Fatalf("unexpected list removals=%+v", lists.removed)
	}
}

func TestSyncIntegrationRemovesMappedSalesforceCampaignMember(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderSalesforce
	store.integration.Settings = map[string]any{
		"org_id":                  "00Dxx0000000001",
		"campaign_membership_map": map[string]any{"701xx000000001": "00000000-0000-0000-0000-000000070101"},
	}
	events := &fakeEventSink{}
	lists := &fakeCRMListMembershipSink{}
	deps := &Deps{
		Repo:            store,
		Profiles:        &fakeProfileSink{},
		Events:          events,
		ListMemberships: lists,
		Now:             func() time.Time { return time.Date(2026, 6, 29, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{
		"events":[{
			"source_id":"salesforce://campaign-member/00vxx000001",
			"email":"Buyer@Example.com",
			"event_name":"crm.campaign_member.removed",
			"properties":{
				"crm_provider_list_id":"701xx000000001",
				"salesforce_campaign_member_status":"Removed",
				"crm_provider_list_removed":true
			}
		}]
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "completed" || out.EventsTracked != 1 || out.RowsFailed != 0 {
		t.Fatalf("summary=%+v", out)
	}
	if len(events.events) != 1 || events.events[0].Email != "buyer@example.com" {
		t.Fatalf("events=%+v", events.events)
	}
	if len(lists.added) != 0 {
		t.Fatalf("unexpected list adds=%+v", lists.added)
	}
	if len(lists.removed) != 1 {
		t.Fatalf("list removals=%+v", lists.removed)
	}
	got := lists.removed[0]
	if got.TenantID != "tenant-1" || got.ListID != "00000000-0000-0000-0000-000000070101" || got.SubscriberID != "" || got.Email != "buyer@example.com" {
		t.Fatalf("list removal=%+v", got)
	}
	if len(lists.providerRemoved) != 1 {
		t.Fatalf("provider removal evidence=%+v", lists.providerRemoved)
	}
	owner := lists.providerRemoved[0]
	if owner.IntegrationID != "crm_1" || owner.Provider != ProviderSalesforce || owner.ProviderSegmentType != "salesforce_campaign" || owner.ProviderListID != "701xx000000001" || owner.NativeListID != "00000000-0000-0000-0000-000000070101" || owner.ProviderMemberID != "salesforce://campaign-member/00vxx000001" || owner.Email != "buyer@example.com" {
		t.Fatalf("provider removal evidence=%+v", owner)
	}
}

func TestSyncIntegrationDoesNotMaterializeSalesforceDefaultCampaignID(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderSalesforce
	store.integration.Settings = map[string]any{
		"org_id":                  "00Dxx0000000001",
		"campaign_id":             "701xx000000001",
		"campaign_membership_map": map[string]string{"701xx000000001": "00000000-0000-0000-0000-000000070101"},
	}
	lists := &fakeCRMListMembershipSink{}
	deps := &Deps{
		Repo:            store,
		Profiles:        &fakeProfileSink{},
		Events:          &fakeEventSink{},
		ListMemberships: lists,
		Now:             func() time.Time { return time.Date(2026, 6, 29, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{
		"events":[{
			"source_id":"salesforce://task/00Txx000001",
			"email":"buyer@example.com",
			"event_name":"crm.task.updated",
			"properties":{"crm_list_ids":["701xx000000001"]}
		}]
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(lists.added) != 0 {
		t.Fatalf("default campaign IDs should stay metadata-only, memberships=%+v", lists.added)
	}
}

func TestSyncIntegrationMarksPartialWhenSalesforceCampaignMembershipFails(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderSalesforce
	store.integration.Settings = map[string]any{
		"org_id":                  "00Dxx0000000001",
		"campaign_membership_map": map[string]string{"701xx000000001": "00000000-0000-0000-0000-000000070101"},
	}
	events := &fakeEventSink{}
	lists := &fakeCRMListMembershipSink{err: errors.New("campaign list write failed")}
	deps := &Deps{
		Repo:            store,
		Profiles:        &fakeProfileSink{},
		Events:          events,
		ListMemberships: lists,
		Now:             func() time.Time { return time.Date(2026, 6, 29, 10, 0, 0, 0, time.UTC) },
	}

	summary := deps.executeSync(context.Background(), "tenant-1", &store.integration, SyncRequest{Events: []EventInput{{
		SourceID:   "salesforce://campaign-member/00vxx000001",
		Email:      "buyer@example.com",
		EventName:  "crm.campaign_member.updated",
		Properties: map[string]any{"crm_provider_list_id": "701xx000000001"},
	}}})

	if summary.Status != "partial" || summary.EventsTracked != 1 || summary.RowsFailed != 1 || !strings.Contains(summary.ErrorMessage, "campaign list write failed") {
		t.Fatalf("summary=%+v", summary)
	}
	if len(events.events) != 1 {
		t.Fatalf("event should still be tracked, events=%+v", events.events)
	}
}

func TestSyncIntegrationMarksPartialWhenSalesforceCampaignRemovalFails(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderSalesforce
	store.integration.Settings = map[string]any{
		"org_id":                  "00Dxx0000000001",
		"campaign_membership_map": map[string]string{"701xx000000001": "00000000-0000-0000-0000-000000070101"},
	}
	events := &fakeEventSink{}
	lists := &fakeCRMListMembershipSink{removeErr: errors.New("campaign list remove failed")}
	deps := &Deps{
		Repo:            store,
		Profiles:        &fakeProfileSink{},
		Events:          events,
		ListMemberships: lists,
		Now:             func() time.Time { return time.Date(2026, 6, 29, 10, 0, 0, 0, time.UTC) },
	}

	summary := deps.executeSync(context.Background(), "tenant-1", &store.integration, SyncRequest{Events: []EventInput{{
		SourceID:  "salesforce://campaign-member/00vxx000001",
		Email:     "buyer@example.com",
		EventName: "crm.campaign_member.updated",
		Properties: map[string]any{
			"crm_provider_list_id":               "701xx000000001",
			"salesforce_campaign_member_status":  "Removed",
			"salesforce_campaign_member_removed": true,
		},
	}}})

	if summary.Status != "partial" || summary.EventsTracked != 1 || summary.RowsFailed != 1 || !strings.Contains(summary.ErrorMessage, "campaign list remove failed") {
		t.Fatalf("summary=%+v", summary)
	}
	if len(events.events) != 1 {
		t.Fatalf("event should still be tracked, events=%+v", events.events)
	}
	if len(lists.added) != 0 {
		t.Fatalf("unexpected list adds=%+v", lists.added)
	}
}

func TestSyncIntegrationRequiresCanonicalRows(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
		Events:   &fakeEventSink{},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{"cursor":"after-123"}`))

	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "payload_required") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("empty CRM sync should not record a provider-pull-like run: %+v", store.runs)
	}
}

func TestSyncIntegrationUsesHubSpotProviderPullForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.SyncCursor = encodeHubSpotCursor(hubSpotCursorState{Object: "contacts", After: "10"})
	profiles := &fakeProfileSink{}
	backfiller := &fakeCRMBackfiller{req: SyncRequest{
		Cursor:   hubSpotCursorComplete,
		Contacts: []ContactInput{{SourceID: "hubspot://contact/1", Email: "Buyer@Example.com", FirstName: "Ada"}},
	}}
	deps := &Deps{
		Repo:              store,
		Profiles:          profiles,
		Events:            &fakeEventSink{},
		HubSpotBackfiller: backfiller,
		Now:               func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotTenant != "tenant-1" || backfiller.gotProvider != ProviderHubSpot || backfiller.gotCursor != store.integration.SyncCursor {
		t.Fatalf("backfiller tenant/provider/cursor = %q/%q/%q", backfiller.gotTenant, backfiller.gotProvider, backfiller.gotCursor)
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Email != "buyer@example.com" {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "completed" || store.runs[0].CursorTo != hubSpotCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationRejectsDisconnectedProviderPullBeforeLocalWrite(t *testing.T) {
	store := newFakeStore()
	store.integration.SyncCursor = encodeHubSpotCursor(hubSpotCursorState{Object: "contacts", After: "10"})
	profiles := &fakeProfileSink{}
	backfiller := &fakeCRMBackfiller{
		req: SyncRequest{
			Cursor:   hubSpotCursorComplete,
			Contacts: []ContactInput{{SourceID: "hubspot://contact/1", Email: "Buyer@Example.com"}},
		},
		afterCall: func() {
			store.integration.Status = "disconnected"
		},
	}
	deps := &Deps{
		Repo:              store,
		Profiles:          profiles,
		Events:            &fakeEventSink{},
		HubSpotBackfiller: backfiller,
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.contacts) != 0 {
		t.Fatalf("disconnected provider pull should not write profiles: %+v", profiles.contacts)
	}
	if len(store.runs) != 0 {
		t.Fatalf("disconnected provider pull should not record runs: %+v", store.runs)
	}
}

func TestSyncIntegrationUsesSalesforceProviderPullForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderSalesforce
	store.integration.Name = "Salesforce 00D"
	store.integration.SyncCursor = encodeSalesforceCursor(salesforceCursorState{Object: "contacts", NextRecordsURL: "/services/data/v67.0/query/01g"})
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &fakeCRMBackfiller{req: SyncRequest{
		Cursor:   encodeSalesforceCursor(salesforceCursorState{Object: "leads"}),
		Contacts: []ContactInput{{SourceID: "salesforce://contact/003", Email: "Buyer@Example.com", FirstName: "Ada"}},
		Events:   []EventInput{{SourceID: "salesforce://campaign-member/00v", Email: "buyer@example.com", EventName: "crm.campaign_member.updated"}},
	}}
	deps := &Deps{
		Repo:                 store,
		Profiles:             profiles,
		Events:               events,
		SalesforceBackfiller: backfiller,
		Now:                  func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/backfill", `{}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotTenant != "tenant-1" || backfiller.gotProvider != ProviderSalesforce || backfiller.gotCursor != store.integration.SyncCursor {
		t.Fatalf("backfiller tenant/provider/cursor = %q/%q/%q", backfiller.gotTenant, backfiller.gotProvider, backfiller.gotCursor)
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Email != "buyer@example.com" {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	if len(events.events) != 1 || events.events[0].EventName != "crm.campaign_member.updated" {
		t.Fatalf("events=%+v", events.events)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].Status != "completed" || store.runs[0].EventsTracked != 1 {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationUsesPipedriveProviderPullForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.Name = "Pipedrive example"
	store.integration.SyncCursor = encodePipedriveCursor(pipedriveCursorState{Object: "persons", Cursor: "cursor-100"})
	profiles := &fakeProfileSink{}
	backfiller := &fakeCRMBackfiller{req: SyncRequest{
		Cursor:   encodePipedriveCursor(pipedriveCursorState{Object: "persons", Cursor: "cursor-200"}),
		Contacts: []ContactInput{{SourceID: "pipedrive://person/123", Email: "Buyer@Example.com", FirstName: "Ada"}},
	}}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		Events:              &fakeEventSink{},
		PipedriveBackfiller: backfiller,
		Now:                 func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotTenant != "tenant-1" || backfiller.gotProvider != ProviderPipedrive || backfiller.gotCursor != store.integration.SyncCursor {
		t.Fatalf("backfiller tenant/provider/cursor = %q/%q/%q", backfiller.gotTenant, backfiller.gotProvider, backfiller.gotCursor)
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Email != "buyer@example.com" {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "completed" || !strings.HasPrefix(store.runs[0].CursorTo, pipedriveCursorPrefix) {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationSkipsPipedriveRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	baseCursor := encodePipedriveCursor(pipedriveCursorState{Object: "deals", Cursor: "deal-cursor-100"})
	retryCursor := encodePipedriveRetryCursor(pipedriveRetryState{
		Cursor:        baseCursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.Name = "Pipedrive example"
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeCRMBackfiller{}
	deps := &Deps{
		Repo:                store,
		Profiles:            &fakeProfileSink{},
		Events:              &fakeEventSink{},
		PipedriveBackfiller: backfiller,
		Now:                 func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotCursor != "" {
		t.Fatalf("backfiller should not be called before retry is due, cursor=%q", backfiller.gotCursor)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != retryCursor {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationResumesPipedriveRetryCursorWhenDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	baseCursor := encodePipedriveCursor(pipedriveCursorState{Object: "deals", Cursor: "deal-cursor-100"})
	retryCursor := encodePipedriveRetryCursor(pipedriveRetryState{
		Cursor:        baseCursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.Name = "Pipedrive example"
	store.integration.SyncCursor = retryCursor
	profiles := &fakeProfileSink{}
	backfiller := &fakeCRMBackfiller{req: SyncRequest{
		Cursor:   encodePipedriveCursor(pipedriveCursorState{Object: "organizations", Cursor: "org-cursor-1"}),
		Contacts: []ContactInput{{SourceID: "pipedrive://person/123", Email: "Buyer@Example.com", FirstName: "Ada"}},
	}}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		Events:              &fakeEventSink{},
		PipedriveBackfiller: backfiller,
		Now:                 func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotCursor != baseCursor || len(profiles.contacts) != 1 {
		t.Fatalf("backfiller cursor=%q contacts=%+v", backfiller.gotCursor, profiles.contacts)
	}
	if len(store.runs) != 1 || !strings.HasPrefix(store.runs[0].CursorTo, pipedriveCursorPrefix) {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationStoresPipedriveRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	baseCursor := encodePipedriveCursor(pipedriveCursorState{Object: "deals", Cursor: "deal-cursor-100"})
	providerErr := PipedriveRESTError{Path: "/api/v2/deals", StatusCode: http.StatusTooManyRequests, RetryAfter: 45 * time.Second, Snippet: "slow down"}
	store := newFakeStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.Name = "Pipedrive example"
	store.integration.SyncCursor = baseCursor
	backfiller := &fakeCRMBackfiller{err: providerErr}
	deps := &Deps{
		Repo:                store,
		Profiles:            &fakeProfileSink{},
		Events:              &fakeEventSink{},
		PipedriveBackfiller: backfiller,
		Now:                 func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotCursor != baseCursor {
		t.Fatalf("backfiller cursor=%q", backfiller.gotCursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodePipedriveRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.runs[0].CursorTo, ok, err)
	}
	if retry.Cursor != baseCursor || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(45*time.Second).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationStoresCloseRetryCursorOnBackfillFailureRequestCursor(t *testing.T) {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	baseCursor := closeCursorPrefix + "100"
	providerErr := CRMStaticRESTError{Path: "/api/v1/contact/", StatusCode: http.StatusTooManyRequests, RetryAfter: 45 * time.Second, Snippet: "slow down"}
	store := newFakeStore()
	store.integration.Provider = ProviderClose
	store.integration.Name = "Close example"
	store.integration.SyncCursor = baseCursor
	backfiller := &fakeCRMBackfiller{err: providerErr}
	deps := &Deps{
		Repo:            store,
		Profiles:        &fakeProfileSink{},
		Events:          &fakeEventSink{},
		CloseBackfiller: backfiller,
		Now:             func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotCursor != baseCursor {
		t.Fatalf("backfiller cursor=%q", backfiller.gotCursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if !strings.HasPrefix(store.lastRecordedRequestCursor, "close_retry:") {
		t.Fatalf("recorded request cursor=%q", store.lastRecordedRequestCursor)
	}
	retry, ok, err := decodeCRMStaticRetryCursor(ProviderClose, store.lastRecordedRequestCursor)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.lastRecordedRequestCursor, ok, err)
	}
	if retry.Cursor != baseCursor || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(45*time.Second).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationSkipsHighLevelRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeHighLevelCursor(highLevelCursorState{Object: "contacts", StartAfterID: "100"})
	retryCursor := encodeHighLevelRetryCursor(highLevelRetryState{
		Cursor:        baseCursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.Provider = ProviderHighLevel
	store.integration.Name = "HighLevel location"
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeCRMBackfiller{}
	deps := &Deps{
		Repo:                store,
		Profiles:            &fakeProfileSink{},
		Events:              &fakeEventSink{},
		HighLevelBackfiller: backfiller,
		Now:                 func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotCursor != "" {
		t.Fatalf("backfiller should not be called before retry is due, cursor=%q", backfiller.gotCursor)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != retryCursor {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationResumesHighLevelRetryCursorWhenDue(t *testing.T) {
	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeHighLevelCursor(highLevelCursorState{Object: "contacts", StartAfterID: "100"})
	retryCursor := encodeHighLevelRetryCursor(highLevelRetryState{
		Cursor:        baseCursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.Provider = ProviderHighLevel
	store.integration.Name = "HighLevel location"
	store.integration.SyncCursor = retryCursor
	profiles := &fakeProfileSink{}
	nextCursor := encodeHighLevelCursor(highLevelCursorState{Object: "contacts", StartAfterID: "200"})
	backfiller := &fakeCRMBackfiller{req: SyncRequest{
		Cursor:   nextCursor,
		Contacts: []ContactInput{{SourceID: "highlevel://contact/123", Email: "Buyer@Example.com", FirstName: "Ada"}},
	}}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		Events:              &fakeEventSink{},
		HighLevelBackfiller: backfiller,
		Now:                 func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotCursor != baseCursor || len(profiles.contacts) != 1 {
		t.Fatalf("backfiller cursor=%q contacts=%+v", backfiller.gotCursor, profiles.contacts)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != nextCursor {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationStoresHighLevelRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeHighLevelCursor(highLevelCursorState{Object: "contacts", StartAfterID: "100"})
	providerErr := HighLevelRESTError{Path: "/contacts/", StatusCode: http.StatusTooManyRequests, RetryAfter: 45 * time.Second, Snippet: "slow down"}
	store := newFakeStore()
	store.integration.Provider = ProviderHighLevel
	store.integration.Name = "HighLevel location"
	store.integration.SyncCursor = baseCursor
	backfiller := &fakeCRMBackfiller{err: providerErr}
	deps := &Deps{
		Repo:                store,
		Profiles:            &fakeProfileSink{},
		Events:              &fakeEventSink{},
		HighLevelBackfiller: backfiller,
		Now:                 func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotCursor != baseCursor {
		t.Fatalf("backfiller cursor=%q", backfiller.gotCursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeHighLevelRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.runs[0].CursorTo, ok, err)
	}
	if retry.Cursor != baseCursor || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(45*time.Second).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationStoresHighLevelRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeHighLevelCursor(highLevelCursorState{Object: "contacts", StartAfterID: "100"})
	store := newFakeStore()
	store.integration.Provider = ProviderHighLevel
	store.integration.Name = "HighLevel location"
	store.integration.SyncCursor = baseCursor
	backfiller := &fakeCRMBackfiller{req: SyncRequest{
		Cursor:   encodeHighLevelCursor(highLevelCursorState{Object: "contacts", StartAfterID: "200"}),
		Contacts: []ContactInput{{SourceID: "highlevel://contact/123", Email: "Buyer@Example.com", FirstName: "Ada"}},
	}}
	deps := &Deps{
		Repo:                store,
		Profiles:            &fakeProfileSink{err: errors.New("profile sink down")},
		Events:              &fakeEventSink{},
		HighLevelBackfiller: backfiller,
		Now:                 func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeHighLevelRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.runs[0].CursorTo, ok, err)
	}
	if retry.Cursor != baseCursor || retry.Attempts != 1 || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(15*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationStoresPipedriveRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	baseCursor := encodePipedriveCursor(pipedriveCursorState{Object: "persons", Cursor: "cursor-100"})
	store := newFakeStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.Name = "Pipedrive example"
	store.integration.SyncCursor = baseCursor
	backfiller := &fakeCRMBackfiller{req: SyncRequest{
		Cursor:   encodePipedriveCursor(pipedriveCursorState{Object: "persons", Cursor: "cursor-200"}),
		Contacts: []ContactInput{{SourceID: "pipedrive://person/123", Email: "Buyer@Example.com", FirstName: "Ada"}},
	}}
	deps := &Deps{
		Repo:                store,
		Profiles:            &fakeProfileSink{err: errors.New("profile sink down")},
		Events:              &fakeEventSink{},
		PipedriveBackfiller: backfiller,
		Now:                 func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodePipedriveRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.runs[0].CursorTo, ok, err)
	}
	if retry.Cursor != baseCursor || retry.Attempts != 1 || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(15*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationSkipsHubSpotRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeHubSpotCursor(hubSpotCursorState{Object: "deals", After: "deal-cursor-100"})
	retryCursor := encodeHubSpotRetryCursor(hubSpotRetryState{
		Cursor:        baseCursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeCRMBackfiller{}
	deps := &Deps{
		Repo:              store,
		Profiles:          &fakeProfileSink{},
		Events:            &fakeEventSink{},
		HubSpotBackfiller: backfiller,
		Now:               func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotCursor != "" {
		t.Fatalf("backfiller should not be called before retry is due, cursor=%q", backfiller.gotCursor)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != retryCursor {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationResumesHubSpotRetryCursorWhenDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeHubSpotCursor(hubSpotCursorState{Object: "deals", After: "deal-cursor-100"})
	retryCursor := encodeHubSpotRetryCursor(hubSpotRetryState{
		Cursor:        baseCursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	profiles := &fakeProfileSink{}
	backfiller := &fakeCRMBackfiller{req: SyncRequest{
		Cursor:   encodeHubSpotCursor(hubSpotCursorState{Object: "contacts", After: "contact-cursor-1"}),
		Contacts: []ContactInput{{SourceID: "hubspot://contact/123", Email: "Buyer@Example.com", FirstName: "Ada"}},
	}}
	deps := &Deps{
		Repo:              store,
		Profiles:          profiles,
		Events:            &fakeEventSink{},
		HubSpotBackfiller: backfiller,
		Now:               func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotCursor != baseCursor || len(profiles.contacts) != 1 {
		t.Fatalf("backfiller cursor=%q contacts=%+v", backfiller.gotCursor, profiles.contacts)
	}
	if len(store.runs) != 1 || !strings.HasPrefix(store.runs[0].CursorTo, hubSpotCursorPrefix) {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationStoresHubSpotRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeHubSpotCursor(hubSpotCursorState{Object: "deals", After: "deal-cursor-100"})
	providerErr := HubSpotRateLimitError{Path: "/crm/v3/objects/deals", StatusCode: http.StatusTooManyRequests, RetryAfter: 45 * time.Second, Snippet: "slow down"}
	store := newFakeStore()
	store.integration.SyncCursor = baseCursor
	backfiller := &fakeCRMBackfiller{err: providerErr}
	deps := &Deps{
		Repo:              store,
		Profiles:          &fakeProfileSink{},
		Events:            &fakeEventSink{},
		HubSpotBackfiller: backfiller,
		Now:               func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotCursor != baseCursor {
		t.Fatalf("backfiller cursor=%q", backfiller.gotCursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeHubSpotRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.runs[0].CursorTo, ok, err)
	}
	if retry.Cursor != baseCursor || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(45*time.Second).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationSkipsSalesforceRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeSalesforceCursor(salesforceCursorState{Object: "tasks", NextRecordsURL: "/services/data/v67.0/query/01g"})
	retryCursor := encodeSalesforceRetryCursor(salesforceRetryState{
		Cursor:        baseCursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.Provider = ProviderSalesforce
	store.integration.Name = "Salesforce 00D"
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeCRMBackfiller{}
	deps := &Deps{
		Repo:                 store,
		Profiles:             &fakeProfileSink{},
		Events:               &fakeEventSink{},
		SalesforceBackfiller: backfiller,
		Now:                  func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotCursor != "" {
		t.Fatalf("backfiller should not be called before retry is due, cursor=%q", backfiller.gotCursor)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != retryCursor {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationResumesSalesforceRetryCursorWhenDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeSalesforceCursor(salesforceCursorState{Object: "tasks", NextRecordsURL: "/services/data/v67.0/query/01g"})
	retryCursor := encodeSalesforceRetryCursor(salesforceRetryState{
		Cursor:        baseCursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.Provider = ProviderSalesforce
	store.integration.Name = "Salesforce 00D"
	store.integration.SyncCursor = retryCursor
	profiles := &fakeProfileSink{}
	backfiller := &fakeCRMBackfiller{req: SyncRequest{
		Cursor:   encodeSalesforceCursor(salesforceCursorState{Object: "campaign_members"}),
		Contacts: []ContactInput{{SourceID: "salesforce://contact/003", Email: "Buyer@Example.com", FirstName: "Ada"}},
	}}
	deps := &Deps{
		Repo:                 store,
		Profiles:             profiles,
		Events:               &fakeEventSink{},
		SalesforceBackfiller: backfiller,
		Now:                  func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotCursor != baseCursor || len(profiles.contacts) != 1 {
		t.Fatalf("backfiller cursor=%q contacts=%+v", backfiller.gotCursor, profiles.contacts)
	}
	if len(store.runs) != 1 || !strings.HasPrefix(store.runs[0].CursorTo, salesforceCursorPrefix) {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationStoresSalesforceRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeSalesforceCursor(salesforceCursorState{Object: "tasks", NextRecordsURL: "/services/data/v67.0/query/01g"})
	providerErr := SalesforceRESTError{Path: "/services/data/v67.0/query", StatusCode: http.StatusTooManyRequests, RetryAfter: 45 * time.Second, Snippet: "slow down"}
	store := newFakeStore()
	store.integration.Provider = ProviderSalesforce
	store.integration.Name = "Salesforce 00D"
	store.integration.SyncCursor = baseCursor
	backfiller := &fakeCRMBackfiller{err: providerErr}
	deps := &Deps{
		Repo:                 store,
		Profiles:             &fakeProfileSink{},
		Events:               &fakeEventSink{},
		SalesforceBackfiller: backfiller,
		Now:                  func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotCursor != baseCursor {
		t.Fatalf("backfiller cursor=%q", backfiller.gotCursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeSalesforceRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.runs[0].CursorTo, ok, err)
	}
	if retry.Cursor != baseCursor || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(45*time.Second).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationSkipsRESTCRMRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	for _, provider := range []string{ProviderZohoCRM, ProviderDynamics365, ProviderKeap} {
		t.Run(provider, func(t *testing.T) {
			baseCursor := crmRESTTestBaseCursor(t, provider)
			retryCursor := crmRESTTestRetryCursor(t, provider, baseCursor, "BACKFILL_FAILED", now.Add(time.Hour))
			store := newFakeStore()
			store.integration.Provider = provider
			store.integration.Name = provider + " example"
			store.integration.SyncCursor = retryCursor
			backfiller := &fakeCRMBackfiller{}
			deps := &Deps{
				Repo:     store,
				Profiles: &fakeProfileSink{},
				Events:   &fakeEventSink{},
				Now:      func() time.Time { return now },
			}
			setCRMRESTBackfiller(t, deps, provider, backfiller)

			rec := httptest.NewRecorder()
			deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

			if rec.Code != http.StatusAccepted {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if backfiller.gotCursor != "" {
				t.Fatalf("backfiller should not be called before retry is due, cursor=%q", backfiller.gotCursor)
			}
			if len(store.runs) != 1 || store.runs[0].CursorTo != retryCursor {
				t.Fatalf("runs=%+v", store.runs)
			}
		})
	}
}

func TestSyncIntegrationResumesRESTCRMRetryCursorWhenDue(t *testing.T) {
	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	for _, provider := range []string{ProviderZohoCRM, ProviderDynamics365, ProviderKeap} {
		t.Run(provider, func(t *testing.T) {
			baseCursor := crmRESTTestBaseCursor(t, provider)
			retryCursor := crmRESTTestRetryCursor(t, provider, baseCursor, "BACKFILL_FAILED", now.Add(-time.Minute))
			store := newFakeStore()
			store.integration.Provider = provider
			store.integration.Name = provider + " example"
			store.integration.SyncCursor = retryCursor
			profiles := &fakeProfileSink{}
			backfiller := &fakeCRMBackfiller{req: SyncRequest{
				Cursor:   crmRESTTestNextCursor(t, provider),
				Contacts: []ContactInput{{SourceID: crmRESTTestSourceID(t, provider), Email: "Buyer@Example.com", FirstName: "Ada"}},
			}}
			deps := &Deps{
				Repo:     store,
				Profiles: profiles,
				Events:   &fakeEventSink{},
				Now:      func() time.Time { return now },
			}
			setCRMRESTBackfiller(t, deps, provider, backfiller)

			rec := httptest.NewRecorder()
			deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

			if rec.Code != http.StatusAccepted {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if backfiller.gotCursor != baseCursor || len(profiles.contacts) != 1 {
				t.Fatalf("backfiller cursor=%q contacts=%+v", backfiller.gotCursor, profiles.contacts)
			}
			if len(store.runs) != 1 || store.runs[0].CursorTo != crmRESTTestNextCursor(t, provider) {
				t.Fatalf("runs=%+v", store.runs)
			}
		})
	}
}

func TestSyncIntegrationStoresRESTCRMRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	for _, provider := range []string{ProviderZohoCRM, ProviderDynamics365, ProviderKeap} {
		t.Run(provider, func(t *testing.T) {
			baseCursor := crmRESTTestBaseCursor(t, provider)
			store := newFakeStore()
			store.integration.Provider = provider
			store.integration.Name = provider + " example"
			store.integration.SyncCursor = baseCursor
			backfiller := &fakeCRMBackfiller{err: crmRESTTestProviderError(t, provider, 45*time.Second)}
			deps := &Deps{
				Repo:     store,
				Profiles: &fakeProfileSink{},
				Events:   &fakeEventSink{},
				Now:      func() time.Time { return now },
			}
			setCRMRESTBackfiller(t, deps, provider, backfiller)

			rec := httptest.NewRecorder()
			deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

			if rec.Code != http.StatusBadGateway {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if backfiller.gotCursor != baseCursor {
				t.Fatalf("backfiller cursor=%q", backfiller.gotCursor)
			}
			if len(store.runs) != 1 || store.runs[0].Status != "failed" {
				t.Fatalf("runs=%+v", store.runs)
			}
			assertCRMRESTRetryCursor(t, provider, store.runs[0].CursorTo, baseCursor, "BACKFILL_FAILED", now.Add(45*time.Second).Format(time.RFC3339))
		})
	}
}

func TestSyncIntegrationStoresRESTCRMRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	for _, provider := range []string{ProviderZohoCRM, ProviderDynamics365, ProviderKeap} {
		t.Run(provider, func(t *testing.T) {
			baseCursor := crmRESTTestBaseCursor(t, provider)
			store := newFakeStore()
			store.integration.Provider = provider
			store.integration.Name = provider + " example"
			store.integration.SyncCursor = baseCursor
			backfiller := &fakeCRMBackfiller{req: SyncRequest{
				Cursor:   crmRESTTestNextCursor(t, provider),
				Contacts: []ContactInput{{SourceID: crmRESTTestSourceID(t, provider), Email: "Buyer@Example.com", FirstName: "Ada"}},
			}}
			deps := &Deps{
				Repo:     store,
				Profiles: &fakeProfileSink{err: errors.New("profile sink down")},
				Events:   &fakeEventSink{},
				Now:      func() time.Time { return now },
			}
			setCRMRESTBackfiller(t, deps, provider, backfiller)

			rec := httptest.NewRecorder()
			deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{}`))

			if rec.Code != http.StatusAccepted {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if len(store.runs) != 1 || store.runs[0].Status != "failed" {
				t.Fatalf("runs=%+v", store.runs)
			}
			assertCRMRESTRetryCursor(t, provider, store.runs[0].CursorTo, baseCursor, "SYNC_FAILED", now.Add(15*time.Minute).Format(time.RFC3339))
		})
	}
}

func TestPipedriveWebhookTracksDealEvent(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.TenantID = "tenant-1"
	store.integration.Settings = map[string]any{"pipedrive_webhook_id": "wh-1"}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:   store,
		Events: events,
		PipedriveCredentials: fakePipedriveCredentialResolver{creds: PipedriveCredentials{
			AccessToken:     "oauth-token",
			WebhookUsername: "postwave",
			WebhookPassword: "secret",
		}},
		Now: func() time.Time { return time.Date(2026, 6, 18, 10, 0, 0, 0, time.UTC) },
	}
	body := `{
		"event":"change.deal",
		"current":{
			"id":444,
			"title":"Enterprise expansion",
			"status":"won",
			"person_id":{"primary_email":"Buyer@Example.com"},
			"update_time":"2026-06-18 10:11:12"
		},
		"meta":{"action":"change","object":"deal","webhook_id":"wh-1"}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/pipedrive/webhooks", strings.NewReader(body))
	req.SetBasicAuth("postwave", "secret")
	rec := httptest.NewRecorder()

	deps.PipedriveWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(events.events) != 1 {
		t.Fatalf("events=%+v", events.events)
	}
	event := events.events[0]
	if event.SourceID != "pipedrive://deal/444" || event.Email != "buyer@example.com" || event.EventName != "crm.deal.won" {
		t.Fatalf("event=%+v", event)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || !store.webhookProcessed || store.webhookFailed {
		t.Fatalf("runs=%+v processed=%v failed=%v", store.runs, store.webhookProcessed, store.webhookFailed)
	}
}

func TestPipedriveWebhookMapsPersonOrganizationAndActivity(t *testing.T) {
	cases := []struct {
		name        string
		body        string
		wantTopic   string
		wantProfile *ContactInput
		wantEvent   *EventInput
	}{
		{
			name: "person",
			body: `{
				"event":"change.person",
				"current":{
					"id":123,
					"name":"Ada Lovelace",
					"first_name":"Ada",
					"last_name":"Lovelace",
					"primary_email":"Ada@Example.com",
					"phone":[{"value":"+15551234567","primary":true}],
					"org_id":{"name":"Analytical Engines"},
					"update_time":"2026-06-18 10:11:12"
				},
				"meta":{"action":"change","object":"person","webhook_id":"wh-1"}
			}`,
			wantTopic: "change.person",
			wantProfile: &ContactInput{
				SourceID: "pipedrive://person/123",
				Email:    "ada@example.com",
				Company:  "Analytical Engines",
			},
		},
		{
			name: "organization",
			body: `{
				"event":"change.organization",
				"current":{
					"id":55,
					"name":"Analytical Engines",
					"primary_email":"Ops@Example.com",
					"people_count":3,
					"update_time":"2026-06-18 10:11:12"
				},
				"meta":{"action":"change","object":"organization","webhook_id":"wh-1"}
			}`,
			wantTopic: "change.organization",
			wantProfile: &ContactInput{
				SourceID: "pipedrive://organization/55/contact/ops@example.com",
				Email:    "ops@example.com",
				Company:  "Analytical Engines",
			},
		},
		{
			name: "activity",
			body: `{
				"event":"change.activity",
				"current":{
					"id":777,
					"subject":"Decision call",
					"type":"call",
					"done":true,
					"primary_email":"Buyer@Example.com",
					"org_id":{"name":"Analytical Engines"},
					"due_date":"2026-06-18",
					"due_time":"10:15",
					"update_time":"2026-06-18 10:11:12"
				},
				"meta":{"action":"change","object":"activity","webhook_id":"wh-1"}
			}`,
			wantTopic: "change.activity",
			wantEvent: &EventInput{
				SourceID:  "pipedrive://activity/777",
				Email:     "buyer@example.com",
				EventName: "crm.activity.completed",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeStore()
			store.integration.Provider = ProviderPipedrive
			store.integration.TenantID = "tenant-1"
			store.integration.Settings = map[string]any{"pipedrive_webhook_id": "wh-1"}
			profiles := &fakeProfileSink{}
			events := &fakeEventSink{}
			deps := &Deps{
				Repo:     store,
				Profiles: profiles,
				Events:   events,
				PipedriveCredentials: fakePipedriveCredentialResolver{creds: PipedriveCredentials{
					AccessToken:     "oauth-token",
					WebhookUsername: "postwave",
					WebhookPassword: "secret",
				}},
				Now: func() time.Time { return time.Date(2026, 6, 18, 10, 0, 0, 0, time.UTC) },
			}
			req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/pipedrive/webhooks", strings.NewReader(tc.body))
			req.SetBasicAuth("postwave", "secret")
			rec := httptest.NewRecorder()

			deps.PipedriveWebhook(rec, req)

			if rec.Code != http.StatusAccepted {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if tc.wantProfile != nil {
				if len(profiles.contacts) != 1 {
					t.Fatalf("contacts=%+v", profiles.contacts)
				}
				got := profiles.contacts[0]
				if got.SourceID != tc.wantProfile.SourceID || got.Email != tc.wantProfile.Email || got.Company != tc.wantProfile.Company {
					t.Fatalf("contact=%+v", got)
				}
				if len(events.events) != 0 {
					t.Fatalf("events=%+v", events.events)
				}
			}
			if tc.wantEvent != nil {
				if len(events.events) != 1 {
					t.Fatalf("events=%+v", events.events)
				}
				got := events.events[0]
				if got.SourceID != tc.wantEvent.SourceID || got.Email != tc.wantEvent.Email || got.EventName != tc.wantEvent.EventName {
					t.Fatalf("event=%+v", got)
				}
				if len(profiles.contacts) != 0 {
					t.Fatalf("contacts=%+v", profiles.contacts)
				}
			}
			if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || !store.webhookProcessed || store.webhookFailed {
				t.Fatalf("runs=%+v processed=%v failed=%v", store.runs, store.webhookProcessed, store.webhookFailed)
			}
			if store.webhookClaimCount != 1 || store.lastWebhookTenantID != "tenant-1" || store.lastWebhookIntegrationID != "crm_1" || store.lastWebhookProvider != ProviderPipedrive {
				t.Fatalf("claim count/tenant/integration/provider = %d/%q/%q/%q", store.webhookClaimCount, store.lastWebhookTenantID, store.lastWebhookIntegrationID, store.lastWebhookProvider)
			}
			if !strings.HasPrefix(store.lastWebhookID, "pipedrive:wh-1:") || store.lastWebhookTopic != tc.wantTopic || string(store.lastWebhookBody) != tc.body {
				t.Fatalf("claim id/topic/body = %q/%q/%q", store.lastWebhookID, store.lastWebhookTopic, string(store.lastWebhookBody))
			}
		})
	}
}

func TestPipedriveWebhookRejectsInvalidBasicAuthBeforeClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.TenantID = "tenant-1"
	store.integration.Settings = map[string]any{"pipedrive_webhook_id": "wh-1"}
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
		Events:   &fakeEventSink{},
		PipedriveCredentials: fakePipedriveCredentialResolver{creds: PipedriveCredentials{
			AccessToken:     "oauth-token",
			WebhookUsername: "postwave",
			WebhookPassword: "secret",
		}},
		Now: func() time.Time { return time.Date(2026, 6, 18, 10, 0, 0, 0, time.UTC) },
	}
	body := `{
		"event":"change.person",
		"current":{"id":123,"primary_email":"Ada@Example.com"},
		"meta":{"action":"change","object":"person","webhook_id":"wh-1"}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/pipedrive/webhooks", strings.NewReader(body))
	req.SetBasicAuth("postwave", "wrong-secret")
	rec := httptest.NewRecorder()

	deps.PipedriveWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.webhookClaimCount != 0 || len(store.runs) != 0 || store.webhookProcessed || store.webhookFailed {
		t.Fatalf("claim=%d runs=%+v processed=%v failed=%v", store.webhookClaimCount, store.runs, store.webhookProcessed, store.webhookFailed)
	}
}

func TestPipedriveWebhookRejectsRouteIdentityMismatchBeforeClaim(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.TenantID = "tenant-1"
	store.integration.Settings = map[string]any{
		"pipedrive_webhook_id":     "wh-1",
		"pipedrive_company_id":     "42",
		"pipedrive_user_id":        "777",
		"pipedrive_company_domain": "example",
	}
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
		Events:   &fakeEventSink{},
		PipedriveCredentials: fakePipedriveCredentialResolver{creds: PipedriveCredentials{
			AccessToken:     "oauth-token",
			WebhookUsername: "postwave",
			WebhookPassword: "secret",
		}},
		Now: func() time.Time { return time.Date(2026, 6, 18, 10, 0, 0, 0, time.UTC) },
	}
	body := `{
		"event":"change.person",
		"current":{"id":123,"primary_email":"Ada@Example.com"},
		"meta":{"action":"change","object":"person","webhook_id":"wh-1","company_id":99,"user_id":777,"host":"example.pipedrive.com"}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/pipedrive/webhooks", strings.NewReader(body))
	req.SetBasicAuth("postwave", "secret")
	rec := httptest.NewRecorder()

	deps.PipedriveWebhook(rec, req)

	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "integration_not_found") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.webhookClaimCount != 0 || len(store.runs) != 0 || store.webhookProcessed || store.webhookFailed {
		t.Fatalf("claim=%d runs=%+v processed=%v failed=%v", store.webhookClaimCount, store.runs, store.webhookProcessed, store.webhookFailed)
	}
}

func TestPipedriveWebhookMarksClaimFailedOnSyncFailure(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.TenantID = "tenant-1"
	store.integration.Settings = map[string]any{"pipedrive_webhook_id": "wh-1"}
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{err: errors.New("profile sink down")},
		Events:   &fakeEventSink{},
		PipedriveCredentials: fakePipedriveCredentialResolver{creds: PipedriveCredentials{
			AccessToken:     "oauth-token",
			WebhookUsername: "postwave",
			WebhookPassword: "secret",
		}},
		Now: func() time.Time { return time.Date(2026, 6, 18, 10, 0, 0, 0, time.UTC) },
	}
	body := `{
		"event":"change.person",
		"current":{"id":123,"primary_email":"Ada@Example.com"},
		"meta":{"action":"change","object":"person","webhook_id":"wh-1"}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/pipedrive/webhooks", strings.NewReader(body))
	req.SetBasicAuth("postwave", "secret")
	rec := httptest.NewRecorder()

	deps.PipedriveWebhook(rec, req)

	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "internal_error") || strings.Contains(rec.Body.String(), "webhook_sync_failed") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" || !store.webhookFailed || store.webhookProcessed {
		t.Fatalf("runs=%+v processed=%v failed=%v", store.runs, store.webhookProcessed, store.webhookFailed)
	}
}

func TestSyncIntegrationUsesZohoProviderPullForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderZohoCRM
	store.integration.Name = "Zoho CRM org"
	store.integration.SyncCursor = encodeZohoCursor(zohoCursorState{Object: "contacts", Page: 2})
	profiles := &fakeProfileSink{}
	backfiller := &fakeCRMBackfiller{req: SyncRequest{
		Cursor:   encodeZohoCursor(zohoCursorState{Object: "leads", Page: 1}),
		Contacts: []ContactInput{{SourceID: "zoho://contact/554023000000310003", Email: "Buyer@Example.com", FirstName: "Ada"}},
	}}
	deps := &Deps{
		Repo:           store,
		Profiles:       profiles,
		Events:         &fakeEventSink{},
		ZohoBackfiller: backfiller,
		Now:            func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/backfill", `{}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotTenant != "tenant-1" || backfiller.gotProvider != ProviderZohoCRM || backfiller.gotCursor != store.integration.SyncCursor {
		t.Fatalf("backfiller tenant/provider/cursor = %q/%q/%q", backfiller.gotTenant, backfiller.gotProvider, backfiller.gotCursor)
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Email != "buyer@example.com" {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].Status != "completed" || !strings.HasPrefix(store.runs[0].CursorTo, zohoCursorPrefix) {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationUsesDynamics365ProviderPullForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderDynamics365
	store.integration.Name = "Dynamics 365 org"
	store.integration.SyncCursor = encodeDynamics365Cursor(dynamics365CursorState{Object: "contacts", NextLink: "https://org.crm.dynamics.com/api/data/v9.2/contacts?$skiptoken=10"})
	profiles := &fakeProfileSink{}
	backfiller := &fakeCRMBackfiller{req: SyncRequest{
		Cursor:   encodeDynamics365Cursor(dynamics365CursorState{Object: "leads"}),
		Contacts: []ContactInput{{SourceID: "dynamics365://contact/00000000-0000-0000-0000-000000000123", Email: "Buyer@Example.com", FirstName: "Ada"}},
	}}
	deps := &Deps{
		Repo:                  store,
		Profiles:              profiles,
		Events:                &fakeEventSink{},
		Dynamics365Backfiller: backfiller,
		Now:                   func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/backfill", `{}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotTenant != "tenant-1" || backfiller.gotProvider != ProviderDynamics365 || backfiller.gotCursor != store.integration.SyncCursor {
		t.Fatalf("backfiller tenant/provider/cursor = %q/%q/%q", backfiller.gotTenant, backfiller.gotProvider, backfiller.gotCursor)
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Email != "buyer@example.com" {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].Status != "completed" || !strings.HasPrefix(store.runs[0].CursorTo, dynamics365CursorPrefix) {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationUsesKeapProviderPullForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderKeap
	store.integration.Name = "Keap account"
	store.integration.SyncCursor = encodeKeapCursor(keapCursorState{Object: "contacts", PageToken: "page-100"})
	profiles := &fakeProfileSink{}
	backfiller := &fakeCRMBackfiller{req: SyncRequest{
		Cursor:   encodeKeapCursor(keapCursorState{Object: "contacts", PageToken: "page-200"}),
		Contacts: []ContactInput{{SourceID: "keap://contact/123", Email: "Buyer@Example.com", FirstName: "Ada"}},
	}}
	deps := &Deps{
		Repo:           store,
		Profiles:       profiles,
		Events:         &fakeEventSink{},
		KeapBackfiller: backfiller,
		Now:            func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/backfill", `{}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotTenant != "tenant-1" || backfiller.gotProvider != ProviderKeap || backfiller.gotCursor != store.integration.SyncCursor {
		t.Fatalf("backfiller tenant/provider/cursor = %q/%q/%q", backfiller.gotTenant, backfiller.gotProvider, backfiller.gotCursor)
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Email != "buyer@example.com" {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].Status != "completed" || !strings.HasPrefix(store.runs[0].CursorTo, keapCursorPrefix) {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationUsesPostscriptProviderPullForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderPostscript
	store.integration.Name = "Postscript SMS"
	store.integration.SyncCursor = postscriptCursorPrefix + "cursor-1"
	profiles := &fakeProfileSink{}
	backfiller := &fakeCRMBackfiller{req: SyncRequest{
		Cursor:   postscriptCursorPrefix + "cursor-2",
		Contacts: []ContactInput{{SourceID: "postscript://subscriber/sub_1", Email: "Buyer@Example.com", Phone: "+15551234567"}},
	}}
	deps := &Deps{
		Repo:                 store,
		Profiles:             profiles,
		Events:               &fakeEventSink{},
		PostscriptBackfiller: backfiller,
		Now:                  func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/backfill", `{}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotTenant != "tenant-1" || backfiller.gotProvider != ProviderPostscript || backfiller.gotCursor != store.integration.SyncCursor {
		t.Fatalf("backfiller tenant/provider/cursor = %q/%q/%q", backfiller.gotTenant, backfiller.gotProvider, backfiller.gotCursor)
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Email != "buyer@example.com" || profiles.contacts[0].Phone != "+15551234567" {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].Status != "completed" || store.runs[0].CursorTo != postscriptCursorPrefix+"cursor-2" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationUsesAttentiveProviderPullForEmptyPayload(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderAttentive
	store.integration.Name = "Attentive SMS"
	store.integration.SyncCursor = attentiveCursorPrefix + "cursor-1"
	profiles := &fakeProfileSink{}
	backfiller := &fakeCRMBackfiller{req: SyncRequest{
		Cursor:   attentiveCursorPrefix + "cursor-2",
		Contacts: []ContactInput{{SourceID: "attentive://subscriber/a_1", Email: "Buyer@Example.com", Phone: "+15559876543"}},
	}}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		Events:              &fakeEventSink{},
		AttentiveBackfiller: backfiller,
		Now:                 func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/backfill", `{}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotTenant != "tenant-1" || backfiller.gotProvider != ProviderAttentive || backfiller.gotCursor != store.integration.SyncCursor {
		t.Fatalf("backfiller tenant/provider/cursor = %q/%q/%q", backfiller.gotTenant, backfiller.gotProvider, backfiller.gotCursor)
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Email != "buyer@example.com" || profiles.contacts[0].Phone != "+15559876543" {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].Status != "completed" || store.runs[0].CursorTo != attentiveCursorPrefix+"cursor-2" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationSkipsPostscriptRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	baseCursor := postscriptCursorPrefix + "cursor-1"
	cfg, _ := smsCursorConfigForProvider(ProviderPostscript)
	retryCursor := encodeSMSRetryCursor(smsRetryState{
		Cursor:        baseCursor,
		Attempts:      1,
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
		LastStatus:    "BACKFILL_FAILED",
	}, cfg)
	store := newFakeStore()
	store.integration.Provider = ProviderPostscript
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeCRMBackfiller{}
	deps := &Deps{
		Repo:                 store,
		Profiles:             &fakeProfileSink{},
		Events:               &fakeEventSink{},
		PostscriptBackfiller: backfiller,
		Now:                  func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotCursor != "" {
		t.Fatalf("backfiller should not be called before retry is due, cursor=%q", backfiller.gotCursor)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != retryCursor {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationResumesAttentiveRetryCursorWhenDue(t *testing.T) {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	baseCursor := attentiveCursorPrefix + "cursor-1"
	cfg, _ := smsCursorConfigForProvider(ProviderAttentive)
	retryCursor := encodeSMSRetryCursor(smsRetryState{
		Cursor:        baseCursor,
		Attempts:      1,
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
		LastStatus:    "BACKFILL_FAILED",
	}, cfg)
	store := newFakeStore()
	store.integration.Provider = ProviderAttentive
	store.integration.SyncCursor = retryCursor
	profiles := &fakeProfileSink{}
	backfiller := &fakeCRMBackfiller{req: SyncRequest{
		Cursor:   attentiveCursorPrefix + "cursor-2",
		Contacts: []ContactInput{{SourceID: "attentive://subscriber/a_2", Email: "Buyer@Example.com", Phone: "+15559870000"}},
	}}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		Events:              &fakeEventSink{},
		AttentiveBackfiller: backfiller,
		Now:                 func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if backfiller.gotCursor != baseCursor {
		t.Fatalf("backfiller cursor=%q want %q", backfiller.gotCursor, baseCursor)
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Email != "buyer@example.com" {
		t.Fatalf("contacts=%+v", profiles.contacts)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != attentiveCursorPrefix+"cursor-2" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationStoresPostscriptRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	baseCursor := postscriptCursorPrefix + "cursor-1"
	providerErr := CRMStaticRESTError{Path: "/subscribers", StatusCode: http.StatusTooManyRequests, RetryAfter: 45 * time.Second, Snippet: "slow down"}
	store := newFakeStore()
	store.integration.Provider = ProviderPostscript
	store.integration.SyncCursor = baseCursor
	deps := &Deps{
		Repo:                 store,
		Profiles:             &fakeProfileSink{},
		Events:               &fakeEventSink{},
		PostscriptBackfiller: &fakeCRMBackfiller{err: providerErr},
		Now:                  func() time.Time { return now },
	}

	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/backfill", `{}`))

	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "internal_error") || strings.Contains(rec.Body.String(), "provider_sync_failed") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodePostscriptRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", store.runs[0].CursorTo, ok, err)
	}
	if retry.Cursor != baseCursor || retry.ProviderCursor != "cursor-1" || retry.Attempts != 1 || retry.NextAttemptAt != now.Add(45*time.Second).Format(time.RFC3339) || retry.LastStatus != "BACKFILL_FAILED" {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationRecordsHubSpotProviderPullFailure(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:              store,
		Profiles:          &fakeProfileSink{},
		Events:            &fakeEventSink{},
		HubSpotBackfiller: &fakeCRMBackfiller{err: errors.New("hubspot 429")},
		Now:               func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/backfill", `{}`))
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "internal_error") || strings.Contains(rec.Body.String(), "provider_sync_failed") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" || !strings.Contains(store.runs[0].ErrorMessage, "hubspot 429") {
		t.Fatalf("runs=%+v", store.runs)
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
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{
		"contacts":[{"source_id":"c1","email":"buyer@example.com"}]
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

func TestBackfillIntegrationRecordsBackfillRunMode(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:     store,
		Profiles: &fakeProfileSink{},
		Events:   &fakeEventSink{},
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/backfill", `{
		"contacts":[{"source_id":"c1","email":"buyer@example.com"}]
	}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestPauseAndDisconnect(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.PauseIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/pause", `{}`))
	if rec.Code != http.StatusOK || !store.paused {
		t.Fatalf("pause status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.DisconnectIntegration(rec, crmReq(http.MethodDelete, "/api/v1/crm/integrations/crm_1", ""))
	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.ProviderCleanup == nil || body.ProviderCleanup.Provider != ProviderHubSpot {
		t.Fatalf("disconnect response=%+v", body)
	}
	if store.disconnectCleanup == nil || store.integration.Settings["provider_cleanup"] == nil {
		t.Fatalf("cleanup evidence was not persisted: cleanup=%+v settings=%+v", store.disconnectCleanup, store.integration.Settings)
	}
}

func TestDisconnectRESTCRMProvidersPersistCleanupEvidenceAndDeleteManagedCredentials(t *testing.T) {
	now := time.Date(2026, 7, 2, 15, 0, 0, 0, time.UTC)
	zohoRef := zohoStoredCredentialPrefix + "cleanup"
	dynamicsRef := dynamics365StoredCredentialPref + "cleanup"
	keapRef := keapStoredCredentialPref + "cleanup"
	zohoRevoked := false
	zohoServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/oauth/v2/token/revoke" || r.URL.Query().Get("token") != "zoho.rt" {
			t.Fatalf("unexpected Zoho revoke request path=%q query=%q", r.URL.Path, r.URL.RawQuery)
		}
		zohoRevoked = true
		w.WriteHeader(http.StatusOK)
	}))
	defer zohoServer.Close()

	cases := []struct {
		name                 string
		provider             string
		ref                  string
		settings             map[string]any
		setupSecrets         func(*fakeStore)
		deps                 func(*fakeStore) *Deps
		wantPosture          string
		wantCredentialStatus string
		wantWebhookStatus    string
		assertDeleted        func(*testing.T, *fakeStore)
		assertOAuth          func(*testing.T, *DisconnectCleanupEvidence)
	}{
		{
			name:     "zoho",
			provider: ProviderZohoCRM,
			ref:      zohoRef,
			settings: map[string]any{"organization_id": "zoho-org-1"},
			setupSecrets: func(store *fakeStore) {
				store.zohoSecrets = map[string]string{
					zohoRef: zohoStoredCredentialJSON(ZohoCredentials{AccessToken: "zoho.at", RefreshToken: "zoho.rt", AccountsURL: zohoServer.URL}),
				}
			},
			deps: func(store *fakeStore) *Deps {
				return &Deps{Repo: store, ZohoOAuthClient: ZohoOAuthClient{HTTPClient: zohoServer.Client(), AccountsURL: zohoServer.URL}, Now: func() time.Time { return now }}
			},
			wantPosture:          "mixed_postwave_oauth_operator_zoho_console",
			wantCredentialStatus: "managed_oauth_refresh_token_revoked_and_local_secret_delete_enforced",
			wantWebhookStatus:    "operator_review_zoho_notification_channels",
			assertDeleted: func(t *testing.T, store *fakeStore) {
				t.Helper()
				if !zohoRevoked {
					t.Fatal("Zoho refresh token was not revoked")
				}
				if store.deletedZohoCredentialRef != zohoRef {
					t.Fatalf("deleted Zoho ref=%q want %q", store.deletedZohoCredentialRef, zohoRef)
				}
				if _, ok := store.zohoSecrets[zohoRef]; ok {
					t.Fatalf("Zoho managed credential secret was not deleted: %+v", store.zohoSecrets)
				}
			},
			assertOAuth: func(t *testing.T, cleanup *DisconnectCleanupEvidence) {
				t.Helper()
				if !cleanup.OAuthRevoked || cleanup.OAuthRevocationStatus != "revoked" {
					t.Fatalf("Zoho cleanup should record OAuth revocation: %+v", cleanup)
				}
			},
		},
		{
			name:     "dynamics365",
			provider: ProviderDynamics365,
			ref:      dynamicsRef,
			settings: map[string]any{"environment_url": "https://org.crm.dynamics.com"},
			setupSecrets: func(store *fakeStore) {
				store.dynamics365Secrets = map[string]string{
					dynamicsRef: dynamics365StoredCredentialJSON(Dynamics365Credentials{AccessToken: "d365.at", RefreshToken: "d365.rt", EnvironmentURL: "https://org.crm.dynamics.com"}),
				}
			},
			deps: func(store *fakeStore) *Deps {
				return &Deps{Repo: store, Now: func() time.Time { return now }}
			},
			wantPosture:          "mixed_postwave_local_oauth_operator_microsoft_console",
			wantCredentialStatus: "local_managed_oauth_credential_delete_enforced_provider_revocation_unavailable",
			wantWebhookStatus:    "operator_review_dataverse_change_tracking_or_webhook_cleanup",
			assertDeleted: func(t *testing.T, store *fakeStore) {
				t.Helper()
				if store.deletedDynamics365CredentialRef != dynamicsRef {
					t.Fatalf("deleted Dynamics ref=%q want %q", store.deletedDynamics365CredentialRef, dynamicsRef)
				}
				if _, ok := store.dynamics365Secrets[dynamicsRef]; ok {
					t.Fatalf("Dynamics managed credential secret was not deleted: %+v", store.dynamics365Secrets)
				}
			},
			assertOAuth: func(t *testing.T, cleanup *DisconnectCleanupEvidence) {
				t.Helper()
				if !cleanup.OAuthRevocationSkipped || cleanup.OAuthRevocationSkipReason != "provider_revocation_endpoint_unavailable" {
					t.Fatalf("Dynamics cleanup should record provider revocation boundary: %+v", cleanup)
				}
			},
		},
		{
			name:     "keap",
			provider: ProviderKeap,
			ref:      keapRef,
			settings: map[string]any{"account_id": "keap-account-1"},
			setupSecrets: func(store *fakeStore) {
				store.keapSecrets = map[string]string{
					keapRef: keapStoredCredentialJSON(KeapCredentials{AccessToken: "keap.at", RefreshToken: "keap.rt"}),
				}
			},
			deps: func(store *fakeStore) *Deps {
				return &Deps{Repo: store, Now: func() time.Time { return now }}
			},
			wantPosture:          "mixed_postwave_local_credential_operator_keap_console",
			wantCredentialStatus: "local_managed_oauth_or_api_key_credential_delete_enforced_provider_revocation_unavailable",
			wantWebhookStatus:    "operator_review_keap_rest_hooks_or_webhook_cleanup",
			assertDeleted: func(t *testing.T, store *fakeStore) {
				t.Helper()
				if store.deletedKeapCredentialRef != keapRef {
					t.Fatalf("deleted Keap ref=%q want %q", store.deletedKeapCredentialRef, keapRef)
				}
				if _, ok := store.keapSecrets[keapRef]; ok {
					t.Fatalf("Keap managed credential secret was not deleted: %+v", store.keapSecrets)
				}
			},
			assertOAuth: func(t *testing.T, cleanup *DisconnectCleanupEvidence) {
				t.Helper()
				if !cleanup.OAuthRevocationSkipped || cleanup.OAuthRevocationSkipReason != "provider_revocation_endpoint_unavailable" {
					t.Fatalf("Keap cleanup should record provider revocation boundary: %+v", cleanup)
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeStore()
			store.integration.Provider = tc.provider
			store.integration.Name = tc.name + " cleanup"
			store.integration.CredentialsRef = tc.ref
			store.integration.Settings = tc.settings
			tc.setupSecrets(store)

			rec := httptest.NewRecorder()
			tc.deps(store).DisconnectIntegration(rec, crmReq(http.MethodDelete, "/api/v1/crm/integrations/crm_1", ""))

			if rec.Code != http.StatusOK || !store.deleted {
				t.Fatalf("status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
			}
			var body DisconnectResponse
			if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			cleanup := body.ProviderCleanup
			if cleanup == nil {
				t.Fatalf("missing cleanup response: %+v", body)
			}
			if cleanup.Provider != tc.provider || cleanup.ProviderCleanupPosture != tc.wantPosture || cleanup.CredentialCleanupStatus != tc.wantCredentialStatus || cleanup.WebhookCleanupStatus != tc.wantWebhookStatus {
				t.Fatalf("cleanup=%+v", cleanup)
			}
			if cleanup.RecordedAt != now.Format(time.RFC3339) || !cleanup.CredentialRefPresent {
				t.Fatalf("cleanup timestamp/credential evidence=%+v", cleanup)
			}
			if store.disconnectCleanup == nil || store.integration.Settings["provider_cleanup"] == nil {
				t.Fatalf("cleanup evidence not persisted: cleanup=%+v settings=%+v", store.disconnectCleanup, store.integration.Settings)
			}
			tc.assertDeleted(t, store)
			tc.assertOAuth(t, cleanup)
		})
	}
}

func TestHighLevelDisconnectDeletesManagedCredentialSecret(t *testing.T) {
	now := time.Date(2026, 7, 2, 15, 30, 0, 0, time.UTC)
	ref := highLevelStoredCredentialPref + "cleanup"
	store := newFakeStore()
	store.integration.Provider = ProviderHighLevel
	store.integration.Name = "HighLevel cleanup"
	store.integration.CredentialsRef = ref
	store.integration.Settings = map[string]any{"credentials_ref": ref, "location_id": "ghl-location-1"}
	store.highLevelSecrets = map[string]string{
		ref: highLevelStoredCredentialJSON(HighLevelCredentials{AccessToken: "ghl.at", RefreshToken: "ghl.rt", LocationID: "ghl-location-1"}),
	}
	deps := &Deps{Repo: store, Now: func() time.Time { return now }}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, crmReq(http.MethodDelete, "/api/v1/crm/integrations/crm_1", ""))

	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if store.deletedHighLevelCredentialRef != ref {
		t.Fatalf("deleted HighLevel ref=%q want %q", store.deletedHighLevelCredentialRef, ref)
	}
	if _, ok := store.highLevelSecrets[ref]; ok {
		t.Fatalf("HighLevel managed credential secret was not deleted: %+v", store.highLevelSecrets)
	}
	var body DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	cleanup := body.ProviderCleanup
	if cleanup == nil {
		t.Fatalf("missing cleanup response: %+v", body)
	}
	if cleanup.ProviderCleanupPosture != "mixed_postwave_local_credential_operator_highlevel_console" ||
		cleanup.CredentialCleanupStatus != "local_managed_oauth_credential_delete_enforced_provider_revocation_unavailable" ||
		cleanup.WebhookCleanupStatus != "operator_review_highlevel_webhooks" ||
		cleanup.ProviderScopeID != "ghl-location-1" {
		t.Fatalf("cleanup=%+v", cleanup)
	}
	if !cleanup.OAuthRevocationSkipped || cleanup.OAuthRevocationSkipReason != "provider_revocation_endpoint_unavailable" || cleanup.OAuthTokenType != "provider_credential" {
		t.Fatalf("cleanup should record provider revocation boundary: %+v", cleanup)
	}
}

func TestDisconnectStaticCRMProvidersPersistOperatorCleanupEvidence(t *testing.T) {
	now := time.Date(2026, 7, 2, 16, 30, 0, 0, time.UTC)
	cases := []struct {
		name                 string
		provider             string
		settings             map[string]any
		wantPosture          string
		wantScopeType        string
		wantScopeID          string
		wantCredentialStatus string
		wantWebhookStatus    string
		wantAction           string
	}{
		{
			name:                 "close",
			provider:             ProviderClose,
			settings:             map[string]any{"organization_id": "close-org-1"},
			wantPosture:          "operator_managed_close_console",
			wantScopeType:        "close_organization_id",
			wantScopeID:          "close-org-1",
			wantCredentialStatus: "operator_revoke_or_rotate_close_api_key_if_no_longer_used",
			wantWebhookStatus:    "operator_review_close_webhooks",
			wantAction:           "Close API key",
		},
		{
			name:                 "copper",
			provider:             ProviderCopper,
			settings:             map[string]any{"account_id": "copper-account-1"},
			wantPosture:          "operator_managed_copper_console",
			wantScopeType:        "copper_account_id",
			wantScopeID:          "copper-account-1",
			wantCredentialStatus: "operator_revoke_or_rotate_copper_api_key_if_no_longer_used",
			wantWebhookStatus:    "operator_review_copper_webhooks",
			wantAction:           "Copper API key",
		},
		{
			name:                 "freshsales",
			provider:             ProviderFreshsales,
			settings:             map[string]any{"account_domain": "acme.myfreshworks.com"},
			wantPosture:          "operator_managed_freshsales_console",
			wantScopeType:        "freshsales_account_domain",
			wantScopeID:          "acme.myfreshworks.com",
			wantCredentialStatus: "operator_revoke_or_rotate_freshsales_api_key_if_no_longer_used",
			wantWebhookStatus:    "operator_review_freshsales_webhooks",
			wantAction:           "Freshsales API key",
		},
		{
			name:                 "highlevel",
			provider:             ProviderHighLevel,
			settings:             map[string]any{"location_id": "ghl-location-1"},
			wantPosture:          "operator_managed_highlevel_console",
			wantScopeType:        "highlevel_location_id",
			wantScopeID:          "ghl-location-1",
			wantCredentialStatus: "operator_revoke_or_rotate_highlevel_oauth_or_api_key_if_no_longer_used",
			wantWebhookStatus:    "operator_review_highlevel_webhooks",
			wantAction:           "HighLevel OAuth/API credential",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeStore()
			store.integration.Provider = tc.provider
			store.integration.Name = tc.name + " cleanup"
			store.integration.CredentialsRef = "cred_" + tc.name
			store.integration.Settings = tc.settings
			deps := &Deps{Repo: store, Now: func() time.Time { return now }}

			rec := httptest.NewRecorder()
			deps.DisconnectIntegration(rec, crmReq(http.MethodDelete, "/api/v1/crm/integrations/crm_1", ""))

			if rec.Code != http.StatusOK || !store.deleted {
				t.Fatalf("status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
			}
			var body DisconnectResponse
			if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			cleanup := body.ProviderCleanup
			if cleanup == nil {
				t.Fatalf("missing cleanup response: %+v", body)
			}
			if cleanup.Provider != tc.provider || cleanup.ProviderCleanupPosture != tc.wantPosture || cleanup.ProviderScopeType != tc.wantScopeType || cleanup.ProviderScopeID != tc.wantScopeID {
				t.Fatalf("cleanup identity=%+v", cleanup)
			}
			if cleanup.CredentialCleanupStatus != tc.wantCredentialStatus || cleanup.WebhookCleanupStatus != tc.wantWebhookStatus || cleanup.RecordedAt != now.Format(time.RFC3339) || !cleanup.CredentialRefPresent {
				t.Fatalf("cleanup status=%+v", cleanup)
			}
			if !strings.Contains(strings.Join(cleanup.ProviderConsoleActions, "\n"), tc.wantAction) || !strings.Contains(strings.Join(cleanup.ProviderCleanupEvidence, "\n"), "operator-managed") {
				t.Fatalf("cleanup actions/evidence=%+v", cleanup)
			}
			if store.disconnectCleanup == nil || store.integration.Settings["provider_cleanup"] == nil {
				t.Fatalf("cleanup evidence not persisted: cleanup=%+v settings=%+v", store.disconnectCleanup, store.integration.Settings)
			}
		})
	}
}

func TestDisconnectSMSSubscriberProvidersPersistOperatorCleanupEvidence(t *testing.T) {
	now := time.Date(2026, 7, 2, 17, 15, 0, 0, time.UTC)
	cases := []struct {
		name                 string
		provider             string
		settings             map[string]any
		wantPosture          string
		wantScopeType        string
		wantScopeID          string
		wantCredentialStatus string
		wantWebhookStatus    string
		wantAction           string
	}{
		{
			name:                 "postscript",
			provider:             ProviderPostscript,
			settings:             map[string]any{"shop_domain": "demo.myshopify.com"},
			wantPosture:          "operator_managed_postscript_console",
			wantScopeType:        "postscript_subscriber_source",
			wantScopeID:          "demo.myshopify.com",
			wantCredentialStatus: "operator_revoke_or_rotate_postscript_api_key_if_no_longer_used",
			wantWebhookStatus:    "operator_review_postscript_webhooks_or_keyword_automations",
			wantAction:           "Postscript API key",
		},
		{
			name:                 "attentive",
			provider:             ProviderAttentive,
			settings:             map[string]any{"account_id": "attentive-account-1"},
			wantPosture:          "operator_managed_attentive_console",
			wantScopeType:        "attentive_subscriber_source",
			wantScopeID:          "attentive-account-1",
			wantCredentialStatus: "operator_revoke_or_rotate_attentive_api_key_if_no_longer_used",
			wantWebhookStatus:    "operator_review_attentive_webhooks_or_keyword_automations",
			wantAction:           "Attentive API key",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeStore()
			store.integration.Provider = tc.provider
			store.integration.Name = tc.name + " cleanup"
			store.integration.CredentialsRef = "cred_" + tc.name
			store.integration.Settings = tc.settings
			deps := &Deps{Repo: store, Now: func() time.Time { return now }}

			rec := httptest.NewRecorder()
			deps.DisconnectIntegration(rec, crmReq(http.MethodDelete, "/api/v1/crm/integrations/crm_1", ""))

			if rec.Code != http.StatusOK || !store.deleted {
				t.Fatalf("status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
			}
			var body DisconnectResponse
			if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			cleanup := body.ProviderCleanup
			if cleanup == nil {
				t.Fatalf("missing cleanup response: %+v", body)
			}
			if cleanup.Provider != tc.provider || cleanup.ProviderCleanupPosture != tc.wantPosture || cleanup.ProviderScopeType != tc.wantScopeType || cleanup.ProviderScopeID != tc.wantScopeID {
				t.Fatalf("cleanup identity=%+v", cleanup)
			}
			if cleanup.CredentialCleanupStatus != tc.wantCredentialStatus || cleanup.WebhookCleanupStatus != tc.wantWebhookStatus || cleanup.RecordedAt != now.Format(time.RFC3339) || !cleanup.CredentialRefPresent {
				t.Fatalf("cleanup status=%+v", cleanup)
			}
			if !strings.Contains(strings.Join(cleanup.ProviderConsoleActions, "\n"), tc.wantAction) || !strings.Contains(strings.Join(cleanup.ProviderCleanupEvidence, "\n"), "operator-managed") {
				t.Fatalf("cleanup actions/evidence=%+v", cleanup)
			}
			if store.disconnectCleanup == nil || store.integration.Settings["provider_cleanup"] == nil {
				t.Fatalf("cleanup evidence not persisted: cleanup=%+v settings=%+v", store.disconnectCleanup, store.integration.Settings)
			}
		})
	}
}

func TestPauseRejectsDisconnectedRows(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.PauseIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/pause", `{}`))

	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.paused || store.integration.Status != "disconnected" {
		t.Fatalf("disconnected integration should not be paused: paused=%v integration=%+v", store.paused, store.integration)
	}
}

func TestDisconnectAlreadyDisconnectedReturnsPersistedCleanupWithoutProviderCalls(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.Settings = map[string]any{
		"portal_id": "123",
		"provider_cleanup": map[string]any{
			"provider":                  ProviderHubSpot,
			"status":                    "operator_action_required",
			"postwave_status":           "disconnected",
			"provider_cleanup_posture":  "mixed_postwave_oauth_operator_hubspot_console",
			"managed_provider_cleanup":  false,
			"webhook_cleanup_status":    "app_level_webhook_subscription_shared_no_per_tenant_cleanup",
			"credential_cleanup_status": "operator_revoke_or_rotate_hubspot_private_app_token_if_no_longer_used",
		},
	}
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, crmReq(http.MethodDelete, "/api/v1/crm/integrations/crm_1", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.deleted {
		t.Fatalf("already disconnected row should not be updated again")
	}
	var body DisconnectResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.ProviderCleanup == nil || body.ProviderCleanup.Provider != ProviderHubSpot {
		t.Fatalf("response=%+v", body)
	}
}

func TestSyncIntegrationRejectsDisconnectedRows(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	deps := &Deps{Repo: store, Profiles: &fakeProfileSink{}}

	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations/crm_1/sync", `{
		"contacts":[{"source_id":"c1","email":"ada@example.com"}]
	}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("disconnected sync should not record runs: %+v", store.runs)
	}
}

func TestHubSpotDisconnectRevokesOAuthAndDeletesManagedCredentialSecret(t *testing.T) {
	ref := hubSpotStoredCredentialPrefix + "disconnect-test"
	store := newFakeStore()
	store.integration.CredentialsRef = ref
	store.integration.Settings = map[string]any{"credentials_ref": ref, "hubspot_portal_id": "123"}
	store.hubSpotSecrets = map[string]string{
		ref: `{"access_token":"old","refresh_token":"refresh-1","client_id":"client-id","client_secret":"client-secret"}`,
	}
	revoked := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/oauth/v1/refresh-tokens/refresh-1" {
			t.Fatalf("unexpected revoke request %s %s", r.Method, r.URL.Path)
		}
		revoked = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	deps := &Deps{
		Repo:               store,
		HubSpotOAuth:       HubSpotOAuthConfig{OAuthBaseURL: srv.URL},
		HubSpotOAuthClient: HubSpotOAuthClient{HTTPClient: srv.Client(), OAuthBaseURL: srv.URL},
		Now:                func() time.Time { return time.Date(2026, 6, 28, 10, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, crmReq(http.MethodDelete, "/api/v1/crm/integrations/crm_1", ""))
	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if !revoked {
		t.Fatal("refresh token was not revoked")
	}
	if _, ok := store.hubSpotSecrets[ref]; ok {
		t.Fatalf("managed credential secret was not deleted: %+v", store.hubSpotSecrets)
	}
	if store.deletedHubSpotCredentialSecret != ref {
		t.Fatalf("deleted credential ref=%q want %q", store.deletedHubSpotCredentialSecret, ref)
	}
	var body struct {
		HubSpotOAuthRevocation HubSpotOAuthRevocationSummary `json:"hubspot_oauth_revocation"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.HubSpotOAuthRevocation.Revoked || body.HubSpotOAuthRevocation.TokenType != "refresh_token" {
		t.Fatalf("revocation summary=%+v", body.HubSpotOAuthRevocation)
	}
}

func TestSalesforceDisconnectRevokesOAuthAndDeletesManagedCredentialSecret(t *testing.T) {
	ref := salesforceStoredCredentialPrefix + "disconnect-test"
	store := newFakeStore()
	store.integration.Provider = ProviderSalesforce
	store.integration.Name = "Salesforce 00D"
	store.integration.CredentialsRef = ref
	store.integration.Settings = map[string]any{"credentials_ref": ref, "org_id": "00Dxx0000000001"}
	store.salesforceSecrets = map[string]string{
		ref: `{"access_token":"old","refresh_token":"refresh-1","client_id":"client-id","client_secret":"client-secret"}`,
	}
	revoked := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/services/oauth2/revoke" {
			t.Fatalf("unexpected revoke request %s %s", r.Method, r.URL.Path)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if got := r.Form.Get("token"); got != "refresh-1" {
			t.Fatalf("revoke token=%q", got)
		}
		revoked = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	deps := &Deps{
		Repo:                  store,
		SalesforceOAuth:       SalesforceOAuthConfig{LoginURL: srv.URL},
		SalesforceOAuthClient: SalesforceOAuthClient{HTTPClient: srv.Client(), LoginURL: srv.URL},
		SalesforceCredentials: &SalesforceSecretsCredentialResolver{Store: store},
		Now:                   func() time.Time { return time.Date(2026, 6, 28, 10, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, crmReq(http.MethodDelete, "/api/v1/crm/integrations/crm_1", ""))
	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if !revoked {
		t.Fatal("refresh token was not revoked")
	}
	if _, ok := store.salesforceSecrets[ref]; ok {
		t.Fatalf("managed credential secret was not deleted: %+v", store.salesforceSecrets)
	}
	if store.deletedSalesforceCredentialRef != ref {
		t.Fatalf("deleted credential ref=%q want %q", store.deletedSalesforceCredentialRef, ref)
	}
	var body struct {
		SalesforceOAuthRevocation SalesforceOAuthRevocationSummary `json:"salesforce_oauth_revocation"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.SalesforceOAuthRevocation.Revoked || body.SalesforceOAuthRevocation.TokenType != "refresh_token" {
		t.Fatalf("revocation summary=%+v", body.SalesforceOAuthRevocation)
	}
}
