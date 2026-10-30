// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakePipedriveCredentialResolver struct {
	creds PipedriveCredentials
	err   error
}

func (f fakePipedriveCredentialResolver) ResolvePipedrive(context.Context, string, Integration) (PipedriveCredentials, error) {
	if f.err != nil {
		return PipedriveCredentials{}, f.err
	}
	return f.creds, nil
}

func TestPipedriveSecretsCredentialResolverParsesRefs(t *testing.T) {
	resolver := NewPipedriveSecretsCredentialResolver(fakeCRMSecretResolver{
		values: map[string]string{
			"raw": "pd-api-token",
			"kv":  "api_token=pd-kv\napi_base_url=https://example.pipedrive.com\nuser_agent=Moosewave Test",
		},
		jsons: map[string]string{
			"json": `{"access_token":"Bearer pd-oauth","api_base_url":"https://api.pipedrive.test","user_agent":"Moosewave OAuth Test"}`,
		},
	})
	for _, tc := range []struct {
		ref        string
		wantAPI    string
		wantAccess string
		wantBase   string
		wantAgent  string
	}{
		{ref: "raw", wantAPI: "pd-api-token"},
		{ref: "kv", wantAPI: "pd-kv", wantBase: "https://example.pipedrive.com", wantAgent: "Moosewave Test"},
		{ref: "json", wantAccess: "pd-oauth", wantBase: "https://api.pipedrive.test", wantAgent: "Moosewave OAuth Test"},
	} {
		t.Run(tc.ref, func(t *testing.T) {
			creds, err := resolver.ResolvePipedrive(context.Background(), "tenant-1", Integration{CredentialsRef: tc.ref})
			if err != nil {
				t.Fatal(err)
			}
			if creds.APIToken != tc.wantAPI || creds.AccessToken != tc.wantAccess || creds.APIBaseURL != tc.wantBase || creds.UserAgent != tc.wantAgent {
				t.Fatalf("creds=%+v", creds)
			}
		})
	}
	if _, err := parsePipedriveCredentialSecret(`{"api_base_url":"https://example.pipedrive.com"}`); err == nil || !strings.Contains(err.Error(), "api_token") {
		t.Fatalf("expected token validation error, got %v", err)
	}
}

func TestPipedriveRESTBackfillerPullsPersonsPage(t *testing.T) {
	var gotPath, gotToken, gotCursor, gotLimit, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotToken = r.URL.Query().Get("api_token")
		gotCursor = r.URL.Query().Get("cursor")
		gotLimit = r.URL.Query().Get("limit")
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"data": []any{
				map[string]any{
					"id":         123,
					"name":       "Ada Lovelace",
					"first_name": "Ada",
					"last_name":  "Lovelace",
					"emails": []any{
						map[string]any{"value": "alt@example.com", "primary": false},
						map[string]any{"value": "Buyer@Example.com", "primary": true, "label": "work"},
					},
					"phones": []any{
						map[string]any{"value": "+15551234567", "primary": true},
					},
					"org_id":           map[string]any{"id": 55, "name": "Analytical Engines"},
					"marketing_status": "subscribed",
					"update_time":      "2026-06-18 10:11:12",
				},
			},
			"additional_data": map[string]any{
				"next_cursor": "cursor-200",
			},
		})
	}))
	defer srv.Close()

	req, err := (PipedriveRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakePipedriveCredentialResolver{creds: PipedriveCredentials{
			APIToken:   "pd-token",
			APIBaseURL: srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderPipedrive,
		CredentialsRef: "cred_pipedrive_1",
		Settings: map[string]any{
			"company_domain": "example",
			"limit":          "50",
			"default_tags":   []any{"crm", "Sales"},
			"list_ids":       "pipedrive-imports",
		},
	}, encodePipedriveCursor(pipedriveCursorState{Object: "persons", Cursor: "cursor-100"}))
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/v2/persons" || gotToken != "pd-token" || gotCursor != "cursor-100" || gotLimit != "50" || gotAuth != "" {
		t.Fatalf("request path/token/cursor/limit/auth=%q/%q/%q/%q/%q", gotPath, gotToken, gotCursor, gotLimit, gotAuth)
	}
	if len(req.Contacts) != 1 {
		t.Fatalf("contacts=%+v", req.Contacts)
	}
	contact := req.Contacts[0]
	if contact.SourceID != "pipedrive://person/123" || contact.Email != "buyer@example.com" || contact.Phone != "+15551234567" || contact.Company != "Analytical Engines" || contact.LifecycleStage != "subscribed" {
		t.Fatalf("contact=%+v", contact)
	}
	if !hasString(contact.Tags, "pipedrive-person") || !hasString(contact.Tags, "Sales") || !hasString(contact.ListIDs, "pipedrive-imports") {
		t.Fatalf("tags/list_ids=%+v/%+v", contact.Tags, contact.ListIDs)
	}
	if contact.UpdatedAt == nil || !contact.UpdatedAt.Equal(time.Date(2026, 6, 18, 10, 11, 12, 0, time.UTC)) {
		t.Fatalf("updated_at=%v", contact.UpdatedAt)
	}
	state, err := decodePipedriveCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "persons" || state.Cursor != "cursor-200" {
		t.Fatalf("cursor state=%+v raw=%s", state, req.Cursor)
	}
}

