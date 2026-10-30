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

func TestParseOptinMonsterCredentialSecret(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{name: "plain", raw: "route_secret", want: "route_secret"},
		{name: "json", raw: `{"webhook_token":"json_secret","user_agent":"Moosewave Test"}`, want: "json_secret"},
		{name: "key value", raw: "route_token=kv_secret&user_agent=Moosewave", want: "kv_secret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			creds, err := parseOptinMonsterCredentialSecret(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if creds.WebhookToken != tc.want {
				t.Fatalf("token=%q want %q", creds.WebhookToken, tc.want)
			}
		})
	}
}

func TestOptinMonsterWebhookIngestsJSONSubmission(t *testing.T) {
	store := optinMonsterFakeStore()
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                    store,
		Profiles:                profiles,
		Events:                  events,
		OptinMonsterCredentials: fakeOptinMonsterCredentialResolver{creds: OptinMonsterCredentials{WebhookToken: "om_secret"}},
		Now:                     func() time.Time { return time.Date(2026, 7, 4, 12, 30, 0, 0, time.UTC) },
		MaxSyncRows:             10,
		PublicBaseURL:           "https://app.postwave.test",
	}
	body := `{
		"lead":{"id":"lead_123","email":"Lead@Example.com","name":"Ada Lovelace","phone":"+15551234567","company":"Moosewave"},
		"campaign":{"id":"campaign_456","title":"Summer Campaign"},
		"meta":{"submitted_at":"2026-07-04T12:00:00Z","page_url":"https://example.com"},
		"smart_tags":{"utm_campaign":"summer"},
		"token":"do_not_store"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/optinmonster/webhooks?account_id=acct_123&campaign_id=campaign_456&token=om_secret", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.OptinMonsterWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || len(events.submissions) != 1 {
		t.Fatalf("profiles=%d events=%d", len(profiles.submissions), len(events.submissions))
	}
	submission := profiles.submissions[0]
	if submission.Email != "lead@example.com" ||
		submission.FullName != "Ada Lovelace" ||
		submission.Phone != "+15551234567" ||
		submission.Company != "Moosewave" ||
		submission.FormID != "campaign_456" ||
		submission.FormName != "Summer Campaign" ||
		submission.SourceID != "optinmonster://lead/acct_123/campaign_456/optinmonster_lead_123" {
		t.Fatalf("submission=%+v", submission)
	}
	if submission.SubmittedAt == nil || !submission.SubmittedAt.Equal(time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("submitted_at=%v", submission.SubmittedAt)
	}
	if !containsFold(submission.Tags, "optinmonster") || !containsFold(submission.Tags, "optinmonster:acct_123") || !containsFold(submission.Tags, "launch") {
		t.Fatalf("tags=%+v", submission.Tags)
	}
	if _, ok := submission.Fields["optinmonster_lead.token"]; ok {
		t.Fatalf("token leaked into lead field map: %+v", submission.Fields)
	}
	raw, ok := submission.Fields["optinmonster_provider_raw"].(map[string]any)
	if !ok || raw["token"] != "[redacted]" {
		t.Fatalf("provider raw redaction failed: %+v", submission.Fields["optinmonster_provider_raw"])
	}
	if store.webhooks[ProviderOptinMonster+":optinmonster_lead_123"] != WebhookProcessed {
		t.Fatalf("webhook claim=%+v", store.webhooks)
	}
}

func TestOptinMonsterWebhookDedupesProcessedDelivery(t *testing.T) {
	store := optinMonsterFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                    store,
		Profiles:                profiles,
		OptinMonsterCredentials: fakeOptinMonsterCredentialResolver{creds: OptinMonsterCredentials{WebhookToken: "om_secret"}},
	}
	target := "/api/public/lead-integrations/optinmonster/webhooks?account_id=acct_123&campaign_id=campaign_456&token=om_secret"
	body := `{"lead":{"id":"lead_123","email":"lead@example.com"},"campaign":{"id":"campaign_456"}}`

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	deps.OptinMonsterWebhook(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	deps.OptinMonsterWebhook(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("duplicate status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 {
		t.Fatalf("duplicate should not reprocess: %+v", profiles.submissions)
	}
}

func TestOptinMonsterWebhookRejectsBadToken(t *testing.T) {
	store := optinMonsterFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                    store,
		Profiles:                profiles,
		OptinMonsterCredentials: fakeOptinMonsterCredentialResolver{creds: OptinMonsterCredentials{WebhookToken: "om_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/optinmonster/webhooks?account_id=acct_123&campaign_id=campaign_456&token=wrong", strings.NewReader(`{"lead":{"email":"lead@example.com"},"campaign":{"id":"campaign_456"}}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.OptinMonsterWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 {
		t.Fatalf("unexpected submissions=%+v", profiles.submissions)
	}
}

func TestDisconnectOptinMonsterReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := optinMonsterFakeStore()
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
	if out.ProviderCleanup.Provider != ProviderOptinMonster ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderScopeType != "optinmonster_account_campaign" ||
		out.ProviderCleanup.ProviderScopeID != "acct_123/campaign_456" ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_review_optinmonster_webhook_destination" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["provider"] != ProviderOptinMonster ||
		stored["provider_scope_id"] != "acct_123/campaign_456" ||
		stored["webhook_cleanup_status"] != "operator_review_optinmonster_webhook_destination" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func optinMonsterFakeStore() *fakeStore {
	store := newFakeStore()
	store.integration.Provider = ProviderOptinMonster
	store.integration.CredentialsRef = "cred_optinmonster_1"
	store.integration.Status = "connected"
	store.integration.Settings = map[string]any{
		"account_id":      "acct_123",
		"campaign_id":     "campaign_456",
		"campaign_name":   "Summer Campaign",
		"credentials_ref": "cred_optinmonster_1",
		"default_tags":    "launch",
	}
	return store
}

type fakeOptinMonsterCredentialResolver struct {
	creds OptinMonsterCredentials
	err   error
}

func (f fakeOptinMonsterCredentialResolver) ResolveOptinMonster(context.Context, string, Integration) (OptinMonsterCredentials, error) {
	if f.err != nil {
		return OptinMonsterCredentials{}, f.err
	}
	return f.creds, nil
}
