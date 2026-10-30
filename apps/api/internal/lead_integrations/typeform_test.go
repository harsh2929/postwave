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

func TestTypeformRESTBackfillerFetchesResponsesAndMapsSubmission(t *testing.T) {
	var sawFormAuth bool
	var sawResponsesAuth bool
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer tf_token" {
			if strings.HasSuffix(r.URL.Path, "/forms/abc123") {
				sawFormAuth = true
			}
			if strings.HasSuffix(r.URL.Path, "/forms/abc123/responses") {
				sawResponsesAuth = true
			}
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/forms/abc123":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":    "abc123",
				"title": "Newsletter Signup",
				"_links": map[string]any{
					"responses": server.URL + "/forms/abc123/responses",
				},
				"fields": []map[string]any{
					{"id": "fld_email", "ref": "email", "title": "Email", "type": "email"},
					{"id": "fld_first", "ref": "first_name", "title": "First name", "type": "short_text"},
					{"id": "fld_company", "ref": "company", "title": "Company", "type": "short_text"},
				},
			})
		case "/forms/abc123/responses":
			if r.URL.Query().Get("page_size") != "2" || r.URL.Query().Get("response_type") != "completed" {
				t.Fatalf("unexpected query: %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"page_count":  1,
				"total_items": 1,
				"items": []map[string]any{
					{
						"token":        "resp_1",
						"submitted_at": "2026-06-16T10:00:00Z",
						"hidden":       map[string]any{"utm_source": "newsletter"},
						"answers": []map[string]any{
							{"field": map[string]any{"id": "fld_email", "ref": "email", "type": "email"}, "type": "email", "email": "Lead@Example.com"},
							{"field": map[string]any{"id": "fld_first", "ref": "first_name", "type": "short_text"}, "type": "text", "text": "Ada"},
							{"field": map[string]any{"id": "fld_company", "ref": "company", "type": "short_text"}, "type": "text", "text": "Moosewave"},
						},
					},
				},
			})
		default:
			t.Fatalf("unexpected Typeform path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	integration := Integration{
		ID:             "lead_1",
		TenantID:       "tenant-1",
		Provider:       ProviderTypeform,
		CredentialsRef: "cred_typeform_1",
		Settings: map[string]any{
			"form_id":      "abc123",
			"default_tags": "newsletter,launch",
		},
	}
	backfiller := TypeformRESTBackfiller{
		HTTPClient:  server.Client(),
		Credentials: fakeTypeformCredentialResolver{creds: TypeformCredentials{AccessToken: "tf_token"}},
		APIBaseURL:  server.URL,
		PageSize:    2,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", integration, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawFormAuth || !sawResponsesAuth {
		t.Fatalf("expected bearer auth on form and responses requests, form=%v responses=%v", sawFormAuth, sawResponsesAuth)
	}
	if !strings.HasPrefix(req.Cursor, typeformCursorPrefix) || req.Cursor == typeformCursorComplete || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	got := req.Submissions[0]
	if got.SourceID != "typeform://response/abc123/resp_1" || got.Email != "lead@example.com" || got.FirstName != "Ada" || got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.Fields["hidden.utm_source"] != "newsletter" || got.Fields["email"] != "Lead@Example.com" {
		t.Fatalf("fields=%+v", got.Fields)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "typeform:abc123") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestTypeformRESTBackfillerUsesAfterCursor(t *testing.T) {
	var after string
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/forms/abc123":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":     "abc123",
				"_links": map[string]any{"responses": server.URL + "/forms/abc123/responses"},
			})
		case "/forms/abc123/responses":
			after = r.URL.Query().Get("after")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"page_count":  2,
				"total_items": 2,
				"items": []map[string]any{
					{"token": "resp_2", "answers": []map[string]any{{"field": map[string]any{"ref": "email", "type": "email"}, "type": "email", "email": "lead@example.com"}}},
				},
			})
		default:
			t.Fatalf("unexpected Typeform path %s", r.URL.Path)
		}
	}))
	defer server.Close()

	req, err := (TypeformRESTBackfiller{
		HTTPClient:  server.Client(),
		Credentials: fakeTypeformCredentialResolver{creds: TypeformCredentials{AccessToken: "tf_token"}},
		APIBaseURL:  server.URL,
		PageSize:    1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderTypeform,
		CredentialsRef: "cred_typeform_1",
		Settings:       map[string]any{"form_id": "abc123"},
	}, encodeTypeformCursor("resp_1"))
	if err != nil {
		t.Fatal(err)
	}
	if after != "resp_1" {
		t.Fatalf("after=%q", after)
	}
	if !strings.HasPrefix(req.Cursor, typeformCursorPrefix) || req.Cursor == typeformCursorComplete {
		t.Fatalf("cursor=%q", req.Cursor)
	}
}

