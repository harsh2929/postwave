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

func TestParseFormsiteCredentialSecret(t *testing.T) {
	creds, err := parseFormsiteCredentialSecret(`{
		"access_token":"fs_token_123",
		"api_base_url":"https://fs1.formsite.com/api/v2/",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "fs_token_123" || creds.APIBaseURL != "https://fs1.formsite.com/api/v2" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestFormsiteRESTBackfillerFetchesResultsAndMapsSubmission(t *testing.T) {
	var sawBearer bool
	var sawResultsQuery bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "bearer fs_access_token" {
			sawBearer = true
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Pagination-Limit", "2")
		w.Header().Set("Pagination-Page-Current", "1")
		w.Header().Set("Pagination-Page-Last", "1")
		if r.URL.Path != "/my-user/forms/form123/results" {
			t.Fatalf("unexpected Formsite path %s", r.URL.Path)
		}
		sawResultsQuery = true
		if r.URL.Query().Get("page") != "1" ||
			r.URL.Query().Get("limit") != "2" ||
			r.URL.Query().Get("sort_id") != "result_id" ||
			r.URL.Query().Get("sort_direction") != "asc" ||
			r.URL.Query().Get("after_date") != "2026-06-01T00:00:00Z" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{
					"id":             "123000",
					"date_finish":    "2026-06-16T10:00:00Z",
					"date_start":     "2026-06-16T09:59:00Z",
					"date_update":    "2026-06-16T10:00:01Z",
					"login_email":    "Login@Example.com",
					"result_status":  "Complete",
					"user_browser":   "Firefox",
					"user_ip":        "203.0.113.10",
					"user_device":    "Desktop",
					"user_referrer":  "https://example.com",
					"payment_status": "Payment Successful",
					"payment_amount": 42.5,
					"items": []map[string]any{
						{"id": "100", "position": 0, "value": "Lead@Example.com"},
						{"id": "101", "position": 1, "value": "Ada"},
						{"id": "102", "position": 2, "value": "Lovelace"},
						{"id": "103", "position": 3, "value": "Moosewave"},
					},
				},
			},
		})
	}))
	defer srv.Close()

	req, err := (FormsiteRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFormsiteCredentialResolver{creds: FormsiteCredentials{AccessToken: "fs_access_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFormsite,
		CredentialsRef: "cred_formsite_1",
		Settings: map[string]any{
			"account_id":         "my-user",
			"form_id":            "form123",
			"form_name":          "Newsletter Signup",
			"default_tags":       "newsletter,launch",
			"after_date":         "2026-06-01T00:00:00Z",
			"email_item_id":      "100",
			"first_name_item_id": "101",
			"last_name_item_id":  "102",
			"company_item_id":    "103",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawBearer || !sawResultsQuery {
		t.Fatalf("expected bearer auth and results query, bearer=%v results=%v", sawBearer, sawResultsQuery)
	}
	if req.Cursor != formsiteCursorComplete || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	got := req.Submissions[0]
	if got.SourceID != "formsite://result/my-user/form123/123000" || got.Email != "lead@example.com" || got.FirstName != "Ada" || got.LastName != "Lovelace" || got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Newsletter Signup" || got.Fields["formsite_item.100"] != "Lead@Example.com" || got.Fields["formsite_user_dir"] != "my-user" || got.Fields["formsite_form_dir"] != "form123" {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "formsite:form123") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestFormsiteRESTBackfillerUsesPageCursor(t *testing.T) {
	var page string
	var limit string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Pagination-Limit", "1")
		w.Header().Set("Pagination-Page-Current", "2")
		w.Header().Set("Pagination-Page-Last", "3")
		if r.URL.Path != "/my-user/forms/form123/results" {
			t.Fatalf("unexpected Formsite path %s", r.URL.Path)
		}
		page = r.URL.Query().Get("page")
		limit = r.URL.Query().Get("limit")
		_, _ = w.Write([]byte(`{"results":[{"id":"123001","date_finish":"2026-06-16T10:00:00Z","items":[{"id":"100","position":0,"value":"lead@example.com"}]}]}`))
	}))
	defer srv.Close()

	req, err := (FormsiteRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFormsiteCredentialResolver{creds: FormsiteCredentials{AccessToken: "fs_access_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFormsite,
		CredentialsRef: "cred_formsite_1",
		Settings:       map[string]any{"account_id": "my-user", "form_id": "form123", "email_item_id": "100"},
	}, encodeFormsiteCursor(formsiteCursorState{Page: 2}))
	if err != nil {
		t.Fatal(err)
	}
	if page != "2" || limit != "1" {
		t.Fatalf("page=%q limit=%q", page, limit)
	}
	if !strings.HasPrefix(req.Cursor, formsiteCursorPrefix) || req.Cursor == formsiteCursorComplete {
		t.Fatalf("cursor=%q", req.Cursor)
	}
	state, err := decodeFormsiteCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Page != 3 {
		t.Fatalf("state=%+v", state)
	}
}

func TestFormsiteRESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (FormsiteRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFormsiteCredentialResolver{creds: FormsiteCredentials{AccessToken: "fs_access_token"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFormsite,
		CredentialsRef: "cred_formsite_1",
		Settings:       map[string]any{"account_id": "my-user", "form_id": "form123"},
	}, "")
	var providerErr FormsiteProviderError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 42*time.Second || !strings.Contains(providerErr.Snippet, "slow down") {
		t.Fatalf("err=%T %v", err, err)
	}
}

type fakeFormsiteCredentialResolver struct {
	creds FormsiteCredentials
	err   error
}

func (f fakeFormsiteCredentialResolver) ResolveFormsite(context.Context, string, Integration) (FormsiteCredentials, error) {
	if f.err != nil {
		return FormsiteCredentials{}, f.err
	}
	return f.creds, nil
}
