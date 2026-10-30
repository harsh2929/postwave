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

func TestParseOutgrowCredentialSecret(t *testing.T) {
	cases := []struct {
		name         string
		raw          string
		wantToken    string
		wantUsername string
		wantPassword string
	}{
		{name: "plain route token", raw: "outgrow_secret", wantToken: "outgrow_secret"},
		{name: "json route token", raw: `{"webhook_token":"json_secret","user_agent":"Moosewave Test"}`, wantToken: "json_secret"},
		{name: "key value basic", raw: "basic_username=postwave&basic_password=kv_secret&user_agent=Moosewave", wantUsername: "postwave", wantPassword: "kv_secret"},
		{name: "colon basic", raw: "postwave:basic_secret", wantUsername: "postwave", wantPassword: "basic_secret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			creds, err := parseOutgrowCredentialSecret(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if creds.WebhookToken != tc.wantToken || creds.Username != tc.wantUsername || creds.Password != tc.wantPassword {
				t.Fatalf("creds=%+v want token=%q username=%q password=%q", creds, tc.wantToken, tc.wantUsername, tc.wantPassword)
			}
		})
	}
}

func TestOutgrowWebhookIngestsJSONLead(t *testing.T) {
	store := outgrowFakeStore()
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:               store,
		Profiles:           profiles,
		Events:             events,
		OutgrowCredentials: fakeOutgrowCredentialResolver{creds: OutgrowCredentials{WebhookToken: "outgrow_secret"}},
		Now:                func() time.Time { return time.Date(2026, 7, 4, 16, 0, 0, 0, time.UTC) },
		MaxSyncRows:        10,
		PublicBaseURL:      "https://app.postwave.test",
	}
	body := `{
		"event":"Lead",
		"lead_id":"lead_123",
		"campaign_id":"campaign_456",
		"calculator_id":"calculator_789",
		"campaign_name":"Savings Calculator",
		"email":"Lead@Example.com",
		"first_name":"Ada",
		"last_name":"Lovelace",
		"company":"Moosewave",
		"created_at":"2026-07-04T12:00:00Z",
		"token":"do_not_store"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/outgrow/webhooks?account_id=acct_123&campaign_id=campaign_456&token=outgrow_secret", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.OutgrowWebhook(rec, req)

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
		submission.FormID != "calculator_789" ||
		submission.FormName != "Savings Calculator" ||
		submission.EventName != "lead.submitted" ||
		submission.SourceID != "outgrow://lead/acct_123/campaign_456/outgrow_lead_created_lead_123" {
		t.Fatalf("submission=%+v", submission)
	}
	if submission.SubmittedAt == nil || !submission.SubmittedAt.Equal(time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("submitted_at=%v", submission.SubmittedAt)
	}
	if !containsFold(submission.Tags, "outgrow") || !containsFold(submission.Tags, "outgrow:acct_123") || !containsFold(submission.Tags, "calculator") {
		t.Fatalf("tags=%+v", submission.Tags)
	}
	if _, ok := submission.Fields["outgrow_field.token"]; ok {
		t.Fatalf("token leaked into field map: %+v", submission.Fields)
	}
	query, ok := submission.Fields["outgrow_query"].(map[string]any)
	if !ok || query["token"] != "[redacted]" {
		t.Fatalf("query redaction failed: %+v", submission.Fields["outgrow_query"])
	}
	if store.webhooks[ProviderOutgrow+":outgrow_lead_created_lead_123"] != WebhookProcessed {
		t.Fatalf("webhook claim=%+v", store.webhooks)
	}
}

func TestOutgrowWebhookAcceptsBasicAuthAndDedupes(t *testing.T) {
	store := outgrowFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:               store,
		Profiles:           profiles,
		OutgrowCredentials: fakeOutgrowCredentialResolver{creds: OutgrowCredentials{Username: "postwave", Password: "basic_secret"}},
	}
	body := `{"event":"Result Calculated","lead_id":"lead_123","campaign_id":"campaign_456","calculator_id":"calculator_789","email":"lead@example.com"}`
	target := "/api/public/lead-integrations/outgrow/webhooks?account_id=acct_123&campaign_id=campaign_456"

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", outgrowBasicAuth("postwave", "basic_secret"))
	deps.OutgrowWebhook(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].EventName != "lead.result.calculated" {
		t.Fatalf("submissions=%+v", profiles.submissions)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", outgrowBasicAuth("postwave", "basic_secret"))
	deps.OutgrowWebhook(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("duplicate status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 {
		t.Fatalf("duplicate should not reprocess: %+v", profiles.submissions)
	}
}

func TestOutgrowWebhookRejectsBadCredential(t *testing.T) {
	store := outgrowFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:               store,
		Profiles:           profiles,
		OutgrowCredentials: fakeOutgrowCredentialResolver{creds: OutgrowCredentials{WebhookToken: "outgrow_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/outgrow/webhooks?account_id=acct_123&campaign_id=campaign_456&token=wrong", strings.NewReader(`{"email":"lead@example.com","lead_id":"bad_1"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.OutgrowWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 {
		t.Fatalf("unexpected submissions=%+v", profiles.submissions)
	}
}

func TestDisconnectOutgrowReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := outgrowFakeStore()
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
	if out.ProviderCleanup.Provider != ProviderOutgrow ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderScopeType != "outgrow_account_campaign" ||
		out.ProviderCleanup.ProviderScopeID != "acct_123/campaign_456" ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_review_outgrow_webhook" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["provider"] != ProviderOutgrow ||
		stored["provider_scope_id"] != "acct_123/campaign_456" ||
		stored["webhook_cleanup_status"] != "operator_review_outgrow_webhook" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func outgrowFakeStore() *fakeStore {
	store := newFakeStore()
	store.integration.Provider = ProviderOutgrow
	store.integration.CredentialsRef = "cred_outgrow_1"
	store.integration.Status = "connected"
	store.integration.Settings = map[string]any{
		"account_id":      "acct_123",
		"campaign_id":     "campaign_456",
		"calculator_id":   "calculator_789",
		"campaign_name":   "Savings Calculator",
		"credentials_ref": "cred_outgrow_1",
		"default_tags":    "calculator",
	}
	return store
}

type fakeOutgrowCredentialResolver struct {
	creds OutgrowCredentials
	err   error
}

func (f fakeOutgrowCredentialResolver) ResolveOutgrow(context.Context, string, Integration) (OutgrowCredentials, error) {
	if f.err != nil {
		return OutgrowCredentials{}, f.err
	}
	return f.creds, nil
}

func outgrowBasicAuth(username, password string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(username+":"+password))
}
