// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func hubSpotV3Signature(secret, method, uri string, body []byte, timestamp string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(method))
	mac.Write([]byte(uri))
	mac.Write(body)
	mac.Write([]byte(timestamp))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func TestVerifyHubSpotWebhookV3Valid(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	secret := "app-client-secret"
	method := http.MethodPost
	uri := "https://app.postwave.test/api/public/crm-integrations/hubspot/webhooks"
	body := []byte(`[{"portalId":123,"subscriptionType":"contact.creation","objectId":1}]`)
	ts := strconv.FormatInt(now.UnixMilli(), 10)
	sig := hubSpotV3Signature(secret, method, uri, body, ts)

	if err := VerifyHubSpotWebhookV3(secret, method, uri, body, sig, ts, now, 5*time.Minute); err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}
}

func TestVerifyHubSpotWebhookV3UsesDocumentedSelectiveQueryDecoding(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	secret := "app-client-secret"
	method := http.MethodPost
	encodedURI := "https://app.postwave.test/api/%2Fhubspot?callback=https%3A%2F%2Fexample.com%2Fhook%3Fowner%3Dada%40example.com&literal=%5Bkeep%5D+plus#ignored"
	signedURI := "https://app.postwave.test/api/%2Fhubspot?callback=https://example.com/hook?owner%3Dada@example.com&literal=%5Bkeep%5D+plus"
	body := []byte(`[]`)
	ts := strconv.FormatInt(now.UnixMilli(), 10)
	sig := hubSpotV3Signature(secret, method, signedURI, body, ts)

	if err := VerifyHubSpotWebhookV3(
		secret,
		method,
		encodedURI,
		body,
		sig,
		ts,
		now,
		5*time.Minute,
	); err != nil {
		t.Fatalf("selectively decoded signature rejected: %v", err)
	}
	if got := normalizeHubSpotWebhookV3RequestURI(encodedURI); got != signedURI {
		t.Fatalf("normalized URI=%q, want %q", got, signedURI)
	}
}

func TestVerifyHubSpotWebhookV3TamperedBody(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	secret := "app-client-secret"
	method := http.MethodPost
	uri := "https://app.postwave.test/api/public/crm-integrations/hubspot/webhooks"
	body := []byte(`[{"portalId":123}]`)
	ts := strconv.FormatInt(now.UnixMilli(), 10)
	sig := hubSpotV3Signature(secret, method, uri, body, ts)

	if err := VerifyHubSpotWebhookV3(secret, method, uri, append(body, '!'), sig, ts, now, 5*time.Minute); err == nil {
		t.Fatal("tampered body accepted")
	}
}

func TestVerifyHubSpotWebhookV3StaleTimestamp(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	secret := "app-client-secret"
	method := http.MethodPost
	uri := "https://app.postwave.test/api/public/crm-integrations/hubspot/webhooks"
	body := []byte(`[]`)
	stale := strconv.FormatInt(now.Add(-10*time.Minute).UnixMilli(), 10)
	sig := hubSpotV3Signature(secret, method, uri, body, stale)

	if err := VerifyHubSpotWebhookV3(secret, method, uri, body, sig, stale, now, 5*time.Minute); err == nil || !strings.Contains(err.Error(), "timestamp") {
		t.Fatalf("stale timestamp should be rejected, got %v", err)
	}
}

func TestVerifyHubSpotWebhookV3MissingInputs(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	if err := VerifyHubSpotWebhookV3("", "POST", "uri", []byte("x"), "sig", "1", now, time.Minute); err == nil {
		t.Fatal("missing secret accepted")
	}
	if err := VerifyHubSpotWebhookV3("secret", "POST", "uri", []byte("x"), "", "1", now, time.Minute); err == nil {
		t.Fatal("missing signature accepted")
	}
	if err := VerifyHubSpotWebhookV3("secret", "POST", "uri", []byte("x"), "sig", "", now, time.Minute); err == nil {
		t.Fatal("missing timestamp accepted")
	}
}

