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

func TestParseFeatheryCredentialSecret(t *testing.T) {
	creds, err := parseFeatheryCredentialSecret(`{
		"api_key":"Token feathery_token_123",
		"api_base_url":"https://api.eu.feathery.io/",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.APIKey != "feathery_token_123" || creds.APIBaseURL != "https://api.eu.feathery.io" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestFeatheryRESTBackfillerFetchesSubmissionsAndMapsSubmission(t *testing.T) {
	var sawToken bool
	var sawQuery bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Token feathery_key" {
			sawToken = true
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/api/form/submission/" {
			t.Fatalf("unexpected Feathery path %s", r.URL.Path)
		}
		sawQuery = true
		if r.URL.Query().Get("form_id") != "form_456" ||
			r.URL.Query().Get("page_size") != "2" ||
			r.URL.Query().Get("start_time") != "2026-06-01T00:00:00Z" ||
			r.URL.Query().Get("completed") != "true" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"count":        1,
			"next":         srvURL(r) + "/api/form/submission/?page=2",
			"previous":     nil,
			"total_pages":  2,
			"current_page": 1,
			"results": []map[string]any{
				{
					"user_id":          "user_123",
					"submission_start": "2026-06-16T09:59:00Z",
					"last_submitted":   "2026-06-16T10:00:00Z",
					"values": []map[string]any{
						{"id": "email", "type": "email", "value": "Lead@Example.com", "display_text": "Email"},
						{"id": "first", "type": "text_field", "value": "Ada", "display_text": "First name"},
						{"id": "last", "type": "text_field", "value": "Lovelace", "display_text": "Last name"},
						{"id": "company", "type": "text_field", "value": "Moosewave", "display_text": "Company"},
					},
				},
			},
		})
	}))
	defer srv.Close()

	req, err := (FeatheryRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFeatheryCredentialResolver{creds: FeatheryCredentials{APIKey: "feathery_key"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFeathery,
		CredentialsRef: "cred_feathery_1",
		Settings: map[string]any{
			"form_id":             "form_456",
			"form_name":           "Newsletter Signup",
			"default_tags":        "newsletter,launch",
			"start_time":          "2026-06-01T00:00:00Z",
			"completed":           "true",
			"email_field_id":      "email",
			"first_name_field_id": "first",
			"last_name_field_id":  "last",
			"company_field_id":    "company",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawToken || !sawQuery {
		t.Fatalf("expected token auth and submissions query, token=%v query=%v", sawToken, sawQuery)
	}
	if !strings.HasPrefix(req.Cursor, featheryCursorPrefix) || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	state, err := decodeFeatheryCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(state.NextURL, "page=2") || state.Since != "2026-06-01T00:00:00Z" {
		t.Fatalf("cursor state=%+v", state)
	}
	got := req.Submissions[0]
	if got.SourceID != "feathery://submission/form_456/user_123" || got.Email != "lead@example.com" || got.FirstName != "Ada" || got.LastName != "Lovelace" || got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Newsletter Signup" || got.Fields["feathery_field.email"] != "Lead@Example.com" || got.Fields["feathery_form_id"] != "form_456" {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "feathery:form_456") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestFeatheryRESTBackfillerUsesNextURLCursor(t *testing.T) {
	var rawQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/api/form/submission/" {
			t.Fatalf("unexpected Feathery path %s", r.URL.Path)
		}
		rawQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`{"results":[{"user_id":"user_124","submission_start":"2026-06-16T10:01:00Z","last_submitted":"2026-06-16T10:02:00Z","values":[{"id":"email","type":"email","value":"lead@example.com"}]}]}`))
	}))
	defer srv.Close()

	req, err := (FeatheryRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFeatheryCredentialResolver{creds: FeatheryCredentials{APIKey: "feathery_key"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFeathery,
		CredentialsRef: "cred_feathery_1",
		Settings:       map[string]any{"form_id": "form_456", "email_field_id": "email"},
	}, encodeFeatheryCursor(featheryCursorState{NextURL: srv.URL + "/api/form/submission/?page=2", Since: "2026-06-01T00:00:00Z"}))
	if err != nil {
		t.Fatal(err)
	}
	if rawQuery != "page=2" {
		t.Fatalf("expected next URL query only, got %q", rawQuery)
	}
	state, err := decodeFeatheryCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.NextURL != "" || state.Since != "2026-06-16T10:02:00Z" {
		t.Fatalf("state=%+v", state)
	}
}

func TestFeatheryRESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (FeatheryRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFeatheryCredentialResolver{creds: FeatheryCredentials{APIKey: "feathery_key"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFeathery,
		CredentialsRef: "cred_feathery_1",
		Settings:       map[string]any{"form_id": "form_456"},
	}, "")
	var providerErr FeatheryProviderError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 42*time.Second || !strings.Contains(providerErr.Snippet, "slow down") {
		t.Fatalf("err=%T %v", err, err)
	}
}

func srvURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

type fakeFeatheryCredentialResolver struct {
	creds FeatheryCredentials
	err   error
}

func (f fakeFeatheryCredentialResolver) ResolveFeathery(context.Context, string, Integration) (FeatheryCredentials, error) {
	if f.err != nil {
		return FeatheryCredentials{}, f.err
	}
	return f.creds, nil
}
