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

func TestParseRiddleCredentialSecret(t *testing.T) {
	cases := []struct {
		name       string
		raw        string
		wantToken  string
		wantSecret string
	}{
		{name: "plain route token", raw: "riddle_route", wantToken: "riddle_route"},
		{name: "json signature", raw: `{"signing_secret":"sig_secret","user_agent":"Moosewave Test"}`, wantSecret: "sig_secret"},
		{name: "key value both", raw: "route_token=route_secret&webhook_secret=webhook_secret&user_agent=Moosewave", wantToken: "route_secret", wantSecret: "webhook_secret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			creds, err := parseRiddleCredentialSecret(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if creds.WebhookToken != tc.wantToken || creds.SigningSecret != tc.wantSecret {
				t.Fatalf("creds=%+v want token=%q secret=%q", creds, tc.wantToken, tc.wantSecret)
			}
		})
	}
}

func TestRiddleWebhookIngestsJSONLead(t *testing.T) {
	store := riddleFakeStore()
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:              store,
		Profiles:          profiles,
		Events:            events,
		RiddleCredentials: fakeRiddleCredentialResolver{creds: RiddleCredentials{WebhookToken: "riddle_secret"}},
		Now:               func() time.Time { return time.Date(2026, 7, 4, 17, 0, 0, 0, time.UTC) },
		MaxSyncRows:       10,
		PublicBaseURL:     "https://app.postwave.test",
	}
	body := `{
		"uniqueId":"lead_123",
		"riddleId":"quiz_456",
		"identifier":"lead@example.com",
		"createdAt":"2026-07-04T12:00:00Z",
		"data":{
			"form":{
				"Email":"Lead@Example.com",
				"First Name":"Ada",
				"Last Name":"Lovelace",
				"Company":"Moosewave",
				"token":"do_not_store"
			},
			"riddle":{"title":"Product Fit Quiz"},
			"result":{"title":"Builder"}
		}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/riddle/webhooks?account_id=acct_123&token=riddle_secret", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.RiddleWebhook(rec, req)

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
		submission.FormID != "quiz_456" ||
		submission.FormName != "Product Fit Quiz" ||
		submission.EventName != "lead.submitted" ||
		submission.SourceID != "riddle://lead/acct_123/quiz_456/riddle_lead_created_lead_123" {
		t.Fatalf("submission=%+v", submission)
	}
	if submission.SubmittedAt == nil || !submission.SubmittedAt.Equal(time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("submitted_at=%v", submission.SubmittedAt)
	}
	if !containsFold(submission.Tags, "riddle") || !containsFold(submission.Tags, "riddle:acct_123") || !containsFold(submission.Tags, "quiz") {
		t.Fatalf("tags=%+v", submission.Tags)
	}
	if _, ok := submission.Fields["riddle_field.token"]; ok {
		t.Fatalf("token leaked into field map: %+v", submission.Fields)
	}
	query, ok := submission.Fields["riddle_query"].(map[string]any)
	if !ok || query["token"] != "[redacted]" {
		t.Fatalf("query redaction failed: %+v", submission.Fields["riddle_query"])
	}
	if store.webhooks[ProviderRiddle+":riddle_lead_created_lead_123"] != WebhookProcessed {
		t.Fatalf("webhook claim=%+v", store.webhooks)
	}
}

func TestRiddleWebhookAcceptsSignatureAndDedupes(t *testing.T) {
	store := riddleFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:              store,
		Profiles:          profiles,
		RiddleCredentials: fakeRiddleCredentialResolver{creds: RiddleCredentials{SigningSecret: "signature_secret"}},
	}
	body := `{"event":"riddle.completed","uniqueId":"lead_123","riddleId":"quiz_456","data":{"form":{"email":"lead@example.com"},"riddle":{"title":"Product Fit Quiz"}}}`
	target := "/api/public/lead-integrations/riddle/webhooks?account_id=acct_123"
	signature := riddleTestSignature("signature_secret", []byte(body))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Riddle-Signature", "sha256="+signature)
	deps.RiddleWebhook(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].EventName != "lead.riddle.completed" {
		t.Fatalf("submissions=%+v", profiles.submissions)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Riddle-Signature", "sha256="+signature)
	deps.RiddleWebhook(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("duplicate status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 {
		t.Fatalf("duplicate should not reprocess: %+v", profiles.submissions)
	}
}

func TestRiddleWebhookRejectsBadCredential(t *testing.T) {
	store := riddleFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:              store,
		Profiles:          profiles,
		RiddleCredentials: fakeRiddleCredentialResolver{creds: RiddleCredentials{WebhookToken: "riddle_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/riddle/webhooks?account_id=acct_123&token=wrong", strings.NewReader(`{"uniqueId":"bad_1","riddleId":"quiz_456","data":{"form":{"email":"lead@example.com"}}}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.RiddleWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 {
		t.Fatalf("unexpected submissions=%+v", profiles.submissions)
	}
}

func TestDisconnectRiddleReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := riddleFakeStore()
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
	if out.ProviderCleanup.Provider != ProviderRiddle ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderScopeType != "riddle_account_quiz" ||
		out.ProviderCleanup.ProviderScopeID != "acct_123/quiz_456" ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_review_riddle_webhook" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["provider"] != ProviderRiddle ||
		stored["provider_scope_id"] != "acct_123/quiz_456" ||
		stored["webhook_cleanup_status"] != "operator_review_riddle_webhook" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func riddleFakeStore() *fakeStore {
	store := newFakeStore()
	store.integration.Provider = ProviderRiddle
	store.integration.CredentialsRef = "cred_riddle_1"
	store.integration.Status = "connected"
	store.integration.Settings = map[string]any{
		"account_id":      "acct_123",
		"quiz_id":         "quiz_456",
		"campaign_id":     "campaign_789",
		"quiz_name":       "Product Fit Quiz",
		"credentials_ref": "cred_riddle_1",
		"default_tags":    "quiz",
	}
	return store
}

type fakeRiddleCredentialResolver struct {
	creds RiddleCredentials
	err   error
}

func (f fakeRiddleCredentialResolver) ResolveRiddle(context.Context, string, Integration) (RiddleCredentials, error) {
	if f.err != nil {
		return RiddleCredentials{}, f.err
	}
	return f.creds, nil
}

func riddleTestSignature(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
