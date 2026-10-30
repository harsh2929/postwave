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

func TestParseNinjaFormsCredentialSecret(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{name: "plain", raw: "ninja_secret", want: "ninja_secret"},
		{name: "json", raw: `{"webhook_token":"json_secret","user_agent":"Moosewave Test"}`, want: "json_secret"},
		{name: "key value", raw: "route_token=kv_secret&user_agent=Moosewave", want: "kv_secret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			creds, err := parseNinjaFormsCredentialSecret(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if creds.WebhookToken != tc.want {
				t.Fatalf("token=%q want %q", creds.WebhookToken, tc.want)
			}
		})
	}
}

func TestNinjaFormsWebhookIngestsFormPost(t *testing.T) {
	store := ninjaFormsFakeStore()
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:                  store,
		Profiles:              profiles,
		Events:                events,
		NinjaFormsCredentials: fakeNinjaFormsCredentialResolver{creds: NinjaFormsCredentials{WebhookToken: "ninja_secret"}},
		Now:                   func() time.Time { return time.Date(2026, 7, 4, 15, 0, 0, 0, time.UTC) },
		MaxSyncRows:           10,
		PublicBaseURL:         "https://app.postwave.test",
	}
	body := "submission_id=sub_123&email=Lead%40Example.com&first_name=Ada&last_name=Lovelace&company=Moosewave&token=do_not_store"
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/ninja-forms/webhooks?site_url=https%3A%2F%2Fexample.com%2F&form_id=newsletter&token=ninja_secret", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()

	deps.NinjaFormsWebhook(rec, req)

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
		submission.FormID != "newsletter" ||
		submission.FormName != "Newsletter" ||
		submission.EventName != "lead.submitted" ||
		submission.SourceID != "ninja-forms://submission/https:%2F%2Fexample.com/newsletter/ninja_forms_sub_123" {
		t.Fatalf("submission=%+v", submission)
	}
	if !containsFold(submission.Tags, "ninja-forms") || !containsFold(submission.Tags, "ninja-forms:form:newsletter") || !containsFold(submission.Tags, "campaign") {
		t.Fatalf("tags=%+v", submission.Tags)
	}
	if _, ok := submission.Fields["ninja_forms_field.token"]; ok {
		t.Fatalf("token leaked into field map: %+v", submission.Fields)
	}
	query, ok := submission.Fields["ninja_forms_query"].(map[string]any)
	if !ok || query["token"] != "[redacted]" {
		t.Fatalf("query redaction failed: %+v", submission.Fields["ninja_forms_query"])
	}
	if store.webhooks[ProviderNinjaForms+":ninja_forms_sub_123"] != WebhookProcessed {
		t.Fatalf("webhook claim=%+v", store.webhooks)
	}
}

func TestNinjaFormsWebhookAcceptsGETAndDedupes(t *testing.T) {
	store := ninjaFormsFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                  store,
		Profiles:              profiles,
		NinjaFormsCredentials: fakeNinjaFormsCredentialResolver{creds: NinjaFormsCredentials{WebhookToken: "ninja_secret"}},
	}
	target := "/api/public/lead-integrations/ninja-forms/webhooks?site_url=https%3A%2F%2Fexample.com&form_id=newsletter&token=ninja_secret&submission_id=get_1&email=get%40example.com&full_name=Get%20Lead"

	rec := httptest.NewRecorder()
	deps.NinjaFormsWebhook(rec, httptest.NewRequest(http.MethodGet, target, nil))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "get@example.com" || profiles.submissions[0].FullName != "Get Lead" {
		t.Fatalf("submissions=%+v", profiles.submissions)
	}

	rec = httptest.NewRecorder()
	deps.NinjaFormsWebhook(rec, httptest.NewRequest(http.MethodGet, target, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("duplicate status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 {
		t.Fatalf("duplicate should not reprocess: %+v", profiles.submissions)
	}
}

func TestNinjaFormsWebhookRejectsBadToken(t *testing.T) {
	store := ninjaFormsFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:                  store,
		Profiles:              profiles,
		NinjaFormsCredentials: fakeNinjaFormsCredentialResolver{creds: NinjaFormsCredentials{WebhookToken: "ninja_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/ninja-forms/webhooks?site_url=https%3A%2F%2Fexample.com&form_id=newsletter&token=wrong", strings.NewReader(`{"email":"lead@example.com","submission_id":"bad_1"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.NinjaFormsWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 {
		t.Fatalf("unexpected submissions=%+v", profiles.submissions)
	}
}

func TestDisconnectNinjaFormsReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := ninjaFormsFakeStore()
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
	if out.ProviderCleanup.Provider != ProviderNinjaForms ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderScopeType != "ninja_forms_site_form" ||
		out.ProviderCleanup.ProviderScopeID != "https://example.com/newsletter" ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_review_ninja_forms_webhook_action" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["provider"] != ProviderNinjaForms ||
		stored["provider_scope_id"] != "https://example.com/newsletter" ||
		stored["webhook_cleanup_status"] != "operator_review_ninja_forms_webhook_action" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func ninjaFormsFakeStore() *fakeStore {
	store := newFakeStore()
	store.integration.Provider = ProviderNinjaForms
	store.integration.CredentialsRef = "cred_ninja_forms_1"
	store.integration.Status = "connected"
	store.integration.Settings = map[string]any{
		"site_url":        "https://example.com",
		"form_id":         "newsletter",
		"form_name":       "Newsletter",
		"credentials_ref": "cred_ninja_forms_1",
		"default_tags":    "campaign",
	}
	return store
}

type fakeNinjaFormsCredentialResolver struct {
	creds NinjaFormsCredentials
	err   error
}

func (f fakeNinjaFormsCredentialResolver) ResolveNinjaForms(context.Context, string, Integration) (NinjaFormsCredentials, error) {
	if f.err != nil {
		return NinjaFormsCredentials{}, f.err
	}
	return f.creds, nil
}