func TestPipedriveRESTBackfillerAdvancesFromPersonsToDeals(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success":         true,
			"data":            []any{},
			"additional_data": map[string]any{},
		})
	}))
	defer srv.Close()

	req, err := (PipedriveRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakePipedriveCredentialResolver{creds: PipedriveCredentials{
			APIToken:   "pd-token",
			APIBaseURL: srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderPipedrive,
		CredentialsRef: "cred_pipedrive_1",
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/v2/persons" {
		t.Fatalf("path=%q", gotPath)
	}
	state, err := decodePipedriveCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "deals" || state.Cursor != "" {
		t.Fatalf("cursor state=%+v raw=%s", state, req.Cursor)
	}
}

func TestPipedriveRESTBackfillerPullsDealsPage(t *testing.T) {
	var gotPath, gotCursor, gotLimit, gotStatus, gotPipeline, gotFilter, gotUpdatedSince string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotCursor = r.URL.Query().Get("cursor")
		gotLimit = r.URL.Query().Get("limit")
		gotStatus = r.URL.Query().Get("status")
		gotPipeline = r.URL.Query().Get("pipeline_id")
		gotFilter = r.URL.Query().Get("filter_id")
		gotUpdatedSince = r.URL.Query().Get("updated_since")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"data": []any{
				map[string]any{
					"id":          444,
					"title":       "Enterprise expansion",
					"status":      "won",
					"value":       25000,
					"currency":    "USD",
					"pipeline_id": 7,
					"stage_id":    8,
					"person_id": map[string]any{
						"id":            123,
						"primary_email": "Buyer@Example.com",
					},
					"update_time": "2026-06-18 10:11:12",
				},
			},
			"additional_data": map[string]any{
				"pagination": map[string]any{"next_cursor": "deal-cursor-200"},
			},
		})
	}))
	defer srv.Close()

	req, err := (PipedriveRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakePipedriveCredentialResolver{creds: PipedriveCredentials{
			APIToken:   "pd-token",
			APIBaseURL: srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderPipedrive,
		CredentialsRef: "cred_pipedrive_1",
		Settings: map[string]any{
			"deal_limit":         "25",
			"deal_status":        "won",
			"pipeline_id":        "7",
			"deal_filter_id":     "9",
			"deal_updated_since": "2026-06-01T00:00:00Z",
		},
	}, encodePipedriveCursor(pipedriveCursorState{Object: "deals", Cursor: "deal-cursor-100"}))
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/v2/deals" || gotCursor != "deal-cursor-100" || gotLimit != "25" || gotStatus != "won" || gotPipeline != "7" || gotFilter != "9" || gotUpdatedSince != "2026-06-01T00:00:00Z" {
		t.Fatalf("request path/cursor/limit/status/pipeline/filter/updated=%q/%q/%q/%q/%q/%q/%q", gotPath, gotCursor, gotLimit, gotStatus, gotPipeline, gotFilter, gotUpdatedSince)
	}
	if len(req.Events) != 1 {
		t.Fatalf("events=%+v", req.Events)
	}
	event := req.Events[0]
	if event.SourceID != "pipedrive://deal/444" || event.Email != "buyer@example.com" || event.EventName != "crm.deal.won" {
		t.Fatalf("event=%+v", event)
	}
	if event.OccurredAt == nil || !event.OccurredAt.Equal(time.Date(2026, 6, 18, 10, 11, 12, 0, time.UTC)) {
		t.Fatalf("occurred_at=%v", event.OccurredAt)
	}
	state, err := decodePipedriveCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "deals" || state.Cursor != "deal-cursor-200" {
		t.Fatalf("cursor state=%+v raw=%s", state, req.Cursor)
	}
}

func TestPipedriveRESTBackfillerPullsOrganizationsPage(t *testing.T) {
	var gotPath, gotCursor, gotLimit, gotFilter, gotUpdatedSince string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotCursor = r.URL.Query().Get("cursor")
		gotLimit = r.URL.Query().Get("limit")
		gotFilter = r.URL.Query().Get("filter_id")
		gotUpdatedSince = r.URL.Query().Get("updated_since")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"data": []any{
				map[string]any{
					"id":           55,
					"name":         "Analytical Engines",
					"address":      map[string]any{"value": "12 Compiler Way"},
					"people_count": 3,
					"person_id": map[string]any{
						"id":            123,
						"name":          "Ada Lovelace",
						"primary_email": "Buyer@Example.com",
					},
					"update_time": "2026-06-18 10:11:12",
				},
			},
		})
	}))
	defer srv.Close()

	req, err := (PipedriveRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakePipedriveCredentialResolver{creds: PipedriveCredentials{
			APIToken:   "pd-token",
			APIBaseURL: srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderPipedrive,
		CredentialsRef: "cred_pipedrive_1",
		Settings: map[string]any{
			"organization_limit":         "25",
			"organization_filter_id":     "17",
			"organization_updated_since": "2026-06-01T00:00:00Z",
		},
	}, encodePipedriveCursor(pipedriveCursorState{Object: "organizations", Cursor: "org-cursor-100"}))
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/v2/organizations" || gotCursor != "org-cursor-100" || gotLimit != "25" || gotFilter != "17" || gotUpdatedSince != "2026-06-01T00:00:00Z" {
		t.Fatalf("request path/cursor/limit/filter/updated=%q/%q/%q/%q/%q", gotPath, gotCursor, gotLimit, gotFilter, gotUpdatedSince)
	}
	if len(req.Contacts) != 1 {
		t.Fatalf("contacts=%+v", req.Contacts)
	}
	contact := req.Contacts[0]
	if contact.SourceID != "pipedrive://person/123" || contact.Email != "buyer@example.com" || contact.Company != "Analytical Engines" || !hasString(contact.Tags, "pipedrive-organization") {
		t.Fatalf("contact=%+v", contact)
	}
	if contact.Properties["pipedrive_organization_id"] != "55" || contact.Properties["pipedrive_person_id"] != "123" {
		t.Fatalf("props=%+v", contact.Properties)
	}
	state, err := decodePipedriveCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "activities" || state.Cursor != "" {
		t.Fatalf("cursor state=%+v raw=%s", state, req.Cursor)
	}
}

