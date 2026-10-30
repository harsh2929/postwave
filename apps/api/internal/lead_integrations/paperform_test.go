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

func TestParsePaperformCredentialSecret(t *testing.T) {
	creds, err := parsePaperformCredentialSecret(`{
		"api_key":"paperform_123",
		"api_base_url":"https://api.paperform.co/v1/",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "paperform_123" || creds.APIBaseURL != "https://api.paperform.co/v1" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestPaperformRESTBackfillerFetchesSubmissionsAndMapsSubmission(t *testing.T) {
	var sawBearer bool
	var sawSubmissionsQuery bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer paperform_token" {
			sawBearer = true
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/forms/form_123/submissions" {
			t.Fatalf("unexpected Paperform path %s", r.URL.Path)
		}
		sawSubmissionsQuery = true
		if r.URL.Query().Get("skip") != "0" || r.URL.Query().Get("limit") != "2" || r.URL.Query().Get("sort") != "ASC" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":   "ok",
			"total":    1,
			"has_more": false,
			"limit":    2,
			"skip":     0,
			"results": map[string]any{
				"submissions": []map[string]any{
					{
						"id":             "sub_123",
						"form_id":        "form_123",
						"created_at":     "2026-06-16T03:00:00.000Z",
						"created_at_utc": "2026-06-16T10:00:00.000Z",
						"data": map[string]any{
							"Email":      "Lead@Example.com",
							"First name": "Ada",
							"Last name":  "Lovelace",
							"Company":    "Moosewave",
						},
						"device": map[string]any{
							"utm_source": "launch",
						},
					},
				},
			},
		})
	}))
	defer srv.Close()

	req, err := (PaperformRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakePaperformCredentialResolver{creds: PaperformCredentials{AccessToken: "paperform_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderPaperform,
		CredentialsRef: "cred_paperform_1",
		Settings:       map[string]any{"form_id": "form_123", "form_name": "Newsletter Signup", "default_tags": "newsletter,launch"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawBearer || !sawSubmissionsQuery {
		t.Fatalf("expected bearer auth and submissions query, bearer=%v submissions=%v", sawBearer, sawSubmissionsQuery)
	}
	if req.Cursor != paperformCursorComplete || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	got := req.Submissions[0]
	if got.SourceID != "paperform://submission/form_123/sub_123" || got.Email != "lead@example.com" || got.FirstName != "Ada" || got.LastName != "Lovelace" || got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Newsletter Signup" || got.Fields["paperform_field.email"] != "Lead@Example.com" || got.Fields["paperform_form_id"] != "form_123" {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "paperform:form_123") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestPaperformRESTBackfillerUsesSkipCursor(t *testing.T) {
	var skip string
	var limit string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/forms/form_123/submissions" {
			t.Fatalf("unexpected Paperform path %s", r.URL.Path)
		}
		skip = r.URL.Query().Get("skip")
		limit = r.URL.Query().Get("limit")
		_, _ = w.Write([]byte(`{"status":"ok","skip":100,"limit":1,"has_more":true,"results":{"submissions":[{"id":"sub_2","form_id":"form_123","created_at_utc":"2026-06-16T10:00:00Z","data":{"Email":"lead@example.com"}}]}}`))
	}))
	defer srv.Close()

	req, err := (PaperformRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakePaperformCredentialResolver{creds: PaperformCredentials{AccessToken: "paperform_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderPaperform,
		CredentialsRef: "cred_paperform_1",
		Settings:       map[string]any{"form_id": "form_123"},
	}, encodePaperformCursor(paperformCursorState{Skip: 100}))
	if err != nil {
		t.Fatal(err)
	}
	if skip != "100" || limit != "1" {
		t.Fatalf("skip=%q limit=%q", skip, limit)
	}
	if !strings.HasPrefix(req.Cursor, paperformCursorPrefix) || req.Cursor == paperformCursorComplete {
		t.Fatalf("cursor=%q", req.Cursor)
	}
	state, err := decodePaperformCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Skip != 101 {
		t.Fatalf("state=%+v", state)
	}
}

func TestPaperformRESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (PaperformRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakePaperformCredentialResolver{creds: PaperformCredentials{AccessToken: "paperform_token"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderPaperform,
		CredentialsRef: "cred_paperform_1",
		Settings:       map[string]any{"form_id": "form_123"},
	}, "")
	var providerErr PaperformProviderError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 42*time.Second || !strings.Contains(providerErr.Snippet, "slow down") {
		t.Fatalf("err=%T %v", err, err)
	}
}

type fakePaperformCredentialResolver struct {
	creds PaperformCredentials
	err   error
}

func (f fakePaperformCredentialResolver) ResolvePaperform(context.Context, string, Integration) (PaperformCredentials, error) {
	if f.err != nil {
		return PaperformCredentials{}, f.err
	}
	return f.creds, nil
}
