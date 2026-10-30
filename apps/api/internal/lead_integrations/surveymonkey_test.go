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

func TestParseSurveyMonkeyCredentialSecret(t *testing.T) {
	creds, err := parseSurveyMonkeyCredentialSecret(`{
		"access_token":"Bearer sm_token_123",
		"api_base_url":"https://api.surveymonkey.com/",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "sm_token_123" || creds.APIBaseURL != "https://api.surveymonkey.com" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestSurveyMonkeyRESTBackfillerFetchesResponsesAndMapsSubmission(t *testing.T) {
	var sawBearer bool
	var sawDetails bool
	var sawResponsesQuery bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer sm_access_token" {
			sawBearer = true
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v3/surveys/survey_456/details":
			sawDetails = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":    "survey_456",
				"title": "Customer survey",
				"pages": []map[string]any{
					{
						"id": "page_1",
						"questions": []map[string]any{
							{"id": "q_email", "family": "open_ended", "subtype": "single", "headings": []map[string]any{{"heading": "Email"}}, "answers": map[string]any{}},
							{"id": "q_first", "family": "open_ended", "subtype": "single", "headings": []map[string]any{{"heading": "First name"}}, "answers": map[string]any{}},
							{"id": "q_last", "family": "open_ended", "subtype": "single", "headings": []map[string]any{{"heading": "Last name"}}, "answers": map[string]any{}},
							{"id": "q_company", "family": "open_ended", "subtype": "single", "headings": []map[string]any{{"heading": "Company"}}, "answers": map[string]any{}},
						},
					},
				},
			})
		case "/v3/surveys/survey_456/responses/bulk":
			sawResponsesQuery = true
			if r.URL.Query().Get("per_page") != "2" ||
				r.URL.Query().Get("simple") != "false" ||
				r.URL.Query().Get("start_modified_at") != "2026-06-01T00:00:00Z" ||
				r.URL.Query().Get("collector_ids") != "collector_1" {
				t.Fatalf("unexpected query: %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"page":     1,
				"per_page": 2,
				"total":    1,
				"links": map[string]any{
					"next": srvURL(r) + "/v3/surveys/survey_456/responses/bulk?page=2",
				},
				"data": []map[string]any{
					{
						"id":              "response_123",
						"survey_id":       "survey_456",
						"collector_id":    "collector_1",
						"response_status": "completed",
						"date_created":    "2026-06-16T09:59:00",
						"date_modified":   "2026-06-16T10:00:00",
						"custom_variables": map[string]any{
							"campaign": "launch",
						},
						"pages": []map[string]any{
							{
								"id": "page_1",
								"questions": []map[string]any{
									{"id": "q_email", "answers": []map[string]any{{"text": "Lead@Example.com"}}},
									{"id": "q_first", "answers": []map[string]any{{"text": "Ada"}}},
									{"id": "q_last", "answers": []map[string]any{{"text": "Lovelace"}}},
									{"id": "q_company", "answers": []map[string]any{{"text": "Moosewave"}}},
								},
							},
						},
					},
				},
			})
		default:
			t.Fatalf("unexpected SurveyMonkey path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (SurveyMonkeyRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeSurveyMonkeyCredentialResolver{creds: SurveyMonkeyCredentials{AccessToken: "sm_access_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderSurveyMonkey,
		CredentialsRef: "cred_surveymonkey_1",
		Settings: map[string]any{
			"survey_id":              "survey_456",
			"survey_name":            "Customer survey",
			"collector_id":           "collector_1",
			"default_tags":           "newsletter,launch",
			"start_modified_at":      "2026-06-01T00:00:00Z",
			"email_question_id":      "q_email",
			"first_name_question_id": "q_first",
			"last_name_question_id":  "q_last",
			"company_question_id":    "q_company",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawBearer || !sawDetails || !sawResponsesQuery {
		t.Fatalf("expected auth/details/responses, bearer=%v details=%v responses=%v", sawBearer, sawDetails, sawResponsesQuery)
	}
	if !strings.HasPrefix(req.Cursor, surveyMonkeyCursorPrefix) || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	state, err := decodeSurveyMonkeyCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(state.NextURL, "page=2") || state.Since != "2026-06-01T00:00:00Z" {
		t.Fatalf("cursor state=%+v", state)
	}
	got := req.Submissions[0]
	if got.SourceID != "surveymonkey://response/survey_456/response_123" || got.Email != "lead@example.com" || got.FirstName != "Ada" || got.LastName != "Lovelace" || got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Customer survey" || got.Fields["surveymonkey_question.email"] != "Lead@Example.com" || got.Fields["surveymonkey_survey_id"] != "survey_456" {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "surveymonkey:survey_456") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestSurveyMonkeyRESTBackfillerUsesNextURLCursor(t *testing.T) {
	var rawQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v3/surveys/survey_456/details":
			_, _ = w.Write([]byte(`{"id":"survey_456","pages":[{"id":"page_1","questions":[{"id":"q_email","headings":[{"heading":"Email"}],"answers":{}}]}]}`))
		case "/v3/surveys/survey_456/responses/bulk":
			rawQuery = r.URL.RawQuery
			_, _ = w.Write([]byte(`{"data":[{"id":"response_124","survey_id":"survey_456","date_created":"2026-06-16T10:01:00","date_modified":"2026-06-16T10:02:00","pages":[{"id":"page_1","questions":[{"id":"q_email","answers":[{"text":"lead@example.com"}]}]}]}]}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (SurveyMonkeyRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeSurveyMonkeyCredentialResolver{creds: SurveyMonkeyCredentials{AccessToken: "sm_access_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderSurveyMonkey,
		CredentialsRef: "cred_surveymonkey_1",
		Settings:       map[string]any{"survey_id": "survey_456", "email_question_id": "q_email"},
	}, encodeSurveyMonkeyCursor(surveyMonkeyCursorState{NextURL: srv.URL + "/v3/surveys/survey_456/responses/bulk?page=2", Since: "2026-06-01T00:00:00Z"}))
	if err != nil {
		t.Fatal(err)
	}
	if rawQuery != "page=2" {
		t.Fatalf("expected next URL query only, got %q", rawQuery)
	}
	state, err := decodeSurveyMonkeyCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.NextURL != "" || state.Since != "2026-06-16T10:02:00" {
		t.Fatalf("state=%+v", state)
	}
}

func TestSurveyMonkeyRESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (SurveyMonkeyRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeSurveyMonkeyCredentialResolver{creds: SurveyMonkeyCredentials{AccessToken: "sm_access_token"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderSurveyMonkey,
		CredentialsRef: "cred_surveymonkey_1",
		Settings:       map[string]any{"survey_id": "survey_456"},
	}, "")
	var providerErr SurveyMonkeyProviderError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 42*time.Second || !strings.Contains(providerErr.Snippet, "slow down") {
		t.Fatalf("err=%T %v", err, err)
	}
}

type fakeSurveyMonkeyCredentialResolver struct {
	creds SurveyMonkeyCredentials
	err   error
}

func (f fakeSurveyMonkeyCredentialResolver) ResolveSurveyMonkey(context.Context, string, Integration) (SurveyMonkeyCredentials, error) {
	if f.err != nil {
		return SurveyMonkeyCredentials{}, f.err
	}
	return f.creds, nil
}
