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

func TestParseConvertFlowCredentialSecret(t *testing.T) {
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
			creds, err := parseConvertFlowCredentialSecret(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if creds.WebhookToken != tc.want {
				t.Fatalf("token=%q want %q", creds.WebhookToken, tc.want)
			}
		})
	}
}

func TestConvertFlowWebhookIngestsFieldsSubmittedPayload(t *testing.T) {
	store := convertFlowFakeStore()
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                   store,
		Profiles:               profiles,
		Events:                 events,
		ConvertFlowCredentials: fakeConvertFlowCredentialResolver{creds: ConvertFlowCredentials{WebhookToken: "cf_secret"}},
		Now:                    func() time.Time { return time.Date(2026, 7, 4, 15, 0, 0, 0, time.UTC) },
		MaxSyncRows:            10,
		PublicBaseURL:          "https://app.postwave.test",
	}
	body := `{
		"id":"submission_123",
		"event":"fields_submitted",
		"contact":{"id":"contact_123","email":"Lead@Example.com","first_name":"Ada","last_name":"Lovelace"},
		"fields":{"phone":"+15551234567","company":"Moosewave"},
		"cta":{"id":"cta_456","title":"Quiz CTA"},
		"submitted_at":"2026-07-04T12:00:00Z",
		"token":"do_not_store"
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/convertflow/webhooks?account_id=acct_123&campaign_id=cta_456&token=cf_secret", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.ConvertFlowWebhook(rec, req)

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
		submission.FormID != "cta_456" ||
		submission.FormName != "Quiz CTA" ||
		submission.SourceID != "convertflow://submission/acct_123/cta_456/convertflow_submission_123" {
		t.Fatalf("submission=%+v", submission)
	}
	if submission.SubmittedAt == nil || !submission.SubmittedAt.Equal(time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("submitted_at=%v", submission.SubmittedAt)
	}
	if !containsFold(submission.Tags, "convertflow") || !containsFold(submission.Tags, "convertflow:acct_123") || !containsFold(submission.Tags, "launch") {
		t.Fatalf("tags=%+v", submission.Tags)
	}
	if _, ok := submission.Fields["convertflow_field.token"]; ok {
		t.Fatalf("token leaked into field map: %+v", submission.Fields)
	}
	raw, ok := submission.Fields["convertflow_provider_raw"].(map[string]any)
	if !ok || raw["token"] != "[redacted]" {
		t.Fatalf("provider raw redaction failed: %+v", submission.Fields["convertflow_provider_raw"])
	}
	if store.webhooks[ProviderConvertFlow+":convertflow_submission_123"] != WebhookProcessed {
		t.Fatalf("webhook claim=%+v", store.webhooks)
	}
}

func TestConvertFlowWebhookDedupesProcessedDelivery(t *testing.T) {
	store := convertFlowFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                   store,
		Profiles:               profiles,
		ConvertFlowCredentials: fakeConvertFlowCredentialResolver{creds: ConvertFlowCredentials{WebhookToken: "cf_secret"}},
	}
	body := `{"id":"submission_123","contact":{"email":"lead@example.com"},"cta":{"id":"cta_456"}}`
	target := "/api/public/lead-integrations/convertflow/webhooks?account_id=acct_123&campaign_id=cta_456&token=cf_secret"

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	deps.ConvertFlowWebhook(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	deps.ConvertFlowWebhook(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("duplicate status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 {
		t.Fatalf("duplicate should not reprocess: %+v", profiles.submissions)
	}
}

func TestConvertFlowWebhookRejectsBadToken(t *testing.T) {
	store := convertFlowFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                   store,
		Profiles:               profiles,
		ConvertFlowCredentials: fakeConvertFlowCredentialResolver{creds: ConvertFlowCredentials{WebhookToken: "cf_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/convertflow/webhooks?account_id=acct_123&campaign_id=cta_456&token=wrong", strings.NewReader(`{"contact":{"email":"lead@example.com"},"cta":{"id":"cta_456"}}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.ConvertFlowWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 {
		t.Fatalf("unexpected submissions=%+v", profiles.submissions)
	}
}

func TestDisconnectConvertFlowReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := convertFlowFakeStore()
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
	if out.ProviderCleanup.Provider != ProviderConvertFlow ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderScopeType != "convertflow_account_campaign" ||
		out.ProviderCleanup.ProviderScopeID != "acct_123/cta_456" ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_review_convertflow_webhook_automation" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["provider"] != ProviderConvertFlow ||
		stored["provider_scope_id"] != "acct_123/cta_456" ||
		stored["webhook_cleanup_status"] != "operator_review_convertflow_webhook_automation" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func convertFlowFakeStore() *fakeStore {
	store := newFakeStore()
	store.integration.Provider = ProviderConvertFlow
	store.integration.CredentialsRef = "cred_convertflow_1"
	store.integration.Status = "connected"
	store.integration.Settings = map[string]any{
		"account_id":      "acct_123",
		"campaign_id":     "cta_456",
		"campaign_name":   "Quiz CTA",
		"credentials_ref": "cred_convertflow_1",
		"default_tags":    "launch",
	}
	return store
}

type fakeConvertFlowCredentialResolver struct {
	creds ConvertFlowCredentials
	err   error
}

func (f fakeConvertFlowCredentialResolver) ResolveConvertFlow(context.Context, string, Integration) (ConvertFlowCredentials, error) {
	if f.err != nil {
		return ConvertFlowCredentials{}, f.err
	}
	return f.creds, nil
}
