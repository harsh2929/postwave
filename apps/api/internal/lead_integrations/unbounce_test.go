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

func TestParseUnbounceCredentialSecret(t *testing.T) {
	creds, err := parseUnbounceCredentialSecret(`{
		"api_key":"ub_api_key_123",
		"api_base_url":"https://api.unbounce.com/",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.APIKey != "ub_api_key_123" || creds.APIBaseURL != "https://api.unbounce.com" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}

	creds, err = parseUnbounceCredentialSecret("access_token=Bearer ub_oauth_token")
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "ub_oauth_token" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestUnbounceRESTBackfillerFetchesLeadsAndMapsSubmission(t *testing.T) {
	var sawBearer bool
	var sawAccept bool
	var sawFields bool
	var sawLeadsQuery bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer ub_access_token" {
			sawBearer = true
		}
		if r.Header.Get("Accept") == unbounceAcceptHeader {
			sawAccept = true
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/pages/page_123/form_fields":
			sawFields = true
			if r.URL.Query().Get("include_sub_pages") != "true" {
				t.Fatalf("unexpected form fields query: %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"form_fields": []map[string]any{
					{"id": "email", "name": "Email", "type": "email"},
					{"id": "name", "name": "Name", "type": "text"},
					{"id": "company", "name": "Company", "type": "text"},
					{"id": "phone_number", "name": "Phone Number", "type": "phone"},
				},
				"metadata": map[string]any{"count": 4},
			})
		case "/pages/page_123/leads":
			sawLeadsQuery = true
			if r.URL.Query().Get("sort_order") != "asc" ||
				r.URL.Query().Get("offset") != "0" ||
				r.URL.Query().Get("limit") != "2" ||
				r.URL.Query().Get("from") != "2026-06-01T00:00:00.000Z" ||
				r.URL.Query().Get("to") != "2026-06-30T00:00:00.000Z" {
				t.Fatalf("unexpected leads query: %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"leads": []map[string]any{
					{
						"created_at":   "2026-06-16T10:00:00.000Z",
						"id":           "lead_123",
						"page_id":      "page_123",
						"submitter_ip": "38.88.7.98",
						"variant_id":   "a",
						"extra_data": map[string]any{
							"request_id": "request_123",
						},
						"form_data": map[string]any{
							"email":        []string{"Lead@Example.com"},
							"name":         []string{"Ada Lovelace"},
							"company":      []string{"Moosewave"},
							"phone_number": []string{"5551234567"},
						},
						"metadata": map[string]any{
							"location":      "https://api.unbounce.com/leads/lead_123",
							"documentation": "https://developer.unbounce.com/api_reference/#id_leads__lead_id_",
						},
					},
				},
				"metadata": map[string]any{"count": 1},
			})
		default:
			t.Fatalf("unexpected Unbounce path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (UnbounceRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeUnbounceCredentialResolver{creds: UnbounceCredentials{AccessToken: "ub_access_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderUnbounce,
		CredentialsRef: "cred_unbounce_1",
		Settings: map[string]any{
			"page_id":           "page_123",
			"page_name":         "Landing Page",
			"include_sub_pages": "true",
			"default_tags":      "newsletter,launch",
			"from":              "2026-06-01T00:00:00.000Z",
			"to":                "2026-06-30T00:00:00.000Z",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawBearer || !sawAccept || !sawFields || !sawLeadsQuery {
		t.Fatalf("expected auth/accept/fields/leads, bearer=%v accept=%v fields=%v leads=%v", sawBearer, sawAccept, sawFields, sawLeadsQuery)
	}
	if !strings.HasPrefix(req.Cursor, unbounceCursorPrefix) || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	state, err := decodeUnbounceCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Offset != 0 || state.Since != "2026-06-16T10:00:00.000Z" {
		t.Fatalf("cursor state=%+v", state)
	}
	got := req.Submissions[0]
	if got.SourceID != "unbounce://lead/page_123/lead_123" || got.Email != "lead@example.com" || got.FullName != "Ada Lovelace" || got.Phone != "5551234567" || got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Landing Page" || got.Fields["unbounce_field.email"] != "Lead@Example.com" || got.Fields["unbounce_submitter_ip"] != "38.88.7.98" {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "unbounce:page_123") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestUnbounceRESTBackfillerUsesBasicAuthAndOffsetCursor(t *testing.T) {
	var authHeader string
	var offset string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/pages/page_123/form_fields":
			_, _ = w.Write([]byte(`{"form_fields":[{"id":"email","name":"Email","type":"email"}]}`))
		case "/pages/page_123/leads":
			offset = r.URL.Query().Get("offset")
			_, _ = w.Write([]byte(`{"leads":[{"created_at":"2026-06-16T10:01:00.000Z","id":"lead_2","page_id":"page_123","form_data":{"email":["lead@example.com"]},"metadata":{}},{"created_at":"2026-06-16T10:02:00.000Z","id":"lead_3","page_id":"page_123","form_data":{"email":["two@example.com"]},"metadata":{}}],"metadata":{"count":2}}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (UnbounceRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeUnbounceCredentialResolver{creds: UnbounceCredentials{APIKey: "ub_api_key"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderUnbounce,
		CredentialsRef: "cred_unbounce_1",
		Settings:       map[string]any{"page_id": "page_123"},
	}, encodeUnbounceCursor(unbounceCursorState{Offset: 2, Since: "2026-06-01T00:00:00.000Z"}))
	if err != nil {
		t.Fatal(err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("ub_api_key:"))
	if authHeader != wantAuth || offset != "2" {
		t.Fatalf("auth=%q offset=%q", authHeader, offset)
	}
	state, err := decodeUnbounceCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Offset != 4 || state.Since != "2026-06-01T00:00:00.000Z" {
		t.Fatalf("state=%+v", state)
	}
}

func TestUnbounceRESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (UnbounceRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeUnbounceCredentialResolver{creds: UnbounceCredentials{AccessToken: "ub_access_token"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderUnbounce,
		CredentialsRef: "cred_unbounce_1",
		Settings:       map[string]any{"page_id": "page_123"},
	}, "")
	var providerErr UnbounceProviderError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 42*time.Second || !strings.Contains(providerErr.Snippet, "slow down") {
		t.Fatalf("err=%T %v", err, err)
	}
}

type fakeUnbounceCredentialResolver struct {
	creds UnbounceCredentials
	err   error
}

func (f fakeUnbounceCredentialResolver) ResolveUnbounce(context.Context, string, Integration) (UnbounceCredentials, error) {
	if f.err != nil {
		return UnbounceCredentials{}, f.err
	}
	return f.creds, nil
}