func TestDecodeHubSpotWebhookEventsAcceptsDocumentedEventTypeAliasAndRejectsConflict(t *testing.T) {
	events, err := decodeHubSpotWebhookEvents([]byte(`[
		{"eventId":1,"eventType":"contact.creation","appId":777,"portalId":123,"objectId":501}
	]`))
	if err != nil {
		t.Fatalf("decode eventType payload: %v", err)
	}
	if len(events) != 1 || events[0].SubscriptionType != "contact.creation" || events[0].EventType != "" {
		t.Fatalf("decoded events=%+v", events)
	}
	_, err = decodeHubSpotWebhookEvents([]byte(`[
		{"eventId":1,"subscriptionType":"contact.creation","eventType":"contact.deletion","appId":777,"portalId":123,"objectId":501}
	]`))
	if err == nil || !strings.Contains(err.Error(), "conflicting subscriptionType and eventType") {
		t.Fatalf("conflicting type error=%v", err)
	}
}

func TestHubSpotAppWebhookRegistrarReconcileCreatesMissing(t *testing.T) {
	var createdTypes []string
	var createdProperties []string
	var listedApp string
	var settingsUpdated bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/settings"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"webhookUrl":            "https://old.postwave.test/hubspot",
				"maxConcurrentRequests": 6,
			})
		case r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "/settings"):
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			settingsUpdated = payload["targetUrl"] == "https://app.postwave.test/api/public/crm-integrations/hubspot/webhooks"
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/subscriptions"):
			listedApp = r.URL.Path
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"id": 1, "eventType": "contact.creation", "active": true},
			})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/subscriptions"):
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			if et, ok := payload["eventType"].(string); ok {
				createdTypes = append(createdTypes, et)
			}
			if property, ok := payload["propertyName"].(string); ok {
				createdProperties = append(createdProperties, property)
			}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 99})
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer srv.Close()

	registrar := HubSpotAppWebhookRegistrar{
		HTTPClient:      srv.Client(),
		APIBaseURL:      srv.URL,
		AppID:           "777",
		DeveloperAPIKey: "dev-key",
		TargetURL:       "https://app.postwave.test/api/public/crm-integrations/hubspot/webhooks",
		EventTypes:      []string{"contact.creation", "contact.propertyChange", "contact.deletion"},
		PropertyNames:   []string{"email"},
	}
	summary, err := registrar.ReconcileSubscriptions(context.Background())
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !strings.Contains(listedApp, "/webhooks/2026-3/777/subscriptions") {
		t.Fatalf("listed app path = %q", listedApp)
	}
	want := map[string]bool{"contact.propertyChange": true, "contact.deletion": true}
	if len(createdTypes) != 2 {
		t.Fatalf("created %v, want the 2 missing types", createdTypes)
	}
	for _, et := range createdTypes {
		if !want[et] {
			t.Fatalf("unexpected created type %q", et)
		}
	}
	if len(createdProperties) != 1 || createdProperties[0] != "email" {
		t.Fatalf("property-change payloads = %v", createdProperties)
	}
	if !settingsUpdated || !summary.SettingsUpdated || summary.Created != 2 || summary.Existing != 1 {
		t.Fatalf("summary = %+v", summary)
	}
}

type hubSpotWebhookRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn hubSpotWebhookRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestHubSpotAppWebhookRegistrarDoesNotLeakDeveloperKeyOnTransportFailure(t *testing.T) {
	const developerKey = "developer-key-must-not-leak"
	client := &http.Client{
		Transport: hubSpotWebhookRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			return nil, fmt.Errorf("dial failed for %s", req.URL.String())
		}),
	}
	registrar := HubSpotAppWebhookRegistrar{
		HTTPClient:      client,
		APIBaseURL:      "https://api.hubapi.com",
		AppID:           "777",
		DeveloperAPIKey: developerKey,
		TargetURL:       "https://app.postwave.test/api/public/crm-integrations/hubspot/webhooks",
	}
	_, err := registrar.ReconcileSubscriptions(context.Background())
	if err == nil {
		t.Fatal("transport failure was accepted")
	}
	if strings.Contains(err.Error(), developerKey) || strings.Contains(err.Error(), "hapikey") {
		t.Fatalf("transport error leaked developer credential: %v", err)
	}
}

