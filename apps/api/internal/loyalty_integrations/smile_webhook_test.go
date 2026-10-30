// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestVerifySmileWebhookSignature(t *testing.T) {
	body := []byte(`{"account_id":304169228,"topic":"ping","data":{}}`)
	secret := "smile_client_secret"
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	timestamp := "1782648000"
	signature := smileTestSignature(secret, timestamp, body)
	if !VerifySmileWebhookSignature(secret, body, timestamp, signature, now) {
		t.Fatal("expected Smile signature to verify")
	}
	if VerifySmileWebhookSignature(secret, body, timestamp, signature, now.Add(6*time.Minute)) {
		t.Fatal("expected stale Smile signature to fail")
	}
	if VerifySmileWebhookSignature(secret, []byte(`{"changed":true}`), timestamp, signature, now) {
		t.Fatal("expected tampered Smile body to fail")
	}
}

func TestSmileWebhookAuthenticatesAndMapsCustomerUpdated(t *testing.T) {
	body := `{
		"account_id":304169228,
		"topic":"customer/updated",
		"data":{"customer":{
			"id":42,
			"email":"Ada@Example.com",
			"first_name":"Ada",
			"last_name":"L",
			"points_balance":275,
			"vip_status":{"vip_tier":{"name":"Gold"}},
			"updated_at":"2026-06-28T10:15:27.893Z"
		}}
	}`
	store := newFakeStore()
	store.integration.Settings = map[string]any{
		"shop_domain":        "acme.myshopify.com",
		"account_id":         "304169228",
		"webhook_secret_ref": "cred_smile_webhook_1",
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:           store,
		Profiles:       profiles,
		Events:         events,
		WebhookSecrets: fakeLoyaltySecretResolver{json: "smile_client_secret"},
		Now:            func() time.Time { return time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC) },
	}
	rec := serveSmileWebhook(deps, body, "smile_client_secret", "1782648000")
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "completed" || out.MembersUpserted != 1 || out.EventsTracked != 1 || out.RunID == "" {
		t.Fatalf("summary=%+v", out)
	}
	if len(profiles.members) != 1 || profiles.members[0].SourceID != "smile://customer/42" ||
		profiles.members[0].Email != "ada@example.com" ||
		profiles.members[0].VIPTier != "Gold" ||
		profiles.members[0].Properties["smile_account_id"] != "304169228" {
		t.Fatalf("members=%+v", profiles.members)
	}
	if len(events.events) != 1 || events.events[0].EventName != "loyalty.customer_updated" ||
		events.events[0].Properties["smile_webhook_topic"] != "customer/updated" {
		t.Fatalf("events=%+v", events.events)
	}
	deliveryID := smileWebhookDeliveryID(smileWebhookEvent{AccountID: "304169228", Topic: "customer/updated"}, []byte(body))
	if store.webhooks[loyaltyWebhookFakeKey(store.integration.ID, ProviderSmile, deliveryID)] != WebhookProcessed {
		t.Fatalf("webhook claim=%+v delivery=%s", store.webhooks, deliveryID)
	}
}

func TestSmileWebhookReplayUsesDurableClaim(t *testing.T) {
	body := `{"account_id":304169228,"topic":"customer/updated","data":{"customer":{"id":42,"email":"Ada@Example.com","points_balance":275}}}`
	store := newFakeStore()
	store.integration.Settings = map[string]any{"account_id": "304169228", "webhook_secret_ref": "cred_smile_webhook_1"}
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:           store,
		Profiles:       profiles,
		Events:         &fakeEventSink{},
		WebhookSecrets: fakeLoyaltySecretResolver{json: "smile_client_secret"},
		Now:            func() time.Time { return time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC) },
	}
	first := serveSmileWebhook(deps, body, "smile_client_secret", "1782648000")
	if first.Code != http.StatusOK {
		t.Fatalf("first status=%d body=%s", first.Code, first.Body.String())
	}
	second := serveSmileWebhook(deps, body, "smile_client_secret", "1782648000")
	if second.Code != http.StatusOK || !strings.Contains(second.Body.String(), "duplicate") {
		t.Fatalf("second status=%d body=%s", second.Code, second.Body.String())
	}
	if len(profiles.members) != 1 {
		t.Fatalf("duplicate should not reprocess member, got %+v", profiles.members)
	}
}

