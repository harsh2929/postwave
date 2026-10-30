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

func TestParseJotformCredentialSecret(t *testing.T) {
	creds, err := parseJotformCredentialSecret(`{
		"api_key":"api_123",
		"webhook_secret":"webhook_123",
		"api_base_url":"https://eu-api.jotform.com/",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.APIKey != "api_123" || creds.WebhookSecret != "webhook_123" {
		t.Fatalf("creds=%+v", creds)
	}
	if creds.APIBaseURL != "https://eu-api.jotform.com" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestJotformRESTBackfillerFetchesSubmissionsAndMapsSubmission(t *testing.T) {
	var sawAPIKey bool
	var sawSubmissionsQuery bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("APIKEY") == "api_123" {
			sawAPIKey = true
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/form/form_123":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"responseCode": 200,
				"content": map[string]any{
					"id":    "form_123",
					"title": "Newsletter Signup",
				},
			})
		case "/form/form_123/questions":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"responseCode": 200,
				"content": map[string]any{
					"1": map[string]any{"qid": "1", "name": "email", "text": "Email", "type": "control_email"},
					"2": map[string]any{"qid": "2", "name": "full_name", "text": "Full name", "type": "control_fullname"},
					"3": map[string]any{"qid": "3", "name": "company", "text": "Company", "type": "control_textbox"},
				},
			})
		case "/form/form_123/submissions":
			sawSubmissionsQuery = true
			if r.URL.Query().Get("offset") != "0" || r.URL.Query().Get("limit") != "2" || r.URL.Query().Get("orderby") != "created_at" {
				t.Fatalf("unexpected query: %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"responseCode": 200,
				"content": []map[string]any{
					{
						"id":         "sub_123",
						"form_id":    "form_123",
						"created_at": "2026-06-16 10:00:00",
						"ip":         "203.0.113.10",
						"answers": map[string]any{
							"1": map[string]any{"name": "email", "text": "Email", "type": "control_email", "answer": "Lead@Example.com"},
							"2": map[string]any{"name": "full_name", "text": "Full name", "type": "control_fullname", "answer": map[string]any{"first": "Ada", "last": "Lovelace"}},
							"3": map[string]any{"name": "company", "text": "Company", "type": "control_textbox", "answer": "Moosewave"},
						},
					},
				},
			})
		default:
			t.Fatalf("unexpected Jotform path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	integration := Integration{
		ID:             "lead_1",
		TenantID:       "tenant-1",
		Provider:       ProviderJotform,
		CredentialsRef: "cred_jotform_1",
		Settings: map[string]any{
			"form_id":      "form_123",
			"default_tags": "newsletter,launch",
		},
	}
	req, err := (JotformRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeJotformCredentialResolver{creds: JotformCredentials{APIKey: "api_123"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}).BackfillPage(context.Background(), "tenant-1", integration, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawAPIKey || !sawSubmissionsQuery {
		t.Fatalf("expected APIKEY auth and submissions query, apiKey=%v submissions=%v", sawAPIKey, sawSubmissionsQuery)
	}
	if req.Cursor != jotformCursorComplete || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	got := req.Submissions[0]
	if got.SourceID != "jotform://submission/form_123/sub_123" || got.Email != "lead@example.com" || got.FirstName != "Ada" || got.LastName != "Lovelace" || got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Newsletter Signup" || got.Fields["jotform_ip"] != "203.0.113.10" || got.Fields["jotform_answer.email"] != "Lead@Example.com" {
		t.Fatalf("fields/form=%+v %+v", got.FormName, got.Fields)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "jotform:form_123") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestJotformRESTBackfillerUsesOffsetCursor(t *testing.T) {
	var offset string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/form/form_123":
			_, _ = w.Write([]byte(`{"responseCode":200,"content":{"id":"form_123"}}`))
		case "/form/form_123/questions":
			_, _ = w.Write([]byte(`{"responseCode":200,"content":{}}`))
		case "/form/form_123/submissions":
			offset = r.URL.Query().Get("offset")
			_, _ = w.Write([]byte(`{"responseCode":200,"content":[{"id":"sub_2","form_id":"form_123","answers":{"email":{"name":"email","text":"Email","type":"control_email","answer":"lead@example.com"}}}]}`))
		default:
			t.Fatalf("unexpected Jotform path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (JotformRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeJotformCredentialResolver{creds: JotformCredentials{APIKey: "api_123"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderJotform,
		CredentialsRef: "cred_jotform_1",
		Settings:       map[string]any{"form_id": "form_123"},
	}, encodeJotformCursor(jotformCursorState{Offset: 1}))
	if err != nil {
		t.Fatal(err)
	}
	if offset != "1" {
		t.Fatalf("offset=%q", offset)
	}
	if !strings.HasPrefix(req.Cursor, jotformCursorPrefix) || req.Cursor == jotformCursorComplete {
		t.Fatalf("cursor=%q", req.Cursor)
	}
	state, err := decodeJotformCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Offset != 2 {
		t.Fatalf("state=%+v", state)
	}
}

func TestJotformRESTWebhookRegistrarReusesExistingWebhookAcrossTokenRotation(t *testing.T) {
	var postCalled bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("APIKEY") != "api_123" {
			t.Fatalf("APIKEY=%q", r.Header.Get("APIKEY"))
		}
		if r.Method == http.MethodPost {
			postCalled = true
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/form/form_123/webhooks":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"responseCode": 200,
				"content": map[string]any{
					"123": "https://app.postwave.test/api/public/lead-integrations/jotform/webhooks?form_id=form_123&token=old_secret",
				},
			})
		default:
			t.Fatalf("unexpected Jotform webhook request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	registeredAt := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	summary, err := (JotformRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: fakeJotformCredentialResolver{creds: JotformCredentials{APIKey: "api_123", WebhookSecret: "new_secret"}},
		APIBaseURL:  srv.URL,
		Now:         func() time.Time { return registeredAt },
	}).ReconcileWebhook(context.Background(), Integration{
		TenantID:       "tenant-1",
		Provider:       ProviderJotform,
		CredentialsRef: "cred_jotform_1",
		Settings:       map[string]any{"form_id": "form_123"},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if postCalled {
		t.Fatal("expected existing webhook to be reused without POST")
	}
	if summary.WebhookID != "123" || !summary.Reused || summary.Created || !summary.RegisteredAt.Equal(registeredAt) {
		t.Fatalf("summary=%+v", summary)
	}
	if strings.Contains(summary.Endpoint, "token=") || summary.Endpoint != "https://app.postwave.test/api/public/lead-integrations/jotform/webhooks?form_id=form_123" {
		t.Fatalf("endpoint=%q", summary.Endpoint)
	}
}

func TestJotformRESTWebhookRegistrarCreatesAndDeletesWebhook(t *testing.T) {
	calls := []string{}
	var deliveryURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("APIKEY") != "api_123" {
			t.Fatalf("APIKEY=%q", r.Header.Get("APIKEY"))
		}
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/form/form_123/webhooks":
			_ = json.NewEncoder(w).Encode(map[string]any{"responseCode": 200, "content": map[string]any{}})
		case r.Method == http.MethodPost && r.URL.Path == "/form/form_123/webhooks":
			if got := r.Header.Get("Content-Type"); !strings.Contains(got, "application/x-www-form-urlencoded") {
				t.Fatalf("content-type=%q", got)
			}
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			deliveryURL = r.Form.Get("webhookURL")
			if !strings.Contains(deliveryURL, "form_id=form_123") || !strings.Contains(deliveryURL, "token=webhook_secret") {
				t.Fatalf("webhookURL=%q", deliveryURL)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"responseCode": 200,
				"content": map[string]any{
					"456": deliveryURL,
				},
			})
		case r.Method == http.MethodDelete && r.URL.Path == "/form/form_123/webhooks/456":
			_ = json.NewEncoder(w).Encode(map[string]any{"responseCode": 200, "content": map[string]any{}})
		default:
			t.Fatalf("unexpected Jotform webhook request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	now := time.Date(2026, 6, 18, 12, 30, 0, 0, time.UTC)
	registrar := JotformRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: fakeJotformCredentialResolver{creds: JotformCredentials{APIKey: "api_123", WebhookSecret: "webhook_secret"}},
		APIBaseURL:  srv.URL,
		Now:         func() time.Time { return now },
	}
	integration := Integration{
		TenantID:       "tenant-1",
		Provider:       ProviderJotform,
		CredentialsRef: "cred_jotform_1",
		Settings:       map[string]any{"form_id": "form_123"},
	}
	reconciled, err := registrar.ReconcileWebhook(context.Background(), integration, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if reconciled.WebhookID != "456" || !reconciled.Created || reconciled.Reused {
		t.Fatalf("reconciled=%+v", reconciled)
	}
	if strings.Contains(reconciled.Endpoint, "token=") || deliveryURL == reconciled.Endpoint {
		t.Fatalf("endpoint=%q deliveryURL=%q", reconciled.Endpoint, deliveryURL)
	}

	integration.Settings["jotform_webhook_id"] = reconciled.WebhookID
	integration.Settings["jotform_webhook_endpoint"] = reconciled.Endpoint
	cleaned, err := registrar.CleanupWebhook(context.Background(), integration, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if cleaned.WebhookID != "456" || !cleaned.Deleted || !cleaned.CleanedUpAt.Equal(now) {
		t.Fatalf("cleaned=%+v", cleaned)
	}
	if got := strings.Join(calls, ","); got != "GET /form/form_123/webhooks,POST /form/form_123/webhooks,DELETE /form/form_123/webhooks/456" {
		t.Fatalf("calls=%+v", calls)
	}
}

func TestJotformRESTWebhookRegistrarTreatsDeleteNotFoundAsCleanedUp(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/form/form_123/webhooks/missing" {
			t.Fatalf("unexpected Jotform webhook request %s %s", r.Method, r.URL.Path)
		}
		http.Error(w, `{"responseCode":404,"message":"not found"}`, http.StatusNotFound)
	}))
	defer srv.Close()

	cleaned, err := (JotformRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: fakeJotformCredentialResolver{creds: JotformCredentials{APIKey: "api_123"}},
		APIBaseURL:  srv.URL,
	}).CleanupWebhook(context.Background(), Integration{
		TenantID:       "tenant-1",
		Provider:       ProviderJotform,
		CredentialsRef: "cred_jotform_1",
		Settings: map[string]any{
			"form_id":                  "form_123",
			"jotform_webhook_id":       "missing",
			"jotform_webhook_endpoint": "https://app.postwave.test/api/public/lead-integrations/jotform/webhooks?form_id=form_123",
		},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if cleaned.WebhookID != "missing" || !cleaned.Deleted {
		t.Fatalf("cleaned=%+v", cleaned)
	}
}

func TestDecodeJotformWebhookListHandlesObjectsArraysAndContent(t *testing.T) {
	got, err := decodeJotformWebhookList([]byte(`{
		"content":{
			"alpha":"https://example.test/a",
			"beta":{"id":"beta","webhookURL":"https://example.test/b"},
			"webhooks":[{"whid":"gamma","url":"https://example.test/c"}]
		}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	for id, url := range map[string]string{
		"alpha": "https://example.test/a",
		"beta":  "https://example.test/b",
		"gamma": "https://example.test/c",
	} {
		if got[id] != url {
			t.Fatalf("got[%s]=%q all=%+v", id, got[id], got)
		}
	}
}
