// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseWPFormsCredentialSecret(t *testing.T) {
	creds, err := parseWPFormsCredentialSecret(`{
		"username":"wp_user",
		"application_password":"app pass",
		"site_url":"https://example.com/",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.Username != "wp_user" || creds.Password != "app pass" || creds.SiteURL != "https://example.com" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}

	creds, err = parseWPFormsCredentialSecret("username=editor\napplication_password=secret")
	if err != nil {
		t.Fatal(err)
	}
	if creds.Username != "editor" || creds.Password != "secret" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestWPFormsRESTBackfillerFetchesEntriesAndMapsSubmission(t *testing.T) {
	var sawAuth bool
	var sawFormQuery bool
	var sawSearchQuery bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("wp_user:app pass"))
		if r.Header.Get("Authorization") == wantAuth {
			sawAuth = true
		}
		q := r.URL.Query()
		switch r.URL.Path {
		case "/wp-json/wp-abilities/v1/abilities/wpforms/get-form/run":
			if q.Get("input[form_id]") == "123" && q.Get("input[include_fields]") == "true" {
				sawFormQuery = true
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":    123,
				"title": "Newsletter",
				"fields": []map[string]any{
					{"id": 1, "type": "email", "label": "Email"},
					{"id": 2, "type": "text", "label": "First Name"},
					{"id": 3, "type": "text", "label": "Last Name"},
					{"id": 4, "type": "text", "label": "Company"},
					{"id": 5, "type": "phone", "label": "Phone"},
				},
			})
		case "/wp-json/wp-abilities/v1/abilities/wpforms/search-entries/run":
			if q.Get("input[form_id]") == "123" &&
				q.Get("input[include_fields]") == "true" &&
				q.Get("input[limit]") == "1" &&
				q.Get("input[page]") == "1" &&
				q.Get("input[orderby]") == "entry_id" &&
				q.Get("input[order]") == "ASC" &&
				q.Get("input[type]") == "unread" {
				sawSearchQuery = true
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"total":       2,
				"total_pages": 2,
				"page":        1,
				"limit":       1,
				"entries": []map[string]any{
					{
						"id":         456,
						"form_id":    123,
						"date":       "2026-02-15 14:32:10",
						"modified":   "2026-02-15 15:00:00",
						"status":     "",
						"viewed":     false,
						"starred":    true,
						"ip_address": "192.168.1.100",
						"fields": []map[string]any{
							{"id": 1, "name": "Email", "value": "Lead@Example.com", "type": "email"},
							{"id": 2, "name": "First Name", "value": "Ada", "type": "text"},
							{"id": 3, "name": "Last Name", "value": "Lovelace", "type": "text"},
							{"id": 4, "name": "Company", "value": "Moosewave", "type": "text"},
							{"id": 5, "name": "Phone", "value": "5551234567", "type": "phone"},
						},
					},
				},
			})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (WPFormsRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeWPFormsCredentialResolver{creds: WPFormsCredentials{
			Username: "wp_user",
			Password: "app pass",
		}},
		SiteURL:  srv.URL,
		PageSize: 1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderWPForms,
		CredentialsRef: "cred_wpforms_1",
		Settings: map[string]any{
			"site_url":     srv.URL,
			"form_id":      "123",
			"type":         "unread",
			"default_tags": "wordpress,newsletter",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawAuth || !sawFormQuery || !sawSearchQuery {
		t.Fatalf("expected auth/form/search, auth=%v form=%v search=%v", sawAuth, sawFormQuery, sawSearchQuery)
	}
	if !strings.HasPrefix(req.Cursor, wpformsCursorPrefix) || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	state, err := decodeWPFormsCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Page != 2 || state.TotalPages != 2 || state.TotalCount != 2 {
		t.Fatalf("cursor state=%+v", state)
	}
	got := req.Submissions[0]
	if !strings.Contains(got.SourceID, "/123/456") ||
		got.Email != "lead@example.com" ||
		got.FirstName != "Ada" ||
		got.LastName != "Lovelace" ||
		got.Phone != "5551234567" ||
		got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Newsletter" || got.Fields["wpforms_field.email"] != "Lead@Example.com" || got.Fields["wpforms_ip_address"] != "192.168.1.100" {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if got.SubmittedAt == nil || got.SubmittedAt.Format(time.RFC3339) != "2026-02-15T14:32:10Z" {
		t.Fatalf("submitted_at=%v", got.SubmittedAt)
	}
	if !containsFold(got.Tags, "wordpress") || !containsFold(got.Tags, "wpforms:123") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestWPFormsRESTBackfillerUsesPageCursor(t *testing.T) {
	var page string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/wp-json/wp-abilities/v1/abilities/wpforms/get-form/run":
			_, _ = w.Write([]byte(`{"id":123,"title":"Newsletter","fields":[{"id":1,"label":"Email","type":"email"}]}`))
		case "/wp-json/wp-abilities/v1/abilities/wpforms/search-entries/run":
			page = r.URL.Query().Get("input[page]")
			_, _ = w.Write([]byte(`{"total":2,"total_pages":2,"page":2,"limit":1,"entries":[{"id":457,"form_id":123,"date":"2026-02-15 14:33:10","fields":[{"id":1,"name":"Email","value":"two@example.com","type":"email"}]}]}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (WPFormsRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeWPFormsCredentialResolver{creds: WPFormsCredentials{Username: "wp_user", Password: "app pass"}},
		SiteURL:     srv.URL,
		PageSize:    1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderWPForms,
		CredentialsRef: "cred_wpforms_1",
		Settings:       map[string]any{"site_url": srv.URL, "form_id": "123"},
	}, encodeWPFormsCursor(wpformsCursorState{Page: 2, TotalPages: 2, TotalCount: 2}))
	if err != nil {
		t.Fatal(err)
	}
	if page != "2" {
		t.Fatalf("page=%q", page)
	}
	state, err := decodeWPFormsCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Page != 3 || state.TotalPages != 2 || state.TotalCount != 2 {
		t.Fatalf("state=%+v", state)
	}
}

func TestWPFormsRESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (WPFormsRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeWPFormsCredentialResolver{creds: WPFormsCredentials{Username: "wp_user", Password: "app pass"}},
		SiteURL:     srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderWPForms,
		CredentialsRef: "cred_wpforms_1",
		Settings:       map[string]any{"site_url": srv.URL, "form_id": "123"},
	}, "")
	var providerErr WPFormsProviderError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 42*time.Second || !strings.Contains(providerErr.Snippet, "slow down") {
		t.Fatalf("err=%T %v", err, err)
	}
}

type fakeWPFormsCredentialResolver struct {
	creds WPFormsCredentials
	err   error
}

func (f fakeWPFormsCredentialResolver) ResolveWPForms(context.Context, string, Integration) (WPFormsCredentials, error) {
	if f.err != nil {
		return WPFormsCredentials{}, f.err
	}
	return f.creds, nil
}