func TestPipedriveRESTBackfillerPullsActivitiesPage(t *testing.T) {
	var gotPath, gotCursor, gotLimit, gotFilter, gotUpdatedSince, gotDone, gotInclude string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotCursor = r.URL.Query().Get("cursor")
		gotLimit = r.URL.Query().Get("limit")
		gotFilter = r.URL.Query().Get("filter_id")
		gotUpdatedSince = r.URL.Query().Get("updated_since")
		gotDone = r.URL.Query().Get("done")
		gotInclude = r.URL.Query().Get("include_fields")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"data": []any{
				map[string]any{
					"id":       777,
					"subject":  "Decision call",
					"type":     "call",
					"done":     true,
					"deal_id":  444,
					"org_id":   map[string]any{"id": 55, "name": "Analytical Engines"},
					"due_date": "2026-06-18",
					"due_time": "10:15",
					"attendees": []any{
						map[string]any{"email": "Buyer@Example.com", "name": "Ada Lovelace", "status": "accepted"},
					},
					"update_time": "2026-06-18 10:11:12",
				},
			},
			"additional_data": map[string]any{"pagination": map[string]any{"next_cursor": "activity-cursor-200"}},
		})
	}))
	defer srv.Close()

	req, err := (PipedriveRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakePipedriveCredentialResolver{creds: PipedriveCredentials{
			APIToken:   "pd-token",
			APIBaseURL: srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderPipedrive,
		CredentialsRef: "cred_pipedrive_1",
		Settings: map[string]any{
			"activity_limit":         "30",
			"activity_filter_id":     "31",
			"activity_updated_since": "2026-06-01T00:00:00Z",
			"activity_done":          "true",
		},
	}, encodePipedriveCursor(pipedriveCursorState{Object: "activities", Cursor: "activity-cursor-100"}))
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/v2/activities" || gotCursor != "activity-cursor-100" || gotLimit != "30" || gotFilter != "31" || gotUpdatedSince != "2026-06-01T00:00:00Z" || gotDone != "true" || gotInclude != "attendees" {
		t.Fatalf("request path/cursor/limit/filter/updated/done/include=%q/%q/%q/%q/%q/%q/%q", gotPath, gotCursor, gotLimit, gotFilter, gotUpdatedSince, gotDone, gotInclude)
	}
	if len(req.Events) != 1 {
		t.Fatalf("events=%+v", req.Events)
	}
	event := req.Events[0]
	if event.SourceID != "pipedrive://activity/777" || event.Email != "buyer@example.com" || event.EventName != "crm.activity.completed" {
		t.Fatalf("event=%+v", event)
	}
	if event.Properties["company"] != "Analytical Engines" || event.Properties["pipedrive_type"] != "call" {
		t.Fatalf("props=%+v", event.Properties)
	}
	state, err := decodePipedriveCursor(req.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if state.Object != "activities" || state.Cursor != "activity-cursor-200" {
		t.Fatalf("cursor state=%+v raw=%s", state, req.Cursor)
	}
}

func TestPipedriveRESTBackfillerSupportsOAuthBearerAndRateLimit(t *testing.T) {
	var gotAuth, gotToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotToken = r.URL.Query().Get("api_token")
		w.Header().Set("Retry-After", "11")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err := (PipedriveRESTBackfiller{
		HTTPClient: srv.Client(),
		Credentials: fakePipedriveCredentialResolver{creds: PipedriveCredentials{
			AccessToken: "pd-oauth-token",
			APIBaseURL:  srv.URL,
		}},
	}).BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderPipedrive, CredentialsRef: "cred_pipedrive_1"}, "")
	if gotAuth != "Bearer pd-oauth-token" || gotToken != "" {
		t.Fatalf("auth/token=%q/%q", gotAuth, gotToken)
	}
	var restErr PipedriveRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 11*time.Second {
		t.Fatalf("expected rate limit error, got %#v", err)
	}
}