type recordingHubSpotProfileSink struct {
	contacts          []ContactInput
	lifecycleStates   []string
	lifecycleSources  []string
	lifecycleMetadata []map[string]any
	lifecycleID       string
	lifecycleFound    bool
	lifecycleErr      error
}

func (s *recordingHubSpotProfileSink) UpsertCRMContact(_ context.Context, _ string, _ Integration, contact ContactInput) (string, error) {
	s.contacts = append(s.contacts, contact)
	return "sub_1", nil
}

func (s *recordingHubSpotProfileSink) ReconcileCRMContactState(
	_ context.Context,
	_ string,
	_ Integration,
	sourceID, state string,
	metadata map[string]any,
) (string, bool, error) {
	s.lifecycleSources = append(s.lifecycleSources, sourceID)
	s.lifecycleStates = append(s.lifecycleStates, state)
	s.lifecycleMetadata = append(s.lifecycleMetadata, metadata)
	return s.lifecycleID, s.lifecycleFound, s.lifecycleErr
}

type fakeHubSpotFetcherBackfiller struct {
	contact ContactInput
	ok      bool
}

func (f fakeHubSpotFetcherBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	return SyncRequest{RunMode: "backfill", Cursor: hubSpotCursorComplete}, nil
}

func (f fakeHubSpotFetcherBackfiller) FetchContactByID(_ context.Context, _ string, _ Integration, _ string) (ContactInput, bool, error) {
	return f.contact, f.ok, nil
}

type flakyHubSpotFetcherBackfiller struct {
	failures map[string]int
}

func (f *flakyHubSpotFetcherBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	return SyncRequest{RunMode: "backfill", Cursor: hubSpotCursorComplete}, nil
}

func (f *flakyHubSpotFetcherBackfiller) FetchContactByID(_ context.Context, _ string, _ Integration, objectID string) (ContactInput, bool, error) {
	if f.failures[objectID] > 0 {
		f.failures[objectID]--
		return ContactInput{}, false, errors.New("temporary HubSpot contact fetch failure")
	}
	return ContactInput{
		SourceID: "hubspot://contact/" + objectID,
		Email:    "contact-" + objectID + "@example.com",
	}, true, nil
}

func signedHubSpotWebhookRequest(t *testing.T, deps *Deps, now time.Time, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	uri := "https://app.postwave.test/api/public/crm-integrations/hubspot/webhooks"
	ts := strconv.FormatInt(now.UnixMilli(), 10)
	sig := hubSpotV3Signature("app-secret", http.MethodPost, uri, body, ts)
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/hubspot/webhooks", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HubSpot-Signature-v3", sig)
	req.Header.Set("X-HubSpot-Request-Timestamp", ts)
	rec := httptest.NewRecorder()
	deps.HubSpotWebhook(rec, req)
	return rec
}

func TestHubSpotWebhookProcessesContactCreation(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration = Integration{ID: "int_1", TenantID: "tenant-1", Provider: ProviderHubSpot, Status: "connected", Settings: map[string]any{
		"portal_id":            "12345678",
		"hubspot_app_id":       "777",
		"hubspot_auth_mode":    "managed_oauth",
		"hubspot_webhook_mode": "app_level_oauth_install",
	}}
	store.webhookClaim = WebhookClaimed
	sink := &recordingHubSpotProfileSink{}
	deps := &Deps{
		Repo:              store,
		Profiles:          sink,
		Now:               func() time.Time { return now },
		HubSpotOAuth:      HubSpotOAuthConfig{AppID: "777", ClientSecret: "app-secret"},
		HubSpotBackfiller: fakeHubSpotFetcherBackfiller{contact: ContactInput{SourceID: "hubspot://contact/501", Email: "ada@example.com"}, ok: true},
		PublicBaseURL:     "https://app.postwave.test",
	}
	body := []byte(`[{"eventId":1,"eventType":"contact.creation","appId":777,"portalId":12345678,"objectId":501}]`)
	uri := "https://app.postwave.test/api/public/crm-integrations/hubspot/webhooks"
	ts := strconv.FormatInt(now.UnixMilli(), 10)
	sig := hubSpotV3Signature("app-secret", http.MethodPost, uri, body, ts)

	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/hubspot/webhooks", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HubSpot-Signature-v3", sig)
	req.Header.Set("X-HubSpot-Request-Timestamp", ts)
	rec := httptest.NewRecorder()

	deps.HubSpotWebhook(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(sink.contacts) != 1 || sink.contacts[0].Email != "ada@example.com" {
		t.Fatalf("contact not upserted: %+v", sink.contacts)
	}
}

