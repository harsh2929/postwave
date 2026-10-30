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

func TestParseGravityFormsCredentialSecret(t *testing.T) {
	creds, err := parseGravityFormsCredentialSecret(`{
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

	creds, err = parseGravityFormsCredentialSecret("consumer_key=ck_123\nconsumer_secret=cs_456")
	if err != nil {
		t.Fatal(err)
	}
	if creds.ConsumerKey != "ck_123" || creds.ConsumerSecret != "cs_456" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestGravityFormsRESTBackfillerFetchesEntriesAndMapsSubmission(t *testing.T) {
	var sawAuth bool
	var sawQuery bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/wp-json/gf/v2/forms/123/entries" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("wp_user:app pass"))
		if r.Header.Get("Authorization") == wantAuth {
			sawAuth = true
		}
		q := r.URL.Query()
		if q.Get("_labels") == "1" &&
			q.Get("paging[page_size]") == "1" &&
			q.Get("paging[offset]") == "0" &&
			q.Get("sorting[key]") == "id" &&
			q.Get("sorting[direction]") == "ASC" &&
			q.Get("sorting[is_numeric]") == "true" &&
			q.Get("status") == "active" {
			sawQuery = true
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"total_count": 2,
			"entries": []map[string]any{
				{
					"id":           "entry_123",
					"form_id":      "123",
					"date_created": "2026-06-16 10:00:00",
					"date_updated": "2026-06-16 10:05:00",
					"status":       "active",
					"ip":           "38.88.7.98",
					"source_url":   "https://example.com/landing",
					"_labels": map[string]any{
						"1": "Email",
						"2": "First Name",
						"3": "Last Name",
						"4": "Company",
						"5": "Phone",
					},
					"1": "Lead@Example.com",
					"2": "Ada",
					"3": "Lovelace",
					"4": "Moosewave",
					"5": "5551234567",
				},
			},
		})
	}))
	defer srv.Close()

	req, err := (GravityFormsRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeGravityFormsCredentialResolver{creds: GravityFormsCredentials{
			Username: "wp_user",
			Password: "app pass",
		}},
		SiteURL:  srv.URL,
		PageSize: 1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderGravityForms,
		CredentialsRef: "cred_gravity_1",
		Settings: map[string]any{
			"site_url":     srv.URL,
			"form_id":      "123",
			"form_name":    "Newsletter",
			"status":       "active",
			"default_tags": "wordpress,newsletter",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawAuth || !sawQuery {
		t.Fatalf("expected auth/query, auth=%v query=%v", sawAuth, sawQuery)
	}
	if !strings.HasPrefix(req.Cursor, gravityFormsCursorPrefix) || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	state, err := decodeGravityFormsCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Offset != 1 || state.TotalCount != 2 {
		t.Fatalf("cursor state=%+v", state)
	}
	got := req.Submissions[0]
	if !strings.Contains(got.SourceID, "/123/entry_123") ||
		got.Email != "lead@example.com" ||
		got.FirstName != "Ada" ||
		got.LastName != "Lovelace" ||
		got.Phone != "5551234567" ||
		got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Newsletter" || got.Fields["gravity_forms_field.email"] != "Lead@Example.com" || got.Fields["gravity_forms_ip"] != "38.88.7.98" {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if got.SubmittedAt == nil || got.SubmittedAt.Format(time.RFC3339) != "2026-06-16T10:00:00Z" {
		t.Fatalf("submitted_at=%v", got.SubmittedAt)
	}
	if !containsFold(got.Tags, "wordpress") || !containsFold(got.Tags, "gravity-forms:123") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestGravityFormsRESTBackfillerUsesOffsetCursor(t *testing.T) {
	var offset string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		offset = r.URL.Query().Get("paging[offset]")
		_, _ = w.Write([]byte(`{"total_count":2,"entries":[{"id":"entry_2","form_id":"123","date_created":"2026-06-16 10:01:00","_labels":{"1":"Email"},"1":"two@example.com"}]}`))
	}))
	defer srv.Close()

	req, err := (GravityFormsRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeGravityFormsCredentialResolver{creds: GravityFormsCredentials{ConsumerKey: "ck", ConsumerSecret: "cs"}},
		SiteURL:     srv.URL,
		PageSize:    1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderGravityForms,
		CredentialsRef: "cred_gravity_1",
		Settings:       map[string]any{"site_url": srv.URL, "form_id": "123"},
	}, encodeGravityFormsCursor(gravityFormsCursorState{Offset: 1, TotalCount: 2}))
	if err != nil {
		t.Fatal(err)
	}
	if offset != "1" {
		t.Fatalf("offset=%q", offset)
	}
	state, err := decodeGravityFormsCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Offset != 2 || state.TotalCount != 2 {
		t.Fatalf("state=%+v", state)
	}
}

func TestGravityFormsRESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (GravityFormsRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeGravityFormsCredentialResolver{creds: GravityFormsCredentials{Username: "wp_user", Password: "app pass"}},
		SiteURL:     srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderGravityForms,
		CredentialsRef: "cred_gravity_1",
		Settings:       map[string]any{"site_url": srv.URL, "form_id": "123"},
	}, "")
	var providerErr GravityFormsProviderError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 42*time.Second || !strings.Contains(providerErr.Snippet, "slow down") {
		t.Fatalf("err=%T %v", err, err)
	}
}

type fakeGravityFormsCredentialResolver struct {
	creds GravityFormsCredentials
	err   error
}

func (f fakeGravityFormsCredentialResolver) ResolveGravityForms(context.Context, string, Integration) (GravityFormsCredentials, error) {
	if f.err != nil {
		return GravityFormsCredentials{}, f.err
	}
	return f.creds, nil
}