func TestPipedriveOAuthClientExchangeAndRefresh(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		user, pass, ok := r.BasicAuth()
		if !ok || user != "client-id" || pass != "client-secret" {
			t.Fatalf("basic auth = %q/%q/%v", user, pass, ok)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		switch calls {
		case 1:
			if r.URL.Path != "/oauth/token" {
				t.Fatalf("path=%q", r.URL.Path)
			}
			if r.Form.Get("grant_type") != "authorization_code" || r.Form.Get("code") != "auth-code" || r.Form.Get("redirect_uri") != "https://app.postwave.test/oauth/callback" {
				t.Fatalf("exchange form=%v", r.Form)
			}
		case 2:
			if r.URL.Path != "/oauth/token" {
				t.Fatalf("path=%q", r.URL.Path)
			}
			if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "refresh-1" {
				t.Fatalf("refresh form=%v", r.Form)
			}
		case 3:
			if r.URL.Path != "/oauth/revoke" {
				t.Fatalf("path=%q", r.URL.Path)
			}
			if r.Form.Get("token") != "refresh-1" || r.Form.Get("token_type_hint") != "refresh_token" {
				t.Fatalf("revoke form=%v", r.Form)
			}
			w.WriteHeader(http.StatusOK)
			return
		default:
			t.Fatalf("unexpected call %d", calls)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  fmt.Sprintf("access-%d", calls),
			"refresh_token": fmt.Sprintf("refresh-%d", calls+1),
			"token_type":    "Bearer",
			"expires_in":    3600,
			"scope":         "contacts:read deals:read",
			"api_domain":    "https://example.pipedrive.com",
		})
	}))
	defer srv.Close()

	now := time.Date(2026, 6, 18, 10, 0, 0, 0, time.UTC)
	client := PipedriveOAuthClient{
		HTTPClient:   srv.Client(),
		OAuthBaseURL: srv.URL,
		Now:          func() time.Time { return now },
	}
	creds := PipedriveCredentials{ClientID: "client-id", ClientSecret: "client-secret", RefreshToken: "refresh-1"}
	token, err := client.ExchangeAuthorizationCode(context.Background(), creds, "auth-code", "https://app.postwave.test/oauth/callback")
	if err != nil {
		t.Fatal(err)
	}
	if token.AccessToken != "access-1" || token.RefreshToken != "refresh-2" || !token.ExpiresAt.Equal(now.Add(time.Hour)) || token.APIBaseURL != "https://example.pipedrive.com" {
		t.Fatalf("exchange token=%+v", token)
	}
	token, err = client.RefreshAccessToken(context.Background(), creds)
	if err != nil {
		t.Fatal(err)
	}
	if token.AccessToken != "access-2" || token.RefreshToken != "refresh-3" {
		t.Fatalf("refresh token=%+v", token)
	}
	if err := client.RevokeRefreshToken(context.Background(), creds); err != nil {
		t.Fatal(err)
	}
}

type fakePipedriveManagedStore struct {
	*fakeStore
	states    map[string]PipedriveOAuthState
	secrets   map[string]string
	puts      []PipedriveCredentials
	deleteErr error
}

func newFakePipedriveManagedStore() *fakePipedriveManagedStore {
	return &fakePipedriveManagedStore{
		fakeStore: newFakeStore(),
		states:    map[string]PipedriveOAuthState{},
		secrets:   map[string]string{},
	}
}

func (f *fakePipedriveManagedStore) CreatePipedriveOAuthState(_ context.Context, state PipedriveOAuthState) (string, error) {
	f.states["state-1"] = state
	return "state-1", nil
}

func (f *fakePipedriveManagedStore) ConsumePipedriveOAuthState(_ context.Context, state string) (PipedriveOAuthState, error) {
	out, ok := f.states[state]
	if !ok {
		return PipedriveOAuthState{}, ErrNotFound
	}
	delete(f.states, state)
	return out, nil
}

func (f *fakePipedriveManagedStore) GetPipedriveCredentialSecret(_ context.Context, _ string, ref string) (string, error) {
	raw, ok := f.secrets[ref]
	if !ok {
		return "", ErrNotFound
	}
	return raw, nil
}

func (f *fakePipedriveManagedStore) PutPipedriveCredentialSecret(_ context.Context, _ string, ref string, creds PipedriveCredentials) error {
	raw, err := pipedriveCredentialsJSON(creds)
	if err != nil {
		return err
	}
	f.secrets[ref] = string(raw)
	f.puts = append(f.puts, creds)
	return nil
}

func (f *fakePipedriveManagedStore) DeletePipedriveCredentialSecret(_ context.Context, _ string, ref string) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	delete(f.secrets, ref)
	return nil
}

func (f *fakePipedriveManagedStore) FindPipedriveIntegrationByOAuthInstall(_ context.Context, clientID, companyID, userID string) (*Integration, error) {
	if settingString(f.integration.Settings, "pipedrive_oauth_client_id") == clientID &&
		settingString(f.integration.Settings, "pipedrive_company_id") == companyID &&
		settingString(f.integration.Settings, "pipedrive_user_id") == userID {
		return &f.integration, nil
	}
	return nil, ErrNotFound
}

type fakePipedriveWebhookRegistrar struct {
	summary PipedriveWebhookReconcileSummary
	cleanup PipedriveWebhookCleanupSummary
	err     error
}

func (f fakePipedriveWebhookRegistrar) ReconcileWebhooks(context.Context, Integration, string) (PipedriveWebhookReconcileSummary, error) {
	if f.err != nil {
		return PipedriveWebhookReconcileSummary{}, f.err
	}
	return f.summary, nil
}

func (f fakePipedriveWebhookRegistrar) CleanupWebhooks(context.Context, Integration, string) (PipedriveWebhookCleanupSummary, error) {
	if f.err != nil {
		return PipedriveWebhookCleanupSummary{}, f.err
	}
	return f.cleanup, nil
}

