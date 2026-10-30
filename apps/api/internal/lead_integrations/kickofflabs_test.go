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

func TestParseKickoffLabsCredentialSecret(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{name: "plain", raw: "kickoff_secret", want: "kickoff_secret"},
		{name: "json", raw: `{"webhook_token":"json_secret","user_agent":"Moosewave Test"}`, want: "json_secret"},
		{name: "key value", raw: "route_token=kv_secret&user_agent=Moosewave", want: "kv_secret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			creds, err := parseKickoffLabsCredentialSecret(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if creds.WebhookToken != tc.want {
				t.Fatalf("token=%q want %q", creds.WebhookToken, tc.want)
			}
		})
	}
}

func TestKickoffLabsWebhookIngestsJSONLead(t *testing.T) {
	store := kickoffLabsFakeStore()
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                   store,
		Profiles:               profiles,
		Events:                 events,
		KickoffLabsCredentials: fakeKickoffLabsCredentialResolver{creds: KickoffLabsCredentials{WebhookToken: "kickoff_secret"}},
		Now:                    func() time.Time { return time.Date(2026, 7, 4, 15, 0, 0, 0, time.UTC) },
		MaxSyncRows:            10,
		PublicBaseURL:          "https://app.postwave.test",
	}
	body := `{
		"event":"New Lead",
		"lead_id":"lead_123",
		"campaign_id":"campaign_456",
		"page_id":"page_789",
		"email":"Lead@Example.com",
		"first_name":"Ada",
		"last_name":"Lovelace",
		"company":"Moosewave",
		"campaign_name":"Launch Giveaway",
		"token":"do_not_store"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/kickofflabs/webhooks?account_id=acct_123&campaign_id=campaign_456&token=kickoff_secret", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.KickoffLabsWebhook(rec, req)

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
		submission.FormID != "page_789" ||
		submission.FormName != "Launch Giveaway" ||
		submission.EventName != "lead.submitted" ||
		submission.SourceID != "kickofflabs://lead/acct_123/campaign_456/kickofflabs_lead_created_lead_123" {
		t.Fatalf("submission=%+v", submission)
	}
	if !containsFold(submission.Tags, "kickofflabs") || !containsFold(submission.Tags, "kickofflabs:acct_123") || !containsFold(submission.Tags, "campaign") {
		t.Fatalf("tags=%+v", submission.Tags)
	}
	if _, ok := submission.Fields["kickofflabs_field.token"]; ok {
		t.Fatalf("token leaked into field map: %+v", submission.Fields)
	}
	query, ok := submission.Fields["kickofflabs_query"].(map[string]any)
	if !ok || query["token"] != "[redacted]" {
		t.Fatalf("query redaction failed: %+v", submission.Fields["kickofflabs_query"])
	}
	if store.webhooks[ProviderKickoffLabs+":kickofflabs_lead_created_lead_123"] != WebhookProcessed {
		t.Fatalf("webhook claim=%+v", store.webhooks)
	}
}

func TestKickoffLabsWebhookAcceptsGETAndDedupes(t *testing.T) {
	store := kickoffLabsFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                   store,
		Profiles:               profiles,
		KickoffLabsCredentials: fakeKickoffLabsCredentialResolver{creds: KickoffLabsCredentials{WebhookToken: "kickoff_secret"}},
	}
	target := "/api/public/lead-integrations/kickofflabs/webhooks?account_id=acct_123&campaign_id=campaign_456&page_id=page_789&token=kickoff_secret&lead_id=get_1&email=get%40example.com&full_name=Get%20Lead"

	rec := httptest.NewRecorder()
	deps.KickoffLabsWebhook(rec, httptest.NewRequest(http.MethodGet, target, nil))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "get@example.com" || profiles.submissions[0].FullName != "Get Lead" {
		t.Fatalf("submissions=%+v", profiles.submissions)
	}

	rec = httptest.NewRecorder()
	deps.KickoffLabsWebhook(rec, httptest.NewRequest(http.MethodGet, target, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("duplicate status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 {
		t.Fatalf("duplicate should not reprocess: %+v", profiles.submissions)
	}
}

func TestKickoffLabsWebhookRejectsBadToken(t *testing.T) {
	store := kickoffLabsFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                   store,
		Profiles:               profiles,
		KickoffLabsCredentials: fakeKickoffLabsCredentialResolver{creds: KickoffLabsCredentials{WebhookToken: "kickoff_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/kickofflabs/webhooks?account_id=acct_123&campaign_id=campaign_456&token=wrong", strings.NewReader(`{"email":"lead@example.com","lead_id":"bad_1"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.KickoffLabsWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 {
		t.Fatalf("unexpected submissions=%+v", profiles.submissions)
	}
}

func TestDisconnectKickoffLabsReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := kickoffLabsFakeStore()
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
	if out.ProviderCleanup.Provider != ProviderKickoffLabs ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderScopeType != "kickofflabs_account_campaign" ||
		out.ProviderCleanup.ProviderScopeID != "acct_123/campaign_456" ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_review_kickofflabs_outbound_webhook" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["provider"] != ProviderKickoffLabs ||
		stored["provider_scope_id"] != "acct_123/campaign_456" ||
		stored["webhook_cleanup_status"] != "operator_review_kickofflabs_outbound_webhook" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func kickoffLabsFakeStore() *fakeStore {
	store := newFakeStore()
	store.integration.Provider = ProviderKickoffLabs
	store.integration.CredentialsRef = "cred_kickofflabs_1"
	store.integration.Status = "connected"
	store.integration.Settings = map[string]any{
		"account_id":      "acct_123",
		"campaign_id":     "campaign_456",
		"page_id":         "page_789",
		"campaign_name":   "Launch Giveaway",
		"credentials_ref": "cred_kickofflabs_1",
		"default_tags":    "campaign",
	}
	return store
}

type fakeKickoffLabsCredentialResolver struct {
	creds KickoffLabsCredentials
	err   error
}

func (f fakeKickoffLabsCredentialResolver) ResolveKickoffLabs(context.Context, string, Integration) (KickoffLabsCredentials, error) {
	if f.err != nil {
		return KickoffLabsCredentials{}, f.err
	}
	return f.creds, nil
}