func TestHubSpotWebhookPartialBatchFailureReturnsRetryableAndReplaysOnlyFailedEvent(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration = Integration{
		ID: "int_1", TenantID: "tenant-1", Provider: ProviderHubSpot, Status: "connected",
		Settings: map[string]any{
			"portal_id":         "12345678",
			"hubspot_app_id":    "777",
			"hubspot_auth_mode": "managed_oauth",
		},
	}
	sink := &recordingHubSpotProfileSink{}
	fetcher := &flakyHubSpotFetcherBackfiller{failures: map[string]int{"501": 1}}
	deps := &Deps{
		Repo:              store,
		Profiles:          sink,
		Now:               func() time.Time { return now },
		HubSpotOAuth:      HubSpotOAuthConfig{AppID: "777", ClientSecret: "app-secret"},
		HubSpotBackfiller: fetcher,
		PublicBaseURL:     "https://app.postwave.test",
	}
	body := []byte(`[
		{"eventId":44,"subscriptionType":"contact.creation","appId":777,"portalId":12345678,"objectId":501,"occurredAt":1720000000000},
		{"eventId":44,"subscriptionType":"contact.creation","appId":777,"portalId":12345678,"objectId":502,"occurredAt":1720000000000}
	]`)

	first := signedHubSpotWebhookRequest(t, deps, now, body)
	if first.Code != http.StatusServiceUnavailable || first.Header().Get("Retry-After") != "10" {
		t.Fatalf("first status=%d retry-after=%q body=%s", first.Code, first.Header().Get("Retry-After"), first.Body.String())
	}
	if len(sink.contacts) != 1 || sink.contacts[0].SourceID != "hubspot://contact/502" {
		t.Fatalf("first delivery contacts=%+v", sink.contacts)
	}

	retry := signedHubSpotWebhookRequest(t, deps, now, body)
	if retry.Code != http.StatusAccepted {
		t.Fatalf("retry status=%d body=%s", retry.Code, retry.Body.String())
	}
	var summary HubSpotWebhookSummary
	if err := json.NewDecoder(retry.Body).Decode(&summary); err != nil {
		t.Fatalf("decode retry summary: %v", err)
	}
	if summary.Processed != 1 || summary.Duplicate != 1 || summary.Failed != 0 {
		t.Fatalf("retry summary=%+v", summary)
	}
	if len(sink.contacts) != 2 || sink.contacts[1].SourceID != "hubspot://contact/501" {
		t.Fatalf("retried contacts=%+v", sink.contacts)
	}
}

