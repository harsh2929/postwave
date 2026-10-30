// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParsePoptinCredentialSecret(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{name: "plain", raw: "poptin_secret", want: "poptin_secret"},
		{name: "json", raw: `{"webhook_token":"json_secret","user_agent":"Moosewave Test"}`, want: "json_secret"},
		{name: "key value", raw: "route_token=kv_secret&user_agent=Moosewave", want: "kv_secret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			creds, err := parsePoptinCredentialSecret(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if creds.WebhookToken != tc.want {
				t.Fatalf("token=%q want %q", creds.WebhookToken, tc.want)
			}
		})
	}
}

func TestPoptinWebhookIngestsFormPost(t *testing.T) {
	store := poptinFakeStore()
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:              store,
		Profiles:          profiles,
		Events:            events,
		PoptinCredentials: fakePoptinCredentialResolver{creds: PoptinCredentials{WebhookToken: "poptin_secret"}},
		Now:               func() time.Time { return time.Date(2026, 7, 4, 14, 0, 0, 0, time.UTC) },
		MaxSyncRows:       10,
		PublicBaseURL:     "https://app.postwave.test",
	}
	body := "lead_id=lead_123&account_id=acct_123&popup_id=popup_456&email=Lead%40Example.com&first_name=Ada&last_name=Lovelace&company=Moosewave&popup_name=Sale%20Popup&token=do_not_store"
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/poptin/webhooks?account_id=acct_123&popup_id=popup_456&token=poptin_secret", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()

	deps.PoptinWebhook(rec, req)

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
		submission.Company != "Moosewave" ||
		submission.FormID != "popup_456" ||
		submission.FormName != "Sale Popup" ||
		submission.SourceID != "poptin://lead/acct_123/popup_456/poptin_lead_123" {
		t.Fatalf("submission=%+v", submission)
	}
	if !containsFold(submission.Tags, "poptin") || !containsFold(submission.Tags, "poptin:acct_123") || !containsFold(submission.Tags, "campaign") {
		t.Fatalf("tags=%+v", submission.Tags)
	}
	if _, ok := submission.Fields["poptin_field.token"]; ok {
		t.Fatalf("token leaked into field map: %+v", submission.Fields)
	}
	query, ok := submission.Fields["poptin_query"].(map[string]any)
	if !ok || query["token"] != "[redacted]" {
		t.Fatalf("query redaction failed: %+v", submission.Fields["poptin_query"])
	}
	if store.webhooks[ProviderPoptin+":poptin_lead_123"] != WebhookProcessed {
		t.Fatalf("webhook claim=%+v", store.webhooks)
	}
}

func TestPoptinWebhookAcceptsGETAndDedupes(t *testing.T) {
	store := poptinFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:              store,
		Profiles:          profiles,
		PoptinCredentials: fakePoptinCredentialResolver{creds: PoptinCredentials{WebhookToken: "poptin_secret"}},
	}
	target := "/api/public/lead-integrations/poptin/webhooks?account_id=acct_123&popup_id=popup_456&token=poptin_secret&lead_id=get_1&email=get%40example.com&full_name=Get%20Lead"

	rec := httptest.NewRecorder()
	deps.PoptinWebhook(rec, httptest.NewRequest(http.MethodGet, target, nil))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "get@example.com" || profiles.submissions[0].FullName != "Get Lead" {
		t.Fatalf("submissions=%+v", profiles.submissions)
	}

	rec = httptest.NewRecorder()
	deps.PoptinWebhook(rec, httptest.NewRequest(http.MethodGet, target, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("duplicate status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 {
		t.Fatalf("duplicate should not reprocess: %+v", profiles.submissions)
	}
}

func TestPoptinWebhookRejectsBadToken(t *testing.T) {
	store := poptinFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:              store,
		Profiles:          profiles,
		PoptinCredentials: fakePoptinCredentialResolver{creds: PoptinCredentials{WebhookToken: "poptin_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/poptin/webhooks?account_id=acct_123&popup_id=popup_456&token=wrong", strings.NewReader(`{"email":"lead@example.com","lead_id":"bad_1"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.PoptinWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 {
		t.Fatalf("unexpected submissions=%+v", profiles.submissions)
	}
}

func TestDisconnectPoptinReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := poptinFakeStore()
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
	if out.ProviderCleanup.Provider != ProviderPoptin ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderScopeType != "poptin_account_popup" ||
		out.ProviderCleanup.ProviderScopeID != "acct_123/popup_456" ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_review_poptin_webhook_integration" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["provider"] != ProviderPoptin ||
		stored["provider_scope_id"] != "acct_123/popup_456" ||
		stored["webhook_cleanup_status"] != "operator_review_poptin_webhook_integration" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func poptinFakeStore() *fakeStore {
	store := newFakeStore()
	store.integration.Provider = ProviderPoptin
	store.integration.CredentialsRef = "cred_poptin_1"
	store.integration.Status = "connected"
	store.integration.Settings = map[string]any{
		"account_id":      "acct_123",
		"popup_id":        "popup_456",
		"site_id":         "site_789",
		"popup_name":      "Sale Popup",
		"credentials_ref": "cred_poptin_1",
		"default_tags":    "campaign",
	}
	return store
}

type fakePoptinCredentialResolver struct {
	creds PoptinCredentials
	err   error
}

func (f fakePoptinCredentialResolver) ResolvePoptin(context.Context, string, Integration) (PoptinCredentials, error) {
	if f.err != nil {
		return PoptinCredentials{}, f.err
	}
	return f.creds, nil
}
