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

func TestParseFormBuilder123CredentialSecret(t *testing.T) {
	creds, err := parseFormBuilder123CredentialSecret(`{
		"jwt":"jwt_123",
		"api_base_url":"https://eu-api.123formbuilder.com/v2/",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.JWT != "jwt_123" || creds.APIBaseURL != "https://eu-api.123formbuilder.com/v2" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}

	creds, err = parseFormBuilder123CredentialSecret("username=owner@example.com\npassword=secret")
	if err != nil {
		t.Fatal(err)
	}
	if creds.Username != "owner@example.com" || creds.Password != "secret" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestFormBuilder123RESTBackfillerFetchesSubmissionsAndMapsSubmission(t *testing.T) {
	var sawToken bool
	var sawSubmissions bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			if r.Method != http.MethodPost || r.URL.Query().Get("username") != "owner@example.com" || r.URL.Query().Get("password") != "secret" {
				t.Fatalf("token request %s %s", r.Method, r.URL.RawQuery)
			}
			sawToken = true
			_ = json.NewEncoder(w).Encode(map[string]any{"token": "jwt_from_login"})
		case "/forms/form_123/submissions":
			if r.Method != http.MethodGet {
				t.Fatalf("unexpected method %s", r.Method)
			}
			if r.URL.Query().Get("JWT") != "jwt_from_login" ||
				r.URL.Query().Get("per_page") != "25" ||
				r.URL.Query().Get("page") != "1" ||
				r.URL.Query().Get("start_date") != "2026-07-01" ||
				r.URL.Query().Get("include_recipients") != "1" {
				t.Fatalf("query=%s", r.URL.RawQuery)
			}
			sawSubmissions = true
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{
						"id":         123,
						"form_id":    "form_123",
						"entry_id":   789,
						"country":    "US",
						"date":       "2026-07-02T12:34:56Z",
						"status":     1,
						"approved":   1,
						"recipients": map[string]any{"email": "ops@example.com"},
						"content":    `{"Email":"Lead@Example.com","First Name":"Ada","Last Name":"Lovelace","Company":"Moosewave","Phone":"5551234567"}`,
					},
				},
				"meta": map[string]any{"pagination": map[string]any{
					"total":        2,
					"count":        1,
					"per_page":     25,
					"current_page": 1,
					"total_pages":  2,
					"links":        map[string]any{"next": "https://api.123formbuilder.com/v2/forms/form_123/submissions?page=2"},
				}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (FormBuilder123RESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakeFormBuilder123CredentialResolver{creds: FormBuilder123Credentials{
			Username: "owner@example.com",
			Password: "secret",
		}},
		APIBaseURL: srv.URL,
		PageSize:   25,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       Provider123FormBuilder,
		CredentialsRef: "cred_123formbuilder_1",
		Settings: map[string]any{
			"account_id":         "acct_123",
			"form_id":            "form_123",
			"form_name":          "Newsletter",
			"default_tags":       "newsletter,forms",
			"start_date":         "2026-07-01",
			"include_recipients": "1",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawToken || !sawSubmissions {
		t.Fatalf("expected token/submissions requests, token=%v submissions=%v", sawToken, sawSubmissions)
	}
	if !strings.HasPrefix(req.Cursor, formBuilder123CursorPrefix) || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	state, err := decodeFormBuilder123Cursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Page != 2 || state.HighWaterID != "123" || state.HighWaterSubmittedAt != "2026-07-02T12:34:56Z" || state.TotalPages != 2 {
		t.Fatalf("cursor state=%+v", state)
	}
	got := req.Submissions[0]
	if got.SourceID != "123formbuilder://submission/form_123/123" ||
		got.Email != "lead@example.com" ||
		got.FirstName != "Ada" ||
		got.LastName != "Lovelace" ||
		got.Phone != "5551234567" ||
		got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Newsletter" || got.Fields["formbuilder123_field.email"] != "Lead@Example.com" {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if got.SubmittedAt == nil || got.SubmittedAt.Format(time.RFC3339) != "2026-07-02T12:34:56Z" {
		t.Fatalf("submitted_at=%v", got.SubmittedAt)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "123formbuilder:form_123") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestFormBuilder123RESTBackfillerUsesCursorCheckpoint(t *testing.T) {
	var gotStartSubmissionID string
	var gotPage string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotStartSubmissionID = r.URL.Query().Get("start_submission_id")
		gotPage = r.URL.Query().Get("page")
		_, _ = w.Write([]byte(`{
			"data": [
				{"id":123,"date":"2026-07-02T12:00:00Z","content":"{\"Email\":\"old@example.com\"}"},
				{"id":124,"date":"2026-07-03T12:00:00Z","content":"{\"Email\":\"new@example.com\"}"}
			],
			"meta":{"pagination":{"current_page":1,"total_pages":1}}
		}`))
	}))
	defer srv.Close()

	req, err := (FormBuilder123RESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFormBuilder123CredentialResolver{creds: FormBuilder123Credentials{JWT: "jwt_123"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       Provider123FormBuilder,
		CredentialsRef: "cred_123formbuilder_1",
		Settings:       map[string]any{"form_id": "form_123"},
	}, encodeFormBuilder123Cursor(formBuilder123CursorState{FormID: "form_123", LastID: "123", LastSubmittedAt: "2026-07-02T12:00:00Z"}))
	if err != nil {
		t.Fatal(err)
	}
	if gotStartSubmissionID != "123" || gotPage != "1" {
		t.Fatalf("start_submission_id=%q page=%q", gotStartSubmissionID, gotPage)
	}
	if len(req.Submissions) != 1 || req.Submissions[0].Email != "new@example.com" {
		t.Fatalf("submissions=%+v", req.Submissions)
	}
	state, err := decodeFormBuilder123Cursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Page != 0 || state.LastID != "124" || state.LastSubmittedAt != "2026-07-03T12:00:00Z" {
		t.Fatalf("state=%+v", state)
	}
}

func TestFormBuilder123RESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (FormBuilder123RESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFormBuilder123CredentialResolver{creds: FormBuilder123Credentials{JWT: "jwt_123"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       Provider123FormBuilder,
		CredentialsRef: "cred_123formbuilder_1",
		Settings:       map[string]any{"form_id": "form_123"},
	}, "")
	var providerErr FormBuilder123ProviderError
	if !errors.As(err, &providerErr) || providerErr.RetryAfter != 42*time.Second {
		t.Fatalf("err=%T %[1]v", err)
	}
}

type fakeFormBuilder123CredentialResolver struct {
	creds FormBuilder123Credentials
	err   error
}

func (f fakeFormBuilder123CredentialResolver) ResolveFormBuilder123(context.Context, string, Integration) (FormBuilder123Credentials, error) {
	if f.err != nil {
		return FormBuilder123Credentials{}, f.err
	}
	return f.creds, nil
}
