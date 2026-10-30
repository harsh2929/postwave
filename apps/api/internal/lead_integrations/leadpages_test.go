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

func TestParseLeadpagesCredentialSecret(t *testing.T) {
	creds, err := parseLeadpagesCredentialSecret(`{
		"api_key":"Bearer lp_api_token_123",
		"api_base_url":"https://api.leadpages.net/",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "lp_api_token_123" || creds.APIBaseURL != "https://api.leadpages.net" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}

	creds, err = parseLeadpagesCredentialSecret("access_token=Bearer lp_oauth_token")
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "lp_oauth_token" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestLeadpagesRESTBackfillerFetchesSubmissionsAndMapsSubmission(t *testing.T) {
	var sawBearer bool
	var sawRequest bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/forms/form_123/submissions" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") == "Bearer lp_access_token" {
			sawBearer = true
		}
		if r.URL.Query().Get("limit") != "25" || r.URL.Query().Get("from") != "2026-07-01T00:00:00Z" {
			t.Fatalf("query=%s", r.URL.RawQuery)
		}
		sawRequest = true
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"submissions": []map[string]any{
				{
					"id":          "sub_123",
					"form_id":     "form_123",
					"page_id":     "page_456",
					"submittedAt": "2026-07-02T12:34:56Z",
					"fields": map[string]any{
						"email":      "Lead@Example.com",
						"first_name": "Ada",
						"last_name":  "Lovelace",
						"company":    "Moosewave",
						"phone":      "5551234567",
					},
				},
			},
			"meta": map[string]any{"next_cursor": "cursor_2"},
		})
	}))
	defer srv.Close()

	req, err := (LeadpagesRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeLeadpagesCredentialResolver{creds: LeadpagesCredentials{AccessToken: "lp_access_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    25,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderLeadpages,
		CredentialsRef: "cred_leadpages_1",
		Settings: map[string]any{
			"form_id":      "form_123",
			"page_id":      "page_456",
			"form_name":    "Launch Page Form",
			"default_tags": "newsletter,launch",
			"from":         "2026-07-01T00:00:00Z",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawBearer || !sawRequest {
		t.Fatalf("expected auth/request, bearer=%v request=%v", sawBearer, sawRequest)
	}
	if !strings.HasPrefix(req.Cursor, leadpagesCursorPrefix) || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	state, err := decodeLeadpagesCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.NextCursor != "cursor_2" || state.LastSubmittedAt != "2026-07-02T12:34:56Z" || state.LastID != "sub_123" {
		t.Fatalf("cursor state=%+v", state)
	}
	got := req.Submissions[0]
	if got.SourceID != "leadpages://submission/form_123/sub_123" ||
		got.Email != "lead@example.com" ||
		got.FirstName != "Ada" ||
		got.LastName != "Lovelace" ||
		got.Phone != "5551234567" ||
		got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Launch Page Form" || got.Fields["leadpages_field.email"] != "Lead@Example.com" {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if got.SubmittedAt == nil || got.SubmittedAt.Format(time.RFC3339) != "2026-07-02T12:34:56Z" {
		t.Fatalf("submitted_at=%v", got.SubmittedAt)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "leadpages:form_123") || !containsFold(got.Tags, "leadpages:page:page_456") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestLeadpagesRESTBackfillerUsesCursorAndWatermark(t *testing.T) {
	var gotCursor string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCursor = r.URL.Query().Get("cursor")
		_, _ = w.Write([]byte(`{
			"data": [
				{"id":"old","submitted_at":"2026-07-02T12:00:00Z","fields":{"email":"old@example.com"}},
				{"id":"new","submitted_at":"2026-07-03T12:00:00Z","fields":{"email":"new@example.com"}}
			]
		}`))
	}))
	defer srv.Close()

	req, err := (LeadpagesRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeLeadpagesCredentialResolver{creds: LeadpagesCredentials{AccessToken: "lp_access_token"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderLeadpages,
		CredentialsRef: "cred_leadpages_1",
		Settings:       map[string]any{"form_id": "form_123"},
	}, encodeLeadpagesCursor(leadpagesCursorState{NextCursor: "cursor_2", LastSubmittedAt: "2026-07-02T12:00:00Z", LastID: "old"}))
	if err != nil {
		t.Fatal(err)
	}
	if gotCursor != "cursor_2" {
		t.Fatalf("cursor=%q", gotCursor)
	}
	if len(req.Submissions) != 1 || req.Submissions[0].Email != "new@example.com" {
		t.Fatalf("submissions=%+v", req.Submissions)
	}
	state, err := decodeLeadpagesCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.NextCursor != "" || state.LastSubmittedAt != "2026-07-03T12:00:00Z" || state.LastID != "new" {
		t.Fatalf("state=%+v", state)
	}
}

func TestLeadpagesRESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (LeadpagesRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeLeadpagesCredentialResolver{creds: LeadpagesCredentials{AccessToken: "lp_access_token"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderLeadpages,
		CredentialsRef: "cred_leadpages_1",
		Settings:       map[string]any{"form_id": "form_123"},
	}, "")
	var providerErr LeadpagesProviderError
	if !errors.As(err, &providerErr) || providerErr.RetryAfter != 42*time.Second {
		t.Fatalf("err=%T %[1]v", err)
	}
}

type fakeLeadpagesCredentialResolver struct {
	creds LeadpagesCredentials
	err   error
}

func (f fakeLeadpagesCredentialResolver) ResolveLeadpages(context.Context, string, Integration) (LeadpagesCredentials, error) {
	if f.err != nil {
		return LeadpagesCredentials{}, f.err
	}
	return f.creds, nil
}