func TestPipedriveSecretsCredentialResolverRefreshesManagedCredential(t *testing.T) {
	now := time.Date(2026, 6, 19, 8, 0, 0, 0, time.UTC)
	ref := pipedriveStoredCredentialRefPrefix + "refresh-test"
	store := newFakePipedriveManagedStore()
	store.secrets[ref] = `{"access_token":"old-access","refresh_token":"refresh-1","client_id":"client-id","client_secret":"client-secret","api_domain":"https://example.pipedrive.com","expires_at":"2026-06-19T07:55:00Z"}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "client-id" || pass != "client-secret" {
			t.Fatalf("basic auth = %q/%q/%v", user, pass, ok)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "refresh-1" {
			t.Fatalf("refresh form=%v", r.Form)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "new-access",
			"refresh_token": "refresh-2",
			"token_type":    "Bearer",
			"expires_in":    3600,
			"scope":         "contacts:read deals:read webhooks:full",
			"api_domain":    "https://example.pipedrive.com",
		})
	}))
	defer srv.Close()

	resolver := NewPipedriveSecretsCredentialResolver(fakeCRMSecretResolver{})
	resolver.Store = store
	resolver.OAuthClient = PipedriveOAuthClient{HTTPClient: srv.Client(), OAuthBaseURL: srv.URL, Now: func() time.Time { return now }}
	resolver.Now = func() time.Time { return now }
	creds, err := resolver.ResolvePipedrive(context.Background(), "tenant-1", Integration{CredentialsRef: ref})
	if err != nil {
		t.Fatal(err)
	}
	if creds.AccessToken != "new-access" || creds.RefreshToken != "refresh-2" || creds.TokenExpiresAt == nil || !creds.TokenExpiresAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("creds=%+v", creds)
	}
	if len(store.puts) != 1 || !strings.Contains(store.secrets[ref], `"access_token":"new-access"`) || !strings.Contains(store.secrets[ref], `"refresh_token":"refresh-2"`) {
		t.Fatalf("stored secret not refreshed: puts=%+v raw=%s", store.puts, store.secrets[ref])
	}
}

func TestPipedriveOAuthCallbackStoresCredentialAndCreatesIntegration(t *testing.T) {
	store := newFakePipedriveManagedStore()
	store.states["state-1"] = PipedriveOAuthState{
		TenantID:        "tenant-1",
		IntegrationName: "Pipedrive OAuth",
		RedirectURI:     "https://app.postwave.test/api/v1/crm/pipedrive/oauth/callback",
		Scopes:          []string{"contacts:read", "deals:read", "webhooks:full"},
		Settings:        map[string]any{"sync_deals": "true"},
		ExpiresAt:       time.Now().Add(time.Minute),
	}
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/oauth/token":
			user, pass, ok := r.BasicAuth()
			if !ok || user != "client-id" || pass != "client-secret" {
				t.Fatalf("basic auth = %q/%q/%v", user, pass, ok)
			}
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			if r.Form.Get("grant_type") != "authorization_code" || r.Form.Get("code") != "auth-code" || r.Form.Get("redirect_uri") != "https://app.postwave.test/api/v1/crm/pipedrive/oauth/callback" {
				t.Fatalf("exchange form=%v", r.Form)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "access-1",
				"refresh_token": "refresh-1",
				"token_type":    "Bearer",
				"expires_in":    3600,
				"scope":         "contacts:read deals:read webhooks:full",
				"api_domain":    srv.URL,
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/users/me":
			if got := r.Header.Get("Authorization"); got != "Bearer access-1" {
				t.Fatalf("authorization=%q", got)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": true,
				"data": map[string]any{
					"id":               777,
					"name":             "Ada Admin",
					"email":            "Ada@Example.com",
					"locale":           "en_US",
					"company_id":       42,
					"company_name":     "Example Inc",
					"company_domain":   "example",
					"company_country":  "US",
					"company_industry": "Software",
				},
			})
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	resolver := NewPipedriveSecretsCredentialResolver(fakeCRMSecretResolver{})
	resolver.Store = store
	deps := &Deps{
		Repo:                 store,
		PipedriveCredentials: resolver,
		PipedriveOAuth: PipedriveOAuthConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
			RedirectURL:  "https://app.postwave.test/api/v1/crm/pipedrive/oauth/callback",
			OAuthBaseURL: srv.URL,
		},
		PipedriveOAuthClient: PipedriveOAuthClient{HTTPClient: srv.Client(), OAuthBaseURL: srv.URL},
		PublicBaseURL:        "https://app.postwave.test",
		Now:                  func() time.Time { return time.Date(2026, 6, 19, 8, 0, 0, 0, time.UTC) },
	}
	rec := httptest.NewRecorder()
	deps.PipedriveOAuthCallback(rec, httptest.NewRequest(http.MethodGet, "/api/v1/crm/pipedrive/oauth/callback?state=state-1&code=auth-code", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.lastInput.Provider != ProviderPipedrive || !strings.HasPrefix(store.lastInput.CredentialsRef, pipedriveStoredCredentialRefPrefix) {
		t.Fatalf("input=%+v", store.lastInput)
	}
	if store.lastInput.Settings["company_domain"] != "example" || store.lastInput.Settings["api_base_url"] != srv.URL || store.lastInput.Settings["pipedrive_oauth_managed_by_postwave"] != true {
		t.Fatalf("settings=%+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["pipedrive_user_id"] != "777" || store.lastInput.Settings["pipedrive_company_id"] != "42" || store.lastInput.Settings["pipedrive_oauth_client_id"] != "client-id" {
		t.Fatalf("oauth install settings=%+v", store.lastInput.Settings)
	}
	raw := store.secrets[store.lastInput.CredentialsRef]
	if !strings.Contains(raw, `"access_token":"access-1"`) || !strings.Contains(raw, `"refresh_token":"refresh-1"`) || !strings.Contains(raw, `"client_secret":"client-secret"`) {
		t.Fatalf("stored secret=%s", raw)
	}
}

func TestPipedriveOAuthCallbackRollsBackCredentialAndWebhooksOnUpsertFailure(t *testing.T) {
	store := newFakePipedriveManagedStore()
	store.upsertErr = errors.New("database unavailable")
	store.states["state-1"] = PipedriveOAuthState{
		TenantID:        "tenant-1",
		IntegrationName: "Pipedrive OAuth",
		RedirectURI:     "https://app.postwave.test/api/v1/crm/pipedrive/oauth/callback",
		Scopes:          []string{"contacts:read", "webhooks:full"},
		Settings:        map[string]any{"manage_webhooks": true, "webhook_events": "create.person"},
		ExpiresAt:       time.Now().Add(time.Minute),
	}
	subscriptions := []map[string]any{}
	deleted := []string{}
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/oauth/token":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "access-1",
				"refresh_token": "refresh-1",
				"token_type":    "Bearer",
				"expires_in":    3600,
				"scope":         "contacts:read webhooks:full",
				"api_domain":    srv.URL,
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/users/me":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": true,
				"data": map[string]any{
					"id":             777,
					"email":          "Ada@Example.com",
					"company_id":     42,
					"company_domain": "example",
				},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/webhooks":
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": subscriptions})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/webhooks":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			body["id"] = "created-person"
			body["subscription_url"] = "https://app.postwave.test/api/public/crm-integrations/pipedrive/webhooks"
			subscriptions = append(subscriptions, body)
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": body})
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/v1/webhooks/"):
			deleted = append(deleted, strings.TrimPrefix(r.URL.Path, "/api/v1/webhooks/"))
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	resolver := NewPipedriveSecretsCredentialResolver(fakeCRMSecretResolver{})
	resolver.Store = store
	deps := &Deps{
		Repo:                 store,
		PipedriveCredentials: resolver,
		PipedriveOAuth: PipedriveOAuthConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
			RedirectURL:  "https://app.postwave.test/api/v1/crm/pipedrive/oauth/callback",
			OAuthBaseURL: srv.URL,
		},
		PipedriveOAuthClient: PipedriveOAuthClient{HTTPClient: srv.Client(), OAuthBaseURL: srv.URL},
		PublicBaseURL:        "https://app.postwave.test",
		Now:                  func() time.Time { return time.Date(2026, 6, 19, 8, 0, 0, 0, time.UTC) },
	}

	rec := httptest.NewRecorder()
	deps.PipedriveOAuthCallback(rec, httptest.NewRequest(http.MethodGet, "/api/v1/crm/pipedrive/oauth/callback?state=state-1&code=auth-code", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.secrets) != 0 {
		t.Fatalf("managed credential should be rolled back: %+v", store.secrets)
	}
	if !hasString(deleted, "created-person") {
		t.Fatalf("managed webhook should be rolled back, deleted=%+v", deleted)
	}
}

func TestCreatePipedriveIntegrationStripsStaleCleanupOnManagedWebhookReconnect(t *testing.T) {
	store := newFakePipedriveManagedStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.Name = "Pipedrive example"
	store.integration.Status = "disconnected"
	store.integration.CredentialsRef = "cred_pipedrive_old"
	store.integration.Settings = map[string]any{
		"company_domain":             "example",
		"credentials_ref":            "cred_pipedrive_old",
		"manage_webhooks":            true,
		"pipedrive_webhook_id":       "old-wh",
		"pipedrive_webhook_ids":      []any{"old-wh"},
		"pipedrive_webhook_endpoint": "https://old.postwave.test/api/public/crm-integrations/pipedrive/webhooks",
		"provider_cleanup": map[string]any{
			"provider": ProviderPipedrive,
			"status":   "operator_action_required",
		},
	}
	deps := &Deps{
		Repo: store,
		PipedriveWebhooks: fakePipedriveWebhookRegistrar{summary: PipedriveWebhookReconcileSummary{
			Endpoint:     "https://app.postwave.test/api/public/crm-integrations/pipedrive/webhooks",
			RegisteredAt: time.Date(2026, 6, 20, 9, 0, 0, 0, time.UTC),
			Subscriptions: []PipedriveWebhookRegistration{{
				ID:          "new-wh",
				EventAction: "change",
				EventObject: "person",
				Endpoint:    "https://app.postwave.test/api/public/crm-integrations/pipedrive/webhooks",
				Version:     "2.0",
				Created:     true,
			}},
		}},
		PublicBaseURL: "https://app.postwave.test",
	}

	rec := httptest.NewRecorder()
	deps.CreateIntegration(rec, crmReq(http.MethodPost, "/api/v1/crm/integrations", `{
		"provider":"pipedrive",
		"name":"Pipedrive example",
		"settings":{
			"company_domain":"example",
			"credentials_ref":"cred_pipedrive_new",
			"manage_webhooks":true,
			"webhook_events":"change.person"
		}
	}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if _, ok := store.lastInput.Settings["provider_cleanup"]; ok {
		t.Fatalf("stale provider_cleanup should not be re-persisted: %+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["pipedrive_webhook_id"] != "new-wh" {
		t.Fatalf("webhook metadata was not refreshed: %+v", store.lastInput.Settings)
	}
	if store.lastInput.Settings["credentials_ref"] != "cred_pipedrive_new" || store.lastInput.CredentialsRef != "cred_pipedrive_new" {
		t.Fatalf("new credential ref was not preserved: input=%+v", store.lastInput)
	}
}

func TestPipedriveDisconnectRevokesOAuthAndDeletesManagedCredentialSecret(t *testing.T) {
	ref := pipedriveStoredCredentialRefPrefix + "disconnect-test"
	store := newFakePipedriveManagedStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.CredentialsRef = ref
	store.integration.Settings = map[string]any{"credentials_ref": ref}
	store.secrets[ref] = `{"access_token":"old","refresh_token":"refresh-1","client_id":"client-id","client_secret":"client-secret"}`
	revoked := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "client-id" || pass != "client-secret" {
			t.Fatalf("basic auth = %q/%q/%v", user, pass, ok)
		}
		if r.Method != http.MethodPost || r.URL.Path != "/oauth/revoke" {
			t.Fatalf("unexpected revoke request %s %s", r.Method, r.URL.Path)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Form.Get("token") != "refresh-1" || r.Form.Get("token_type_hint") != "refresh_token" {
			t.Fatalf("revoke form=%v", r.Form)
		}
		revoked = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	deps := &Deps{
		Repo: store,
		PipedriveOAuth: PipedriveOAuthConfig{
			OAuthBaseURL: srv.URL,
		},
		PipedriveOAuthClient: PipedriveOAuthClient{HTTPClient: srv.Client(), OAuthBaseURL: srv.URL},
	}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, crmReq(http.MethodDelete, "/api/v1/crm/integrations/crm_1", ""))
	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if !revoked {
		t.Fatalf("refresh token was not revoked")
	}
	if _, ok := store.secrets[ref]; ok {
		t.Fatalf("managed credential secret was not deleted: %+v", store.secrets)
	}
}

func TestPipedriveDisconnectDoesNotFinalizeWhenManagedCredentialDeleteFails(t *testing.T) {
	ref := pipedriveStoredCredentialRefPrefix + "disconnect-delete-fails"
	store := newFakePipedriveManagedStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.CredentialsRef = ref
	store.integration.Settings = map[string]any{"credentials_ref": ref}
	store.secrets[ref] = `{"access_token":"old","client_id":"client-id","client_secret":"client-secret"}`
	store.deleteErr = errors.New("vault unavailable")
	deps := &Deps{Repo: store}

	rec := httptest.NewRecorder()
	deps.DisconnectIntegration(rec, crmReq(http.MethodDelete, "/api/v1/crm/integrations/crm_1", ""))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.deleted || store.integration.Status == "disconnected" || store.disconnectCleanup != nil {
		t.Fatalf("disconnect should not be finalized: deleted=%v integration=%+v cleanup=%+v", store.deleted, store.integration, store.disconnectCleanup)
	}
	if _, ok := store.secrets[ref]; !ok {
		t.Fatalf("secret should remain when deletion fails: %+v", store.secrets)
	}
}

func TestPipedriveOAuthUninstallCallbackDisconnectsInstall(t *testing.T) {
	ref := pipedriveStoredCredentialRefPrefix + "uninstall-test"
	store := newFakePipedriveManagedStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.CredentialsRef = ref
	store.integration.Settings = map[string]any{
		"credentials_ref":            ref,
		"pipedrive_oauth_client_id":  "client-id",
		"pipedrive_company_id":       "42",
		"pipedrive_user_id":          "777",
		"pipedrive_oauth_connected":  true,
		"pipedrive_company_domain":   "example",
		"pipedrive_oauth_uninstall":  "pending",
		"pipedrive_oauth_managed_by": "postwave",
	}
	store.secrets[ref] = `{"access_token":"old","refresh_token":"refresh-1","client_id":"client-id","client_secret":"client-secret"}`
	deps := &Deps{
		Repo: store,
		PipedriveOAuth: PipedriveOAuthConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
			RedirectURL:  "https://app.postwave.test/api/v1/crm/pipedrive/oauth/callback",
		},
	}
	body := `{"client_id":"client-id","company_id":42,"user_id":777,"timestamp":"2026-06-19T08:00:00Z"}`
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/crm/pipedrive/oauth/callback", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth("client-id", "client-secret")
	rec := httptest.NewRecorder()

	deps.PipedriveOAuthUninstallCallback(rec, req)
	if rec.Code != http.StatusOK || !store.deleted {
		t.Fatalf("status=%d body=%s deleted=%v", rec.Code, rec.Body.String(), store.deleted)
	}
	if _, ok := store.secrets[ref]; ok {
		t.Fatalf("managed credential secret was not deleted: %+v", store.secrets)
	}
	if store.disconnectCleanup == nil || store.disconnectCleanup.Provider != ProviderPipedrive || !store.disconnectCleanup.OAuthRevocationSkipped || store.disconnectCleanup.OAuthRevocationSkipReason != "provider_uninstall_callback" {
		t.Fatalf("cleanup evidence=%+v", store.disconnectCleanup)
	}
	if store.disconnectCleanup.CredentialCleanupStatus != "provider_uninstall_callback_local_managed_secret_delete_enforced" {
		t.Fatalf("credential cleanup status=%q", store.disconnectCleanup.CredentialCleanupStatus)
	}
}

