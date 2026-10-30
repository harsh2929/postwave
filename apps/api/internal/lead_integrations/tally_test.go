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

func TestParseTallyCredentialSecret(t *testing.T) {
	creds, err := parseTallyCredentialSecret(`{
		"api_key":"tally_123",
		"api_base_url":"https://api.tally.so/",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "tally_123" || creds.APIBaseURL != "https://api.tally.so" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestTallyRESTBackfillerFetchesSubmissionsAndMapsSubmission(t *testing.T) {
	var sawBearer bool
	var sawSubmissionsQuery bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer tally_token" {
			sawBearer = true
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/forms/form_123/submissions" {
			t.Fatalf("unexpected Tally path %s", r.URL.Path)
		}
		sawSubmissionsQuery = true
		if r.URL.Query().Get("page") != "1" || r.URL.Query().Get("limit") != "2" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"page":    1,
			"limit":   2,
			"hasMore": false,
			"questions": []map[string]any{
				{"id": "q_email", "title": "Email", "type": "INPUT_EMAIL"},
				{"id": "q_first", "title": "First name", "type": "INPUT_TEXT"},
				{"id": "q_last", "title": "Last name", "type": "INPUT_TEXT"},
				{"id": "q_company", "title": "Company", "type": "INPUT_TEXT"},
			},
			"submissions": []map[string]any{
				{
					"id":           "sub_123",
					"formId":       "form_123",
					"formName":     "Newsletter Signup",
					"respondentId": "resp_123",
					"isCompleted":  true,
					"submittedAt":  "2026-06-16T10:00:00Z",
					"responses": []map[string]any{
						{"id": "resp_email", "questionId": "q_email", "answer": "Lead@Example.com", "formattedAnswer": "Lead@Example.com"},
						{"id": "resp_first", "questionId": "q_first", "answer": "Ada", "formattedAnswer": "Ada"},
						{"id": "resp_last", "questionId": "q_last", "answer": "Lovelace", "formattedAnswer": "Lovelace"},
						{"id": "resp_company", "questionId": "q_company", "answer": "Moosewave", "formattedAnswer": "Moosewave"},
					},
				},
			},
		})
	}))
	defer srv.Close()

	req, err := (TallyRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeTallyCredentialResolver{creds: TallyCredentials{AccessToken: "tally_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderTally,
		CredentialsRef: "cred_tally_1",
		Settings:       map[string]any{"form_id": "form_123", "default_tags": "newsletter,launch"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawBearer || !sawSubmissionsQuery {
		t.Fatalf("expected bearer auth and submissions query, bearer=%v submissions=%v", sawBearer, sawSubmissionsQuery)
	}
	if req.Cursor != tallyCursorComplete || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	got := req.Submissions[0]
	if got.SourceID != "tally://submission/form_123/sub_123" || got.Email != "lead@example.com" || got.FirstName != "Ada" || got.LastName != "Lovelace" || got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Newsletter Signup" || got.Fields["tally_response.email"] != "Lead@Example.com" || got.Fields["tally_respondent_id"] != "resp_123" || got.Fields["tally_is_completed"] != true {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "tally:form_123") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestTallyRESTBackfillerUsesPageCursor(t *testing.T) {
	var page string
	var limit string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/forms/form_123/submissions" {
			t.Fatalf("unexpected Tally path %s", r.URL.Path)
		}
		page = r.URL.Query().Get("page")
		limit = r.URL.Query().Get("limit")
		_, _ = w.Write([]byte(`{"page":2,"limit":1,"hasMore":true,"submissions":[{"id":"sub_2","formId":"form_123","submittedAt":"2026-06-16T10:00:00Z","fields":[{"label":"Email","type":"INPUT_EMAIL","value":"lead@example.com"}]}]}`))
	}))
	defer srv.Close()

	req, err := (TallyRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeTallyCredentialResolver{creds: TallyCredentials{AccessToken: "tally_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderTally,
		CredentialsRef: "cred_tally_1",
		Settings:       map[string]any{"form_id": "form_123"},
	}, encodeTallyCursor(tallyCursorState{Page: 2}))
	if err != nil {
		t.Fatal(err)
	}
	if page != "2" || limit != "1" {
		t.Fatalf("page=%q limit=%q", page, limit)
	}
	if !strings.HasPrefix(req.Cursor, tallyCursorPrefix) || req.Cursor == tallyCursorComplete {
		t.Fatalf("cursor=%q", req.Cursor)
	}
	state, err := decodeTallyCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Page != 3 {
		t.Fatalf("state=%+v", state)
	}
}

func TestTallyRESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (TallyRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeTallyCredentialResolver{creds: TallyCredentials{AccessToken: "tally_token"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderTally,
		CredentialsRef: "cred_tally_1",
		Settings:       map[string]any{"form_id": "form_123"},
	}, "")
	var providerErr TallyProviderError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 42*time.Second || !strings.Contains(providerErr.Snippet, "slow down") {
		t.Fatalf("err=%T %v", err, err)
	}
}

type fakeTallyCredentialResolver struct {
	creds TallyCredentials
	err   error
}

func (f fakeTallyCredentialResolver) ResolveTally(context.Context, string, Integration) (TallyCredentials, error) {
	if f.err != nil {
		return TallyCredentials{}, f.err
	}
	return f.creds, nil
}