func TestHubSpotWebhookFinalizationFailureAndInProgressClaimReturnRetryable(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration = Integration{
		ID: "int_1", TenantID: "tenant-1", Provider: ProviderHubSpot, Status: "connected",
		Settings: map[string]any{
			"portal_id":         "12345678",
			"hubspot_app_id":    "777",
			"hubspot_auth_mode": "managed_oauth",
		},
	}
	store.markWebhookProcessedErr = errors.New("temporary ledger finalization failure")
	profiles := &recordingHubSpotProfileSink{lifecycleFound: false}
	deps := &Deps{
		Repo:          store,
		Profiles:      profiles,
		Now:           func() time.Time { return now },
		HubSpotOAuth:  HubSpotOAuthConfig{AppID: "777", ClientSecret: "app-secret"},
		PublicBaseURL: "https://app.postwave.test",
	}
	body := []byte(`[{"eventId":91,"subscriptionType":"contact.deletion","appId":777,"portalId":12345678,"objectId":501,"occurredAt":1720000000000}]`)

	first := signedHubSpotWebhookRequest(t, deps, now, body)
	if first.Code != http.StatusServiceUnavailable || first.Header().Get("Retry-After") != "10" {
		t.Fatalf("finalization failure status=%d retry-after=%q body=%s", first.Code, first.Header().Get("Retry-After"), first.Body.String())
	}
	store.markWebhookProcessedErr = nil
	retry := signedHubSpotWebhookRequest(t, deps, now, body)
	if retry.Code != http.StatusServiceUnavailable || retry.Header().Get("Retry-After") != "10" {
		t.Fatalf("in-progress retry status=%d retry-after=%q body=%s", retry.Code, retry.Header().Get("Retry-After"), retry.Body.String())
	}
	if len(profiles.lifecycleStates) != 1 {
		t.Fatalf("in-progress retry reapplied lifecycle transition: %v", profiles.lifecycleStates)
	}
}

func TestHandleHubSpotWebhookReconcilesDeletionAndNoEmailWithoutChangingSubscriberLifecycle(t *testing.T) {
	integration := &Integration{
		ID: "int_1", TenantID: "tenant-1", Provider: ProviderHubSpot, Status: "connected",
	}
	for _, test := range []struct {
		name          string
		eventType     string
		fetchOK       bool
		expectedState string
	}{
		{
			name:          "deletion",
			eventType:     "contact.deletion",
			expectedState: "deleted",
		},
		{
			name:          "privacy deletion",
			eventType:     "contact.privacyDeletion",
			expectedState: "privacy_deleted",
		},
		{
			name:          "property change without a resolvable primary email",
			eventType:     "contact.propertyChange",
			fetchOK:       false,
			expectedState: "no_email",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			profiles := &recordingHubSpotProfileSink{
				lifecycleID:    "sub_1",
				lifecycleFound: true,
			}
			memberships := &fakeCRMListMembershipSink{}
			deps := &Deps{
				Profiles:          profiles,
				ListMemberships:   memberships,
				HubSpotBackfiller: fakeHubSpotFetcherBackfiller{ok: test.fetchOK},
			}
			err := deps.handleHubSpotWebhookEvent(context.Background(), integration, hubSpotWebhookEvent{
				EventID:          json.Number("91"),
				SubscriptionType: test.eventType,
				ObjectID:         json.Number("501"),
				OccurredAt:       1234,
			})
			if err != nil {
				t.Fatalf("handle lifecycle event: %v", err)
			}
			if len(profiles.lifecycleStates) != 1 ||
				profiles.lifecycleStates[0] != test.expectedState ||
				profiles.lifecycleSources[0] != "hubspot://contact/501" {
				t.Fatalf("lifecycle states=%v sources=%v", profiles.lifecycleStates, profiles.lifecycleSources)
			}
			if len(memberships.contactRemoved) != 1 {
				t.Fatalf("contact-owned memberships removed=%+v", memberships.contactRemoved)
			}
			removed := memberships.contactRemoved[0]
			if removed.IntegrationID != integration.ID ||
				removed.Provider != ProviderHubSpot ||
				removed.SubscriberID != "sub_1" {
				t.Fatalf("membership removal=%+v", removed)
			}
		})
	}
}

func TestHandleHubSpotWebhookUnknownBindingIsIdempotentNoOp(t *testing.T) {
	integration := &Integration{
		ID: "int_1", TenantID: "tenant-1", Provider: ProviderHubSpot, Status: "connected",
	}
	profiles := &recordingHubSpotProfileSink{lifecycleFound: false}
	deps := &Deps{Profiles: profiles}
	event := hubSpotWebhookEvent{
		EventID:          json.Number("92"),
		SubscriptionType: "contact.deletion",
		ObjectID:         json.Number("999"),
	}
	for i := 0; i < 2; i++ {
		if err := deps.handleHubSpotWebhookEvent(context.Background(), integration, event); err != nil {
			t.Fatalf("unknown binding pass %d: %v", i+1, err)
		}
	}
	if len(profiles.lifecycleStates) != 2 {
		t.Fatalf("lifecycle calls=%v", profiles.lifecycleStates)
	}
}