func TestPipedriveOAuthUninstallCallbackRejectsInvalidBasicAuth(t *testing.T) {
	store := newFakePipedriveManagedStore()
	deps := &Deps{
		Repo: store,
		PipedriveOAuth: PipedriveOAuthConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
		},
	}
	req := httptest.NewRequest(
		http.MethodDelete,
		"/api/v1/crm/pipedrive/oauth/callback",
		strings.NewReader(`{"company_id":42,"user_id":777}`),
	)
	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth("client-id", "wrong-secret")
	rec := httptest.NewRecorder()

	deps.PipedriveOAuthUninstallCallback(rec, req)

	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), "invalid_oauth_uninstall_auth") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.deleted || store.disconnectCleanup != nil {
		t.Fatalf("unauthenticated callback changed installation: deleted=%v cleanup=%+v", store.deleted, store.disconnectCleanup)
	}
}

func TestPipedriveOAuthUninstallCallbackDoesNotFinalizeWhenManagedCredentialDeleteFails(t *testing.T) {
	ref := pipedriveStoredCredentialRefPrefix + "uninstall-delete-fails"
	store := newFakePipedriveManagedStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.CredentialsRef = ref
	store.integration.Settings = map[string]any{
		"credentials_ref":           ref,
		"pipedrive_oauth_client_id": "client-id",
		"pipedrive_company_id":      "42",
		"pipedrive_user_id":         "777",
	}
	store.secrets[ref] = `{"access_token":"old","refresh_token":"refresh-1","client_id":"client-id","client_secret":"client-secret"}`
	store.deleteErr = errors.New("vault unavailable")
	deps := &Deps{
		Repo: store,
		PipedriveOAuth: PipedriveOAuthConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
			RedirectURL:  "https://app.postwave.test/api/v1/crm/pipedrive/oauth/callback",
		},
	}
	body := `{"client_id":"client-id","company_id":42,"user_id":777}`
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/crm/pipedrive/oauth/callback", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth("client-id", "client-secret")
	rec := httptest.NewRecorder()

	deps.PipedriveOAuthUninstallCallback(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if store.deleted || store.integration.Status == "disconnected" || store.disconnectCleanup != nil {
		t.Fatalf("uninstall should not finalize disconnect: deleted=%v integration=%+v cleanup=%+v", store.deleted, store.integration, store.disconnectCleanup)
	}
	if _, ok := store.secrets[ref]; !ok {
		t.Fatalf("secret should remain when deletion fails: %+v", store.secrets)
	}
}

