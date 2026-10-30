// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseCognitoFormsCredentialSecret(t *testing.T) {
	creds, err := parseCognitoFormsCredentialSecret(`{
		"api_key": "Bearer api-secret",
		"api_base_url": "https://www.cognitoforms.com/api/",
		"odata_base_url": "https://www.cognitoforms.com/api/odata/",
		"user_agent": "Custom UA"
	}`)
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "api-secret" || creds.APIBaseURL != "https://www.cognitoforms.com/api" || creds.ODataBaseURL != "https://www.cognitoforms.com/api/odata" || creds.UserAgent != "Custom UA" {
		t.Fatalf("creds=%+v", creds)
	}

	creds, err = parseCognitoFormsCredentialSecret("access_token=token-123\nodata_base_url=https://forms.example.com/api/odata/")
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "token-123" || creds.ODataBaseURL != "https://forms.example.com/api/odata" {
		t.Fatalf("key-value creds=%+v", creds)
	}
}

func TestCognitoFormsRESTBackfillerDiscoversIDsHydratesEntriesAndMapsSubmission(t *testing.T) {
	var sawForm, sawSchema, sawIDs, sawEntry100, sawEntry101 bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer api-secret" {
			t.Fatalf("bad auth header %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("User-Agent") != cognitoFormsDefaultUserAgent {
			t.Fatalf("bad user-agent %q", r.Header.Get("User-Agent"))
		}
		switch r.URL.Path {
		case "/api/odata/Forms(123)":
			sawForm = true
			_, _ = w.Write([]byte(`{"Id":123,"Name":"Newsletter","InternalName":"Newsletter"}`))
		case "/api/forms/123/schema":
			sawSchema = true
			if r.URL.Query().Get("input") != "false" || r.URL.Query().Get("includeLinks") != "false" {
				t.Fatalf("unexpected schema query %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{
				"properties":{
					"Email":{"type":"string","description":"Email"},
					"FullName":{"type":"string","description":"Full Name"},
					"Phone":{"type":"string","description":"Phone"},
					"Company":{"type":"string","description":"Company"}
				}
			}`))
		case "/api/odata/Forms(123)/Views(456)/Entries":
			sawIDs = true
			if r.URL.Query().Get("$select") != "Id" || r.URL.Query().Get("$count") != "true" {
				t.Fatalf("unexpected ID query %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"@odata.count":3,"value":[{"Id":100},{"Id":101},{"Id":102}]}`))
		case "/api/forms/123/entries/100":
			sawEntry100 = true
			_, _ = w.Write([]byte(`{
				"Id":"100",
				"Entry":{
					"DateSubmitted":"2026-07-03T12:34:56Z",
					"DateCreated":"2026-07-03T12:30:00Z",
					"Status":"Submitted",
					"User":{"Email":"owner@example.com","Name":"Owner"}
				},
				"Email":"Lead@Example.COM",
				"FullName":"Ada Lovelace",
				"Phone":"+15555550123",
				"Company":"Analytical Engines"
			}`))
		case "/api/forms/123/entries/101":
			sawEntry101 = true
			_, _ = w.Write([]byte(`{
				"Id":"101",
				"Entry":{"DateSubmitted":"2026-07-03T13:00:00Z","Status":"Submitted"},
				"Email":"second@example.com"
			}`))
		default:
			t.Fatalf("unexpected path %s", r.URL.String())
		}
	}))
	defer server.Close()

	req, err := (CognitoFormsRESTBackfiller{
		HTTPClient:  server.Client(),
		Credentials: fakeCognitoFormsCredentialResolver{creds: CognitoFormsCredentials{AccessToken: "api-secret"}},
		PageSize:    2,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		ID:             "lead_1",
		Provider:       ProviderCognitoForms,
		CredentialsRef: "cred_1",
		Settings: map[string]any{
			"api_base_url":   server.URL + "/api",
			"odata_base_url": server.URL + "/api/odata",
			"form_id":        "123",
			"view_id":        "456",
			"default_tags":   "forms, high-intent",
		},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !sawForm || !sawSchema || !sawIDs || !sawEntry100 || !sawEntry101 {
		t.Fatalf("saw form=%v schema=%v ids=%v entry100=%v entry101=%v", sawForm, sawSchema, sawIDs, sawEntry100, sawEntry101)
	}
	if len(req.Submissions) != 2 {
		t.Fatalf("submissions=%+v", req.Submissions)
	}
	sub := req.Submissions[0]
	if sub.SourceID != "cognito-forms://entry/123/456/100" {
		t.Fatalf("source id=%q", sub.SourceID)
	}
	if sub.Email != "lead@example.com" || sub.FullName != "Ada Lovelace" || sub.Phone != "+15555550123" || sub.Company != "Analytical Engines" {
		t.Fatalf("identity mapping failed: %+v", sub)
	}
	if sub.FormID != "123" || sub.FormName != "Newsletter" || sub.EventName != "lead.submitted" {
		t.Fatalf("form/event mapping failed: %+v", sub)
	}
	if sub.SubmittedAt == nil || !sub.SubmittedAt.Equal(time.Date(2026, 7, 3, 12, 34, 56, 0, time.UTC)) {
		t.Fatalf("submitted_at=%v", sub.SubmittedAt)
	}
	if !containsFold(sub.Tags, "cognito-forms") || !containsFold(sub.Tags, "cognito-forms:123") || !containsFold(sub.Tags, "cognito-forms:view:456") || !containsFold(sub.Tags, "high-intent") {
		t.Fatalf("tags=%+v", sub.Tags)
	}
	if sub.Fields["cognito_forms_field.email"] != "Lead@Example.COM" {
		t.Fatalf("fields=%+v", sub.Fields)
	}
	state, err := decodeCognitoFormsCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.FormID != "123" || state.ViewID != "456" || state.LastID != "101" || state.TotalCount != 3 {
		t.Fatalf("cursor state=%+v cursor=%q", state, req.Cursor)
	}
}

func TestCognitoFormsRESTBackfillerUsesLastIDCursor(t *testing.T) {
	seenEntries := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/odata/Forms(123)" {
			_, _ = w.Write([]byte(`{"Id":123,"Name":"Newsletter"}`))
			return
		}
		if r.URL.Path == "/api/forms/123/schema" {
			_, _ = w.Write([]byte(`{"properties":{"Email":{"type":"string","description":"Email"}}}`))
			return
		}
		if r.URL.Path == "/api/odata/Forms(123)/Views(456)/Entries" {
			_, _ = w.Write([]byte(`{"value":[{"Id":100},{"Id":101},{"Id":102}]}`))
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/forms/123/entries/") {
			seenEntries = append(seenEntries, strings.TrimPrefix(r.URL.Path, "/api/forms/123/entries/"))
			_, _ = w.Write([]byte(`{"Id":"102","Entry":{"DateSubmitted":"2026-07-03T14:00:00Z"},"Email":"next@example.com"}`))
			return
		}
		t.Fatalf("unexpected path %s", r.URL.String())
	}))
	defer server.Close()

	req, err := (CognitoFormsRESTBackfiller{
		HTTPClient:  server.Client(),
		Credentials: fakeCognitoFormsCredentialResolver{creds: CognitoFormsCredentials{AccessToken: "api-secret"}},
		PageSize:    10,
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderCognitoForms,
		CredentialsRef: "cred_1",
		Settings: map[string]any{
			"api_base_url":   server.URL + "/api",
			"odata_base_url": server.URL + "/api/odata",
			"form_id":        "123",
			"view_id":        "456",
		},
	}, encodeCognitoFormsCursor(cognitoFormsCursorState{FormID: "123", ViewID: "456", LastID: "101", TotalCount: 3}))
	if err != nil {
		t.Fatal(err)
	}
	if len(seenEntries) != 1 || seenEntries[0] != "102" || len(req.Submissions) != 1 {
		t.Fatalf("seenEntries=%+v req=%+v", seenEntries, req)
	}
	state, err := decodeCognitoFormsCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.LastID != "102" {
		t.Fatalf("state=%+v", state)
	}
}

func TestCognitoFormsRESTBackfillerProviderErrorCarriesRetryAfter(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "120")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer server.Close()

	_, err := (CognitoFormsRESTBackfiller{
		HTTPClient:  server.Client(),
		Credentials: fakeCognitoFormsCredentialResolver{creds: CognitoFormsCredentials{AccessToken: "api-secret"}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderCognitoForms,
		CredentialsRef: "cred_1",
		Settings: map[string]any{
			"api_base_url":   server.URL + "/api",
			"odata_base_url": server.URL + "/api/odata",
			"form_id":        "123",
			"view_id":        "456",
		},
	}, "")
	var providerErr CognitoFormsProviderError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != http.StatusTooManyRequests || providerErr.RetryAfter != 2*time.Minute {
		t.Fatalf("err=%T %[1]v", err)
	}
}

type fakeCognitoFormsCredentialResolver struct {
	creds CognitoFormsCredentials
	err   error
}

func (f fakeCognitoFormsCredentialResolver) ResolveCognitoForms(context.Context, string, Integration) (CognitoFormsCredentials, error) {
	if f.err != nil {
		return CognitoFormsCredentials{}, f.err
	}
	return f.creds, nil
}
