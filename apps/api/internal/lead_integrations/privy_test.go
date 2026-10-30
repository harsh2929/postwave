// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParsePrivyCredentialSecret(t *testing.T) {
	cases := []struct {
		name         string
		raw          string
		wantUsername string
		wantPassword string
	}{
		{name: "colon", raw: "postwave:basic_secret", wantUsername: "postwave", wantPassword: "basic_secret"},
		{name: "json", raw: `{"username":"json_user","password":"json_secret","user_agent":"Moosewave Test"}`, wantUsername: "json_user", wantPassword: "json_secret"},
		{name: "key value", raw: "username=kv_user&password=kv_secret&user_agent=Moosewave", wantUsername: "kv_user", wantPassword: "kv_secret"},
		{name: "token only", raw: "token_secret", wantUsername: "postwave", wantPassword: "token_secret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			creds, err := parsePrivyCredentialSecret(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if creds.Username != tc.wantUsername || creds.Password != tc.wantPassword {
				t.Fatalf("creds=%+v want username=%q password=%q", creds, tc.wantUsername, tc.wantPassword)
			}
		})
	}
}

func TestPrivyWebhookIngestsBasicAuthSignup(t *testing.T) {
	store := privyFakeStore()
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:             store,
		Profiles:         profiles,
		Events:           events,
		PrivyCredentials: fakePrivyCredentialResolver{creds: PrivyCredentials{Username: "postwave", Password: "privy_secret"}},
		Now:              func() time.Time { return time.Date(2026, 7, 4, 14, 0, 0, 0, time.UTC) },
		MaxSyncRows:      10,
		PublicBaseURL:    "https://app.postwave.test",
	}
	body := `{
		"id":"signup_123",
		"email":"Lead@Example.com",
		"first_name":"Ada",
		"last_name":"Lovelace",
		"phone":"+15551234567",
		"created_at":"2026-07-04T12:00:00Z",
		"custom_fields":{"company":"Moosewave"},
		"campaign":{"id":"display_456","title":"Summer Popup"},
		"password":"do_not_store"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/privy/webhooks?account_id=acct_123&campaign_id=display_456", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", privyBasicAuth("postwave", "privy_secret"))
	rec := httptest.NewRecorder()

	deps.PrivyWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || len(events.submissions) != 1 {
		t.Fatalf("profiles=%d events=%d", len(profiles.submissions), len(events.submissions))
	}
	submission := profiles.submissions[0]
	if submission.Email != "lead@example.com" ||
		submission.FirstName != "Ada" ||
		submission.LastName != "Lovelace" ||
		submission.Phone != "+15551234567" ||
		submission.Company != "Moosewave" ||
		submission.FormID != "display_456" ||
		submission.FormName != "Summer Popup" ||
		submission.SourceID != "privy://signup/acct_123/display_456/privy_signup_123" {
		t.Fatalf("submission=%+v", submission)
	}
	if submission.SubmittedAt == nil || !submission.SubmittedAt.Equal(time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("submitted_at=%v", submission.SubmittedAt)
	}
	if !containsFold(submission.Tags, "privy") || !containsFold(submission.Tags, "privy:acct_123") || !containsFold(submission.Tags, "launch") {
		t.Fatalf("tags=%+v", submission.Tags)
	}
	if _, ok := submission.Fields["privy_field.password"]; ok {
		t.Fatalf("password leaked into field map: %+v", submission.Fields)
	}
	raw, ok := submission.Fields["privy_provider_raw"].(map[string]any)
	if !ok || raw["password"] != "[redacted]" {
		t.Fatalf("provider raw redaction failed: %+v", submission.Fields["privy_provider_raw"])
	}
	if store.webhooks[ProviderPrivy+":privy_signup_123"] != WebhookProcessed {
		t.Fatalf("webhook claim=%+v", store.webhooks)
	}
}

func TestPrivyWebhookDedupesProcessedDelivery(t *testing.T) {
	store := privyFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:             store,
		Profiles:         profiles,
		PrivyCredentials: fakePrivyCredentialResolver{creds: PrivyCredentials{Username: "postwave", Password: "privy_secret"}},
	}
	body := `{"id":"signup_123","email":"lead@example.com","campaign":{"id":"display_456"}}`
	target := "/api/public/lead-integrations/privy/webhooks?account_id=acct_123&campaign_id=display_456"

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", privyBasicAuth("postwave", "privy_secret"))
	deps.PrivyWebhook(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", privyBasicAuth("postwave", "privy_secret"))
	deps.PrivyWebhook(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("duplicate status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 {
		t.Fatalf("duplicate should not reprocess: %+v", profiles.submissions)
	}
}

func TestPrivyWebhookRejectsBadBasicAuth(t *testing.T) {
	store := privyFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:             store,
		Profiles:         profiles,
		PrivyCredentials: fakePrivyCredentialResolver{creds: PrivyCredentials{Username: "postwave", Password: "privy_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/privy/webhooks?account_id=acct_123&campaign_id=display_456", strings.NewReader(`{"id":"signup_123","email":"lead@example.com","campaign":{"id":"display_456"}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", privyBasicAuth("postwave", "wrong"))
	rec := httptest.NewRecorder()

	deps.PrivyWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 {
		t.Fatalf("unexpected submissions=%+v", profiles.submissions)
	}
}

func TestDisconnectPrivyReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := privyFakeStore()
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
	if out.ProviderCleanup.Provider != ProviderPrivy ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderScopeType != "privy_account_campaign" ||
		out.ProviderCleanup.ProviderScopeID != "acct_123/display_456" ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_review_privy_custom_webhook" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["provider"] != ProviderPrivy ||
		stored["provider_scope_id"] != "acct_123/display_456" ||
		stored["webhook_cleanup_status"] != "operator_review_privy_custom_webhook" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func privyFakeStore() *fakeStore {
	store := newFakeStore()
	store.integration.Provider = ProviderPrivy
	store.integration.CredentialsRef = "cred_privy_1"
	store.integration.Status = "connected"
	store.integration.Settings = map[string]any{
		"account_id":      "acct_123",
		"campaign_id":     "display_456",
		"campaign_name":   "Summer Popup",
		"credentials_ref": "cred_privy_1",
		"default_tags":    "launch",
	}
	return store
}

type fakePrivyCredentialResolver struct {
	creds PrivyCredentials
	err   error
}

func (f fakePrivyCredentialResolver) ResolvePrivy(context.Context, string, Integration) (PrivyCredentials, error) {
	if f.err != nil {
		return PrivyCredentials{}, f.err
	}
	return f.creds, nil
}

func privyBasicAuth(username, password string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+password))
}
