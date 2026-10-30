// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseWebflowCredentialSecret(t *testing.T) {
	creds, err := parseWebflowCredentialSecret(`{
		"access_token":"wf_123",
		"webhook_secret":"whsec_123",
		"api_base_url":"https://api.webflow.com/",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "wf_123" || creds.WebhookSecret != "whsec_123" {
		t.Fatalf("creds=%+v", creds)
	}
	if creds.APIBaseURL != "https://api.webflow.com" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestWebflowRESTBackfillerFetchesSubmissionsAndMapsSubmission(t *testing.T) {
	var sawBearer bool
	var sawSubmissionsQuery bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer wf_token" {
			sawBearer = true
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/sites/site_123/forms/form_456/submissions":
			sawSubmissionsQuery = true
			if r.URL.Query().Get("offset") != "0" || r.URL.Query().Get("limit") != "2" {
				t.Fatalf("unexpected query: %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"formSubmissions": []map[string]any{
					{
						"id":            "sub_123",
						"displayName":   "Newsletter",
						"siteId":        "site_123",
						"workspaceId":   "workspace_123",
						"formId":        "form_456",
						"formElementId": "element_789",
						"dateSubmitted": "2026-06-16T10:00:00Z",
						"formResponse": map[string]any{
							"Email":      "Lead@Example.com",
							"First Name": "Ada",
							"Last Name":  "Lovelace",
							"Company":    "Moosewave",
						},
						"schema": []map[string]any{
							{"fieldName": "Email", "fieldType": "Email", "fieldElementId": "field_email"},
						},
					},
				},
				"pagination": map[string]any{"limit": 2, "offset": 0, "total": 1},
			})
		default:
			t.Fatalf("unexpected Webflow path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (WebflowRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{AccessToken: "wf_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderWebflow,
		CredentialsRef: "cred_webflow_1",
		Settings:       map[string]any{"site_id": "site_123", "form_id": "form_456", "default_tags": "newsletter,launch"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawBearer || !sawSubmissionsQuery {
		t.Fatalf("expected bearer auth and submissions query, bearer=%v submissions=%v", sawBearer, sawSubmissionsQuery)
	}
	if req.Cursor != webflowCursorComplete || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	got := req.Submissions[0]
	if got.SourceID != "webflow://submission/site_123/sub_123" || got.Email != "lead@example.com" || got.FirstName != "Ada" || got.LastName != "Lovelace" || got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Newsletter" || got.Fields["webflow_workspace_id"] != "workspace_123" || got.Fields["webflow_field.email"] != "Lead@Example.com" {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "webflow:site_123") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestWebflowRESTBackfillerRateLimitCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/sites/site_123/form_submissions" {
			t.Fatalf("unexpected Webflow path %s", r.URL.Path)
		}
		w.Header().Set("Retry-After", "42")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"message":"slow down"}`))
	}))
	defer srv.Close()

	_, err := (WebflowRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{AccessToken: "wf_token"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderWebflow,
		CredentialsRef: "cred_webflow_1",
		Settings:       map[string]any{"site_id": "site_123"},
	}, "")
	if err == nil {
		t.Fatal("expected rate limit error")
	}
	var statusErr webflowHTTPStatusError
	if !errors.As(err, &statusErr) || statusErr.StatusCode != http.StatusTooManyRequests || statusErr.RetryAfter != 42*time.Second || !strings.Contains(statusErr.Body, "slow down") {
		t.Fatalf("status error=%+v err=%v", statusErr, err)
	}
}

func TestWebflowRESTBackfillerUsesOffsetCursorAndSiteEndpoint(t *testing.T) {
	var offset string
	var elementID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/sites/site_123/form_submissions":
			offset = r.URL.Query().Get("offset")
			elementID = r.URL.Query().Get("elementId")
			_, _ = w.Write([]byte(`{"formSubmissions":[{"id":"sub_2","siteId":"site_123","formResponse":{"Email":"lead@example.com"}}],"pagination":{"limit":1,"offset":1,"total":3}}`))
		default:
			t.Fatalf("unexpected Webflow path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (WebflowRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{AccessToken: "wf_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderWebflow,
		CredentialsRef: "cred_webflow_1",
		Settings:       map[string]any{"site_id": "site_123", "form_element_id": "element_123"},
	}, encodeWebflowCursor(webflowCursorState{Offset: 1}))
	if err != nil {
		t.Fatal(err)
	}
	if offset != "1" || elementID != "element_123" {
		t.Fatalf("offset=%q elementID=%q", offset, elementID)
	}
	if !strings.HasPrefix(req.Cursor, webflowCursorPrefix) || req.Cursor == webflowCursorComplete {
		t.Fatalf("cursor=%q", req.Cursor)
	}
	state, err := decodeWebflowCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Offset != 2 {
		t.Fatalf("state=%+v", state)
	}
}