func TestSmileWebhookInProgressClaimReturnsRetry(t *testing.T) {
	body := `{"account_id":304169228,"topic":"customer/updated","data":{"customer":{"id":42,"email":"Ada@Example.com"}}}`
	store := newFakeStore()
	store.integration.Settings = map[string]any{"account_id": "304169228", "webhook_secret_ref": "cred_smile_webhook_1"}
	deliveryID := smileWebhookDeliveryID(smileWebhookEvent{AccountID: "304169228", Topic: "customer/updated"}, []byte(body))
	store.webhooks[loyaltyWebhookFakeKey(store.integration.ID, ProviderSmile, deliveryID)] = WebhookInProgress
	deps := &Deps{
		Repo:           store,
		Profiles:       &fakeProfileSink{},
		WebhookSecrets: fakeLoyaltySecretResolver{json: "smile_client_secret"},
		Now:            func() time.Time { return time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC) },
	}
	rec := serveSmileWebhook(deps, body, "smile_client_secret", "1782648000")
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("Retry-After") != "10" {
		t.Fatalf("status=%d retry=%q body=%s", rec.Code, rec.Header().Get("Retry-After"), rec.Body.String())
	}
}

func TestSmileWebhookRejectsInvalidSignature(t *testing.T) {
	body := `{"account_id":304169228,"topic":"customer/updated","data":{"customer":{"id":42,"email":"Ada@Example.com"}}}`
	store := newFakeStore()
	store.integration.Settings = map[string]any{"account_id": "304169228", "webhook_secret_ref": "cred_smile_webhook_1"}
	deps := &Deps{
		Repo:           store,
		Profiles:       &fakeProfileSink{},
		WebhookSecrets: fakeLoyaltySecretResolver{json: "smile_client_secret"},
		Now:            func() time.Time { return time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC) },
	}
	rec := serveSmileWebhook(deps, body, "wrong_secret", "1782648000")
	if rec.Code != http.StatusUnauthorized || len(store.webhooks) != 0 {
		t.Fatalf("status=%d body=%s webhooks=%+v", rec.Code, rec.Body.String(), store.webhooks)
	}
}

func TestSmileWebhookMarksClaimFailedOnSyncFailure(t *testing.T) {
	body := `{"account_id":304169228,"topic":"customer/updated","data":{"customer":{"id":42,"email":"Ada@Example.com"}}}`
	store := newFakeStore()
	store.integration.Settings = map[string]any{"account_id": "304169228", "webhook_secret_ref": "cred_smile_webhook_1"}
	deps := &Deps{
		Repo:           store,
		Profiles:       &fakeProfileSink{err: errors.New("profile sink unavailable")},
		WebhookSecrets: fakeLoyaltySecretResolver{json: "smile_client_secret"},
		Now:            func() time.Time { return time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC) },
	}

	rec := serveSmileWebhook(deps, body, "smile_client_secret", "1782648000")
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "internal_error") || strings.Contains(rec.Body.String(), "webhook_processing_failed") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	deliveryID := smileWebhookDeliveryID(smileWebhookEvent{AccountID: "304169228", Topic: "customer/updated"}, []byte(body))
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if got := store.webhooks[loyaltyWebhookFakeKey(store.integration.ID, ProviderSmile, deliveryID)]; got != "" {
		t.Fatalf("failed claim should be retryable, got state=%q map=%+v", got, store.webhooks)
	}
}

func TestSmileWebhookRejectsSameDeliveryIDDifferentBody(t *testing.T) {
	body1 := `{"account_id":304169228,"topic":"customer/updated","data":{"customer":{"id":42,"email":"Ada@Example.com","points_balance":275}}}`
	body2 := `{"account_id":304169228,"topic":"customer/updated","data":{"customer":{"id":42,"email":"Ada@Example.com","points_balance":1}}}`
	store := newFakeStore()
	store.integration.Settings = map[string]any{"account_id": "304169228", "webhook_secret_ref": "cred_smile_webhook_1"}
	deps := &Deps{
		Repo:           store,
		Profiles:       &fakeProfileSink{},
		Events:         &fakeEventSink{},
		WebhookSecrets: fakeLoyaltySecretResolver{json: "smile_client_secret"},
		Now:            func() time.Time { return time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC) },
	}

	first := serveSmileWebhookWithHeaders(deps, body1, "smile_client_secret", "1782648000", map[string]string{"Smile-Delivery-Id": "delivery-1"})
	if first.Code != http.StatusOK {
		t.Fatalf("first status=%d body=%s", first.Code, first.Body.String())
	}
	second := serveSmileWebhookWithHeaders(deps, body2, "smile_client_secret", "1782648000", map[string]string{"Smile-Delivery-Id": "delivery-1"})
	if second.Code != http.StatusConflict || !strings.Contains(second.Body.String(), "webhook_body_mismatch") {
		t.Fatalf("second status=%d body=%s", second.Code, second.Body.String())
	}
	if len(store.runs) != 1 {
		t.Fatalf("mismatched body should not reprocess: runs=%+v", store.runs)
	}
}

