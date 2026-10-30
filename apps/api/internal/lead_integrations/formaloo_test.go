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

func TestParseFormalooCredentialSecret(t *testing.T) {
	creds, err := parseFormalooCredentialSecret(`{
		"api_key":"api_key_123",
		"authorization_token":"JWT token_123",
		"api_base_url":"https://api.formaloo.me/",
		"workspace_id":"workspace_123",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.APIKey != "api_key_123" ||
		creds.AuthorizationToken != "token_123" ||
		creds.APIBaseURL != "https://api.formaloo.me" ||
		creds.WorkspaceID != "workspace_123" ||
		creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}

	creds, err = parseFormalooCredentialSecret("api_key=api_key_123\napi_secret=secret_123")
	if err != nil {
		t.Fatal(err)
	}
	if creds.APIKey != "api_key_123" || creds.APISecret != "secret_123" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestFormalooRESTBackfillerFetchesRowsAndMapsSubmission(t *testing.T) {
	var sawToken bool
	var sawRows bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v3.0/oauth2/authorization-token/":
			if r.Method != http.MethodPost {
				t.Fatalf("token method=%s", r.Method)
			}
			if r.Header.Get("x-api-key") != "api_key_123" || r.Header.Get("Authorization") != "Basic secret_123" {
				t.Fatalf("token headers x-api-key=%q auth=%q", r.Header.Get("x-api-key"), r.Header.Get("Authorization"))
			}
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			if r.Form.Get("grant_type") != "client_credentials" {
				t.Fatalf("token form=%s", r.Form.Encode())
			}
			sawToken = true
			_ = json.NewEncoder(w).Encode(map[string]any{"authorization_token": "jwt_from_secret"})
		case "/v3.0/forms/form_123/rows/":
			if r.Method != http.MethodGet {
				t.Fatalf("rows method=%s", r.Method)
			}
			if r.Header.Get("x-api-key") != "api_key_123" ||
				r.Header.Get("Authorization") != "JWT jwt_from_secret" ||
				r.Header.Get("x-workspace") != "workspace_123" {
				t.Fatalf("rows headers x-api-key=%q auth=%q workspace=%q", r.Header.Get("x-api-key"), r.Header.Get("Authorization"), r.Header.Get("x-workspace"))
			}
			if r.URL.Query().Get("page") != "1" ||
				r.URL.Query().Get("page_size") != "25" ||
				r.URL.Query().Get("created_at_gte") != "2026-07-01T00:00:00Z" ||
				r.URL.Query().Get("tags") != "newsletter" {
				t.Fatalf("query=%s", r.URL.RawQuery)
			}
			sawRows = true
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"results": []map[string]any{
					{
						"slug":                        "row_1",
						"created_at":                  "2026-07-03T12:34:56Z",
						"updated_at":                  "2026-07-03T12:35:56Z",
						"tracking_code":               "track_1",
						"submit_number":               42,
						"submitter_referer_address":   "https://example.com",
						"status":                      "submitted",
						"form":                        map[string]any{"slug": "form_123", "title": "Contact"},
						"data":                        map[string]any{"Email": "Lead@Example.com", "First Name": "Ada", "Last Name": "Lovelace", "Company": "Moosewave", "Phone": "5551234567"},
						"readable_data":               map[string]any{"Plan": "Pro"},
						"formaloo_provider_extra_key": "kept",
					},
				},
				"count":        2,
				"current_page": 1,
				"page_count":   2,
				"next":         "/v3.0/forms/form_123/rows/?page=2",
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (FormalooRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeFormalooCredentialResolver{creds: FormalooCredentials{
			APIKey:    "api_key_123",
			APISecret: "secret_123",
		}},
		APIBaseURL: srv.URL,
		PageSize:   25,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFormaloo,
		CredentialsRef: "cred_formaloo_1",
		Settings: map[string]any{
			"workspace_id":    "workspace_123",
			"form_id":         "form_123",
			"form_name":       "Newsletter",
			"default_tags":    "newsletter,forms",
			"created_at_gte":  "2026-07-01T00:00:00Z",
			"tags":            "newsletter",
			"credentials_ref": "cred_formaloo_1",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawToken || !sawRows {
		t.Fatalf("expected token/rows requests, token=%v rows=%v", sawToken, sawRows)
	}
	if !strings.HasPrefix(req.Cursor, formalooCursorPrefix) || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	state, err := decodeFormalooCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Page != 2 || state.HighWaterSlug != "row_1" || state.HighWaterSubmittedAt != "2026-07-03T12:34:56Z" || state.PageCount != 2 {
		t.Fatalf("cursor state=%+v", state)
	}
	got := req.Submissions[0]
	if got.SourceID != "formaloo://row/form_123/row_1" ||
		got.Email != "lead@example.com" ||
		got.FirstName != "Ada" ||
		got.LastName != "Lovelace" ||
		got.Phone != "5551234567" ||
		got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Newsletter" || got.Fields["formaloo_field.email"] != "Lead@Example.com" || got.Fields["formaloo_field.plan"] != "Pro" {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if got.SubmittedAt == nil || got.SubmittedAt.Format(time.RFC3339) != "2026-07-03T12:34:56Z" {
		t.Fatalf("submitted_at=%v", got.SubmittedAt)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "formaloo:form_123") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestFormalooRESTBackfillerUsesCursorLowerBound(t *testing.T) {
	var gotCreatedAtGTE string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCreatedAtGTE = r.URL.Query().Get("created_at_gte")
		_, _ = w.Write([]byte(`{
			"results": [
				{"slug":"row_1","created_at":"2026-07-02T12:00:00Z","data":{"Email":"old@example.com"}},
				{"slug":"row_2","created_at":"2026-07-03T12:00:00Z","data":{"Email":"new@example.com"}}
			],
			"current_page":1,
			"page_count":1
		}`))
	}))
	defer srv.Close()

	req, err := (FormalooRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFormalooCredentialResolver{creds: FormalooCredentials{APIKey: "api_key_123", AuthorizationToken: "token_123"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFormaloo,
		CredentialsRef: "cred_formaloo_1",
		Settings:       map[string]any{"form_id": "form_123"},
	}, encodeFormalooCursor(formalooCursorState{FormSlug: "form_123", LastSubmittedAt: "2026-07-02T12:00:00Z", LastSlug: "row_1"}))
	if err != nil {
		t.Fatal(err)
	}
	if gotCreatedAtGTE != "2026-07-02T12:00:00Z" {
		t.Fatalf("created_at_gte=%q", gotCreatedAtGTE)
	}
	if len(req.Submissions) != 1 || req.Submissions[0].Email != "new@example.com" {
		t.Fatalf("submissions=%+v", req.Submissions)
	}
	state, err := decodeFormalooCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Page != 0 || state.LastSlug != "row_2" || state.LastSubmittedAt != "2026-07-03T12:00:00Z" {
		t.Fatalf("state=%+v", state)
	}
}

func TestFormalooRESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (FormalooRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFormalooCredentialResolver{creds: FormalooCredentials{APIKey: "api_key_123", AuthorizationToken: "token_123"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFormaloo,
		CredentialsRef: "cred_formaloo_1",
		Settings:       map[string]any{"form_id": "form_123"},
	}, "")
	var providerErr FormalooProviderError
	if !errors.As(err, &providerErr) || providerErr.RetryAfter != 42*time.Second {
		t.Fatalf("err=%T %[1]v", err)
	}
}

type fakeFormalooCredentialResolver struct {
	creds FormalooCredentials
	err   error
}

func (f fakeFormalooCredentialResolver) ResolveFormaloo(context.Context, string, Integration) (FormalooCredentials, error) {
	if f.err != nil {
		return FormalooCredentials{}, f.err
	}
	return f.creds, nil
}
