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

func TestParseFormstackCredentialSecret(t *testing.T) {
	creds, err := parseFormstackCredentialSecret(`{
		"personal_access_token":"fs_pat_123",
		"api_base_url":"https://www.formstack.com/api/v2025/",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "fs_pat_123" || creds.APIBaseURL != "https://www.formstack.com/api/v2025" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestFormstackRESTBackfillerFetchesSubmissionsAndMapsSubmission(t *testing.T) {
	var sawBearer bool
	var sawSubmissionsQuery bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer fs_pat_token" {
			sawBearer = true
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/forms/123/submissions" {
			t.Fatalf("unexpected Formstack path %s", r.URL.Path)
		}
		sawSubmissionsQuery = true
		if r.URL.Query().Get("pageNumber") != "1" ||
			r.URL.Query().Get("pageSize") != "2" ||
			r.URL.Query().Get("order") != "ASC" ||
			r.URL.Query().Get("data") != "true" ||
			r.URL.Query().Get("expandData") != "true" ||
			r.URL.Query().Get("dataFormat") != "legacy" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"page": map[string]any{
				"size":          1,
				"pageNumber":    1,
				"pageSize":      2,
				"totalElements": 1,
				"totalPages":    1,
			},
			"submissions": []map[string]any{
				{
					"id":         456,
					"formId":     123,
					"timestamp":  "2026-06-16T10:00:00Z",
					"prettyName": "Ada Lovelace",
					"data": map[string]any{
						"111": map[string]any{"field": "111", "label": "Email", "type": "email", "internal_label": "email", "value": "Lead@Example.com", "flat_value": "Lead@Example.com"},
						"112": map[string]any{"field": "112", "label": "First name", "type": "text", "internal_label": "first_name", "value": "Ada", "flat_value": "Ada"},
						"113": map[string]any{"field": "113", "label": "Last name", "type": "text", "internal_label": "last_name", "value": "Lovelace", "flat_value": "Lovelace"},
						"114": map[string]any{"field": "114", "label": "Company", "type": "text", "internal_label": "company", "value": "Moosewave", "flat_value": "Moosewave"},
					},
				},
			},
		})
	}))
	defer srv.Close()

	req, err := (FormstackRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFormstackCredentialResolver{creds: FormstackCredentials{AccessToken: "fs_pat_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFormstack,
		CredentialsRef: "cred_formstack_1",
		Settings:       map[string]any{"form_id": "123", "form_name": "Newsletter Signup", "default_tags": "newsletter,launch"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawBearer || !sawSubmissionsQuery {
		t.Fatalf("expected bearer auth and submissions query, bearer=%v submissions=%v", sawBearer, sawSubmissionsQuery)
	}
	if req.Cursor != formstackCursorComplete || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	got := req.Submissions[0]
	if got.SourceID != "formstack://submission/123/456" || got.Email != "lead@example.com" || got.FirstName != "Ada" || got.LastName != "Lovelace" || got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Newsletter Signup" || got.FullName != "Ada Lovelace" || got.Fields["formstack_field.email"] != "Lead@Example.com" || got.Fields["formstack_form_id"] != "123" {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "formstack:123") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestFormstackRESTBackfillerUsesPageCursor(t *testing.T) {
	var pageNumber string
	var pageSize string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/forms/123/submissions" {
			t.Fatalf("unexpected Formstack path %s", r.URL.Path)
		}
		pageNumber = r.URL.Query().Get("pageNumber")
		pageSize = r.URL.Query().Get("pageSize")
		_, _ = w.Write([]byte(`{"page":{"size":1,"pageNumber":2,"pageSize":1,"totalElements":3,"totalPages":3},"submissions":[{"id":789,"formId":123,"timestamp":"2026-06-16T10:00:00Z","data":{"111":{"field":"111","label":"Email","type":"email","value":"lead@example.com","flat_value":"lead@example.com"}}}]}`))
	}))
	defer srv.Close()

	req, err := (FormstackRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFormstackCredentialResolver{creds: FormstackCredentials{AccessToken: "fs_pat_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFormstack,
		CredentialsRef: "cred_formstack_1",
		Settings:       map[string]any{"form_id": "123"},
	}, encodeFormstackCursor(formstackCursorState{Page: 2}))
	if err != nil {
		t.Fatal(err)
	}
	if pageNumber != "2" || pageSize != "1" {
		t.Fatalf("pageNumber=%q pageSize=%q", pageNumber, pageSize)
	}
	if !strings.HasPrefix(req.Cursor, formstackCursorPrefix) || req.Cursor == formstackCursorComplete {
		t.Fatalf("cursor=%q", req.Cursor)
	}
	state, err := decodeFormstackCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Page != 3 {
		t.Fatalf("state=%+v", state)
	}
}

func TestFormstackRESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (FormstackRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeFormstackCredentialResolver{creds: FormstackCredentials{AccessToken: "fs_pat_token"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderFormstack,
		CredentialsRef: "cred_formstack_1",
		Settings:       map[string]any{"form_id": "123"},
	}, "")
	var providerErr FormstackProviderError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 42*time.Second || !strings.Contains(providerErr.Snippet, "slow down") {
		t.Fatalf("err=%T %v", err, err)
	}
}

type fakeFormstackCredentialResolver struct {
	creds FormstackCredentials
	err   error
}

func (f fakeFormstackCredentialResolver) ResolveFormstack(context.Context, string, Integration) (FormstackCredentials, error) {
	if f.err != nil {
		return FormstackCredentials{}, f.err
	}
	return f.creds, nil
}