func TestPipedriveWebhookRegistrarReconcilesAndCleansUp(t *testing.T) {
	endpoint := "https://app.postwave.test/api/public/crm-integrations/pipedrive/webhooks"
	subscriptions := []map[string]any{
		{
			"id":               "existing-person",
			"event_action":     "create",
			"event_object":     "person",
			"subscription_url": endpoint,
			"version":          "2.0",
		},
	}
	created := []map[string]any{}
	deleted := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/webhooks":
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": subscriptions})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/webhooks":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["http_auth_user"] != "postwave" || body["http_auth_password"] != "secret" || body["version"] != "2.0" {
				t.Fatalf("create body=%+v", body)
			}
			id := fmt.Sprintf("created-%s-%s", body["event_action"], body["event_object"])
			body["id"] = id
			body["subscription_url"] = endpoint
			created = append(created, body)
			subscriptions = append(subscriptions, body)
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": body})
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/v1/webhooks/"):
			deleted = append(deleted, strings.TrimPrefix(r.URL.Path, "/api/v1/webhooks/"))
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	registrar := PipedriveRESTWebhookRegistrar{
		HTTPClient: srv.Client(),
		APIBaseURL: srv.URL,
		Credentials: fakePipedriveCredentialResolver{creds: PipedriveCredentials{
			APIToken:        "pd-token",
			WebhookUsername: "postwave",
			WebhookPassword: "secret",
		}},
		Topics: []string{"create.person", "change.deal"},
		Now:    func() time.Time { return time.Date(2026, 6, 18, 10, 0, 0, 0, time.UTC) },
	}
	summary, err := registrar.ReconcileWebhooks(context.Background(), Integration{Provider: ProviderPipedrive}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if summary.Endpoint != endpoint || len(summary.Subscriptions) != 2 || len(created) != 1 || !summary.Subscriptions[0].Reused || !summary.Subscriptions[1].Created {
		t.Fatalf("summary=%+v created=%+v", summary, created)
	}
	cleanup, err := registrar.CleanupWebhooks(context.Background(), Integration{Provider: ProviderPipedrive}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if len(cleanup.Subscriptions) != 2 || len(deleted) != 2 || !hasString(deleted, "existing-person") || !hasString(deleted, "created-change-deal") {
		t.Fatalf("cleanup=%+v deleted=%+v", cleanup, deleted)
	}
}

func TestPipedriveWebhookCleanupDeletesStoredIDsEvenWhenTopicsDrift(t *testing.T) {
	endpoint := "https://app.postwave.test/api/public/crm-integrations/pipedrive/webhooks"
	subscriptions := []map[string]any{
		{
			"id":               "current-person",
			"event_action":     "create",
			"event_object":     "person",
			"subscription_url": endpoint,
			"version":          "2.0",
		},
		{
			"id":               "stored-stale-deal",
			"event_action":     "change",
			"event_object":     "deal",
			"subscription_url": "https://old.postwave.test/api/public/crm-integrations/pipedrive/webhooks",
			"version":          "2.0",
		},
	}
	deleted := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/webhooks":
			_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": subscriptions})
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/v1/webhooks/"):
			deleted = append(deleted, strings.TrimPrefix(r.URL.Path, "/api/v1/webhooks/"))
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	registrar := PipedriveRESTWebhookRegistrar{
		HTTPClient: srv.Client(),
		APIBaseURL: srv.URL,
		Credentials: fakePipedriveCredentialResolver{creds: PipedriveCredentials{
			APIToken:        "pd-token",
			WebhookUsername: "postwave",
			WebhookPassword: "secret",
		}},
		Now: func() time.Time { return time.Date(2026, 6, 18, 10, 0, 0, 0, time.UTC) },
	}
	cleanup, err := registrar.CleanupWebhooks(context.Background(), Integration{
		Provider: ProviderPipedrive,
		Settings: map[string]any{
			"webhook_events":             "create.person",
			"pipedrive_webhook_endpoint": endpoint,
			"pipedrive_webhook_ids":      []string{"stored-stale-deal"},
		},
	}, "https://app.postwave.test")
	if err != nil {
		t.Fatal(err)
	}
	if len(cleanup.Subscriptions) != 2 || !hasString(deleted, "current-person") || !hasString(deleted, "stored-stale-deal") {
		t.Fatalf("cleanup=%+v deleted=%+v", cleanup, deleted)
	}
}
