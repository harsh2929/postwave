// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseWisepopsCredentialSecret(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{name: "plain", raw: "site_api_key", want: "site_api_key"},
		{name: "json", raw: `{"api_key":"json_key","user_agent":"Moosewave Test"}`, want: "json_key"},
		{name: "key value", raw: "api_key=kv_key&user_agent=Moosewave", want: "kv_key"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			creds, err := parseWisepopsCredentialSecret(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if creds.APIKey != tc.want {
				t.Fatalf("api_key=%q want %q", creds.APIKey, tc.want)
			}
		})
	}
}

func TestWisepopsWebhookIngestsSignedContacts(t *testing.T) {
	store := wisepopsFakeStore()
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		Events:              events,
		WisepopsCredentials: fakeWisepopsCredentialResolver{creds: WisepopsCredentials{APIKey: "wisepops_api_key"}},
		Now:                 func() time.Time { return time.Date(2026, 7, 4, 13, 0, 0, 0, time.UTC) },
		MaxSyncRows:         10,
		PublicBaseURL:       "https://app.postwave.test",
	}
	body := `[{"id":"contact_123","email":"Lead@Example.com","first_name":"Ada","last_name":"Lovelace","phone":"+15551234567","company":"Moosewave","collected_at":"2026-07-04T12:00:00Z","secret":"do_not_store"},{"id":"contact_456","email":"second@example.com","name":"Second Lead"}]`
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/wisepops/webhooks?account_id=acct_123&campaign_id=campaign_456", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wisepops-Signature", wisepopsTestSignature("wisepops_api_key", body))
	req.Header.Set("X-Wisepops-Delivery-ID", "delivery_123")
	rec := httptest.NewRecorder()

	deps.WisepopsWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 2 || len(events.submissions) != 2 {
		t.Fatalf("profiles=%d events=%d", len(profiles.submissions), len(events.submissions))
	}
	got := profiles.submissions[0]
	if got.Email != "lead@example.com" ||
		got.FirstName != "Ada" ||
		got.LastName != "Lovelace" ||
		got.Company != "Moosewave" ||
		got.FormID != "campaign_456" ||
		got.FormName != "Summer Popup" ||
		got.SourceID != "wisepops://lead/acct_123/campaign_456/wisepops_contact_123" {
		t.Fatalf("submission=%+v", got)
	}
	if got.SubmittedAt == nil || !got.SubmittedAt.Equal(time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("submitted_at=%v", got.SubmittedAt)
	}
	if !containsFold(got.Tags, "wisepops") || !containsFold(got.Tags, "wisepops:acct_123") || !containsFold(got.Tags, "launch") {
		t.Fatalf("tags=%+v", got.Tags)
	}
	if _, ok := got.Fields["wisepops_field.secret"]; ok {
		t.Fatalf("secret leaked into field map: %+v", got.Fields)
	}
	raw, ok := got.Fields["wisepops_provider_raw"].(map[string]any)
	if !ok || raw["secret"] != "[redacted]" {
		t.Fatalf("provider raw redaction failed: %+v", got.Fields["wisepops_provider_raw"])
	}
	if store.webhooks[ProviderWisepops+":wisepops_delivery_delivery_123"] != WebhookProcessed {
		t.Fatalf("webhook claim=%+v", store.webhooks)
	}
}

func TestWisepopsWebhookDedupesProcessedDelivery(t *testing.T) {
	store := wisepopsFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		WisepopsCredentials: fakeWisepopsCredentialResolver{creds: WisepopsCredentials{APIKey: "wisepops_api_key"}},
	}
	body := `[{"id":"contact_123","email":"lead@example.com"}]`
	target := "/api/public/lead-integrations/wisepops/webhooks?account_id=acct_123&campaign_id=campaign_456"

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wisepops-Signature", wisepopsTestSignature("wisepops_api_key", body))
	req.Header.Set("X-Wisepops-Delivery-ID", "delivery_123")
	deps.WisepopsWebhook(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wisepops-Signature", wisepopsTestSignature("wisepops_api_key", body))
	req.Header.Set("X-Wisepops-Delivery-ID", "delivery_123")
	deps.WisepopsWebhook(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("duplicate status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 {
		t.Fatalf("duplicate should not reprocess: %+v", profiles.submissions)
	}
}

func TestWisepopsWebhookRejectsBadSignature(t *testing.T) {
	store := wisepopsFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		WisepopsCredentials: fakeWisepopsCredentialResolver{creds: WisepopsCredentials{APIKey: "wisepops_api_key"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/wisepops/webhooks?account_id=acct_123&campaign_id=campaign_456", strings.NewReader(`[{"email":"lead@example.com"}]`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Wisepops-Signature", "bad")
	rec := httptest.NewRecorder()

	deps.WisepopsWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 {
		t.Fatalf("unexpected submissions=%+v", profiles.submissions)
	}
}

func TestDisconnectWisepopsReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := wisepopsFakeStore()
	store.integration.Settings["provider_cleanup"] = map[string]any{"status": "stale"}
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
	if out.ProviderCleanup.Provider != ProviderWisepops ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderScopeType != "wisepops_account_campaign" ||
		out.ProviderCleanup.ProviderScopeID != "acct_123/campaign_456" ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_review_wisepops_webhook_hook" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["provider"] != ProviderWisepops ||
		stored["provider_scope_id"] != "acct_123/campaign_456" ||
		stored["webhook_cleanup_status"] != "operator_review_wisepops_webhook_hook" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func wisepopsFakeStore() *fakeStore {
	store := newFakeStore()
	store.integration.Provider = ProviderWisepops
	store.integration.CredentialsRef = "cred_wisepops_1"
	store.integration.Status = "connected"
	store.integration.Settings = map[string]any{
		"account_id":      "acct_123",
		"campaign_id":     "campaign_456",
		"campaign_name":   "Summer Popup",
		"credentials_ref": "cred_wisepops_1",
		"default_tags":    "launch",
	}
	return store
}

type fakeWisepopsCredentialResolver struct {
	creds WisepopsCredentials
	err   error
}

func (f fakeWisepopsCredentialResolver) ResolveWisepops(context.Context, string, Integration) (WisepopsCredentials, error) {
	if f.err != nil {
		return WisepopsCredentials{}, f.err
	}
	return f.creds, nil
}

func wisepopsTestSignature(secret, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(body))
	return hex.EncodeToString(mac.Sum(nil))
}