func TestHandleHubSpotWebhookKnownDeletionIsRetrySafe(t *testing.T) {
	integration := &Integration{
		ID: "int_1", TenantID: "tenant-1", Provider: ProviderHubSpot, Status: "connected",
	}
	profiles := &recordingHubSpotProfileSink{
		lifecycleID:    "sub_1",
		lifecycleFound: true,
	}
	memberships := &fakeCRMListMembershipSink{}
	deps := &Deps{Profiles: profiles, ListMemberships: memberships}
	event := hubSpotWebhookEvent{
		EventID:          json.Number("93"),
		SubscriptionType: "contact.deletion",
		ObjectID:         json.Number("501"),
	}
	for i := 0; i < 2; i++ {
		if err := deps.handleHubSpotWebhookEvent(context.Background(), integration, event); err != nil {
			t.Fatalf("known deletion pass %d: %v", i+1, err)
		}
	}
	if len(profiles.lifecycleStates) != 2 || len(memberships.contactRemoved) != 2 {
		t.Fatalf(
			"lifecycle calls=%v membership removals=%+v",
			profiles.lifecycleStates,
			memberships.contactRemoved,
		)
	}
}

func TestHubSpotWebhookClaimIdentityDoesNotTrustEventIDUniqueness(t *testing.T) {
	base := hubSpotWebhookEvent{
		AppID:            json.Number("777"),
		PortalID:         json.Number("12345678"),
		EventID:          json.Number("44"),
		SubscriptionID:   json.Number("71"),
		SubscriptionType: "contact.deletion",
		ObjectID:         json.Number("501"),
		OccurredAt:       1720000000000,
		PropertyName:     "email",
		PropertyValue:    json.RawMessage(`{"token":"sensitive-literal","version":1}`),
		ChangeSource:     "CRM_UI",
		AttemptNumber:    1,
	}
	baseID, baseBody := hubSpotWebhookEventClaim(base)
	otherObject := base
	otherObject.ObjectID = json.Number("502")
	otherObjectID, _ := hubSpotWebhookEventClaim(otherObject)
	otherType := base
	otherType.SubscriptionType = "contact.privacyDeletion"
	otherTypeID, _ := hubSpotWebhookEventClaim(otherType)
	otherSubscription := base
	otherSubscription.SubscriptionID = json.Number("72")
	otherSubscriptionID, _ := hubSpotWebhookEventClaim(otherSubscription)
	otherValue := base
	otherValue.PropertyValue = json.RawMessage(`{"token":"different-sensitive-literal","version":1}`)
	otherValueID, _ := hubSpotWebhookEventClaim(otherValue)
	retry := base
	retry.AttemptNumber = 9
	retryID, retryBody := hubSpotWebhookEventClaim(retry)
	if baseID == otherObjectID ||
		baseID == otherTypeID ||
		baseID == otherSubscriptionID ||
		baseID == otherValueID {
		t.Fatalf(
			"claim ids collided: base=%q object=%q type=%q subscription=%q value=%q",
			baseID,
			otherObjectID,
			otherTypeID,
			otherSubscriptionID,
			otherValueID,
		)
	}
	if retryID != baseID || !bytes.Equal(retryBody, baseBody) {
		t.Fatalf("same event is not deterministic: id %q/%q body %q/%q", baseID, retryID, baseBody, retryBody)
	}
	if bytes.Contains(baseBody, []byte("[")) {
		t.Fatalf("claim body must be one canonical event, got %s", baseBody)
	}
	if bytes.Contains(baseBody, []byte("sensitive-literal")) || bytes.Contains(baseBody, []byte(`"attempt_number"`)) {
		t.Fatalf("claim body retained a sensitive property value or retry attempt: %s", baseBody)
	}
}

