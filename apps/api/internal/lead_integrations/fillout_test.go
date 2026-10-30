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

func TestParseFilloutCredentialSecret(t *testing.T) {
	creds, err := parseFilloutCredentialSecret(`{
		"api_key":"api_123",
		"webhook_secret":"webhook_123",
		"api_base_url":"https://eu-api.fillout.com/v1/api/",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "api_123" || creds.WebhookSecret != "webhook_123" {
		t.Fatalf("creds=%+v", creds)
	}
	if creds.APIBaseURL != "https://eu-api.fillout.com/v1/api" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestFilloutRESTBackfillerFetchesSubmissionsAndMapsSubmission(t *testing.T) {
	var sawBearer bool
	var sawSubmissionsQuery bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer fillout_token" {
			sawBearer = true
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/forms/form_123":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":   "form_123",
				"name": "Newsletter Signup",
				"questions": []map[string]any{
					{"id": "q_email", "name": "Email"},
					{"id": "q_first", "name": "First name"},
					{"id": "q_last", "name": "Last name"},
					{"id": "q_company", "name": "Company"},
				},
			})
		case "/forms/form_123/submissions":
			sawSubmissionsQuery = true
			if r.URL.Query().Get("offset") != "0" || r.URL.Query().Get("limit") != "2" || r.URL.Query().Get("sort") != "asc" || r.URL.Query().Get("status") != "finished" {
				t.Fatalf("unexpected query: %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"totalResponses": 1,
				"pageCount":      1,
				"responses": []map[string]any{
					{
						"submissionId":   "sub_123",
						"submissionTime": "2026-06-16T10:00:00Z",
						"questions": []map[string]any{
							{"id": "q_email", "name": "Email", "type": "EmailInput", "value": "Lead@Example.com"},
							{"id": "q_first", "name": "First name", "type": "ShortAnswer", "value": "Ada"},
							{"id": "q_last", "name": "Last name", "type": "ShortAnswer", "value": "Lovelace"},
							{"id": "q_company", "name": "Company", "type": "ShortAnswer", "value": "Moosewave"},
						},
						"urlParameters": []map[string]any{
							{"id": "utm_source", "name": "utm_source", "type": "Hidden", "value": "launch"},
						},
					},
				},
			})
		default:
			t.Fatalf("unexpected Fillout path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (FilloutRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFilloutCredentialResolver{creds: FilloutCredentials{AccessToken: "fillout_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFillout,
		CredentialsRef: "cred_fillout_1",
		Settings:       map[string]any{"form_id": "form_123", "status": "finished", "default_tags": "newsletter,launch"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawBearer || !sawSubmissionsQuery {
		t.Fatalf("expected bearer auth and submissions query, bearer=%v submissions=%v", sawBearer, sawSubmissionsQuery)
	}
	if req.Cursor != filloutCursorComplete || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	got := req.Submissions[0]
	if got.SourceID != "fillout://submission/form_123/sub_123" || got.Email != "lead@example.com" || got.FirstName != "Ada" || got.LastName != "Lovelace" || got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Newsletter Signup" || got.Fields["fillout_url_parameter.utm_source"] != "launch" || got.Fields["fillout_question.email"] != "Lead@Example.com" {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "fillout:form_123") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestFilloutRESTBackfillerUsesOffsetCursor(t *testing.T) {
	var offset string
	var limit string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/forms/form_123":
			_, _ = w.Write([]byte(`{"id":"form_123","name":"Newsletter"}`))
		case "/forms/form_123/submissions":
			offset = r.URL.Query().Get("offset")
			limit = r.URL.Query().Get("limit")
			_, _ = w.Write([]byte(`{"totalResponses":3,"responses":[{"submissionId":"sub_2","submissionTime":"2026-06-16T10:00:00Z","questions":[{"name":"Email","type":"EmailInput","value":"lead@example.com"}]}]}`))
		default:
			t.Fatalf("unexpected Fillout path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (FilloutRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFilloutCredentialResolver{creds: FilloutCredentials{AccessToken: "fillout_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFillout,
		CredentialsRef: "cred_fillout_1",
		Settings:       map[string]any{"form_id": "form_123"},
	}, encodeFilloutCursor(filloutCursorState{Offset: 1}))
	if err != nil {
		t.Fatal(err)
	}
	if offset != "1" || limit != "1" {
		t.Fatalf("offset=%q limit=%q", offset, limit)
	}
	if !strings.HasPrefix(req.Cursor, filloutCursorPrefix) || req.Cursor == filloutCursorComplete {
		t.Fatalf("cursor=%q", req.Cursor)
	}
	state, err := decodeFilloutCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Offset != 2 {
		t.Fatalf("state=%+v", state)
	}
}

func TestFilloutRESTWebhookRegistrarCreatesAndDeletesWebhook(t *testing.T) {
	var createBody map[string]string
	var deleteBody map[string]string
	var sawBearer bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer fillout_token" {
			sawBearer = true
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/webhook/create":
			if err := json.NewDecoder(r.Body).Decode(&createBody); err != nil {
				t.Fatal(err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 321})
		case "/webhook/delete":
			if err := json.NewDecoder(r.Body).Decode(&deleteBody); err != nil {
				t.Fatal(err)
			}
			_, _ = w.Write([]byte(`{}`))
		default:
			t.Fatalf("unexpected Fillout path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	registrar := FilloutRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: fakeFilloutCredentialResolver{creds: FilloutCredentials{AccessToken: "fillout_token", WebhookSecret: "fillout_secret"}},
		APIBaseURL:  srv.URL,
		Now:         func() time.Time { return now },
	}
	integration := Integration{
		TenantID:       "tenant-1",
		Provider:       ProviderFillout,
		CredentialsRef: "cred_fillout_1",
		Settings:       map[string]any{"form_id": "form_123", "credentials_ref": "cred_fillout_1"},
	}
	summary, err := registrar.ReconcileWebhook(context.Background(), integration, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !sawBearer || summary.WebhookID != "321" || !summary.Created || !summary.RegisteredAt.Equal(now) {
		t.Fatalf("summary=%+v bearer=%v", summary, sawBearer)
	}
	if summary.Endpoint != "https://app.postwave.test/api/public/lead-integrations/fillout/webhooks?form_id=form_123" || strings.Contains(summary.Endpoint, "token=") {
		t.Fatalf("safe endpoint=%q", summary.Endpoint)
	}
	if createBody["formId"] != "form_123" || !strings.Contains(createBody["url"], "token=fillout_secret") || !strings.Contains(createBody["url"], "form_id=form_123") {
		t.Fatalf("createBody=%+v", createBody)
	}

	integration.Settings["fillout_webhook_id"] = summary.WebhookID
	integration.Settings["fillout_webhook_endpoint"] = summary.Endpoint
	cleanup, err := registrar.CleanupWebhook(context.Background(), integration, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if cleanup.WebhookID != "321" || !cleanup.Deleted || !cleanup.CleanedUpAt.Equal(now) {
		t.Fatalf("cleanup=%+v", cleanup)
	}
	if deleteBody["webhookId"] != "321" {
		t.Fatalf("deleteBody=%+v", deleteBody)
	}
}

func TestFilloutRESTWebhookRegistrarReusesExistingWebhookMetadata(t *testing.T) {
	registrar := FilloutRESTWebhookRegistrar{
		Credentials: fakeFilloutCredentialResolver{creds: FilloutCredentials{AccessToken: "fillout_token", WebhookSecret: "fillout_secret"}},
		Now:         func() time.Time { return time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC) },
	}
	summary, err := registrar.ReconcileWebhook(context.Background(), Integration{
		Provider: ProviderFillout,
		Settings: map[string]any{
			"form_id":                  "form_123",
			"fillout_webhook_id":       "fillout_wh_existing",
			"fillout_webhook_endpoint": "https://app.postwave.test/api/public/lead-integrations/fillout/webhooks?form_id=form_123",
		},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if summary.WebhookID != "fillout_wh_existing" || !summary.Reused || summary.Created {
		t.Fatalf("summary=%+v", summary)
	}
}
