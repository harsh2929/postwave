// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseShortStackCredentialSecret(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{name: "plain", raw: "short_secret", want: "short_secret"},
		{name: "json", raw: `{"webhook_secret":"json_secret","user_agent":"Moosewave Test"}`, want: "json_secret"},
		{name: "key value", raw: "signing_secret=kv_secret&user_agent=Moosewave", want: "kv_secret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			creds, err := parseShortStackCredentialSecret(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if creds.WebhookSecret != tc.want {
				t.Fatalf("secret=%q want %q", creds.WebhookSecret, tc.want)
			}
		})
	}
}

func TestShortStackWebhookIngestsSignedFormPost(t *testing.T) {
	store := shortStackFakeStore()
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                  store,
		Profiles:              profiles,
		Events:                events,
		ShortStackCredentials: fakeShortStackCredentialResolver{creds: ShortStackCredentials{WebhookSecret: "short_secret"}},
		Now:                   func() time.Time { return time.Date(2026, 7, 4, 14, 0, 0, 0, time.UTC) },
		MaxSyncRows:           10,
		PublicBaseURL:         "https://app.postwave.test",
	}
	body := "entry_id=entry_123&account_id=acct_123&campaign_id=contest_456&form_id=form_789&email=Lead%40Example.com&first_name=Ada&last_name=Lovelace&company=Moosewave&form_name=Giveaway%20Form&secret_key=do_not_store"
	req := shortStackSignedRequest(http.MethodPost, "/api/public/lead-integrations/shortstack/webhooks?account_id=acct_123&campaign_id=contest_456", body, "short_secret")
	rec := httptest.NewRecorder()

	deps.ShortStackWebhook(rec, req)

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
		submission.FormID != "form_789" ||
		submission.FormName != "Giveaway Form" ||
		submission.SourceID != "shortstack://entry/acct_123/contest_456/shortstack_entry_123" {
		t.Fatalf("submission=%+v", submission)
	}
	if !containsFold(submission.Tags, "shortstack") || !containsFold(submission.Tags, "shortstack:acct_123") || !containsFold(submission.Tags, "campaign") {
		t.Fatalf("tags=%+v", submission.Tags)
	}
	if _, ok := submission.Fields["shortstack_field.secret_key"]; ok {
		t.Fatalf("secret leaked into field map: %+v", submission.Fields)
	}
	if store.webhooks[ProviderShortStack+":shortstack_entry_123"] != WebhookProcessed {
		t.Fatalf("webhook claim=%+v", store.webhooks)
	}
}

func TestShortStackWebhookDedupesSignedPost(t *testing.T) {
	store := shortStackFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                  store,
		Profiles:              profiles,
		ShortStackCredentials: fakeShortStackCredentialResolver{creds: ShortStackCredentials{WebhookSecret: "short_secret"}},
	}
	body := "entry_id=entry_get_1&account_id=acct_123&campaign_id=contest_456&form_id=form_789&email=get%40example.com&full_name=Get%20Lead"
	target := "/api/public/lead-integrations/shortstack/webhooks"

	rec := httptest.NewRecorder()
	deps.ShortStackWebhook(rec, shortStackSignedRequest(http.MethodPost, target, body, "short_secret"))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "get@example.com" || profiles.submissions[0].FullName != "Get Lead" {
		t.Fatalf("submissions=%+v", profiles.submissions)
	}

	rec = httptest.NewRecorder()
	deps.ShortStackWebhook(rec, shortStackSignedRequest(http.MethodPost, target, body, "short_secret"))
	if rec.Code != http.StatusOK {
		t.Fatalf("duplicate status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 {
		t.Fatalf("duplicate should not reprocess: %+v", profiles.submissions)
	}
}

func TestShortStackWebhookRejectsBadSignature(t *testing.T) {
	store := shortStackFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                  store,
		Profiles:              profiles,
		ShortStackCredentials: fakeShortStackCredentialResolver{creds: ShortStackCredentials{WebhookSecret: "short_secret"}},
	}
	req := shortStackSignedRequest(http.MethodPost, "/api/public/lead-integrations/shortstack/webhooks", "entry_id=bad_1&account_id=acct_123&campaign_id=contest_456&email=lead%40example.com", "wrong_secret")
	rec := httptest.NewRecorder()

	deps.ShortStackWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 {
		t.Fatalf("unexpected submissions=%+v", profiles.submissions)
	}
}

func TestDisconnectShortStackReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := shortStackFakeStore()
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
	if out.ProviderCleanup.Provider != ProviderShortStack ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderScopeType != "shortstack_account_campaign" ||
		out.ProviderCleanup.ProviderScopeID != "acct_123/contest_456" ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_review_shortstack_webhook_integration" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["provider"] != ProviderShortStack ||
		stored["provider_scope_id"] != "acct_123/contest_456" ||
		stored["webhook_cleanup_status"] != "operator_review_shortstack_webhook_integration" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func shortStackFakeStore() *fakeStore {
	store := newFakeStore()
	store.integration.Provider = ProviderShortStack
	store.integration.CredentialsRef = "cred_shortstack_1"
	store.integration.Status = "connected"
	store.integration.Settings = map[string]any{
		"account_id":      "acct_123",
		"campaign_id":     "contest_456",
		"form_id":         "form_789",
		"form_name":       "Giveaway Form",
		"credentials_ref": "cred_shortstack_1",
		"default_tags":    "campaign",
	}
	return store
}

func shortStackSignedRequest(method, target, body, secret string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(body))
	req.Header.Set("X-SS-Signature", "sha1="+hex.EncodeToString(mac.Sum(nil)))
	return req
}

type fakeShortStackCredentialResolver struct {
	creds ShortStackCredentials
	err   error
}

func (f fakeShortStackCredentialResolver) ResolveShortStack(context.Context, string, Integration) (ShortStackCredentials, error) {
	if f.err != nil {
		return ShortStackCredentials{}, f.err
	}
	return f.creds, nil
}