func TestProcessHubSpotWebhookClaimsEachCanonicalEventIndependentOfBatching(t *testing.T) {
	store := newFakeStore()
	store.integration = Integration{
		ID: "int_1", TenantID: "tenant-1", Provider: ProviderHubSpot, Status: "connected",
		Settings: map[string]any{
			"portal_id":         "12345678",
			"hubspot_app_id":    "777",
			"hubspot_auth_mode": "managed_oauth",
		},
	}
	profiles := &recordingHubSpotProfileSink{lifecycleFound: false}
	deps := &Deps{
		Repo:         store,
		Profiles:     profiles,
		HubSpotOAuth: HubSpotOAuthConfig{AppID: "777"},
	}
	first := hubSpotWebhookEvent{
		AppID:            json.Number("777"),
		PortalID:         json.Number("12345678"),
		EventID:          json.Number("44"),
		SubscriptionType: "contact.deletion",
		ObjectID:         json.Number("501"),
		OccurredAt:       1720000000000,
	}
	second := first
	second.ObjectID = json.Number("502")
	summary, err := deps.processHubSpotWebhookEvents(
		context.Background(),
		[]hubSpotWebhookEvent{first, second},
		[]byte(`[{"different":"batch-shape"}]`),
	)
	if err != nil {
		t.Fatalf("process first batch: %v", err)
	}
	if summary.Processed != 2 || store.webhookClaimCount != 2 {
		t.Fatalf("summary=%+v claims=%d", summary, store.webhookClaimCount)
	}
	firstID, firstBody := hubSpotWebhookEventClaim(first)
	secondID, secondBody := hubSpotWebhookEventClaim(second)
	if firstID == secondID {
		t.Fatalf("same eventId produced same claim for different contacts: %q", firstID)
	}
	if store.lastWebhookID != secondID ||
		store.lastWebhookProcessedID != secondID ||
		!bytes.Equal(store.lastWebhookBody, secondBody) {
		t.Fatalf(
			"last claim id=%q processed=%q body=%s, want id=%q body=%s",
			store.lastWebhookID,
			store.lastWebhookProcessedID,
			store.lastWebhookBody,
			secondID,
			secondBody,
		)
	}

	retry, err := deps.processHubSpotWebhookEvents(
		context.Background(),
		[]hubSpotWebhookEvent{first},
		[]byte(`[{"same-event":"retried-in-another-batch"}]`),
	)
	if err != nil {
		t.Fatalf("process retry batch: %v", err)
	}
	if retry.Processed != 0 ||
		retry.Duplicate != 1 ||
		store.lastWebhookID != firstID ||
		!bytes.Equal(store.lastWebhookBody, firstBody) {
		t.Fatalf("retry summary=%+v id=%q body=%s", retry, store.lastWebhookID, store.lastWebhookBody)
	}
}

func TestHubSpotWebhookIgnoresPausedIntegration(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	store := newFakeStore()
	store.integration = Integration{ID: "int_1", TenantID: "tenant-1", Provider: ProviderHubSpot, Status: "paused", Settings: map[string]any{
		"portal_id":         "12345678",
		"hubspot_app_id":    "777",
		"hubspot_auth_mode": "managed_oauth",
	}}
	sink := &recordingHubSpotProfileSink{}
	deps := &Deps{
		Repo:              store,
		Profiles:          sink,
		Now:               func() time.Time { return now },
		HubSpotOAuth:      HubSpotOAuthConfig{AppID: "777", ClientSecret: "app-secret"},
		HubSpotBackfiller: fakeHubSpotFetcherBackfiller{contact: ContactInput{SourceID: "hubspot://contact/501", Email: "ada@example.com"}, ok: true},
		PublicBaseURL:     "https://app.postwave.test",
	}
	body := []byte(`[{"eventId":1,"subscriptionType":"contact.creation","appId":777,"portalId":12345678,"objectId":501}]`)
	uri := "https://app.postwave.test/api/public/crm-integrations/hubspot/webhooks"
	ts := strconv.FormatInt(now.UnixMilli(), 10)
	sig := hubSpotV3Signature("app-secret", http.MethodPost, uri, body, ts)

	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/hubspot/webhooks", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HubSpot-Signature-v3", sig)
	req.Header.Set("X-HubSpot-Request-Timestamp", ts)
	rec := httptest.NewRecorder()

	deps.HubSpotWebhook(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var summary HubSpotWebhookSummary
	if err := json.NewDecoder(rec.Body).Decode(&summary); err != nil {
		t.Fatal(err)
	}
	if summary.Processed != 0 || summary.Ignored != 1 || len(sink.contacts) != 0 || store.webhookClaimCount != 0 {
		t.Fatalf("summary=%+v contacts=%+v claims=%d", summary, sink.contacts, store.webhookClaimCount)
	}
}

