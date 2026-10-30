// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeStore struct {
	integration  Integration
	runs         []SyncRun
	lastInput    IntegrationInput
	paused       bool
	deleted      bool
	provisionErr error
	webhooks     map[string]WebhookClaim
	webhookHash  map[string]string
}

func newFakeStore() *fakeStore {
	now := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
	return &fakeStore{integration: Integration{
		ID:             "review_1",
		TenantID:       "tenant-1",
		Provider:       ProviderYotpo,
		Name:           "Yotpo store",
		Status:         "connected",
		Scopes:         []string{"reviews.read"},
		CredentialsRef: "cred_yotpo_1",
		Settings:       map[string]any{"store_id": "store-1"},
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
func (f *fakeStore) FindReviewIntegrationByIngestToken(_ context.Context, provider, token string) (*Integration, error) {
	if f.integration.Provider == strings.TrimSpace(provider) &&
		settingString(f.integration.Settings, reviewIngestTokenSetting) == token && token != "" &&
		f.integration.Status != "disconnected" {
		return &f.integration, nil
	}
	return nil, ErrNotFound
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
		ID:        "review_ingest_1",
		TenantID:  tenantID,
		Provider:  in.Provider,
		Name:      name,
		Status:    "connected",
		Settings:  map[string]any{"review_ingest_token": token, "ingest_mode": "webhook"},
		CreatedAt: now,
		UpdatedAt: now,
	}
	if ref := strings.TrimSpace(in.WebhookSecretRef); ref != "" {
		f.integration.Settings["webhook_secret_ref"] = ref
	}
	return &f.integration, nil
}
func (f *fakeStore) RotateIngestToken(_ context.Context, _ string, _ string, token string) (*Integration, error) {
	// Model the repo's WHERE guard: a disconnected or non-ingest row → no match
	// → ErrNotFound (404). (Wrong-id matching is exercised by the router test.)
	if f.integration.Status == "disconnected" ||
		settingString(f.integration.Settings, "review_ingest_token") == "" {
		return nil, ErrNotFound
	}
	delete(f.integration.Settings, "provider_cleanup")
	f.integration.Settings["review_ingest_token"] = token
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
	if !reviewProviderCleanupEligible(f.integration.Provider) || f.integration.Status != "disconnected" ||
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
		ID:               "run_1",
		IntegrationID:    summary.IntegrationID,
		RunMode:          req.RunMode,
		Status:           summary.Status,
		CursorTo:         cursor,
		ReviewsSeen:      summary.ReviewsSeen,
		ReviewsImported:  summary.ReviewsImported,
		ProfilesUpserted: summary.ProfilesUpserted,
		EventsTracked:    summary.EventsTracked,
		RowsFailed:       summary.RowsFailed,
		ErrorMessage:     summary.ErrorMessage,
		StartedAt:        started,
		CompletedAt:      &completed,
		CreatedAt:        completed,
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
func (f *fakeStore) ClaimReviewWebhook(_ context.Context, _ string, integrationID, provider, webhookID, _ string, body []byte) (WebhookClaim, error) {
	if f.webhooks == nil {
		f.webhooks = map[string]WebhookClaim{}
	}
	if f.webhookHash == nil {
		f.webhookHash = map[string]string{}
	}
	key := reviewWebhookFakeKey(integrationID, provider, webhookID)
	sum := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(sum[:])
	if stored := f.webhookHash[key]; stored != "" && stored != bodyHash {
		return "", ErrReviewWebhookBodyMismatch
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
func (f *fakeStore) MarkReviewWebhookProcessed(_ context.Context, _ string, integrationID, provider, webhookID string) error {
	if f.webhooks == nil {
		f.webhooks = map[string]WebhookClaim{}
	}
	f.webhooks[reviewWebhookFakeKey(integrationID, provider, webhookID)] = WebhookProcessed
	return nil
}
func (f *fakeStore) MarkReviewWebhookFailed(_ context.Context, _ string, integrationID, provider, webhookID string, _ error) error {
	if f.webhooks == nil {
		f.webhooks = map[string]WebhookClaim{}
	}
	f.webhooks[reviewWebhookFakeKey(integrationID, provider, webhookID)] = ""
	return nil
}

func reviewWebhookFakeKey(integrationID, provider, webhookID string) string {
	return integrationID + ":" + provider + ":" + webhookID
}

type fakeReviewSink struct {
	reviews []ReviewInput
	err     error
}

func (f *fakeReviewSink) ImportReview(_ context.Context, _ string, _ string, review ReviewInput) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.reviews = append(f.reviews, review)
	return "rev_1", nil
}

type fakeProfileSink struct {
	reviews []ReviewInput
	err     error
}

func (f *fakeProfileSink) UpsertReviewer(_ context.Context, _ string, _ string, review ReviewInput) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.reviews = append(f.reviews, review)
	return "sub_1", nil
}

type fakeEventSink struct {
	reviews []ReviewInput
	err     error
}

func (f *fakeEventSink) TrackReviewEvent(_ context.Context, _ string, _ string, review ReviewInput) (int64, error) {
	if f.err != nil {
		return 0, f.err
	}
	f.reviews = append(f.reviews, review)
	return int64(len(f.reviews)), nil
}

type fakeProductResolver struct {
	productID        string
	orderID          string
	orderProductID   string
	customerID       string
	err              error
	orderErr         error
	orderProductErr  error
	customerErr      error
	reviews          []ReviewInput
	orderReviews     []ReviewInput
	orderLineReviews []ReviewInput
	customerReviews  []ReviewInput
}

func (f *fakeProductResolver) ResolveReviewProductID(_ context.Context, _ string, _ Integration, review ReviewInput) (string, error) {
	f.reviews = append(f.reviews, review)
	if f.err != nil {
		return "", f.err
	}
	return f.productID, nil
}

func (f *fakeProductResolver) ResolveReviewOrderID(_ context.Context, _ string, _ Integration, review ReviewInput) (string, error) {
	f.orderReviews = append(f.orderReviews, review)
	if f.orderErr != nil {
		return "", f.orderErr
	}
	return f.orderID, nil
}

func (f *fakeProductResolver) ResolveReviewProductIDFromOrderLine(_ context.Context, _ string, _ Integration, review ReviewInput) (string, error) {
	f.orderLineReviews = append(f.orderLineReviews, review)
	if f.orderProductErr != nil {
		return "", f.orderProductErr
	}
	return f.orderProductID, nil
}

func (f *fakeProductResolver) ResolveReviewCustomerID(_ context.Context, _ string, _ Integration, review ReviewInput) (string, error) {
	f.customerReviews = append(f.customerReviews, review)
	if f.customerErr != nil {
		return "", f.customerErr
	}
	return f.customerID, nil
}

type fakeReviewBackfiller struct {
	req    SyncRequest
	err    error
	called bool
	cursor string
}

func (f *fakeReviewBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.cursor = cursor
	return f.req, f.err
}

func reviewReq(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"}))
}

func TestListProvidersIncludesReviewNatives(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Deps{Repo: newFakeStore()}).ListProviders(rec, httptest.NewRequest(http.MethodGet, "/api/v1/review-integrations/providers", nil))

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
		if item.Provider == ProviderYotpo {
			if item.SyncModel != yotpoSyncModelNative || !strings.Contains(item.VerificationMode, "reviews_rest") {
				t.Fatalf("Yotpo should expose native REST metadata, got %q/%q", item.SyncModel, item.VerificationMode)
			}
			if len(item.Scopes) != 0 {
				t.Fatalf("Yotpo should not expose unverified scopes: %+v", item.Scopes)
			}
			if !slices.Contains(item.WebhookTopics, "review_create") || !slices.Contains(item.WebhookTopics, "review_updated") {
				t.Fatalf("Yotpo should expose tokenized review webhook topics: %+v", item.WebhookTopics)
			}
			if providerFieldByKey(item.OptionalSettings, "page_size").Key == "" ||
				providerFieldByKey(item.OptionalSettings, "webhook_secret_ref").Key != "" {
				t.Fatalf("Yotpo optional fields should expose page_size but not webhook_secret_ref: %+v", item.OptionalSettings)
			}
			continue
		}
		if isNativeReviewPullerProvider(item.Provider) {
			if item.SyncModel != nativeReviewPullerSyncModel(item.Provider) {
				t.Fatalf("%s sync model = %q, want %q", item.Provider, item.SyncModel, nativeReviewPullerSyncModel(item.Provider))
			}
			if !strings.Contains(item.VerificationMode, "backfill") {
				t.Fatalf("%s should expose native backfill verification posture, got %q", item.Provider, item.VerificationMode)
			}
			if len(item.Scopes) == 0 {
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
		if item.SyncModel != reviewSyncModelIngest {
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
		ProviderYotpo,
		ProviderJudgeMe,
		ProviderOkendo,
		ProviderLoox,
		ProviderStamped,
		ProviderTrustpilot,
		ProviderReviewsIO,
		ProviderBazaarvoice,
		ProviderPowerReviews,
	} {
		if !seen[provider] {
			t.Fatalf("provider %q missing or unmanaged: %+v", provider, res.Items)
		}
	}
}

func TestCreateTrustpilotIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations", `{
		"provider":"trustpilot",
		"settings":{
			"business_unit_id":"bu_123",
			"credentials_ref":"cred_trustpilot_1",
			"locale":"en-US"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderTrustpilot || store.lastInput.CredentialsRef != "cred_trustpilot_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["business_unit_id"] != "bu_123" ||
		store.lastInput.Settings["setup_surface"] != "review_integrations" ||
		store.lastInput.Settings["sync_model"] != trustpilotSyncModelNative ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if len(store.lastInput.Scopes) == 0 {
		t.Fatalf("Trustpilot should carry native puller read scopes: %+v", store.lastInput.Scopes)
	}
}

func TestCreateReviewsIOIntegration(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations", `{
		"provider":"reviews-io",
		"settings":{
			"store_id":"store_123",
			"credentials_ref":"cred_reviewsio_1",
			"webhook_secret_ref":"cred_reviewsio_webhook_1"
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderReviewsIO || store.lastInput.CredentialsRef != "cred_reviewsio_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["store_id"] != "store_123" ||
		store.lastInput.Settings["setup_surface"] != "review_integrations" ||
		store.lastInput.Settings["webhook_secret_ref"] != nil ||
		store.lastInput.Settings["sync_model"] != reviewsIOSyncModelNative ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if len(store.lastInput.Scopes) == 0 {
		t.Fatalf("Reviews.io should carry native puller read scopes: %+v", store.lastInput.Scopes)
	}
}

func TestCreateIntegrationRequiresCredentialRefAndRejectsRawToken(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations", `{
		"provider":"yotpo",
		"settings":{"store_id":"store-1","api_key":"secret"}
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "raw_credentials_rejected") {
		t.Fatalf("raw token status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.CreateIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations", `{
		"provider":"yotpo",
		"settings":{
			"store_id":"store-1",
			"credentials_ref":"cred_yotpo_1",
			"page_size":25,
			"webhook_secret_ref":"cred_webhook_should_strip",
			"provider_cleanup":{"status":"spoofed","credential_ref":"vault://ignore"}
		}
	}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderYotpo || store.lastInput.CredentialsRef != "cred_yotpo_1" {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["api_key"] != nil ||
		store.lastInput.Settings["sync_model"] != yotpoSyncModelNative ||
		store.lastInput.Settings["verification_mode"] != "yotpo_app_key_secret_reviews_rest_tokenized_review_webhook_ingest_pending_signed_webhooks_live_certification" ||
		store.lastInput.Settings["webhook_secret_ref"] != nil ||
		store.lastInput.Settings["provider_cleanup"] != nil ||
		store.lastInput.Settings["page_size"] != float64(25) ||
		store.lastInput.Settings["managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if len(store.lastInput.Scopes) != 0 {
		t.Fatalf("scopes should be empty for review ingest foundations: %+v", store.lastInput.Scopes)
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

func containsStringContaining(values []string, needle string) bool {
	for _, value := range values {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}

func TestSyncIntegrationImportsReviewsProfilesAndEvents(t *testing.T) {
	store := newFakeStore()
	reviews := &fakeReviewSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:     store,
		Reviews:  reviews,
		Profiles: profiles,
		Events:   events,
		Now:      func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/sync", `{
		"cursor":"after-123",
		"reviews":[{"source_id":"r1","reviewer_email":"Buyer@Example.com","rating":5,"title":"Great"}]
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "completed" || out.ReviewsImported != 1 || out.ProfilesUpserted != 1 || out.EventsTracked != 1 || out.RunID == "" {
		t.Fatalf("summary=%+v", out)
	}
	if len(reviews.reviews) != 1 || reviews.reviews[0].ReviewerEmail != "buyer@example.com" {
		t.Fatalf("reviews=%+v", reviews.reviews)
	}
}

func TestSyncIntegrationEnrichesYotpoProductIDBeforeSinks(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings["commerce_integration_id"] = "commerce_1"
	reviews := &fakeReviewSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	products := &fakeProductResolver{
		productID:  "11111111-1111-1111-1111-111111111111",
		orderID:    "33333333-3333-3333-3333-333333333333",
		customerID: "44444444-4444-4444-4444-444444444444",
	}
	deps := &Deps{
		Repo:     store,
		Reviews:  reviews,
		Profiles: profiles,
		Events:   events,
		Products: products,
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/sync", `{
		"reviews":[{
			"source_id":"yotpo://review/1",
			"reviewer_email":"Buyer@Example.com",
			"rating":5,
			"title":"Great",
			"metadata":{"provider_product_id":"Y-1","external_order_id":"ORDER-1","provider_customer_id":"CUST-1"}
		}]
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(products.reviews) != 1 || products.reviews[0].Metadata["provider_product_id"] != "Y-1" {
		t.Fatalf("resolver reviews=%+v", products.reviews)
	}
	if len(products.orderReviews) != 1 || products.orderReviews[0].Metadata["external_order_id"] != "ORDER-1" {
		t.Fatalf("order resolver reviews=%+v", products.orderReviews)
	}
	if len(products.customerReviews) != 1 || products.customerReviews[0].Metadata["provider_customer_id"] != "CUST-1" {
		t.Fatalf("customer resolver reviews=%+v", products.customerReviews)
	}
	for name, got := range map[string][]ReviewInput{
		"profiles": profiles.reviews,
		"reviews":  reviews.reviews,
		"events":   events.reviews,
	} {
		if len(got) != 1 || got[0].ProductID != "11111111-1111-1111-1111-111111111111" ||
			got[0].OrderID != "33333333-3333-3333-3333-333333333333" ||
			got[0].CustomerID != "44444444-4444-4444-4444-444444444444" ||
			got[0].Metadata["resolved_product_id"] != "11111111-1111-1111-1111-111111111111" ||
			got[0].Metadata["product_resolution"] != "commerce_products" ||
			got[0].Metadata["resolved_order_id"] != "33333333-3333-3333-3333-333333333333" ||
			got[0].Metadata["order_resolution"] != "commerce_orders" ||
			got[0].Metadata["resolved_customer_id"] != "44444444-4444-4444-4444-444444444444" ||
			got[0].Metadata["customer_resolution"] != "commerce_customers" {
			t.Fatalf("%s reviews=%+v", name, got)
		}
	}
}

func TestSyncIntegrationResolvesYotpoProductFromResolvedOrderLineBeforeSinks(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings["commerce_integration_id"] = "commerce_1"
	reviews := &fakeReviewSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	products := &fakeProductResolver{
		orderID:        "33333333-3333-3333-3333-333333333333",
		orderProductID: "22222222-2222-2222-2222-222222222222",
	}
	deps := &Deps{
		Repo:     store,
		Reviews:  reviews,
		Profiles: profiles,
		Events:   events,
		Products: products,
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/sync", `{
		"reviews":[{
			"source_id":"yotpo://review/1b",
			"reviewer_email":"Buyer@Example.com",
			"rating":5,
			"title":"Great",
			"metadata":{"external_product_id":"PROD-1","external_order_id":"ORDER-1"}
		}]
	}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(products.reviews) != 1 || len(products.orderReviews) != 1 || len(products.orderLineReviews) != 1 {
		t.Fatalf("resolver calls product=%+v order=%+v order-line=%+v", products.reviews, products.orderReviews, products.orderLineReviews)
	}
	if products.orderLineReviews[0].OrderID != "33333333-3333-3333-3333-333333333333" {
		t.Fatalf("order-line resolver did not receive resolved order id: %+v", products.orderLineReviews[0])
	}
	for name, got := range map[string][]ReviewInput{
		"profiles": profiles.reviews,
		"reviews":  reviews.reviews,
		"events":   events.reviews,
	} {
		if len(got) != 1 ||
			got[0].ProductID != "22222222-2222-2222-2222-222222222222" ||
			got[0].OrderID != "33333333-3333-3333-3333-333333333333" ||
			got[0].Metadata["resolved_product_id"] != "22222222-2222-2222-2222-222222222222" ||
			got[0].Metadata["product_resolution"] != "commerce_order_line_items" ||
			got[0].Metadata["product_refresh_required"] != nil {
			t.Fatalf("%s reviews=%+v", name, got)
		}
	}
}

func TestSyncIntegrationLeavesYotpoProductEvidenceMetadataOnlyWhenLookupMisses(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings["commerce_integration_id"] = "commerce_1"
	reviews := &fakeReviewSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	products := &fakeProductResolver{}
	deps := &Deps{
		Repo:     store,
		Reviews:  reviews,
		Profiles: profiles,
		Events:   events,
		Products: products,
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/sync", `{
		"reviews":[{
			"source_id":"yotpo://review/2",
			"reviewer_email":"Buyer@Example.com",
			"rating":5,
			"title":"Great",
			"metadata":{
				"external_product_id":"PROD-67890",
				"provider_product_id":"12345",
				"product_title":"Linen shirt"
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
	if out.Status != "completed" || out.ReviewsImported != 1 || out.RowsFailed != 0 {
		t.Fatalf("summary=%+v", out)
	}
	if len(products.reviews) != 1 || products.reviews[0].Metadata["external_product_id"] != "PROD-67890" {
		t.Fatalf("product resolver reviews=%+v", products.reviews)
	}
	if len(reviews.reviews) != 1 {
		t.Fatalf("reviews=%+v", reviews.reviews)
	}
	got := reviews.reviews[0]
	if got.ProductID != "" || got.Metadata["resolved_product_id"] != nil {
		t.Fatalf("review product should remain metadata-only on lookup miss: %+v", got)
	}
	if got.Metadata["external_product_id"] != "PROD-67890" ||
		got.Metadata["provider_product_id"] != "12345" ||
		got.Metadata["product_title"] != "Linen shirt" {
		t.Fatalf("product metadata not preserved: %+v", got.Metadata)
	}
	candidates, ok := got.Metadata["product_refresh_candidates"].([]string)
	if !ok || len(candidates) == 0 || candidates[0] != "PROD-67890" {
		t.Fatalf("product refresh candidates not recorded: %+v", got.Metadata)
	}
	if got.Metadata["product_resolution"] != "commerce_products_lookup_miss" ||
		got.Metadata["product_refresh_required"] != true ||
		got.Metadata["product_refresh_owner"] != "commerce_integration" ||
		got.Metadata["product_refresh_reason"] != "commerce_product_lookup_miss" ||
		got.Metadata["product_refresh_target_integration_id"] != "commerce_1" {
		t.Fatalf("product refresh handoff metadata not recorded: %+v", got.Metadata)
	}
}

func TestSyncIntegrationRequiresCanonicalReviews(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:    store,
		Reviews: &fakeReviewSink{},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/sync", `{"cursor":"after-123"}`))

	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "payload_required") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("empty review sync should not record a provider-pull-like run: %+v", store.runs)
	}
}

func TestSyncIntegrationPullsYotpoProviderOnEmptyRequest(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings["commerce_integration_id"] = "commerce_1"
	backfiller := &fakeReviewBackfiller{req: SyncRequest{
		RunMode: "backfill",
		Cursor:  "yotpo:2",
		Reviews: []ReviewInput{{
			SourceID:      "yotpo://review/42",
			ReviewerEmail: "buyer@example.com",
			Rating:        5,
			Title:         "Great",
			Metadata:      map[string]any{"provider_product_id": "Y-42", "provider_order_id": "ORDER-42", "provider_customer_id": "CUST-42"},
		}},
	}}
	reviews := &fakeReviewSink{}
	products := &fakeProductResolver{
		productID:  "22222222-2222-2222-2222-222222222222",
		orderID:    "55555555-5555-5555-5555-555555555555",
		customerID: "66666666-6666-6666-6666-666666666666",
	}
	deps := &Deps{
		Repo:            store,
		Reviews:         reviews,
		Profiles:        &fakeProfileSink{},
		Events:          &fakeEventSink{},
		Products:        products,
		YotpoBackfiller: backfiller,
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/sync", `{"cursor":"yotpo:1"}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !backfiller.called || backfiller.cursor != "yotpo:1" {
		t.Fatalf("provider pull not called with cursor: called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if out.Status != "completed" || out.ReviewsImported != 1 || out.ProfilesUpserted != 1 || out.EventsTracked != 1 || out.Cursor != "yotpo:2" {
		t.Fatalf("summary=%+v", out)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != "yotpo:2" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if len(products.reviews) != 1 || products.reviews[0].Metadata["provider_product_id"] != "Y-42" {
		t.Fatalf("product resolver reviews=%+v", products.reviews)
	}
	if len(products.orderReviews) != 1 || products.orderReviews[0].Metadata["provider_order_id"] != "ORDER-42" {
		t.Fatalf("order resolver reviews=%+v", products.orderReviews)
	}
	if len(products.customerReviews) != 1 || products.customerReviews[0].Metadata["provider_customer_id"] != "CUST-42" {
		t.Fatalf("customer resolver reviews=%+v", products.customerReviews)
	}
	if len(reviews.reviews) != 1 ||
		reviews.reviews[0].ProductID != "22222222-2222-2222-2222-222222222222" ||
		reviews.reviews[0].OrderID != "55555555-5555-5555-5555-555555555555" ||
		reviews.reviews[0].CustomerID != "66666666-6666-6666-6666-666666666666" ||
		reviews.reviews[0].Metadata["resolved_customer_id"] != "66666666-6666-6666-6666-666666666666" {
		t.Fatalf("resolved reviews=%+v", reviews.reviews)
	}
}

func TestSyncIntegrationUsesStoredYotpoCursorOnEmptyRequest(t *testing.T) {
	store := newFakeStore()
	store.integration.SyncCursor = yotpoCursorPrefix + "1"
	backfiller := &fakeReviewBackfiller{req: SyncRequest{
		RunMode: "backfill",
		Cursor:  yotpoCursorPrefix + "2",
		Reviews: []ReviewInput{{SourceID: "yotpo://review/42", ReviewerEmail: "buyer@example.com", Rating: 5, Title: "Great"}},
	}}
	deps := &Deps{
		Repo:            store,
		Reviews:         &fakeReviewSink{},
		Profiles:        &fakeProfileSink{},
		Events:          &fakeEventSink{},
		YotpoBackfiller: backfiller,
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != yotpoCursorPrefix+"1" {
		t.Fatalf("called=%v cursor=%q", backfiller.called, backfiller.cursor)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "backfill" || store.runs[0].CursorTo != yotpoCursorPrefix+"2" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationSkipsYotpoRetryCursorBeforeDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := yotpoCursorPrefix + "1"
	retryCursor := encodeYotpoRetryCursor(yotpoRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeReviewBackfiller{}
	deps := &Deps{
		Repo:            store,
		YotpoBackfiller: backfiller,
		Now:             func() time.Time { return now },
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/backfill", `{}`))

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

func TestSyncIntegrationResumesYotpoRetryCursorWhenDue(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := yotpoCursorPrefix + "1"
	retryCursor := encodeYotpoRetryCursor(yotpoRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeReviewBackfiller{req: SyncRequest{
		RunMode: "backfill",
		Cursor:  yotpoCursorPrefix + "2",
		Reviews: []ReviewInput{{SourceID: "yotpo://review/42", ReviewerEmail: "buyer@example.com", Rating: 5, Title: "Great"}},
	}}
	deps := &Deps{
		Repo:            store,
		Reviews:         &fakeReviewSink{},
		Profiles:        &fakeProfileSink{},
		Events:          &fakeEventSink{},
		YotpoBackfiller: backfiller,
		Now:             func() time.Time { return now },
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != yotpoCursorPrefix+"2" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSyncIntegrationStoresYotpoRetryCursorOnBackfillFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := yotpoCursorPrefix + "1"
	retryCursor := encodeYotpoRetryCursor(yotpoRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeReviewBackfiller{err: ReviewRESTError{StatusCode: http.StatusTooManyRequests, RetryAfter: 2 * time.Minute, Snippet: "still throttled"}}
	deps := &Deps{
		Repo:            store,
		YotpoBackfiller: backfiller,
		Now:             func() time.Time { return now },
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/backfill", `{}`))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeYotpoRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, err, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 2 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationStoresYotpoRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := yotpoCursorPrefix + "1"
	store := newFakeStore()
	store.integration.SyncCursor = cursor
	backfiller := &fakeReviewBackfiller{req: SyncRequest{
		RunMode: "backfill",
		Cursor:  yotpoCursorPrefix + "2",
		Reviews: []ReviewInput{{SourceID: "yotpo://review/42", ReviewerEmail: "buyer@example.com", Rating: 5, Title: "Great"}},
	}}
	deps := &Deps{
		Repo:            store,
		Reviews:         &fakeReviewSink{err: errors.New("review sink unavailable")},
		YotpoBackfiller: backfiller,
		Now:             func() time.Time { return now },
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/backfill", `{}`))

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
	if out.Status != "failed" || out.Cursor == yotpoCursorPrefix+"2" {
		t.Fatalf("summary=%+v", out)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeYotpoRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, err, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 1 || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(15*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationPreservesYotpoRetryAttemptsOnDueSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := yotpoCursorPrefix + "1"
	retryCursor := encodeYotpoRetryCursor(yotpoRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "SYNC_FAILED",
		LastError:     "review sink unavailable",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &fakeReviewBackfiller{req: SyncRequest{
		RunMode: "backfill",
		Cursor:  yotpoCursorPrefix + "2",
		Reviews: []ReviewInput{{SourceID: "yotpo://review/42", ReviewerEmail: "buyer@example.com", Rating: 5, Title: "Great"}},
	}}
	deps := &Deps{
		Repo:            store,
		Reviews:         &fakeReviewSink{err: errors.New("review sink still unavailable")},
		YotpoBackfiller: backfiller,
		Now:             func() time.Time { return now },
	}
	rec := httptest.NewRecorder()

	deps.BackfillIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/backfill", `{}`))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, err := decodeYotpoRetryCursor(store.runs[0].CursorTo)
	if err != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, err, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 2 || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(30*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSyncIntegrationRejectsDisconnectedReviewRows(t *testing.T) {
	for _, path := range []struct {
		name   string
		handle func(*Deps, http.ResponseWriter, *http.Request)
		url    string
	}{
		{name: "sync", handle: (*Deps).SyncIntegration, url: "/api/v1/review-integrations/review_1/sync"},
		{name: "backfill", handle: (*Deps).BackfillIntegration, url: "/api/v1/review-integrations/review_1/backfill"},
	} {
		t.Run(path.name, func(t *testing.T) {
			store := newFakeStore()
			store.integration.Status = "disconnected"
			backfiller := &fakeReviewBackfiller{req: SyncRequest{Reviews: []ReviewInput{{SourceID: "yotpo://review/42", ReviewerEmail: "buyer@example.com", Rating: 5}}}}
			deps := &Deps{Repo: store, YotpoBackfiller: backfiller}
			rec := httptest.NewRecorder()

			path.handle(deps, rec, reviewReq(http.MethodPost, path.url, `{}`))

			if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if backfiller.called || len(store.runs) != 0 {
				t.Fatalf("called=%v runs=%+v", backfiller.called, store.runs)
			}
		})
	}
}

func TestIngestReviewRecordsWebhookRun(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:     store,
		Reviews:  &fakeReviewSink{},
		Profiles: &fakeProfileSink{},
		Events:   &fakeEventSink{},
	}
	rec := httptest.NewRecorder()
	deps.IngestReview(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/ingest", `{
		"source_id":"r1",
		"reviewer_email":"buyer@example.com",
		"rating":5,
		"title":"Great"
	}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestIngestReviewRejectsDisconnectedReviewRows(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	reviews := &fakeReviewSink{}
	deps := &Deps{
		Repo:    store,
		Reviews: reviews,
	}
	rec := httptest.NewRecorder()

	deps.IngestReview(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/ingest", `{
		"source_id":"r1",
		"reviewer_email":"buyer@example.com",
		"rating":5
	}`))

	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(reviews.reviews) != 0 || len(store.runs) != 0 {
		t.Fatalf("reviews=%+v runs=%+v", reviews.reviews, store.runs)
	}
}

func TestPauseRejectsDisconnectedReviewRows(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	deps := &Deps{Repo: store}
	rec := httptest.NewRecorder()

	deps.PauseIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/pause", `{}`))

	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "integration_disconnected") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.paused || store.integration.Status != "disconnected" {
		t.Fatalf("paused=%v status=%q", store.paused, store.integration.Status)
	}
}

func TestReviewWebhookIngestRejectsProviderTokenMismatch(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderYotpo
	store.integration.Settings = map[string]any{reviewIngestTokenSetting: "tok_yotpo_1"}
	deps := &Deps{Repo: store, Reviews: &fakeReviewSink{}}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/public/review-integrations/okendo/ingest/tok_yotpo_1", strings.NewReader(`{"email":"buyer@example.com","rating":5,"title":"Great"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "integration_not_found") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("mismatched provider should not record runs: %+v", store.runs)
	}
}

func TestReviewWebhookIngestTreatsDisconnectedRowsAsNotFound(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderYotpo
	store.integration.Status = "disconnected"
	store.integration.Settings = map[string]any{reviewIngestTokenSetting: "tok_yotpo_1"}
	reviews := &fakeReviewSink{}
	deps := &Deps{Repo: store, Reviews: reviews, Profiles: &fakeProfileSink{}, Events: &fakeEventSink{}}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/public/review-integrations/yotpo/ingest/tok_yotpo_1", strings.NewReader(`{"event":"review_create","data":{"id":"rv_1","customer_email":"buyer@example.com","score":5}}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "integration_not_found") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(reviews.reviews) != 0 || len(store.runs) != 0 {
		t.Fatalf("reviews=%+v runs=%+v", reviews.reviews, store.runs)
	}
}

func TestReviewWebhookIngestFailsClosedWhenConfiguredSecretIsMissing(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderYotpo
	store.integration.Settings = map[string]any{
		reviewIngestTokenSetting: "tok_yotpo_1",
		"webhook_secret_ref":     "cred_yotpo_webhook_1",
	}
	deps := &Deps{Repo: store, Reviews: &fakeReviewSink{}}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/public/review-integrations/yotpo/ingest/tok_yotpo_1", strings.NewReader(`{"event":"review_create","data":{"id":"rv_1","customer_email":"buyer@example.com","score":5,"title":"Great"}}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "request authentication failed") || strings.Contains(rec.Body.String(), "review webhook secret is required") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("missing configured secret should not record runs: %+v", store.runs)
	}
}

func TestReviewWebhookIngestDedupesYotpoWebhookMessageID(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderYotpo
	store.integration.Settings = map[string]any{reviewIngestTokenSetting: "tok_yotpo_1"}
	reviews := &fakeReviewSink{}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{Repo: store, Reviews: reviews, Profiles: profiles, Events: events}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	body := `{
		"data":{
			"id":"rv_1",
			"customer_email":"Buyer@Example.com",
			"reviewer_display_name":"Buyer",
			"score":5,
			"title":"Great",
			"content":"Loved it"
		}
	}`

	req := httptest.NewRequest(http.MethodPost, "/api/public/review-integrations/yotpo/ingest/tok_yotpo_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("WebhookMessageId", "msg_1")
	req.Header.Set("X-Yotpo-Webhooks-Event-Type", "review_create")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || len(reviews.reviews) != 1 || len(profiles.reviews) != 1 || len(events.reviews) != 1 {
		t.Fatalf("runs=%+v reviews=%+v profiles=%+v events=%+v", store.runs, reviews.reviews, profiles.reviews, events.reviews)
	}
	if store.webhooks[reviewWebhookFakeKey(store.integration.ID, ProviderYotpo, "msg_1")] != WebhookProcessed {
		t.Fatalf("webhook state=%+v", store.webhooks)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/public/review-integrations/yotpo/ingest/tok_yotpo_1", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("WebhookMessageId", "msg_1")
	req.Header.Set("X-Yotpo-Webhooks-Event-Type", "review_create")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted || !strings.Contains(rec.Body.String(), `"duplicate":true`) {
		t.Fatalf("duplicate status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || len(reviews.reviews) != 1 {
		t.Fatalf("duplicate should not reprocess: runs=%+v reviews=%+v", store.runs, reviews.reviews)
	}
}

func TestReviewWebhookInProgressClaimReturnsRetry(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderYotpo
	store.integration.Settings = map[string]any{reviewIngestTokenSetting: "tok_yotpo_1"}
	store.webhooks = map[string]WebhookClaim{reviewWebhookFakeKey(store.integration.ID, ProviderYotpo, "msg_1"): WebhookInProgress}
	deps := &Deps{Repo: store, Reviews: &fakeReviewSink{}}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)

	req := httptest.NewRequest(http.MethodPost, "/api/public/review-integrations/yotpo/ingest/tok_yotpo_1", strings.NewReader(`{"data":{"id":"rv_1","customer_email":"buyer@example.com","score":5}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("WebhookMessageId", "msg_1")
	req.Header.Set("X-Yotpo-Webhooks-Event-Type", "review_create")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "10" || !strings.Contains(rec.Body.String(), "internal_error") || strings.Contains(rec.Body.String(), "webhook_in_progress") {
		t.Fatalf("status=%d retry=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
	if len(store.runs) != 0 {
		t.Fatalf("in-progress delivery should not record runs: %+v", store.runs)
	}
}

func TestReviewWebhookIngestMarksClaimFailedOnSyncFailure(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderYotpo
	store.integration.Settings = map[string]any{reviewIngestTokenSetting: "tok_yotpo_1"}
	deps := &Deps{
		Repo:    store,
		Reviews: &fakeReviewSink{err: errors.New("review sink unavailable")},
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)

	req := httptest.NewRequest(http.MethodPost, "/api/public/review-integrations/yotpo/ingest/tok_yotpo_1", strings.NewReader(`{"data":{"id":"rv_1","customer_email":"buyer@example.com","score":5}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("WebhookMessageId", "msg_1")
	req.Header.Set("X-Yotpo-Webhooks-Event-Type", "review_create")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "internal_error") || strings.Contains(rec.Body.String(), "webhook_processing_failed") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if got := store.webhooks[reviewWebhookFakeKey(store.integration.ID, ProviderYotpo, "msg_1")]; got != "" {
		t.Fatalf("failed claim should be retryable, got state=%q map=%+v", got, store.webhooks)
	}
}

func TestReviewWebhookIngestRejectsSameMessageIDDifferentBody(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderYotpo
	store.integration.Settings = map[string]any{reviewIngestTokenSetting: "tok_yotpo_1"}
	deps := &Deps{
		Repo:     store,
		Reviews:  &fakeReviewSink{},
		Profiles: &fakeProfileSink{},
		Events:   &fakeEventSink{},
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)

	body1 := `{"data":{"id":"rv_1","customer_email":"buyer@example.com","score":5,"title":"Great"}}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/review-integrations/yotpo/ingest/tok_yotpo_1", strings.NewReader(body1))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("WebhookMessageId", "msg_1")
	req.Header.Set("X-Yotpo-Webhooks-Event-Type", "review_create")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", rec.Code, rec.Body.String())
	}

	body2 := `{"data":{"id":"rv_1","customer_email":"buyer@example.com","score":1,"title":"Different"}}`
	req = httptest.NewRequest(http.MethodPost, "/api/public/review-integrations/yotpo/ingest/tok_yotpo_1", strings.NewReader(body2))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("WebhookMessageId", "msg_1")
	req.Header.Set("X-Yotpo-Webhooks-Event-Type", "review_create")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "webhook_body_mismatch") {
		t.Fatalf("mismatch status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.runs) != 1 {
		t.Fatalf("mismatched body should not reprocess: runs=%+v", store.runs)
	}
}

func TestBackfillIntegrationRecordsBackfillRunMode(t *testing.T) {
	store := newFakeStore()
	deps := &Deps{
		Repo:    store,
		Reviews: &fakeReviewSink{},
	}
	rec := httptest.NewRecorder()
	deps.BackfillIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/backfill", `{
		"reviews":[{"source_id":"r1","rating":5,"title":"Great"}]
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
		Repo:    store,
		Reviews: &fakeReviewSink{err: errors.New("boom")},
	}
	rec := httptest.NewRecorder()
	deps.SyncIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/sync", `{
		"reviews":[{"source_id":"r1","rating":5,"title":"Great"}]
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
	deps.PauseIntegration(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/pause", `{}`))
	if rec.Code != http.StatusOK || !store.paused {
		t.Fatalf("pause status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	deps.DisconnectIntegration(rec, reviewReq(http.MethodDelete, "/api/v1/review-integrations/review_1", ""))
	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("delete status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDisconnectYotpoReturnsAndPersistsProviderCleanupEvidence(t *testing.T) {
	recordedAt := time.Date(2026, 6, 29, 13, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration.Settings = map[string]any{
		"store_id":             "store-1",
		"review_ingest_token":  "tok_secret_should_not_leak",
		"webhook_secret_ref":   "vault://review/yotpo-webhook",
		"provider_cleanup":     map[string]any{"status": "stale"},
		"yotpo_secret_leak":    "do-not-copy",
		"commerce_integration": "commerce_1",
	}
	deps := &Deps{
		Repo: store,
		Now:  func() time.Time { return recordedAt },
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, reviewReq(http.MethodDelete, "/api/v1/review-integrations/review_1", ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, "vault://") || strings.Contains(body, "tok_secret_should_not_leak") || strings.Contains(body, "do-not-copy") {
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
		cleanup.Provider != ProviderYotpo ||
		cleanup.Status != "operator_action_required" ||
		cleanup.RecordedAt != "2026-06-29T13:00:00Z" ||
		cleanup.PostwaveStatus != "disconnected" ||
		cleanup.ProviderCleanupPosture != "operator_managed_provider_console" ||
		cleanup.ManagedProviderCleanup ||
		cleanup.ProviderScopeType != "yotpo_store_id" ||
		cleanup.ProviderScopeID != "store-1" ||
		!cleanup.CredentialRefPresent ||
		!cleanup.WebhookSecretRefPresent ||
		!cleanup.TokenizedIngestTokenPresent ||
		cleanup.WebhookCleanupStatus != "operator_cleanup_required" ||
		cleanup.CredentialCleanupStatus != "operator_revoke_or_rotate_if_no_longer_used" {
		t.Fatalf("cleanup=%+v", cleanup)
	}
	if !slices.Contains(cleanup.PostwaveEffects, "tokenized Yotpo review webhook ingest no longer resolves this row") {
		t.Fatalf("cleanup should disclose local webhook stop effect: %+v", cleanup.PostwaveEffects)
	}
	if !containsStringContaining(cleanup.ProviderConsoleActions, "Yotpo webhook") ||
		!containsStringContaining(cleanup.ProviderConsoleActions, "app secret") {
		t.Fatalf("cleanup should disclose Yotpo operator actions: %+v", cleanup.ProviderConsoleActions)
	}
	if !containsStringContaining(cleanup.ProviderCleanupEvidence, "does not call") {
		t.Fatalf("cleanup should disclose non-managed provider cleanup posture: %+v", cleanup.ProviderCleanupEvidence)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("stored cleanup missing: %+v", store.integration.Settings)
	}
	if stored["status"] != "operator_action_required" ||
		stored["provider"] != ProviderYotpo ||
		stored["provider_scope_id"] != "store-1" ||
		stored["managed_provider_cleanup"] != false ||
		stored["credential_ref_present"] != true ||
		stored["webhook_secret_ref_present"] != true ||
		stored["tokenized_ingest_token_present"] != true {
		t.Fatalf("stored cleanup=%+v", stored)
	}
	if stored["credential_ref"] != nil || stored["webhook_secret_ref"] != nil || stored["review_ingest_token"] != nil {
		t.Fatalf("stored cleanup should not include raw secret refs or tokens: %+v", stored)
	}
}

func TestAcknowledgeProviderCleanupPersistsYotpoOperatorAttestation(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.Settings = map[string]any{
		"store_id":            "store-1",
		"webhook_secret_ref":  "vault://review/yotpo-webhook",
		"review_ingest_token": "tok_secret_should_not_leak",
		"provider_cleanup": map[string]any{
			"provider":                 ProviderYotpo,
			"status":                   "operator_action_required",
			"recorded_at":              "2026-06-29T13:00:00Z",
			"managed_provider_cleanup": false,
			"provider_scope_id":        "store-1",
		},
	}
	deps := &Deps{
		Repo: store,
		Now:  func() time.Time { return time.Date(2026, 6, 29, 14, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.AcknowledgeProviderCleanup(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/provider-cleanup/acknowledge", `{
		"completed_actions":["app_secret_or_api_credentials_rotated","webhook_target_filter_or_subscription_removed_or_disabled","app_secret_or_api_credentials_rotated"],
		"notes":"Verified in Yotpo console",
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
		stored["operator_notes"] != "Verified in Yotpo console" ||
		stored["managed_provider_cleanup"] != false ||
		stored["recorded_at"] != "2026-06-29T13:00:00Z" ||
		len(actions) != 2 ||
		actions[0] != "app_secret_or_api_credentials_rotated" ||
		actions[1] != "webhook_target_filter_or_subscription_removed_or_disabled" {
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

func TestAcknowledgeProviderCleanupRejectsConnectedYotpo(t *testing.T) {
	store := newFakeStore()
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderYotpo,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/provider-cleanup/acknowledge", `{"notes":"done"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "provider_cleanup_missing") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAcknowledgeProviderCleanupAcceptsNativeReviewPuller(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderJudgeMe
	store.integration.Status = "disconnected"
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderJudgeMe,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{
		Repo: store,
		Now:  func() time.Time { return time.Date(2026, 6, 29, 14, 0, 0, 0, time.UTC) },
	}).AcknowledgeProviderCleanup(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/provider-cleanup/acknowledge", `{
		"completed_actions":["provider_api_credentials_rotated","provider_webhook_target_or_subscription_removed"],
		"notes":"Verified in Judge.me console"
	}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	stored := store.integration.Settings["provider_cleanup"].(map[string]any)
	if stored["status"] != "operator_acknowledged" ||
		stored["acknowledged_at"] != "2026-06-29T14:00:00Z" ||
		stored["operator_notes"] != "Verified in Judge.me console" ||
		stored["managed_provider_cleanup"] != false {
		t.Fatalf("stored provider cleanup=%+v", stored)
	}
}

func TestAcknowledgeProviderCleanupRequiresRecordedEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/provider-cleanup/acknowledge", `{"notes":"done"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "provider_cleanup_missing") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAcknowledgeProviderCleanupRequiresAttestationEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderYotpo,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/provider-cleanup/acknowledge", `{}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "completed_actions or notes is required") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAcknowledgeProviderCleanupValidatesYotpoActionKeys(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.Settings["provider_cleanup"] = map[string]any{
		"provider": ProviderYotpo,
		"status":   "operator_action_required",
	}
	rec := httptest.NewRecorder()
	(&Deps{Repo: store}).AcknowledgeProviderCleanup(rec, reviewReq(http.MethodPost, "/api/v1/review-integrations/review_1/provider-cleanup/acknowledge", `{
		"completed_actions":["rotated Yotpo app secret"]
	}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "unsupported review cleanup action key") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDisconnectNativeReviewPullerReturnsProviderCleanupEvidence(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderJudgeMe
	store.integration.Settings = map[string]any{
		"shop_domain":        "acme.myshopify.com",
		"webhook_secret_ref": "vault://review/judgeme",
		"provider_cleanup":   map[string]any{"status": "stale"},
		"api_token":          "do-not-copy",
	}
	deps := &Deps{
		Repo: store,
		Now:  func() time.Time { return time.Date(2026, 6, 29, 15, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, reviewReq(http.MethodDelete, "/api/v1/review-integrations/review_1", ""))

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
		cleanup.Provider != ProviderJudgeMe ||
		cleanup.RecordedAt != "2026-06-29T15:00:00Z" ||
		cleanup.ProviderScopeType != "shop_domain" ||
		cleanup.ProviderScopeID != "acme.myshopify.com" ||
		!cleanup.CredentialRefPresent ||
		!cleanup.WebhookSecretRefPresent ||
		cleanup.ManagedProviderCleanup ||
		cleanup.WebhookCleanupStatus != "operator_cleanup_required" {
		t.Fatalf("cleanup=%+v", cleanup)
	}
	if !containsStringContaining(cleanup.ProviderConsoleActions, "Judge.me webhook") ||
		!containsStringContaining(cleanup.ProviderCleanupEvidence, "Judge.me provider-cleanup API") {
		t.Fatalf("cleanup should disclose Judge.me operator cleanup: %+v", cleanup)
	}
	if store.integration.Status != "disconnected" || store.integration.Settings["provider_cleanup"] == nil {
		t.Fatalf("state=%s settings=%+v", store.integration.Status, store.integration.Settings)
	}
}
