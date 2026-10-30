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

func TestParseGoogleFormsCredentialSecret(t *testing.T) {
	creds, err := parseGoogleFormsCredentialSecret(`{
		"access_token":"Bearer google_token",
		"api_base_url":"https://forms.googleapis.com/",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "google_token" || creds.APIBaseURL != "https://forms.googleapis.com" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestGoogleFormsRESTBackfillerFetchesResponsesAndMapsSubmission(t *testing.T) {
	var sawBearer bool
	var sawForm bool
	var sawResponses bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer google_token" {
			sawBearer = true
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/forms/form123":
			sawForm = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"formId": "form123",
				"info":   map[string]any{"title": "Newsletter Signup"},
				"items": []map[string]any{
					{"itemId": "item_email", "title": "Email", "questionItem": map[string]any{"question": map[string]any{"questionId": "q_email"}}},
					{"itemId": "item_first", "title": "First name", "questionItem": map[string]any{"question": map[string]any{"questionId": "q_first"}}},
					{"itemId": "item_last", "title": "Last name", "questionItem": map[string]any{"question": map[string]any{"questionId": "q_last"}}},
					{"itemId": "item_company", "title": "Company", "questionItem": map[string]any{"question": map[string]any{"questionId": "q_company"}}},
				},
			})
		case "/v1/forms/form123/responses":
			sawResponses = true
			if r.URL.Query().Get("pageSize") != "2" || r.URL.Query().Get("filter") != "timestamp > 2026-06-01T00:00:00Z" {
				t.Fatalf("unexpected query: %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"nextPageToken": "next_page",
				"responses": []map[string]any{
					{
						"responseId":        "resp_1",
						"createTime":        "2026-06-16T09:59:00Z",
						"lastSubmittedTime": "2026-06-16T10:00:00Z",
						"respondentEmail":   "Collected@Example.com",
						"answers": map[string]any{
							"q_email":   map[string]any{"questionId": "q_email", "textAnswers": map[string]any{"answers": []map[string]any{{"value": "Lead@Example.com"}}}},
							"q_first":   map[string]any{"questionId": "q_first", "textAnswers": map[string]any{"answers": []map[string]any{{"value": "Ada"}}}},
							"q_last":    map[string]any{"questionId": "q_last", "textAnswers": map[string]any{"answers": []map[string]any{{"value": "Lovelace"}}}},
							"q_company": map[string]any{"questionId": "q_company", "textAnswers": map[string]any{"answers": []map[string]any{{"value": "Moosewave"}}}},
						},
					},
				},
			})
		default:
			t.Fatalf("unexpected Google Forms path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (GoogleFormsRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeGoogleFormsCredentialResolver{creds: GoogleFormsCredentials{AccessToken: "google_token"}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderGoogleForms,
		CredentialsRef: "cred_google_forms_1",
		Settings: map[string]any{
			"form_id":                "form123",
			"credentials_ref":        "cred_google_forms_1",
			"after_time":             "2026-06-01T00:00:00Z",
			"default_tags":           "newsletter,google",
			"email_question_id":      "q_email",
			"first_name_question_id": "q_first",
			"last_name_question_id":  "q_last",
			"company_question_id":    "q_company",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawBearer || !sawForm || !sawResponses {
		t.Fatalf("expected bearer/form/responses calls, bearer=%v form=%v responses=%v", sawBearer, sawForm, sawResponses)
	}
	if len(req.Submissions) != 1 || !strings.HasPrefix(req.Cursor, googleFormsCursorPrefix) {
		t.Fatalf("req=%+v", req)
	}
	state, err := decodeGoogleFormsCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.PageToken != "next_page" || state.Since != "2026-06-01T00:00:00Z" {
		t.Fatalf("state=%+v", state)
	}
	got := req.Submissions[0]
	if got.SourceID != "google-forms://response/form123/resp_1" || got.Email != "lead@example.com" || got.FirstName != "Ada" || got.LastName != "Lovelace" || got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Newsletter Signup" || got.Fields["google_forms_answer.email"] != "Lead@Example.com" || got.Fields["google_forms_question_id.email"] != "q_email" {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "google-forms:form123") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestGoogleFormsRESTBackfillerUsesPageTokenCursor(t *testing.T) {
	var pageToken string
	var filter string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/forms/form123":
			_, _ = w.Write([]byte(`{"formId":"form123","info":{"title":"Signup"},"items":[{"itemId":"email","title":"Email","questionItem":{"question":{"questionId":"q_email"}}}]}`))
		case "/v1/forms/form123/responses":
			pageToken = r.URL.Query().Get("pageToken")
			filter = r.URL.Query().Get("filter")
			_, _ = w.Write([]byte(`{"responses":[{"responseId":"resp_2","lastSubmittedTime":"2026-06-16T10:01:00Z","answers":{"q_email":{"questionId":"q_email","textAnswers":{"answers":[{"value":"lead@example.com"}]}}}}]}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	req, err := (GoogleFormsRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeGoogleFormsCredentialResolver{creds: GoogleFormsCredentials{AccessToken: "google_token"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderGoogleForms,
		CredentialsRef: "cred_google_forms_1",
		Settings:       map[string]any{"form_id": "form123"},
	}, encodeGoogleFormsCursor(googleFormsCursorState{PageToken: "page_2", Since: "2026-06-01T00:00:00Z"}))
	if err != nil {
		t.Fatal(err)
	}
	if pageToken != "page_2" || filter != "" {
		t.Fatalf("pageToken=%q filter=%q", pageToken, filter)
	}
	state, err := decodeGoogleFormsCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.PageToken != "" || state.Since != "2026-06-16T10:01:00Z" {
		t.Fatalf("state=%+v", state)
	}
}

func TestGoogleFormsRESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (GoogleFormsRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeGoogleFormsCredentialResolver{creds: GoogleFormsCredentials{AccessToken: "google_token"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderGoogleForms,
		CredentialsRef: "cred_google_forms_1",
		Settings:       map[string]any{"form_id": "form123"},
	}, "")
	var providerErr GoogleFormsProviderError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 42*time.Second || !strings.Contains(providerErr.Snippet, "slow down") {
		t.Fatalf("err=%T %v", err, err)
	}
}

type fakeGoogleFormsCredentialResolver struct {
	creds GoogleFormsCredentials
	err   error
}

func (f fakeGoogleFormsCredentialResolver) ResolveGoogleForms(context.Context, string, Integration) (GoogleFormsCredentials, error) {
	if f.err != nil {
		return GoogleFormsCredentials{}, f.err
	}
	return f.creds, nil
}
