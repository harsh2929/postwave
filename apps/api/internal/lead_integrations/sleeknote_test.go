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

func TestParseSleeknoteCredentialSecret(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{name: "plain", raw: "sleeknote_secret", want: "sleeknote_secret"},
		{name: "json", raw: `{"webhook_token":"json_secret","user_agent":"Moosewave Test"}`, want: "json_secret"},
		{name: "key value", raw: "route_token=kv_secret&user_agent=Moosewave", want: "kv_secret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			creds, err := parseSleeknoteCredentialSecret(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if creds.WebhookToken != tc.want {
				t.Fatalf("token=%q want %q", creds.WebhookToken, tc.want)
			}
		})
	}
}

func TestSleeknoteWebhookIngestsFormPost(t *testing.T) {
	store := sleeknoteFakeStore()
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                 store,
		Profiles:             profiles,
		Events:               events,
		SleeknoteCredentials: fakeSleeknoteCredentialResolver{creds: SleeknoteCredentials{WebhookToken: "sleek_secret"}},
		Now:                  func() time.Time { return time.Date(2026, 7, 4, 13, 0, 0, 0, time.UTC) },
		MaxSyncRows:          10,
		PublicBaseURL:        "https://app.postwave.test",
		FilloutBackfiller:    nil,
	}
	body := "guid=signup_123&CustomerId=acct_123&SleeknoteId=campaign_456&email=Lead%40Example.com&first_name=Ada&last_name=Lovelace&company=Moosewave&SignupPage=Newsletter&token=do_not_store"
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/sleeknote/webhooks?account_id=acct_123&campaign_id=campaign_456&token=sleek_secret", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()

	deps.SleeknoteWebhook(rec, req)

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
		submission.FormID != "campaign_456" ||
		submission.FormName != "Newsletter" ||
		submission.SourceID != "sleeknote://signup/acct_123/campaign_456/sleeknote_signup_123" {
		t.Fatalf("submission=%+v", submission)
	}
	if !containsFold(submission.Tags, "sleeknote") || !containsFold(submission.Tags, "sleeknote:acct_123") || !containsFold(submission.Tags, "launch") {
		t.Fatalf("tags=%+v", submission.Tags)
	}
	if _, ok := submission.Fields["sleeknote_field.token"]; ok {
		t.Fatalf("token leaked into field map: %+v", submission.Fields)
	}
	query, ok := submission.Fields["sleeknote_query"].(map[string]any)
	if !ok || query["token"] != "[redacted]" {
		t.Fatalf("query redaction failed: %+v", submission.Fields["sleeknote_query"])
	}
	if store.webhooks[ProviderSleeknote+":sleeknote_signup_123"] != WebhookProcessed {
		t.Fatalf("webhook claim=%+v", store.webhooks)
	}
}

func TestSleeknoteWebhookAcceptsGETAndDedupes(t *testing.T) {
	store := sleeknoteFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                 store,
		Profiles:             profiles,
		SleeknoteCredentials: fakeSleeknoteCredentialResolver{creds: SleeknoteCredentials{WebhookToken: "sleek_secret"}},
	}
	target := "/api/public/lead-integrations/sleeknote/webhooks?account_id=acct_123&campaign_id=campaign_456&token=sleek_secret&guid=get_1&email=get%40example.com&full_name=Get%20Lead"

	rec := httptest.NewRecorder()
	deps.SleeknoteWebhook(rec, httptest.NewRequest(http.MethodGet, target, nil))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "get@example.com" || profiles.submissions[0].FullName != "Get Lead" {
		t.Fatalf("submissions=%+v", profiles.submissions)
	}

	rec = httptest.NewRecorder()
	deps.SleeknoteWebhook(rec, httptest.NewRequest(http.MethodGet, target, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("duplicate status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 {
		t.Fatalf("duplicate should not reprocess: %+v", profiles.submissions)
	}
}

func TestSleeknoteWebhookRejectsBadToken(t *testing.T) {
	store := sleeknoteFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                 store,
		Profiles:             profiles,
		SleeknoteCredentials: fakeSleeknoteCredentialResolver{creds: SleeknoteCredentials{WebhookToken: "sleek_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/sleeknote/webhooks?account_id=acct_123&campaign_id=campaign_456&token=wrong", strings.NewReader(`{"email":"lead@example.com","guid":"bad_1"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.SleeknoteWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 {
		t.Fatalf("unexpected submissions=%+v", profiles.submissions)
	}
}

func TestDisconnectSleeknoteReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := sleeknoteFakeStore()
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
	if out.ProviderCleanup.Provider != ProviderSleeknote ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderScopeType != "sleeknote_account_campaign" ||
		out.ProviderCleanup.ProviderScopeID != "acct_123/campaign_456" ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_review_sleeknote_custom_integration" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["provider"] != ProviderSleeknote ||
		stored["provider_scope_id"] != "acct_123/campaign_456" ||
		stored["webhook_cleanup_status"] != "operator_review_sleeknote_custom_integration" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func sleeknoteFakeStore() *fakeStore {
	store := newFakeStore()
	store.integration.Provider = ProviderSleeknote
	store.integration.CredentialsRef = "cred_sleeknote_1"
	store.integration.Status = "connected"
	store.integration.Settings = map[string]any{
		"account_id":      "acct_123",
		"campaign_id":     "campaign_456",
		"site_id":         "site_789",
		"campaign_name":   "Newsletter",
		"credentials_ref": "cred_sleeknote_1",
		"default_tags":    "launch",
	}
	return store
}

type fakeSleeknoteCredentialResolver struct {
	creds SleeknoteCredentials
	err   error
}

func (f fakeSleeknoteCredentialResolver) ResolveSleeknote(context.Context, string, Integration) (SleeknoteCredentials, error) {
	if f.err != nil {
		return SleeknoteCredentials{}, f.err
	}
	return f.creds, nil
}