func TestTypeformRESTWebhookRegistrarUpsertsAndDeletesWebhook(t *testing.T) {
	var upsertBody map[string]any
	var deleteCalled bool
	var sawBearer bool
	var verifyCalled bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer tf_token" {
			sawBearer = true
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/forms/abc123/webhooks/postwave-prod":
			if err := json.NewDecoder(r.Body).Decode(&upsertBody); err != nil {
				t.Fatal(err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":          "wh_123",
				"tag":         "postwave-prod",
				"form_id":     "abc123",
				"url":         "https://app.postwave.test/api/public/lead-integrations/typeform/webhooks",
				"enabled":     true,
				"event_types": map[string]bool{"form_response": true},
				"verify_ssl":  true,
			})
		case r.Method == http.MethodGet && r.URL.Path == "/forms/abc123/webhooks/postwave-prod":
			verifyCalled = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":          "wh_123",
				"tag":         "postwave-prod",
				"form_id":     "abc123",
				"url":         "https://app.postwave.test/api/public/lead-integrations/typeform/webhooks",
				"enabled":     true,
				"event_types": map[string]bool{"form_response": true},
				"verify_ssl":  true,
			})
		case r.Method == http.MethodDelete && r.URL.Path == "/forms/abc123/webhooks/postwave-prod":
			deleteCalled = true
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected Typeform request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	registrar := TypeformRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: fakeTypeformCredentialResolver{creds: TypeformCredentials{AccessToken: "tf_token", WebhookSecret: "whsec_123"}},
		APIBaseURL:  srv.URL,
		Now:         func() time.Time { return now },
	}
	integration := Integration{
		TenantID:       "tenant-1",
		Provider:       ProviderTypeform,
		CredentialsRef: "cred_typeform_1",
		Settings:       map[string]any{"form_id": "abc123", "credentials_ref": "cred_typeform_1", "webhook_tag": "postwave-prod"},
	}
	summary, err := registrar.ReconcileWebhook(context.Background(), integration, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !sawBearer || !verifyCalled || summary.WebhookID != "wh_123" || summary.Tag != "postwave-prod" || !summary.Upserted || !summary.Verified || !summary.RegisteredAt.Equal(now) || !summary.VerifiedAt.Equal(now) {
		t.Fatalf("summary=%+v bearer=%v verifyCalled=%v", summary, sawBearer, verifyCalled)
	}
	if upsertBody["url"] != "https://app.postwave.test/api/public/lead-integrations/typeform/webhooks" ||
		upsertBody["secret"] != "whsec_123" ||
		upsertBody["enabled"] != true ||
		upsertBody["verify_ssl"] != true {
		t.Fatalf("upsertBody=%+v", upsertBody)
	}
	eventTypes, ok := upsertBody["event_types"].(map[string]any)
	if !ok || eventTypes["form_response"] != true {
		t.Fatalf("event_types=%+v", upsertBody["event_types"])
	}

	integration.Settings["typeform_webhook_id"] = summary.WebhookID
	integration.Settings["typeform_webhook_tag"] = summary.Tag
	integration.Settings["typeform_webhook_endpoint"] = summary.Endpoint
	cleanup, err := registrar.CleanupWebhook(context.Background(), integration, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !deleteCalled || cleanup.WebhookID != "wh_123" || cleanup.Tag != "postwave-prod" || !cleanup.Deleted || !cleanup.CleanedUpAt.Equal(now) {
		t.Fatalf("cleanup=%+v deleteCalled=%v", cleanup, deleteCalled)
	}
}

func TestTypeformRESTWebhookRegistrarRejectsDriftAfterUpsert(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/forms/abc123/webhooks/postwave":
			_, _ = w.Write([]byte(`{"id":"wh_123","tag":"postwave","form_id":"abc123","url":"https://app.postwave.test/api/public/lead-integrations/typeform/webhooks","event_types":{"form_response":true}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/forms/abc123/webhooks/postwave":
			_, _ = w.Write([]byte(`{"id":"wh_123","tag":"postwave","form_id":"abc123","url":"https://other.example/webhook","event_types":{"form_response":true}}`))
		default:
			t.Fatalf("unexpected Typeform request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	_, err := (TypeformRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: fakeTypeformCredentialResolver{creds: TypeformCredentials{AccessToken: "tf_token", WebhookSecret: "whsec_123"}},
		APIBaseURL:  srv.URL,
	}).ReconcileWebhook(context.Background(), Integration{
		Provider:       ProviderTypeform,
		CredentialsRef: "cred_typeform_1",
		Settings:       map[string]any{"form_id": "abc123", "credentials_ref": "cred_typeform_1"},
	}, "https://app.postwave.test")
	if err == nil || !strings.Contains(err.Error(), "provider returned url") {
		t.Fatalf("expected verified webhook drift error, got %v", err)
	}
}

func TestTypeformRESTWebhookRegistrarTreatsDeleteNotFoundAsCleanedUp(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/forms/abc123/webhooks/postwave" {
			t.Fatalf("unexpected Typeform request %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"not_found"}`))
	}))
	defer srv.Close()

	cleanup, err := (TypeformRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: fakeTypeformCredentialResolver{creds: TypeformCredentials{AccessToken: "tf_token", WebhookSecret: "whsec_123"}},
		APIBaseURL:  srv.URL,
	}).CleanupWebhook(context.Background(), Integration{
		Provider:       ProviderTypeform,
		CredentialsRef: "cred_typeform_1",
		Settings:       map[string]any{"form_id": "abc123", "credentials_ref": "cred_typeform_1", "typeform_webhook_tag": "postwave"},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !cleanup.NotFound || cleanup.Deleted {
		t.Fatalf("cleanup=%+v", cleanup)
	}
}

func TestTypeformWebhookEventTypesIncludePartialWhenConfigured(t *testing.T) {
	got := typeformWebhookEventTypes(Integration{Settings: map[string]any{"response_type": "partial"}})
	if !got["form_response"] || !got["form_response_partial"] {
		t.Fatalf("event types=%+v", got)
	}
}