func TestSmileWebhookRejectsMissingAccountID(t *testing.T) {
	body := `{"topic":"customer/updated","data":{"customer":{"id":42,"email":"Ada@Example.com"}}}`
	store := newFakeStore()
	store.integration.Settings = map[string]any{"account_id": "304169228", "webhook_secret_ref": "cred_smile_webhook_1"}
	deps := &Deps{
		Repo:           store,
		Profiles:       &fakeProfileSink{},
		WebhookSecrets: fakeLoyaltySecretResolver{json: "smile_client_secret"},
		Now:            func() time.Time { return time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC) },
	}
	rec := serveSmileWebhook(deps, body, "smile_client_secret", "1782648000")
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "missing_account_id") || len(store.webhooks) != 0 {
		t.Fatalf("status=%d body=%s webhooks=%+v", rec.Code, rec.Body.String(), store.webhooks)
	}
}

func TestSmileWebhookRejectsUnroutedAccountID(t *testing.T) {
	body := `{"account_id":999999,"topic":"customer/updated","data":{"customer":{"id":42,"email":"Ada@Example.com"}}}`
	store := newFakeStore()
	store.integration.Settings = map[string]any{"account_id": "304169228", "webhook_secret_ref": "cred_smile_webhook_1"}
	deps := &Deps{
		Repo:           store,
		Profiles:       &fakeProfileSink{},
		WebhookSecrets: fakeLoyaltySecretResolver{json: "smile_client_secret"},
		Now:            func() time.Time { return time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC) },
	}
	rec := serveSmileWebhook(deps, body, "smile_client_secret", "1782648000")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "integration_not_found") || len(store.webhooks) != 0 {
		t.Fatalf("status=%d body=%s webhooks=%+v", rec.Code, rec.Body.String(), store.webhooks)
	}
}

func TestSmileWebhookRejectsDisconnectedIntegrationWithoutClaim(t *testing.T) {
	body := `{"account_id":304169228,"topic":"customer/updated","data":{"customer":{"id":42,"email":"Ada@Example.com"}}}`
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.Settings = map[string]any{"account_id": "304169228", "webhook_secret_ref": "cred_smile_webhook_1"}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:           store,
		Profiles:       profiles,
		Events:         events,
		WebhookSecrets: fakeLoyaltySecretResolver{json: "smile_client_secret"},
		Now:            func() time.Time { return time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC) },
	}
	rec := serveSmileWebhook(deps, body, "smile_client_secret", "1782648000")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "integration_not_found") || len(store.webhooks) != 0 {
		t.Fatalf("status=%d body=%s webhooks=%+v", rec.Code, rec.Body.String(), store.webhooks)
	}
	if len(store.runs) != 0 || len(profiles.members) != 0 || len(events.events) != 0 {
		t.Fatalf("disconnected webhook should not process: runs=%+v members=%+v events=%+v", store.runs, profiles.members, events.events)
	}
}

func TestSmileWebhookPingIsVerifiedAndIgnored(t *testing.T) {
	body := `{"account_id":304169228,"topic":"ping","data":{}}`
	store := newFakeStore()
	store.integration.Settings = map[string]any{"account_id": "304169228", "webhook_secret_ref": "cred_smile_webhook_1"}
	deps := &Deps{
		Repo:           store,
		Profiles:       &fakeProfileSink{},
		WebhookSecrets: fakeLoyaltySecretResolver{json: "smile_client_secret"},
		Now:            func() time.Time { return time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC) },
	}
	rec := serveSmileWebhook(deps, body, "smile_client_secret", "1782648000")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "ignored") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func serveSmileWebhook(deps *Deps, body, secret, timestamp string) *httptest.ResponseRecorder {
	return serveSmileWebhookWithHeaders(deps, body, secret, timestamp, nil)
}

func serveSmileWebhookWithHeaders(deps *Deps, body, secret, timestamp string, headers map[string]string) *httptest.ResponseRecorder {
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	req := httptest.NewRequest(http.MethodPost, "/api/public/loyalty-integrations/smile/webhooks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Smile-Timestamp", timestamp)
	req.Header.Set("Smile-Signature", smileTestSignature(secret, timestamp, []byte(body)))
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func smileTestSignature(secret, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp))
	_, _ = mac.Write([]byte("."))
	_, _ = mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
