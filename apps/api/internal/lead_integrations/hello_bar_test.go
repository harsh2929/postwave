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

func TestParseHelloBarCredentialSecret(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{name: "plain", raw: "hello_secret", want: "hello_secret"},
		{name: "json", raw: `{"webhook_token":"json_secret","user_agent":"Moosewave Test"}`, want: "json_secret"},
		{name: "key value", raw: "route_token=kv_secret&user_agent=Moosewave", want: "kv_secret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			creds, err := parseHelloBarCredentialSecret(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if creds.WebhookToken != tc.want {
				t.Fatalf("token=%q want %q", creds.WebhookToken, tc.want)
			}
		})
	}
}

func TestHelloBarWebhookIngestsFormPost(t *testing.T) {
	store := helloBarFakeStore()
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		Events:              events,
		HelloBarCredentials: fakeHelloBarCredentialResolver{creds: HelloBarCredentials{WebhookToken: "hello_secret"}},
		Now:                 func() time.Time { return time.Date(2026, 7, 4, 14, 0, 0, 0, time.UTC) },
		MaxSyncRows:         10,
		PublicBaseURL:       "https://app.postwave.test",
	}
	body := "lead_id=lead_123&site_id=site_123&campaign_id=bar_456&email=Lead%40Example.com&first_name=Ada&last_name=Lovelace&bar_name=Top%20Bar&token=do_not_store"
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/hello-bar/webhooks?site_id=site_123&campaign_id=bar_456&token=hello_secret", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()

	deps.HelloBarWebhook(rec, req)

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
		submission.FormID != "bar_456" ||
		submission.FormName != "Top Bar" ||
		submission.SourceID != "hello-bar://lead/site_123/bar_456/hello_bar_lead_123" {
		t.Fatalf("submission=%+v", submission)
	}
	if !containsFold(submission.Tags, "hello-bar") || !containsFold(submission.Tags, "hello-bar:site_123") || !containsFold(submission.Tags, "campaign") {
		t.Fatalf("tags=%+v", submission.Tags)
	}
	if _, ok := submission.Fields["hello_bar_field.token"]; ok {
		t.Fatalf("token leaked into field map: %+v", submission.Fields)
	}
	query, ok := submission.Fields["hello_bar_query"].(map[string]any)
	if !ok || query["token"] != "[redacted]" {
		t.Fatalf("query redaction failed: %+v", submission.Fields["hello_bar_query"])
	}
	if store.webhooks[ProviderHelloBar+":hello_bar_lead_123"] != WebhookProcessed {
		t.Fatalf("webhook claim=%+v", store.webhooks)
	}
}

func TestHelloBarWebhookAcceptsGETAndDedupes(t *testing.T) {
	store := helloBarFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		HelloBarCredentials: fakeHelloBarCredentialResolver{creds: HelloBarCredentials{WebhookToken: "hello_secret"}},
	}
	target := "/api/public/lead-integrations/hello-bar/webhooks?site_id=site_123&campaign_id=bar_456&token=hello_secret&lead_id=get_1&email=get%40example.com&full_name=Get%20Lead"

	rec := httptest.NewRecorder()
	deps.HelloBarWebhook(rec, httptest.NewRequest(http.MethodGet, target, nil))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "get@example.com" || profiles.submissions[0].FullName != "Get Lead" {
		t.Fatalf("submissions=%+v", profiles.submissions)
	}

	rec = httptest.NewRecorder()
	deps.HelloBarWebhook(rec, httptest.NewRequest(http.MethodGet, target, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("duplicate status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 {
		t.Fatalf("duplicate should not reprocess: %+v", profiles.submissions)
	}
}

func TestHelloBarWebhookRejectsBadToken(t *testing.T) {
	store := helloBarFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                store,
		Profiles:            profiles,
		HelloBarCredentials: fakeHelloBarCredentialResolver{creds: HelloBarCredentials{WebhookToken: "hello_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/hello-bar/webhooks?site_id=site_123&campaign_id=bar_456&token=wrong", strings.NewReader(`{"email":"lead@example.com","lead_id":"bad_1"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.HelloBarWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 {
		t.Fatalf("unexpected submissions=%+v", profiles.submissions)
	}
}

func TestDisconnectHelloBarReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := helloBarFakeStore()
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
	if out.ProviderCleanup.Provider != ProviderHelloBar ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderScopeType != "hello_bar_site_campaign" ||
		out.ProviderCleanup.ProviderScopeID != "site_123/bar_456" ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_review_hello_bar_webhook" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["provider"] != ProviderHelloBar ||
		stored["provider_scope_id"] != "site_123/bar_456" ||
		stored["webhook_cleanup_status"] != "operator_review_hello_bar_webhook" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func helloBarFakeStore() *fakeStore {
	store := newFakeStore()
	store.integration.Provider = ProviderHelloBar
	store.integration.CredentialsRef = "cred_hello_bar_1"
	store.integration.Status = "connected"
	store.integration.Settings = map[string]any{
		"site_id":         "site_123",
		"campaign_id":     "bar_456",
		"bar_name":        "Top Bar",
		"account_id":      "acct_789",
		"credentials_ref": "cred_hello_bar_1",
		"default_tags":    "campaign",
	}
	return store
}

type fakeHelloBarCredentialResolver struct {
	creds HelloBarCredentials
	err   error
}

func (f fakeHelloBarCredentialResolver) ResolveHelloBar(context.Context, string, Integration) (HelloBarCredentials, error) {
	if f.err != nil {
		return HelloBarCredentials{}, f.err
	}
	return f.creds, nil
}