func TestHubSpotWebhookDoesNotRoutePrivateAppOrDifferentAppInstall(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name     string
		settings map[string]any
		eventApp string
	}{
		{
			name: "private app is polling only",
			settings: map[string]any{
				"portal_id":            "12345678",
				"hubspot_auth_mode":    "private_app",
				"hubspot_webhook_mode": "polling_only",
			},
			eventApp: "777",
		},
		{
			name: "different public app id",
			settings: map[string]any{
				"portal_id":         "12345678",
				"hubspot_app_id":    "777",
				"hubspot_auth_mode": "managed_oauth",
			},
			eventApp: "888",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := newFakeStore()
			store.integration = Integration{
				ID: "int_1", TenantID: "tenant-1", Provider: ProviderHubSpot,
				Status: "connected", Settings: test.settings,
			}
			sink := &recordingHubSpotProfileSink{}
			deps := &Deps{
				Repo:              store,
				Profiles:          sink,
				Now:               func() time.Time { return now },
				HubSpotOAuth:      HubSpotOAuthConfig{AppID: "777", ClientSecret: "app-secret"},
				HubSpotBackfiller: fakeHubSpotFetcherBackfiller{contact: ContactInput{SourceID: "hubspot://contact/501", Email: "ada@example.com"}, ok: true},
				PublicBaseURL:     "https://app.postwave.test",
			}
			body := []byte(`[{"eventId":1,"subscriptionType":"contact.creation","appId":` + test.eventApp + `,"portalId":12345678,"objectId":501}]`)
			uri := "https://app.postwave.test/api/public/crm-integrations/hubspot/webhooks"
			ts := strconv.FormatInt(now.UnixMilli(), 10)
			sig := hubSpotV3Signature("app-secret", http.MethodPost, uri, body, ts)
			req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/hubspot/webhooks", bytes.NewReader(body))
			req.Header.Set("X-HubSpot-Signature-v3", sig)
			req.Header.Set("X-HubSpot-Request-Timestamp", ts)
			rec := httptest.NewRecorder()

			deps.HubSpotWebhook(rec, req)
			if rec.Code != http.StatusAccepted {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			var summary HubSpotWebhookSummary
			if err := json.NewDecoder(rec.Body).Decode(&summary); err != nil {
				t.Fatal(err)
			}
			if summary.Processed != 0 || summary.Ignored != 1 || len(sink.contacts) != 0 || store.webhookClaimCount != 0 {
				t.Fatalf("summary=%+v contacts=%+v claims=%d", summary, sink.contacts, store.webhookClaimCount)
			}
		})
	}
}

func TestHubSpotWebhookRejectsBadSignature(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	deps := &Deps{
		Repo:          newFakeStore(),
		Now:           func() time.Time { return now },
		HubSpotOAuth:  HubSpotOAuthConfig{AppID: "777", ClientSecret: "app-secret"},
		PublicBaseURL: "https://app.postwave.test",
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/crm-integrations/hubspot/webhooks", bytes.NewReader([]byte(`[]`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-HubSpot-Signature-v3", "wrong-signature")
	req.Header.Set("X-HubSpot-Request-Timestamp", strconv.FormatInt(now.UnixMilli(), 10))
	rec := httptest.NewRecorder()

	deps.HubSpotWebhook(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}
