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

func TestParseInstapageCredentialSecret(t *testing.T) {
	creds, err := parseInstapageCredentialSecret(`{
		"api_key":"Bearer ip_api_token_123",
		"api_base_url":"https://api.instapage.com/",
		"user_agent":"Moosewave Test"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "ip_api_token_123" || creds.APIBaseURL != "https://api.instapage.com" || creds.UserAgent != "Moosewave Test" {
		t.Fatalf("creds=%+v", creds)
	}

	creds, err = parseInstapageCredentialSecret("access_token=Bearer ip_oauth_token")
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "ip_oauth_token" {
		t.Fatalf("creds=%+v", creds)
	}
}

func TestInstapageRESTBackfillerFetchesSubmissionsAndMapsSubmission(t *testing.T) {
	var sawBearer bool
	var sawRequest bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/workspaces/workspace_123/submissions" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") == "Bearer ip_access_token" {
			sawBearer = true
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		pages, _ := body["pages"].([]any)
		timeframe, _ := body["timeframe"].(map[string]any)
		if len(pages) != 1 || pages[0] != "page_456" ||
			int64(timeframe["start"].(float64)) != 1781517600 ||
			int64(timeframe["end"].(float64)) != 1781607600 {
			t.Fatalf("body=%+v", body)
		}
		sawRequest = true
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{
				"submissions": []map[string]any{
					{
						"id":        "sub_123",
						"pageId":    "page_456",
						"createdAt": "1781604000",
						"fields": map[string]any{
							"email":      []string{"Lead@Example.com"},
							"first_name": "Ada",
							"last_name":  "Lovelace",
							"company":    "Moosewave",
							"phone":      "5551234567",
						},
					},
				},
			},
			"meta": map[string]any{
				"limit":         100,
				"nextPageToken": "token_2",
			},
		})
	}))
	defer srv.Close()

	req, err := (InstapageRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeInstapageCredentialResolver{creds: InstapageCredentials{AccessToken: "ip_access_token"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderInstapage,
		CredentialsRef: "cred_instapage_1",
		Settings: map[string]any{
			"workspace_id": "workspace_123",
			"page_id":      "page_456",
			"page_name":    "Launch Page",
			"default_tags": "newsletter,launch",
			"from":         "1781517600",
			"to":           "1781607600",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawBearer || !sawRequest {
		t.Fatalf("expected auth/request, bearer=%v request=%v", sawBearer, sawRequest)
	}
	if !strings.HasPrefix(req.Cursor, instapageCursorPrefix) || len(req.Submissions) != 1 {
		t.Fatalf("req=%+v", req)
	}
	state, err := decodeInstapageCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.NextPageToken != "token_2" || state.Since != 1781517600 {
		t.Fatalf("cursor state=%+v", state)
	}
	got := req.Submissions[0]
	if got.SourceID != "instapage://submission/workspace_123/page_456/sub_123" ||
		got.Email != "lead@example.com" ||
		got.FirstName != "Ada" ||
		got.LastName != "Lovelace" ||
		got.Phone != "5551234567" ||
		got.Company != "Moosewave" {
		t.Fatalf("submission=%+v", got)
	}
	if got.FormName != "Launch Page" || got.Fields["instapage_field.email"] != "Lead@Example.com" {
		t.Fatalf("form/fields=%q %+v", got.FormName, got.Fields)
	}
	if got.SubmittedAt == nil || got.SubmittedAt.Unix() != 1781604000 {
		t.Fatalf("submitted_at=%v", got.SubmittedAt)
	}
	if !containsFold(got.Tags, "newsletter") || !containsFold(got.Tags, "instapage:page_456") {
		t.Fatalf("tags=%+v", got.Tags)
	}
}

func TestInstapageRESTBackfillerUsesNextPageTokenCursor(t *testing.T) {
	var nextToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		nextToken, _ = body["nextPageToken"].(string)
		_, _ = w.Write([]byte(`{"data":{"submissions":[{"id":"sub_2","pageId":"page_456","createdAt":1781605000,"fields":{"email":"two@example.com"}}]}}`))
	}))
	defer srv.Close()

	req, err := (InstapageRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeInstapageCredentialResolver{creds: InstapageCredentials{AccessToken: "ip_access_token"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderInstapage,
		CredentialsRef: "cred_instapage_1",
		Settings:       map[string]any{"workspace_id": "workspace_123", "page_id": "page_456"},
	}, encodeInstapageCursor(instapageCursorState{NextPageToken: "token_2", Since: 1781517600}))
	if err != nil {
		t.Fatal(err)
	}
	if nextToken != "token_2" {
		t.Fatalf("nextPageToken=%q", nextToken)
	}
	state, err := decodeInstapageCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.NextPageToken != "" || state.Since != 1781605000 {
		t.Fatalf("state=%+v", state)
	}
}

func TestInstapageRESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (InstapageRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: fakeInstapageCredentialResolver{creds: InstapageCredentials{AccessToken: "ip_access_token"}},
		APIBaseURL:  srv.URL,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderInstapage,
		CredentialsRef: "cred_instapage_1",
		Settings:       map[string]any{"workspace_id": "workspace_123", "page_id": "page_456"},
	}, "")
	var providerErr InstapageProviderError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 42*time.Second || !strings.Contains(providerErr.Snippet, "slow down") {
		t.Fatalf("err=%T %v", err, err)
	}
}

type fakeInstapageCredentialResolver struct {
	creds InstapageCredentials
	err   error
}

func (f fakeInstapageCredentialResolver) ResolveInstapage(context.Context, string, Integration) (InstapageCredentials, error) {
	if f.err != nil {
		return InstapageCredentials{}, f.err
	}
	return f.creds, nil
}
