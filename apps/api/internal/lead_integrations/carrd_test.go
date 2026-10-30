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

func TestParseCarrdCredentialSecret(t *testing.T) {
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
			creds, err := parseCarrdCredentialSecret(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if creds.WebhookToken != tc.want {
				t.Fatalf("token=%q want %q", creds.WebhookToken, tc.want)
			}
		})
	}
}

func TestCarrdWebhookIngestsJSONSubmission(t *testing.T) {
	store := carrdFakeStore()
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	deps := &Deps{
		Repo:              store,
		Profiles:          profiles,
		Events:            events,
		CarrdCredentials:  fakeCarrdCredentialResolver{creds: CarrdCredentials{WebhookToken: "carrd_secret"}},
		Now:               func() time.Time { return time.Date(2026, 7, 4, 12, 30, 0, 0, time.UTC) },
		MaxSyncRows:       10,
		PublicBaseURL:     "https://app.postwave.test",
		FilloutBackfiller: nil,
	}
	body := `{"submission_id":"sub_123","email":"Lead@Example.com","first_name":"Ada","company":"Moosewave","submitted_at":"2026-07-04T12:00:00Z","token":"do_not_store"}`
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/carrd/webhooks?site_id=site_123&form_id=newsletter&token=carrd_secret", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.CarrdWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || len(events.submissions) != 1 {
		t.Fatalf("profiles=%d events=%d", len(profiles.submissions), len(events.submissions))
	}
	submission := profiles.submissions[0]
	if submission.Email != "lead@example.com" ||
		submission.FirstName != "Ada" ||
		submission.Company != "Moosewave" ||
		submission.FormID != "newsletter" ||
		submission.FormName != "Newsletter" ||
		submission.SourceID != "carrd://site_123/newsletter/carrd_sub_123" {
		t.Fatalf("submission=%+v", submission)
	}
	if submission.SubmittedAt == nil || !submission.SubmittedAt.Equal(time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("submitted_at=%v", submission.SubmittedAt)
	}
	if !containsFold(submission.Tags, "carrd") || !containsFold(submission.Tags, "carrd:site_123") || !containsFold(submission.Tags, "campaign") {
		t.Fatalf("tags=%+v", submission.Tags)
	}
	if _, ok := submission.Fields["carrd_field.token"]; ok {
		t.Fatalf("token leaked into field map: %+v", submission.Fields)
	}
	query, ok := submission.Fields["carrd_query"].(map[string]any)
	if !ok || query["token"] != "[redacted]" {
		t.Fatalf("query redaction failed: %+v", submission.Fields["carrd_query"])
	}
	if store.webhooks[ProviderCarrd+":carrd_sub_123"] != WebhookProcessed {
		t.Fatalf("webhook claim=%+v", store.webhooks)
	}
}

func TestCarrdWebhookAcceptsGETAndDedupes(t *testing.T) {
	store := carrdFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:             store,
		Profiles:         profiles,
		CarrdCredentials: fakeCarrdCredentialResolver{creds: CarrdCredentials{WebhookToken: "carrd_secret"}},
	}
	target := "/api/public/lead-integrations/carrd/webhooks?site_id=site_123&form_id=newsletter&token=carrd_secret&submission_id=get_1&email=get%40example.com&full_name=Get%20Lead"

	rec := httptest.NewRecorder()
	deps.CarrdWebhook(rec, httptest.NewRequest(http.MethodGet, target, nil))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "get@example.com" || profiles.submissions[0].FullName != "Get Lead" {
		t.Fatalf("submissions=%+v", profiles.submissions)
	}

	rec = httptest.NewRecorder()
	deps.CarrdWebhook(rec, httptest.NewRequest(http.MethodGet, target, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("duplicate status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 {
		t.Fatalf("duplicate should not reprocess: %+v", profiles.submissions)
	}
}

func TestCarrdWebhookRejectsBadToken(t *testing.T) {
	store := carrdFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:             store,
		Profiles:         profiles,
		CarrdCredentials: fakeCarrdCredentialResolver{creds: CarrdCredentials{WebhookToken: "carrd_secret"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/carrd/webhooks?site_id=site_123&form_id=newsletter&token=wrong", strings.NewReader(`{"email":"lead@example.com"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.CarrdWebhook(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 0 {
		t.Fatalf("unexpected submissions=%+v", profiles.submissions)
	}
}

func TestCarrdWebhookAcceptsXMLSubmission(t *testing.T) {
	store := carrdFakeStore()
	profiles := &fakeProfileSink{}
	deps := &Deps{
		Repo:             store,
		Profiles:         profiles,
		CarrdCredentials: fakeCarrdCredentialResolver{creds: CarrdCredentials{WebhookToken: "carrd_secret"}},
	}
	body := `<submission><site_id>site_123</site_id><form_id>newsletter</form_id><submission_id>xml_1</submission_id><email>xml@example.com</email><name>XML Lead</name></submission>`
	req := httptest.NewRequest(http.MethodPost, "/api/public/lead-integrations/carrd/webhooks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/xml")
	req.Header.Set("X-Postwave-Webhook-Token", "carrd_secret")
	rec := httptest.NewRecorder()

	deps.CarrdWebhook(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(profiles.submissions) != 1 ||
		profiles.submissions[0].Email != "xml@example.com" ||
		profiles.submissions[0].FullName != "XML Lead" {
		t.Fatalf("submissions=%+v", profiles.submissions)
	}
}

func TestDisconnectCarrdReturnsAndPersistsOperatorCleanupEvidence(t *testing.T) {
	store := carrdFakeStore()
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
	if out.ProviderCleanup.Provider != ProviderCarrd ||
		out.ProviderCleanup.Status != "provider_cleanup_operator_managed" ||
		out.ProviderCleanup.ManagedProviderCleanup ||
		out.ProviderCleanup.ProviderScopeType != "carrd_site_form" ||
		out.ProviderCleanup.ProviderScopeID != "site_123/newsletter" ||
		out.ProviderCleanup.WebhookCleanupStatus != "operator_review_custom_url_form_destination" {
		t.Fatalf("provider_cleanup=%+v", out.ProviderCleanup)
	}
	stored, ok := store.integration.Settings["provider_cleanup"].(map[string]any)
	if !ok {
		t.Fatalf("provider cleanup was not persisted: %+v", store.integration.Settings)
	}
	if stored["provider"] != ProviderCarrd ||
		stored["provider_scope_id"] != "site_123/newsletter" ||
		stored["webhook_cleanup_status"] != "operator_review_custom_url_form_destination" {
		t.Fatalf("stored cleanup=%+v", stored)
	}
}

func carrdFakeStore() *fakeStore {
	store := newFakeStore()
	store.integration.Provider = ProviderCarrd
	store.integration.CredentialsRef = "cred_carrd_1"
	store.integration.Status = "connected"
	store.integration.Settings = map[string]any{
		"site_id":         "site_123",
		"form_id":         "newsletter",
		"form_name":       "Newsletter",
		"credentials_ref": "cred_carrd_1",
		"default_tags":    "campaign",
	}
	return store
}

type fakeCarrdCredentialResolver struct {
	creds CarrdCredentials
	err   error
}

func (f fakeCarrdCredentialResolver) ResolveCarrd(context.Context, string, Integration) (CarrdCredentials, error) {
	if f.err != nil {
		return CarrdCredentials{}, f.err
	}
	return f.creds, nil
}