func TestWebflowRESTWebhookRegistrarReusesMatchingWebhook(t *testing.T) {
	var listed bool
	var created bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer wf_token" {
			t.Fatalf("missing bearer auth: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v2/sites/site_123/webhooks":
			if r.Method != http.MethodGet {
				t.Fatalf("method=%s", r.Method)
			}
			listed = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"webhooks": []map[string]any{
					{
						"id":          "webflow_wh_existing",
						"triggerType": "form_submission",
						"url":         "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks",
						"siteId":      "site_123",
						"filter":      map[string]any{"name": "Newsletter"},
					},
				},
			})
		default:
			if r.Method == http.MethodPost {
				created = true
			}
			t.Fatalf("unexpected Webflow path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	summary, err := (WebflowRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{AccessToken: "wf_token", WebhookSecret: "wf_secret"}},
		APIBaseURL:  srv.URL,
		Now:         func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}).ReconcileWebhook(context.Background(), Integration{
		Provider: ProviderWebflow,
		Settings: map[string]any{"site_id": "site_123", "form_name": "Newsletter"},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !listed || created || !summary.Reused || summary.Created || summary.WebhookID != "webflow_wh_existing" {
		t.Fatalf("listed=%v created=%v summary=%+v", listed, created, summary)
	}
	if summary.Filter["name"] != "Newsletter" {
		t.Fatalf("filter=%+v", summary.Filter)
	}
}

func TestWebflowRESTWebhookRegistrarReusesStoredWebhookID(t *testing.T) {
	var fetched bool
	var listed bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer wf_token" {
			t.Fatalf("missing bearer auth: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v2/webhooks/webflow_wh_existing":
			fetched = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":          "webflow_wh_existing",
				"triggerType": "form_submission",
				"url":         "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks",
				"siteId":      "site_123",
				"filter":      map[string]any{"name": "Newsletter"},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/v2/sites/site_123/webhooks":
			listed = true
			_, _ = w.Write([]byte(`{"webhooks":[]}`))
		default:
			t.Fatalf("unexpected Webflow request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	summary, err := (WebflowRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{AccessToken: "wf_token", WebhookSecret: "wf_secret"}},
		APIBaseURL:  srv.URL,
		Now:         func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}).ReconcileWebhook(context.Background(), Integration{
		Provider: ProviderWebflow,
		Settings: map[string]any{"site_id": "site_123", "form_name": "Newsletter", "webflow_webhook_id": "webflow_wh_existing"},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !fetched || listed || !summary.Reused || summary.Repaired || summary.WebhookID != "webflow_wh_existing" {
		t.Fatalf("fetched=%v listed=%v summary=%+v", fetched, listed, summary)
	}
}

func TestWebflowRESTWebhookRegistrarRepairsMissingStoredWebhookByReusingMatch(t *testing.T) {
	var fetched bool
	var listed bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer wf_token" {
			t.Fatalf("missing bearer auth: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v2/webhooks/webflow_wh_stale":
			fetched = true
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"not found"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v2/sites/site_123/webhooks":
			listed = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"webhooks": []map[string]any{
					{
						"id":          "webflow_wh_match",
						"triggerType": "form_submission",
						"url":         "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks",
						"siteId":      "site_123",
						"filter":      map[string]any{"name": "Newsletter"},
					},
				},
			})
		default:
			t.Fatalf("unexpected Webflow request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	summary, err := (WebflowRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{AccessToken: "wf_token", WebhookSecret: "wf_secret"}},
		APIBaseURL:  srv.URL,
		Now:         func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}).ReconcileWebhook(context.Background(), Integration{
		Provider: ProviderWebflow,
		Settings: map[string]any{"site_id": "site_123", "form_name": "Newsletter", "webflow_webhook_id": "webflow_wh_stale"},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !fetched || !listed || !summary.Reused || !summary.Repaired || summary.WebhookID != "webflow_wh_match" ||
		summary.RepairReason != "stored_webhook_not_found" || summary.PreviousWebhookID != "webflow_wh_stale" {
		t.Fatalf("fetched=%v listed=%v summary=%+v", fetched, listed, summary)
	}
}

func TestWebflowRESTWebhookRegistrarCreatesAndDeletesWebhook(t *testing.T) {
	var created bool
	var deleted bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer wf_token" {
			t.Fatalf("missing bearer auth: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v2/sites/site_123/webhooks":
			_, _ = w.Write([]byte(`{"webhooks":[]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v2/sites/site_123/webhooks":
			created = true
			if r.Header.Get("Content-Type") != "application/json" {
				t.Fatalf("content-type=%q", r.Header.Get("Content-Type"))
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			filter, _ := body["filter"].(map[string]any)
			if body["triggerType"] != "form_submission" ||
				body["url"] != "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks" ||
				filter["name"] != "Newsletter" {
				t.Fatalf("body=%+v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":          "webflow_wh_created",
				"triggerType": "form_submission",
				"url":         "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks",
				"siteId":      "site_123",
				"filter":      map[string]any{"name": "Newsletter"},
			})
		case r.Method == http.MethodDelete && r.URL.Path == "/v2/webhooks/webflow_wh_created":
			deleted = true
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected Webflow request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	registrar := WebflowRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{AccessToken: "wf_token", WebhookSecret: "wf_secret"}},
		APIBaseURL:  srv.URL,
		Now:         func() time.Time { return time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC) },
	}
	integration := Integration{
		Provider: ProviderWebflow,
		Settings: map[string]any{"site_id": "site_123", "form_name": "Newsletter"},
	}
	summary, err := registrar.ReconcileWebhook(context.Background(), integration, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !created || !summary.Created || summary.WebhookID != "webflow_wh_created" {
		t.Fatalf("created=%v summary=%+v", created, summary)
	}

	integration.Settings["webflow_webhook_id"] = summary.WebhookID
	integration.Settings["webflow_webhook_endpoint"] = summary.Endpoint
	cleanup, err := registrar.CleanupWebhook(context.Background(), integration, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !deleted || !cleanup.Deleted || cleanup.WebhookID != "webflow_wh_created" {
		t.Fatalf("deleted=%v cleanup=%+v", deleted, cleanup)
	}
}

func TestWebflowRESTWebhookRegistrarTreatsDeleteNotFoundAsCleanedUp(t *testing.T) {
	var deleted bool
	var listed bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodDelete && r.URL.Path == "/v2/webhooks/webflow_wh_missing":
			deleted = true
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"not found"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v2/sites/site_123/webhooks":
			listed = true
			_, _ = w.Write([]byte(`{"webhooks":[]}`))
		default:
			t.Fatalf("unexpected Webflow request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	cleanup, err := (WebflowRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{AccessToken: "wf_token", WebhookSecret: "wf_secret"}},
		APIBaseURL:  srv.URL,
	}).CleanupWebhook(context.Background(), Integration{
		Provider: ProviderWebflow,
		Settings: map[string]any{"site_id": "site_123", "webflow_webhook_id": "webflow_wh_missing"},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !deleted || !listed || cleanup.Deleted || !cleanup.NotFound || cleanup.WebhookID != "webflow_wh_missing" || cleanup.CleanupReason != "stored_id_not_found" {
		t.Fatalf("deleted=%v listed=%v cleanup=%+v", deleted, listed, cleanup)
	}
}

func TestWebflowRESTWebhookRegistrarSkipsCleanupWhenStoredIDMissingAndFallbackLookupFails(t *testing.T) {
	var deleted bool
	var listed bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodDelete && r.URL.Path == "/v2/webhooks/webflow_wh_missing":
			deleted = true
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"not found"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v2/sites/site_123/webhooks":
			listed = true
			http.Error(w, "webflow unavailable", http.StatusServiceUnavailable)
		default:
			t.Fatalf("unexpected Webflow request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	cleanup, err := (WebflowRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{AccessToken: "wf_token", WebhookSecret: "wf_secret"}},
		APIBaseURL:  srv.URL,
	}).CleanupWebhook(context.Background(), Integration{
		Provider: ProviderWebflow,
		Settings: map[string]any{"site_id": "site_123", "webflow_webhook_id": "webflow_wh_missing"},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !deleted || !listed || cleanup.Deleted || !cleanup.NotFound || !cleanup.Skipped ||
		cleanup.SkipReason != "fallback_lookup_failed" ||
		cleanup.CleanupReason != "stored_id_not_found_fallback_lookup_failed" {
		t.Fatalf("deleted=%v listed=%v cleanup=%+v", deleted, listed, cleanup)
	}
}

func TestWebflowRESTWebhookRegistrarDeletesMatchingWebhookWhenStoredIDMissing(t *testing.T) {
	var listed bool
	var deleted bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer wf_token" {
			t.Fatalf("missing bearer auth: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v2/sites/site_123/webhooks":
			listed = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"webhooks": []map[string]any{
					{
						"id":          "webflow_wh_match",
						"triggerType": "form_submission",
						"url":         "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks",
						"siteId":      "site_123",
						"filter":      map[string]any{"name": "Newsletter"},
					},
				},
			})
		case r.Method == http.MethodDelete && r.URL.Path == "/v2/webhooks/webflow_wh_match":
			deleted = true
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected Webflow request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	cleanup, err := (WebflowRESTWebhookRegistrar{
		HTTPClient:  srv.Client(),
		Credentials: fakeWebflowCredentialResolver{creds: WebflowCredentials{AccessToken: "wf_token", WebhookSecret: "wf_secret"}},
		APIBaseURL:  srv.URL,
	}).CleanupWebhook(context.Background(), Integration{
		Provider: ProviderWebflow,
		Settings: map[string]any{
			"site_id":                  "site_123",
			"form_name":                "Newsletter",
			"webflow_webhook_endpoint": "https://app.postwave.test/api/public/lead-integrations/webflow/webhooks",
		},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if !listed || !deleted || !cleanup.Deleted || cleanup.WebhookID != "webflow_wh_match" ||
		cleanup.CleanupReason != "matched_endpoint_without_stored_id" {
		t.Fatalf("listed=%v deleted=%v cleanup=%+v", listed, deleted, cleanup)
	}
}
